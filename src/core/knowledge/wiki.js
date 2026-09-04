/*
 * PRTS.Wiki 检索器（明日方舟攻略维基）：chat.js 三级知识库中「方舟话题」的联网检索层。
 *
 * 对外导出与复用：WikiRetriever 类（统一检索出口 retrieve），以及被 moegirl.js /
 * wikipedia.js / chat.js 复用的两个纯函数 extractKeywords（问句剥语气词）、
 * isArknightsRelated（方舟话题门）。类只在 chat.js 的 ChatBot 构造内 new
 * （三个 Wiki 检索器同此），config 的 wiki.* 键经构造参数注入。
 * 读写数据：无本地读写；请求 https://prts.wiki/api.php 的 MediaWiki API，带最小间隔
 * 节流、反爬冷却与 3 次重试（见 _waitForSlot/_get），单请求 12s 超时。
 */
import { log } from '../platform/logger.js';

const API_URL = 'https://prts.wiki/api.php';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';

/**
 * 从问句中提取检索核心词：剥掉标点与提问语气词（什么/怎么/哪里/多少/谁…）。
 * 三个检索器与 chat.js 共用，保证「搜索词」口径一致。
 * @param {string} question - 原始问句
 * @returns {string} 清洗后的核心词；传入空值时返回空串（调用方需自行回退到原句）
 */
