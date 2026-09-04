/**
 * 测试公共工具：临时目录、随机序列桩、日志静音，以及合成数据夹具。
 *
 * 用途：所有基线测试的公共底座（node:test，无第三方依赖）。夹具刻意用「半真实」
 * 干员/藏品/卡池命名——断言文案可读，且与 README 中的示例（波登克→波登可等）一一对应；
 * 数据体积小（每表几条），加载快、确定性强。
 *
 * 约束：夹具形状必须贴合 ArkDB/refresher 对上游 JSON 的结构约定
 * （见 docs/data-format.md §5）——character_table 扁平对象、handbook 取
 * .handbookDict、藏品递归收集 type==='RELIC'、卡池取 .gachaPoolClient。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 临时目录登记表：同文件内 makeTmp 建出的目录都排在此队，由文件级
 * cleanupTmpDirs()（after 钩子）统一逆序清理——先跑目录的关闭器（如 SQLite
 * db.close），再删目录。
 *
 * 为什么不做成 makeTmp 里 t.after 自清理：node:test 的 after 钩子按注册顺序
 * （FIFO）执行，而关闭器往往在 makeTmp 返回之后才登记（Analytics 在下一行才 new），
 * 轮不到关库就先删目录；Windows 上未 close 的 node:sqlite 句柄使 rmSync 永久
 * EPERM（句柄不随引用丢弃/GC 释放，只能显式 close 或等进程退出）。
 */
const tmpDirs = [];

/**
 * 建一个进程级唯一临时目录并登记进文件级清理队列。
 * @returns {string} 临时目录绝对路径
 */
export function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-test-'));
  tmpDirs.push({ dir, closers: [] });
  return dir;
}

/**
 * 给最近一次 makeTmp() 的目录登记一个「删目录前先执行」的关闭器。
 * 打开过 SQLite（Analytics/db）的用例必须在构造后调用本函数，否则 Windows 下
 * 清理目录会 EPERM。
 * @param {{close(): void}} handle - 带 close() 的资源句柄（如 Analytics 实例）
 */
export function trackDbClose(handle) {
  const last = tmpDirs[tmpDirs.length - 1];
  last.closers.push(() => {
    try { handle.close(); } catch { /* 已关闭则忽略 */ }
  });
}

/**
 * 文件级清理（测试文件顶层 `after(cleanupTmpDirs)`）：逆序逐个目录
 * 先跑关闭器再 rm -rf；EPERM 属瞬态（杀软/句柄延迟释放）时短重试。
 */
export function cleanupTmpDirs() {
  while (tmpDirs.length) {
    const { dir, closers } = tmpDirs.pop();
    for (const close of closers.reverse()) close();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        // 最后一次仍失败则放弃（留下一个 %TEMP% 空壳，不影响断言结果）
      }
    }
  }
}

/**
 * 以固定序列代替 Math.random 跑同步逻辑（抽卡类测试的确定性来源）。
 * 序列用尽后停留在最后一个值；无论成功与否都恢复原 Math.random。
 * @param {number[]} seq - 依次出队的随机数
 * @param {Function} fn - 同步函数（内部消费 Math.random）
 * @returns {*} fn 的返回值
 */
