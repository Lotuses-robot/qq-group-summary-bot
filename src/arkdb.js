/*
 * 本地明日方舟数据库（ArkDB）：干员表 / 档案 / 肉鸽藏品 / 真实卡池四张表 +
 * 语义模糊匹配 + 抽卡引擎，支撑 commands.js 的干员/藏品/生日/卡池/抽卡指令秒回。
 *
 * 对外导出：ArkDB 类（各公开方法见下）；默认只读 data/ark/ 下 refresher.js 下载的四张
 * JSON（character_table / handbook_info_table / roguelike_topic_table /
 * gacha_table），首次访问懒加载进内存，reload() 供数据更新后的热重载。
 * 依赖与实例化点：只 import logger；实例在 chat.js 的 ChatBot 构造内 new 并暴露为
 * chatBot.arkdb——commands.js（命令 ctx 注入）与 webui.js（面板查询/刷新）都在借用
 * 同一实例，是事实上的进程内共享单例（见 architecture.md §7）。
 * 读写数据：本类只读上述 JSON（缺表/解析失败只记日志不崩）；不写盘——抽卡记录落库
 * 在 analytics.js，数据下载/校验/原子写入在 refresher.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data', 'ark');

/**
 * 明日方舟本地数据库：四表懒加载（load，幂等）+ 名称/藏品查询与语义模糊匹配 +
 * 权重抽卡与真实卡池抽卡（出率语义见 randomPull / pullFromPool 的注释）。
 */