export function extractKeywords(question) {
  if (!question) return '';
  let text = String(question)
    .replace(/[？?。，,！!、；;：:（()）]/g, ' ')
    .replace(/(什么时候|啥时候|是什么时候|是哪天|哪天|几号|几月|几月几日|几号生日)/g, ' ')
    .replace(/(哪里刷|怎么刷|刷哪里|刷哪关|去哪刷|哪关|哪关刷|怎么获取|怎么获得|怎么合成|怎么搞|怎么弄)/g, ' ')
    .replace(/(谁|是什么|是什么人|是啥|哪一关|哪一章|怎么打|怎么过|怎么玩|在哪里|在哪|多少|怎么样|如何|能打|能过|能不能|有什么|干嘛|为何|为什么|求|推荐|介绍|说说|讲讲|知道吗|吗|呢|啊|吧|的|了|是|和|与|在|有|给|问|意思|含义|指|叫|俗称|别称|外号|梗|生日|资料|信息|简介|档案|设定|属性|数据|技能|强度|攻略|排行|评价|今天|哪个|什么|时候|干啥|哪里|哪儿|去哪|需要什么|需要|材料|掉落|掉率|刷取|获取|得到|拿到|哪里出|哪里掉|合成|刷)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

// 明日方舟相关关键词（用于判断是否检索 PRTS.Wiki）
const ARK_KEYWORDS = [
  '明日方舟', '方舟', '阿米娅', '博士', '罗德岛', '干员', 'PRTS', 'prts',
  '龙门', '源石', '合成玉', '理智', '体力', '抽卡', '卡池', '寻访',
  '关卡', '剿灭', '危机合约', '集成战略', '肉鸽', '保全派驻', '生息演算',
  '基建', '线索', '精二', '专三', '专武', '潜能', '信赖', '技能',
  '能天使', '银灰', '艾雅法拉', '小火龙', '塞雷娅', '星熊', '拉普兰德',
  '德克萨斯', '推进之王', '斯卡蒂', '棘刺', '山', '水陈', '玛恩纳',
  '史尔特尔', '42', '泥岩', '煌', '夜莺', '白面鸮', '赛诺斯',
  '凯尔希', '陈', '诗怀雅', '凛冬', '守林人', '梅', '桃金娘',
  '普瑞塞斯', '特蕾西娅', '博士', '源石病', '矿石病', '感染者', '整合运动',
  '爱国者', '霜星', '塔露拉', '迷迭香', 'W', '凯尔西', '阿米娅',
  '先锋', '近卫', '重装', '狙击', '术士', '医疗', '辅助', '特种',
  '部署', '费用', '攻速', '攻击力', '防御', '法抗', '模组', '专精',
  // 常用养成材料
  '芯片', '芯片组', '双芯片', '装置', '聚酸酯', '异铁', '酮凝集', '固源岩', '代糖', '酯原料', '铁', '酮', '糖',
  '研磨石', '糖聚块', '提纯源岩', '聚合凝胶', '凝胶', '晶体元件', '晶体电路', '晶体电子单元', '聚合剂', '双极纳米片', 'D32钢', '扭转醇', '轻锰矿', '全新装置', '炽合金', 'RMA70', '白马醇', '酮阵列', '异铁块', '聚酸酯块', '提纯源岩',
  '龙门币', '作战记录', '基建材料', '招聘许可', '家具零件', '技巧概要', '技能书',
  // 常用敌人
  '整合运动', '霜星', '爱国者', 'W', '弑君者', '浮士德', '梅菲斯特', '碎骨', '复仇者', '屠夫', '大鲍勃', '爱国者',
  '蒸汽骑士', '特雷西斯', '血魔', '萨卡兹', '源石虫', '弩手', '术士', '掷矛手',
  // 玩法/系统
  '剧情', '活动', '常驻关卡', '主线', '剿灭作战', '信赖', '潜能', '皮肤', '时装', '声优', '配音',
  '危机合约', '合约赏金', '极限演习', '无脑挂机', '刷材料', '基建',
  '企鹅物流', '整合', '罗德岛', '乌萨斯', '龙门', '维多利亚', '莱塔尼亚', '哥伦比亚',
  '博士', '阿米娅', '陈', '凯尔希', '迷迭香', '闪灵', '夜莺', '塞雷娅',
  '能天使', '银灰', '艾雅法拉', '煌', '棘刺', '水陈', '玛恩纳', '泥岩',
];

// 关卡编号形态（如 1-7、S2-3、JT8-2），命中即视为方舟相关问题
const STAGE_PATTERN = /(^|[^A-Za-z0-9])([A-Za-z]?-?[0-9]+-[0-9]+|[A-Za-z]{2,3}-?[0-9]{1,3})([^A-Za-z0-9]|$)/i;

/**
 * 方舟话题门：文本含 ARK_KEYWORDS 任一关键词，或形如关卡编号即判为方舟相关。
 * @param {string} text - 待判文本
 * @returns {boolean} 相关为 true；空输入恒 false（匹配大小写不敏感）
 */
export function isArknightsRelated(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  for (const kw of ARK_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return true;
  }
  if (STAGE_PATTERN.test(text)) return true;
  return false;
}

/**
 * PRTS.Wiki 检索器：对单个问题执行「search → 取页 → 关键词定位截段」，输出可并入
 * LLM 上下文的「【标题】正文…」片段（输出协议见 external-apis.md §3）。
 * enabled=false（wikiEnabled）时检索类方法直接空转。
 */
export class WikiRetriever {
  /**
   * @param {Object} cfg - 配置（config.json 的 wiki.* 键，缺省用默认值）
   * @param {boolean} [cfg.wikiEnabled=true] - 是否启用本检索器
   * @param {string} [cfg.wikiApiUrl] - PRTS.Wiki 的 api.php 地址
   * @param {number} [cfg.wikiMaxResults=5] - search 单次返回条数上限
   * @param {number} [cfg.wikiMaxCharPerPage=4000] - 单页正文并入上限字符
   * @param {number} [cfg.wikiTopK=3] - 并入 context 的页数上限
   * @param {number} [cfg.wikiMinInterval=2000] - 相邻请求最小间隔 ms
   * @param {number} [cfg.wikiCooldownMs=10000] - 疑似反爬后的冷却时长 ms
   */
  constructor(cfg = {}) {
    this.enabled = cfg.wikiEnabled !== false;
    this.apiUrl = cfg.wikiApiUrl || API_URL;
    this.maxResults = cfg.wikiMaxResults ?? 5;
    this.maxCharPerPage = cfg.wikiMaxCharPerPage ?? 4000;
    this.topK = cfg.wikiTopK ?? 3;
    this.snippets = new Map();
    this.lastQuery = null;
    this._minInterval = cfg.wikiMinInterval ?? 2000;
    this._cooldownMs = cfg.wikiCooldownMs ?? 10000;
    this._lastRequestAt = 0;
    this._antiBotUntil = 0;
    this._consecutiveFail = 0;
  }

  // 节流/冷却等待：距上次请求不足 _minInterval，或在反爬冷却期（_antiBotUntil）内则 sleep 到放行
  async _waitForSlot() {
    const now = Date.now();
    const waitUntil = Math.max(this._lastRequestAt + this._minInterval, this._antiBotUntil);
    if (now < waitUntil) {
      await new Promise((r) => setTimeout(r, waitUntil - now));
    }
    this._lastRequestAt = Date.now();
  }

  // 带重试的 MediaWiki GET：单次 12s 超时；响应非 JSON（HTML=疑似反爬）计入
  // _consecutiveFail，连续 ≥2 次进入 10s 冷却（_antiBotUntil）并写日志；间隔 1.5s
  // 重试，3 次仍失败则抛最后一次错误
  async _get(params, retries = 3) {
    const full = { format: 'json', ...params };
    const qs = Object.entries(full)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.apiUrl}?${qs}`;

    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      await this._waitForSlot();
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
        const text = await resp.text();
        const trimmed = text.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          this._consecutiveFail = 0;
          return JSON.parse(text);
        }
        this._consecutiveFail++;
        if (this._consecutiveFail >= 2) {
          this._antiBotUntil = Date.now() + this._cooldownMs;
          log(`[wiki] 连续反爬，进入 ${this._cooldownMs / 1000}s 冷却`);
        }
        lastErr = new Error(`Wiki 返回 HTML(可能是反爬，第${attempt}次)`);
      } catch (e) {
        this._consecutiveFail++;
        lastErr = e;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500));
    }
    throw lastErr || new Error('Wiki 请求失败');
  }

  /**
   * 搜索页面列表（内部再经 extractKeywords 清洗关键词）。
   * 副作用: 更新 lastQuery；成功/失败均写 [wiki] 日志，失败不抛错。
   * @param {string} title - 搜索词（原始问句亦可）
   * @returns {Promise<Object[]>} [{title, snippet, size, wordcount}]；
   *   空数组 = 未启用 / 空输入 / 请求失败
   */
  async search(title) {
    if (!this.enabled || !title) return [];
    this.lastQuery = title;
    const query = extractKeywords(title) || title;
    try {
      const data = await this._get({
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(this.maxResults),
        srprop: 'snippet|wordcount|size',
      });
      const results = (data?.query?.search || []).map((r) => ({
        title: r.title,
        snippet: (r.snippet || '').replace(/<[^>]+>/g, ''),
        size: r.size ?? 0,
        wordcount: r.wordcount ?? 0,
      }));
      log(`[wiki] 搜索 "${title}" → ${results.length} 条结果`);
      return results;
    } catch (e) {
      log(`[wiki] 搜索失败: ${e.message}`);
      return [];
    }
  }

  /**
   * 拉取单页 wikitext 并清洗（_cleanWikitext），截断到 maxCharPerPage。
   * @param {string} title - 页面标题
   * @returns {Promise<string>} 清洗后的正文；空串 = 失败或空页（失败只记日志不抛）
   */
  async getPageContent(title) {
    try {
      const data = await this._get({
        action: 'parse',
        page: title,
        prop: 'wikitext',
        formatversion: '2',
      });
      const wikitext = data?.parse?.wikitext || '';
      const cleaned = this._cleanWikitext(wikitext);
      return cleaned.slice(0, this.maxCharPerPage);
    } catch (e) {
      log(`[wiki] 拉取页面 "${title}" 失败: ${e.message}`);
      return '';
    }
  }

  // wikitext 白名单清洗：删 <ref>/HTML 标签与无关模板，从信息模板中保留关键参数行
  // （|名称=… 等），章节标题转 [标题] 行，最后压缩空行与多余空格
  _cleanWikitext(text) {
    if (!text) return '';
    let out = text;
    out = out.replace(/<ref[\s\S]*?<\/ref>/g, '');
    out = out.replace(/<[^>]+>/g, ' ');
    // 链接 [[目标|显示]] → 显示
    out = out.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
    // 模板：保留关键参数行（如 |名称=... |描述=... |用途=...），去掉纯导航模板
    const paramLines = [];
    out = out.replace(/\{\{(?:道具信息|道具价格|材料信息|敌人信息|关卡信息|物品信息|干员信息|时装信息)[\s\S]*?\}\}/g, (block) => {
      const lines = block.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*\|?([A-Za-z\u4e00-\u9fff]+)\s*=\s*(.+)$/);
        if (m && m[2] && !/^\{\{/.test(m[2])) {
          const key = m[1].trim();
          if (['名称', 'name', '描述', '用途', 'description', 'usage', '价格', '稀有度', '分类', '类型', '效果', '冷却', 'duration', 'position', '职业', 'profession', '阵营', 'nation'].includes(key)) {
            paramLines.push(`${key}：${m[2].trim()}`);
          }
        }
      }
      return '';
    });
    // 去掉其余无关模板
    out = out.replace(/\{\{[^}]*\}\}/g, '');
    out = out.replace(/\{\{[\s\S]*?\}\}/g, '');
    // 章节标题保留
    out = out.replace(/^(==+)\s*(.*?)\s*\1$/gm, '\n[标题] $2\n');
    out = out.replace(/'''|''/g, '');
    out = out.replace(/\n{3,}/g, '\n\n');
    out = out.replace(/[ \t]{2,}/g, ' ');
    const extra = paramLines.join('\n');
    return (extra ? extra + '\n' : '') + out.trim();
  }

  /**
   * 检索总入口：search → 前 topK 页各取正文；长页且含关键词时把截断窗口移到关键词
   * 附近，拼成「【标题】正文…」context 返回（chat.js 将其并入 LLM 提示）。
   * @param {string} question - 群内原始提问
   * @returns {Promise<{context: string, sources: string[], scoreSize: number}>}
   *   context='' 且 sources=[] 表示未启用或零命中（此时无 scoreSize 字段）；
   *   有命中时 scoreSize = 各命中页 size（上游页面字节数）的最大值
   */
  async retrieve(question) {
    if (!this.enabled) return { context: '', sources: [] };

    const hits = await this.search(question);
    if (hits.length === 0) return { context: '', sources: [] };

    const pages = [];
    let maxSize = 0;
    const keywords = extractKeywords(question) || question;
    for (const hit of hits.slice(0, this.topK)) {
      const content = await this.getPageContent(hit.title);
      if (content) {
        // 若页面较长且包含关键词，优先定位关键词相关段落
        let final = content;
        const kw = String(keywords).trim();
        if (kw && content.length > this.maxCharPerPage * 0.6) {
          const idx = content.indexOf(kw);
          if (idx > 0) {
            const start = Math.max(0, idx - 100);
            final = content.slice(start, start + this.maxCharPerPage);
          }
        }
        pages.push({ title: hit.title, content: final, size: hit.size || 0, wordcount: hit.wordcount || 0 });
        maxSize = Math.max(maxSize, hit.size || 0);
      }
    }

    const context = pages
      .map((p) => `【${p.title}】\n${p.content}`)
      .join('\n\n---\n\n')
      .slice(0, this.topK * this.maxCharPerPage);

    return { context, sources: pages.map((p) => p.title), scoreSize: maxSize };
  }
}