export function withRand(seq, fn) {
  const orig = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

/**
 * 测试期间静音 console.log（logger.log 的出口；被测模块加载/构造会打日志），
 * console.error 保留（出错可见）。文件写盘（logs/）不受影响。
 * 需在测试文件顶层调用一次：`const restore = silenceLog(); after(() => restore());`
 * @returns {Function} 恢复函数（把 console.log 换回去）
 */
export function silenceLog() {
  const orig = console.log;
  console.log = () => {};
  return () => { console.log = orig; };
}

/** 今天的本地「M月D日」串（与 commands「今日生日」文案同格式），夹具按它造生日干员 */
export function todayLabel(d = new Date()) {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 把一条记录写成 JSONL 行（测试预置磁盘消息用）
function lineOf(rec) {
  return JSON.stringify(rec) + '\n';
}

/**
 * 向 messages/<群号>/<日期>.jsonl 预写消息记录（含可选坏行/重复行，模拟历史脏盘）。
 * @param {string} dir - 临时数据根目录（将建 data/messages 子结构）
 * @param {string} gid - 群号
 * @param {string} dateStr - "YYYY-MM-DD" 文件名日期
 * @param {Array<Object|string>} recs - 记录对象数组；字符串元素原样写入（模拟坏行）
 */
export function seedMessages(dir, gid, dateStr, recs) {
  const file = path.join(dir, 'messages', String(gid), `${dateStr}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => (typeof r === 'string' ? r : lineOf(r))).join(''));
  return file;
}

/**
 * 写一套合成方舟数据到临时 data/ark 目录（ArkDB/commands 测试用）。
 *
 * 干员表构成（插入顺序 = characters Map 遍历顺序，抽卡索引测试依赖它）：
 *   归溟幽灵鲨 6★ SPECIAL isSpChar   —— 异格限定：仅在其 UP 卡池可出
 *   能天使     6★ SNIPER            —— 常驻 6★，池1 UP
 *   阿米娅     5★ CASTER            —— 池1 5★UP
 *   德克萨斯   5★ PIONEER
 *   波登可     4★ MEDIC             —— 语义模糊目标（波登克→波登可）
 *   玫兰莎     3★ WARRIOR
 *   预备干员-近战 3★ WARRIOR isNotObtainable —— 不可获取，永不入池
 *   铁拳卫     3★ TRAP              —— profession 不在白名单，非干员
 *   生日测试员 3★ WARRIOR（档案生日 = 今天）   —— 「今日生日」恒命中
 * 档案表：能天使(5月25日)/阿米娅/波登可/生日测试员(今天)。
 * 藏品表：高卢银行支票（嵌套在多层对象里）+ 策略之眼；夹一个非 RELIC 节点验证过滤。
 * 卡池表：池1「深池纪念」常开（UP：能天使/阿米娅）；池2「愚人号」常开（UP：归溟幽灵鲨）；
 *   池3「已关闭池」endTime 已过、池4「未来池」openTime 未到——验证 currentGachaPools 过滤。
 * @param {string} dir - 临时数据根目录
 * @returns {string} data/ark 目录路径
 */
export function writeArkTables(dir) {
  const arkDir = path.join(dir, 'data', 'ark');
  fs.mkdirSync(arkDir, { recursive: true });

  const characters = {
    'char_701_sp': { name: '归溟幽灵鲨', appellation: '归溟幽灵鲨', rarity: 'TIER_6', profession: 'SPECIAL', isSpChar: true, description: '<span>异格干员</span>' },
    'char_141_night': { name: '能天使', appellation: '能天使', rarity: 'TIER_6', profession: 'SNIPER' },
    'char_502_amiya': { name: '阿米娅', appellation: '阿米娅', rarity: 'TIER_5', profession: 'CASTER' },
    'char_503_texas': { name: '德克萨斯', appellation: '德克萨斯', rarity: 'TIER_5', profession: 'PIONEER' },
    'char_401_pod': { name: '波登可', appellation: '波登可', rarity: 'TIER_4', profession: 'MEDIC' },
    'char_301_melan': { name: '玫兰莎', appellation: '玫兰莎', rarity: 'TIER_3', profession: 'WARRIOR' },
    'char_prep_melee': { name: '预备干员-近战', appellation: '预备干员', rarity: 'TIER_3', profession: 'WARRIOR', isNotObtainable: true },
    'char_tok_fist': { name: '铁拳卫', appellation: '', rarity: 'TIER_3', profession: 'TRAP' },
    'char_bday_today': { name: '生日测试员', appellation: '生日测试员', rarity: 'TIER_3', profession: 'WARRIOR' },
  };
  fs.writeFileSync(path.join(arkDir, 'character_table.json'), JSON.stringify(characters));

  // 档案 storyText 以【小节名】单行值结构承载（ArkDB._extractProfile 的正则消费面）
  const handbook = (charID, infoName, { gender = '男', birthday = '1月1日', race = '鲁珀' } = {}) => ({
    charID,
    infoName,
    storyTextAudio: [{ stories: [{ storyText: `【代号】${infoName}\n【性别】${gender}\n【生日】${birthday}\n【种族】${race}\n【身高】160cm` }] }],
  });
  const handbooks = {
    'char_141_night': handbook('char_141_night', '能天使', { birthday: '5月25日' }),
    'char_502_amiya': handbook('char_502_amiya', '阿米娅', { gender: '女', birthday: '12月23日' }),
    'char_401_pod': handbook('char_401_pod', '波登可', { gender: '女' }),
    'char_bday_today': handbook('char_bday_today', '生日测试员', { gender: '女', birthday: todayLabel() }),
  };
  fs.writeFileSync(path.join(arkDir, 'handbook_info_table.json'), JSON.stringify({ handbookDict: handbooks }));

  // 藏品：RELIC 节点埋在多层（group → rewards → entries），混入非 RELIC 节点
  const relics = {
    general: {
      groupName: '通用组',
      rewards: {
        entries: [
          { type: 'NOT_RELIC', name: '应被过滤' },
          { type: 'RELIC', name: '高卢银行支票', usage: '部署费用-2，再部署时间-15%', description: '高卢的遗产，银行的金库深处。' },
          { type: 'RELIC', name: '策略之眼', usage: '初始技力+6', description: '看穿一切战术的眼睛。' },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(arkDir, 'roguelike_topic_table.json'), JSON.stringify(relics));

  const gachaPools = [
    {
      gachaPoolId: 'pool_open_1',
      gachaPoolName: '深池纪念',
      gachaRuleType: '限定寻访',
      dynMeta: {
        main6RarityCharId: 'char_141_night',
        rare5CharList: ['char_502_amiya'],
      },
    },
    {
      gachaPoolId: 'pool_open_2',
      gachaPoolName: '愚人号',
      dynMeta: {
        main6RarityCharId: 'char_701_sp',
        rare5CharList: ['char_503_texas'],
      },
    },
    { gachaPoolId: 'pool_closed', gachaPoolName: '已关闭池', endTime: 1000, dynMeta: {} },
    { gachaPoolId: 'pool_future', gachaPoolName: '未来池', openTime: 2_000_000_000, dynMeta: {} },
  ];
  fs.writeFileSync(path.join(arkDir, 'gacha_table.json'), JSON.stringify({ gachaPoolClient: gachaPools }));

  return arkDir;
}