export class ArkDB {
  /**
   * @param {string} [dataDir=DEFAULT_DATA_DIR] - 数据目录（默认 src/../data/ark），测试可注入
   */
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.characters = new Map(); // charId -> 基础信息
    this.handbooks = new Map();  // charId -> 档案
    this.aliasMap = new Map();   // 别名/名称 -> charId
    this.relics = new Map();     // 藏品名 -> 藏品信息
    this.gachaPools = [];        // 真实卡池列表
    this._loaded = false;
  }

  /**
   * 清空全部内存表后重新加载（数据定期更新后的热重载入口：refresher → index.js → 此处）。
   * @returns {void} 无返回；单表加载容错同 load
   */
  reload() {
    this.characters.clear();
    this.handbooks.clear();
    this.aliasMap.clear();
    this.relics.clear();
    this.gachaPools = [];
    this._loaded = false;
    this.load();
  }

  /**
   * 懒加载（幂等，_loaded 已为真则直接返回）：依次读干员表 → 档案表 → 肉鸽藏品表 →
   * 卡池表；缺表/解析失败仅记日志不抛错（损坏容错见 docs/data-format.md）。
   * aliasMap = 干员名/代号/档案名 → charId 的汇总索引。
   * 副作用: 填充 this.characters/handbooks/aliasMap/relics/gachaPools，置 _loaded=true。
   * @returns {void} 无返回；查询/抽卡类方法内部都会先调本方法
   */
  load() {
    if (this._loaded) return;
    const charFile = path.join(this.dataDir, 'character_table.json');
    const handbookFile = path.join(this.dataDir, 'handbook_info_table.json');

    if (fs.existsSync(charFile)) {
      try {
        const table = JSON.parse(fs.readFileSync(charFile, 'utf8'));
        const dict = table.characters || table;
        for (const [id, c] of Object.entries(dict)) {
          const name = c.name || '';
          this.characters.set(id, {
            id,
            name,
            rarity: c.rarity ?? -1,
            profession: c.profession || '',
            position: c.position || '',
            tags: c.tags || [],
            desc: (c.description || '').replace(/<[^>]+>/g, ''),
            nation: c.nation || '',
            team: c.team || '',
            groupId: c.groupId || '',
            notObtainable: c.isNotObtainable === true,
            spChar: c.isSpChar === true,
          });
          if (name) this.aliasMap.set(name, id);
          if (c.appellation) this.aliasMap.set(c.appellation, id);
        }
        log(`[arkdb] 已加载 ${this.characters.size} 个干员`);
      } catch (e) {
        log(`[arkdb] 干员表加载失败: ${e.message}`);
      }
    }

    if (fs.existsSync(handbookFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(handbookFile, 'utf8'));
        const dict = data.handbookDict || {};
        for (const [id, h] of Object.entries(dict)) {
          const profile = this._extractProfile(h);
          this.handbooks.set(id, profile);
          if (profile.name) this.aliasMap.set(profile.name, id);
        }
        log(`[arkdb] 已加载 ${this.handbooks.size} 份干员档案`);
      } catch (e) {
        log(`[arkdb] 档案表加载失败: ${e.message}`);
      }
    }

    // 肉鸽藏品表（集成战略藏品，含高卢银行支票等）
    const relicFile = path.join(this.dataDir, 'roguelike_topic_table.json');
    if (fs.existsSync(relicFile)) {
      try {
        const rl = JSON.parse(fs.readFileSync(relicFile, 'utf8'));
        const collectAll = (obj) => {
          const out = [];
          const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            for (const v of Object.values(o)) {
              if (v && typeof v === 'object') {
                if (v.type === 'RELIC' && v.name) out.push(v);
                else walk(v);
              }
            }
          };
          walk(obj);
          return out;
        };
        const relics = collectAll(rl);
        for (const r of relics) {
          if (r.name) this.relics.set(r.name, r);
        }
        log(`[arkdb] 已加载 ${this.relics.size} 个肉鸽藏品`);
      } catch (e) {
        log(`[arkdb] 藏品表加载失败: ${e.message}`);
      }
    }

    // 真实卡池表
    const gachaFile = path.join(this.dataDir, 'gacha_table.json');
    if (fs.existsSync(gachaFile)) {
      try {
        const gt = JSON.parse(fs.readFileSync(gachaFile, 'utf8'));
        this.gachaPools = (gt.gachaPoolClient || []).filter((p) => p.gachaPoolId && p.gachaPoolName);
        log(`[arkdb] 已加载 ${this.gachaPools.length} 个卡池`);
      } catch (e) {
        log(`[arkdb] 卡池表加载失败: ${e.message}`);
      }
    }

    this._loaded = true;
  }

  /**
   * 按藏品名查询：先全等命中，再退化到「查询词是某藏品名子串」的包含匹配
   * （如「支票」→「高卢银行支票」）；≤2 字短词不做包含匹配防误配。
   * @param {string} name - 藏品名或其中片段
   * @returns {Object|null} 藏品对象；null = 空名 / 未命中 / 短词且无全等命中
   */
  findRelic(name) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length === 0) return null;
    if (this.relics.has(n)) return this.relics.get(n);
    // 模糊匹配：短词（≤2字）不模糊匹配，避免"高卢"误配"高卢小圆饼"
    if (n.length <= 2) return null;
    // 优先匹配包含关系：查询词包含在藏品名中（如"支票"→"高卢银行支票"）
    for (const [key, r] of this.relics) {
      if (key.length > 0 && key.includes(n)) return r;
    }
    return null;
  }

  /**
   * 判断文本是否包含任一藏品名（≥2 字），供 chat.js 决定是否走本地藏品检索分支。
   * @param {string} text - 待判文本
   * @returns {boolean} 命中任一藏品名为 true；空输入恒 false
   */
  containsRelicName(text) {
    if (!text) return false;
    this.load();
    const t = String(text);
    for (const key of this.relics.keys()) {
      if (key.length >= 2 && t.includes(key)) return true;
    }
    return false;
  }
  // 从单条档案原始对象抽出常用档案字段：拼接全部 storyText 后按【小节名】正则抠行
  // （性别/生日/出身地…）；infoName 为空或 Unknown 时回退取【代号】
  _extractProfile(handbook) {
    const text = handbook.storyTextAudio
      ?.map((s) => s.stories?.map((st) => st.storyText || '').join('\n'))
      .join('\n') || '';
    const get = (key) => {
      const m = text.match(new RegExp(`【${key}】([^\\n]*)`));
      return m ? m[1].trim() : '';
    };
    // infoName 可能为空或"Unknown"，优先用原文的【代号】
    let name = (handbook.infoName || '').trim();
    if (!name || name === 'Unknown') name = get('代号');
    return {
      charId: handbook.charID,
      name,
      gender: get('性别'),
      combatExp: get('战斗经验'),
      birthPlace: get('出身地'),
      birthday: get('生日'),
      race: get('种族'),
      height: get('身高'),
      infectionStatus: get('矿石病感染情况'),
      raw: text.slice(0, 3000),
    };
  }

  /**
   * 按名称/别名（含代号）查找干员：先全等命中 aliasMap，再退化到互相包含的子串匹配；
   * ≤2 字短名拒绝子串模糊（防「山」「陈」等单字误配大量干员）。
   * @param {string} name - 干员名/别名/代号
   * @returns {Object|null} getById 合并后的干员对象；null = 未找到
   */
  findByName(name) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length === 0) return null;

    const id = this.aliasMap.get(n);
    if (id) return this.getById(id);

    // 模糊匹配：短名（≤2字）要求全词相等，避免"山""陈"等单字误配大量干员
    if (n.length <= 2) {
      return null;
    }
    for (const [key, cid] of this.aliasMap) {
      if (key.length > 0 && key !== n && (key.includes(n) || n.includes(key))) return this.getById(cid);
    }
    return null;
  }

  // ---- 语义模糊匹配（bigram Dice 系数，无外部依赖的轻量 embedding 替代）----
  // 去除非中英文字符后切相邻二元组（bigram）集合，作为轻量相似度特征
  _bigrams(str) {
    const s = String(str).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  // Dice 系数 = 2×共同二元组数 / 两集合大小之和；任一为空集时相似度为 0
  _similarity(a, b) {
    const A = this._bigrams(a);
    const B = this._bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
  }

  /**
   * 语义模糊匹配干员名（bigram Dice 系数，如「波登克」→「波登可」）：候选名长度差
   * >4 或 ≤1 字直接跳过，只取超过阈值的最高分。
   * @param {string} name - 查询名
   * @param {number} [threshold=0.38] - 相似度阈值（0–1），未超过视为不匹配
   * @returns {Object|null} 得分最高的干员对象；无候选超过阈值时 null
   */
  findOperatorFuzzy(name, threshold = 0.38) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length <= 1) return null;
    let best = null;
    let bestScore = threshold;
    for (const [key, cid] of this.aliasMap) {
      if (key.length <= 1) continue;
      if (Math.abs(key.length - n.length) > 4) continue;
      const score = this._similarity(n, key);
      if (score > bestScore) {
        bestScore = score;
        best = this.getById(cid);
      }
    }
    return best;
  }

  /**
   * 语义模糊匹配藏品名（bigram Dice 系数，如「高卢的支票本」→「高卢银行支票」），
   * 逻辑与阈值同 findOperatorFuzzy。
   * @param {string} name - 查询名
   * @param {number} [threshold=0.38] - 相似度阈值（0–1），未超过视为不匹配
   * @returns {Object|null} 得分最高的藏品对象；无候选超过阈值时 null
   */
  findRelicFuzzy(name, threshold = 0.38) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length <= 1) return null;
    let best = null;
    let bestScore = threshold;
    for (const [key, r] of this.relics) {
      if (key.length <= 1) continue;
      if (Math.abs(key.length - n.length) > 4) continue;
      const score = this._similarity(n, key);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  /**
   * 判断文本是否包含任一干员名/别名（≥2 字），供 chat.js 的方舟话题门触发本地干员检索。
   * @param {string} text - 待判文本
   * @returns {boolean} 命中任一名字为 true；空输入恒 false
   */
  containsOperatorName(text) {
    if (!text) return false;
    this.load();
    const t = String(text);
    for (const key of this.aliasMap.keys()) {
      if (key.length >= 2 && t.includes(key)) return true;
    }
    return false;
  }

  /**
   * 按 charId 合并干员表与档案表：档案字段覆盖同名基础字段；name 优先取干员表
   * （更可靠），查询类公开方法的最终出口。
   * @param {string} id - 干员 charId（如 char_002_amiya）
   * @returns {Object|null} 合并后的干员对象；两表都无此 id 时 null
   */
  getById(id) {
    const base = this.characters.get(id);
    const profile = this.handbooks.get(id);
    if (!base && !profile) return null;
    const merged = { ...(base || {}), ...(profile || {}) };
    // name 优先用 character 表的（更可靠），profile 名仅作兜底
    if (base?.name) merged.name = base.name;
    return merged;
  }

  /**
   * 在完整提问文本中找已收录干员名并返回其生日（指令「干员生日/生日 名」用）。
   * @param {string} keyword - 完整提问文本（含干员名）
   * @returns {{name: string, birthday: string}|null} name 为干员表名、birthday 为
   *   「M月D日」档案原文（档案缺失或未写生日时为 ''）；文本不含任何已收录名字时 null
   */
  searchBirthday(keyword) {
    // 从关键词提取干员名
    const names = [...this.aliasMap.keys()];
    const hit = names.find((n) => keyword.includes(n));
    if (!hit) return null;
    const op = this.findByName(hit);
    if (!op) return null;
    return { name: op.name || hit, birthday: op.birthday || '' };
  }

  /**
   * 今日过生日的干员（指令「今日生日/今天谁生日」用；按「M月D日」精确比对档案生日）。
   * @param {Date} [date=new Date()] - 参考日期（默认今天；测试可传其他日期）
   * @returns {string[]} 干员名数组（按档案表遍历顺序、已去重）；无人过生日时为空数组
   */
  todaysBirthdays(date = new Date()) {
    this.load();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const target = `${m}月${d}日`;
    const list = [];
    for (const [, profile] of this.handbooks) {
      if (profile.birthday && profile.birthday === target) {
        list.push(profile.name);
      }
    }
    return [...new Set(list)];
  }

  /**
   * 权重抽卡（无卡池时的降级常驻抽卡路径）：星级按明日方舟出率 6★2% / 5★8% /
   * 4★50% / 3★40% 抽取，同星级内等概率随机；排除不可获取（预备干员 isNotObtainable）
   * 与异格限定（isSpChar）。
   * 副作用: 首次触发 load；结果不落盘——逐抽记录由调用方（commands.js → analytics）负责。
   * @param {number} [n=1] - 抽数（单抽 1、十连 10）
   * @returns {Array<{star: string, name: string, up: boolean}>} 逐抽结果（无 UP 概念，
   *   up 恒为 false）；该星级无候选时 name 为「（未知）」，展示格式交由调用方渲染
   */
  randomPull(n = 1) {
    this.load();
    const weights = { TIER_6: 0.02, TIER_5: 0.08, TIER_4: 0.5, TIER_3: 0.4 };
    const stars = { TIER_6: '★★★★★★', TIER_5: '★★★★★', TIER_4: '★★★★', TIER_3: '★★★' };
    const pool = [...this.characters.values()].filter((c) => c.name && weights[c.rarity] && this._isOperator(c) && !c.spChar);
    const pickOne = () => {
      let r = Math.random();
      for (const [tier, w] of Object.entries(weights)) {
        if (r < w) return { tier, star: stars[tier] };
        r -= w;
      }
      return { tier: 'TIER_3', star: stars.TIER_3 };
    };
    const results = [];
    for (let i = 0; i < n; i++) {
      const { tier, star } = pickOne();
      const candidates = pool.filter((c) => c.rarity === tier);
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      results.push({ star, name: c ? c.name : '（未知）', up: false });
    }
    return results;
  }

  // ---- 真实卡池系统 ----

  // 是否为可抽取的真实干员（排除召唤物 TOKEN / 陷阱 TRAP / 不可获取的预备干员）
  _isOperator(c) {
    return ['MEDIC', 'WARRIOR', 'SPECIAL', 'SNIPER', 'SUPPORT', 'TANK', 'PIONEER', 'CASTER'].includes(c.profession)
      && !c.notObtainable;
  }

  /**
   * 当前开放中的真实卡池（按服务器秒级时间过滤 openTime ≤ now ≤ endTime；
   * 单侧时间字段缺省视为不设限）。
   * @returns {Object[]} 卡池条目（含 gachaPoolId / gachaPoolName / dynMeta 等）；
   *   无开放池或未加载卡池表时为空数组
   */
  currentGachaPools() {
    this.load();
    const now = Math.floor(Date.now() / 1000);
    return this.gachaPools.filter(
      (p) => (!p.openTime || p.openTime <= now) && (!p.endTime || p.endTime >= now)
    );
  }

  /**
   * 提取卡池的 UP 干员名单：读 pool.dynMeta 的 main6RarityCharId / rare5CharList /
   * rarityPickCharDict，合并去重并只保留干员表中真实存在的 id。
   * @param {Object} pool - 卡池对象（如 currentGachaPools() 的条目）
   * @returns {{up6: string[], up5: string[]}} 6★/5★ UP 干员的 charId 数组；无 UP 时为空数组
   */
  poolRateUps(pool) {
    const up6 = [];
    const up5 = [];
    const d = pool?.dynMeta || {};
    if (d.main6RarityCharId) up6.push(d.main6RarityCharId);
    if (Array.isArray(d.rare5CharList)) up5.push(...d.rare5CharList);
    if (d.rarityPickCharDict) {
      for (const id of (d.rarityPickCharDict.TIER_6 || []).slice(0, 3)) up6.push(id);
      for (const id of (d.rarityPickCharDict.TIER_5 || []).slice(0, 3)) up5.push(id);
    }
    return {
      up6: [...new Set(up6)].filter((id) => this.characters.has(id)),
      up5: [...new Set(up5)].filter((id) => this.characters.has(id)),
    };
  }

  /**
   * 从真实卡池抽卡：星级概率 6★2% / 5★8% / 4★50% / 3★40%（与 randomPull 出率一致），
   * 命中星级后再掷 50%：UP 干员占该星级的一半概率（多名 UP 均分），另一半由该星级
   * 非 UP 干员均分；异格/联动限定（isSpChar）仅在其 UP 卡池中可出。
   * 副作用: 首次触发 load；结果不落盘——逐抽记录由调用方（commands.js → analytics）负责。
   * @param {Object} pool - 卡池对象；null/undefined 时降级为 randomPull(count)
   * @param {number} [count=10] - 抽数
   * @returns {Array<{star: string, name: string, up: boolean}>} 逐抽结果（up=true 表示
   *   命中 UP）；该星级无候选时 name 为「未知」
   */
  pullFromPool(pool, count = 10) {
    this.load();
    if (!pool) return this.randomPull(count);
    const { up6, up5 } = this.poolRateUps(pool);
    const upSet6 = new Set(up6);
    const upSet5 = new Set(up5);
    const stars = { TIER_6: '★★★★★★', TIER_5: '★★★★★', TIER_4: '★★★★', TIER_3: '★★★' };
    const byTier = { TIER_6: [], TIER_5: [], TIER_4: [], TIER_3: [] };
    for (const c of this.characters.values()) {
      if (!c.name || !byTier[c.rarity] || !this._isOperator(c)) continue;
      // 异格/联动限定干员（isSpChar）仅在其 UP 卡池中可抽取
      if (c.spChar && !upSet6.has(c.id) && !upSet5.has(c.id)) continue;
      byTier[c.rarity].push(c);
    }
    const pickTier = () => {
      const r = Math.random();
      if (r < 0.02) return 'TIER_6';
      if (r < 0.1) return 'TIER_5';
      if (r < 0.6) return 'TIER_4';
      return 'TIER_3';
    };
    const pickChar = (tier) => {
      let candidates = byTier[tier] || [];
      const upSet = tier === 'TIER_6' ? upSet6 : tier === 'TIER_5' ? upSet5 : new Set();
      if (upSet.size && Math.random() < 0.5) {
        const ups = candidates.filter((c) => upSet.has(c.id));
        if (ups.length) candidates = ups;
      } else {
        const nonUps = candidates.filter((c) => !upSet.has(c.id));
        if (nonUps.length) candidates = nonUps;
      }
      if (!candidates.length) candidates = byTier[tier] || [];
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      return { star: stars[tier], name: c?.name || '未知', up: c ? upSet.has(c.id) : false };
    };
    const results = [];
    for (let i = 0; i < count; i++) {
      const tier = pickTier();
      const r = pickChar(tier);
      results.push({ star: r.star, name: r.name, up: r.up });
    }
    return results;
  }
}
