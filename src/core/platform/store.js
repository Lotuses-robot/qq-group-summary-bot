/**
 * 消息持久化层与文本工具。
 *
 * 职责：把 OneBot 实时群消息事件与 backfill 拉回的历史消息统一归一成纯文本记录，
 * 追加写入 data/messages/<群号>/<YYYY-MM-DD>.jsonl，并按群缓存在内存
 * （messages/users/lastSummaryAt）；另维护两份状态文件：data/state/<群号>.json
 * （每群最后概括时间）与 data/state/lastSeen.json（各群 lastSeen 水位，backfill 按群起点；
 * 2026-09 由全局单值改为 per-group，见 docs/data-format.md §2）。文件布局与行格式
 * 详见 docs/data-format.md §1-2。
 *
 * 对外导出：纯函数 segmentToText / extractText / localDate / hhmm / fmtFull，
 * 以及类 MessageStore（仅由 core/runtime.js 的 createApp 装配一次，进程级单实例共享）。
 * 时间戳单位约定：消息记录统一用「秒」；纯函数里 localDate 的入参是毫秒，
 * hhmm 的入参是秒（与消息 time 字段一致），勿混用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

/**
 * 单个 OneBot 消息段（{type, data}）→ 展示用纯文本。
 * 图片/语音等不可文本化的类型返回固定的中括号占位符（[图片] 等），保证落盘与
 * 喂给 LLM 的永远是纯文本形态；未知类型优先取 data.text，取不到回退 [<type>]。
 * @param {Object} seg - CQ 消息段；非对象或为空返回 ''
 * @returns {string} 纯文本或占位符串
 */
export function segmentToText(seg) {
  if (!seg || typeof seg !== 'object') return '';
  const d = seg.data || {};
  switch (seg.type) {
    case 'text': return d.text ?? '';
    case 'face': return '[表情]';
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.name || d.qq || ''}`;
    case 'reply': return '[回复消息]';
    case 'forward': return '[合并转发]';
    case 'json': return '[卡片消息]';
    case 'dice': return '[骰子]';
    case 'poke': return '[戳一戳]';
    case 'redbag': return '[红包]';
    case 'shake': return '[窗口抖动]';
    default: return d.text ? String(d.text) : `[${seg.type}]`;
  }
}

/**
 * 把一条消息归一成纯文本：字符串原样返回；段数组逐段 segmentToText 拼接后 trim。
 * addMessage / addHistoryMessage 落盘前都先经此归一。
 * @param {string|Object[]} message - 纯文本，或 OneBot message 段数组
 * @returns {string} 归一化纯文本（纯图片/表情消息可能为 ''）
 */
export function extractText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.map(segmentToText).join('').trim();
}

/**
 * 毫秒时间戳 → 本地时区日期串 "YYYY-MM-DD"，即 JSONL 按天分片的文件名日期，
 * 也是 loadFromDisk 翻文件的日期游标单位。注意入参单位是毫秒。
 * @param {number} tsMs - 毫秒级时间戳
 * @returns {string} 形如 "2024-01-05"
 */
export function localDate(tsMs) {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 秒级时间戳 → 本地时区时刻串 "HH:mm"，做消息行前缀 "[HH:mm] 昵称: 文本" 用。
 * 与 localDate 相反：入参单位是秒（与消息记录里的 time 字段一致）。
 * @param {number} ts - 秒级时间戳
 * @returns {string} 形如 "08:30"
 */
export function hhmm(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Date 对象 → 完整时刻串 "YYYY-MM-DD HH:mm"，日志与「时间范围描述」文案用
 * （plugins/summary.js 的 span 文案与 core/routing.js 的 backfill 日志即由它拼出）。
 * @param {Date} d - Date 对象
 * @returns {string} 形如 "2024-01-05 08:30"
 */
export function fmtFull(d) {
  return `${localDate(d.getTime())} ${hhmm(Math.floor(d.getTime() / 1000))}`;
}

/**
 * 消息仓库：内存缓存 + JSONL/状态文件双份持久化，进程内单实例使用。
 * 单条记录形状 {id, time, userId, name, card, text}（详见 data-format.md §1）：
 * id = 消息 message_id 字符串；time = 秒；name = card||nickname||'未知'；
 * card = 群名片原始值（可为空串）；text = 纯文本。
 */
export class MessageStore {
  /**
   * 建好 messages/ 与 state/ 子目录（recursive，已存在不报错）并恢复各群 lastSeen 水位。
   * @param {string} dataDir - 数据根目录（config.dataDir）
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.msgsDir = path.join(dataDir, 'messages');
    this.stateDir = path.join(dataDir, 'state');
    fs.mkdirSync(this.msgsDir, { recursive: true });
    fs.mkdirSync(this.stateDir, { recursive: true });
    // 已知群集合：出现过/加载过的群都会登记；backfill 补偿与日报遍历无配置时靠它枚举群
    this.groupIds = new Set();
    // 每群内存态：messages 按消息 id 索引（该群消息全量常驻内存）；
    // users 群成员名片缓存（userId → {name, card}）；lastSummaryAt 最后概括时间（秒，0 = 从未概括）
    this.groups = new Map();
    // 已写盘闸 "群号:消息id"：防同一条消息重复追加 JSONL。只增不减——一旦写入终身有效；
    // 重启后由 loadFromDisk 扫盘逐行重建，保证跨进程幂等
    this.writtenIds = new Set();
    // 各群最后在线时间（秒，群号 String 归一）：backfill 补偿按群的起点水位（见
    // docs/architecture.md §6.1）。每群只增不减——水位回退会让重启补偿重复拉回已见过的消息；
    // 群间独立——单群拉取失败不会推高别群起点（2026-09 修复坑 9：原为全局单值，失败群
    // 缺口会被其他群推高的水位永久错过）
    this.lastSeenByGroup = new Map();
    // v1 旧形状（{"lastSeenTs": n}）读入时的进程内回退值：本次启动新出现的群在
    // 首写 v2 文件前都按它起水位；v2 文件已存在时恒 0（见 _loadLastSeen）
    this._legacyV1 = 0;
    this._loadLastSeen();
  }

  // lastSeen 状态文件路径：data/state/lastSeen.json（v2 形状 {"byGroup": {群号: 秒}}）
  _lastSeenFile() {
    return path.join(this.stateDir, 'lastSeen.json');
  }

  // v1→v2 迁移播种来源：扫 messages/ 顶层群目录（目录 = 磁盘上出现过的群）。
  // 构造期调用（此时 msgsDir 已 mkdir 好、尚无消息写入），一次 readdir 开销可忽略
  _seedGroupDirs() {
    try {
      return fs.readdirSync(this.msgsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  // 启动恢复各群 lastSeen（data/state/lastSeen.json）：
  // - v2 形状 {"byGroup": {...}}：逐群载入（键 String 归一，非数字值丢弃）；
  // - 旧 v1 形状 {"lastSeenTs": n}（无 byGroup 字段）：迁移播种——msgsDir 下每个已知群
  //   目录都按 n 起水位，并保留 _legacyV1=n 供本进程新出现的群回退（首次 set 落盘即转 v2）；
  // - 文件缺失或解析失败一律按空（后果：backfill 起点退化为 now − maxHours，
  //   即拉满补偿窗口，见 data-format.md §2）
  _loadLastSeen() {
    try {
      const f = this._lastSeenFile();
      if (!fs.existsSync(f)) return;
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      const byGroup = data.byGroup && typeof data.byGroup === 'object' ? data.byGroup : null;
      if (byGroup) {
        // v2 形状优先：即便文件里还残留 v1 的 lastSeenTs 冗余键也忽略（v2 更晚、覆盖 v1）
        for (const [k, v] of Object.entries(byGroup)) {
          if (typeof v === 'number') this.lastSeenByGroup.set(String(k), v);
        }
      } else if (typeof data.lastSeenTs === 'number') {
        this._legacyV1 = data.lastSeenTs;
        for (const name of this._seedGroupDirs()) this.lastSeenByGroup.set(name, data.lastSeenTs);
      }
    } catch {
      /* 损坏一律按空 */
    }
  }

  /**
   * 读某群最后在线时间（该群 backfill 补偿拉取的起点水位，见 core/routing.js
   * backfillHistory）。群号以 String 归一——number/string 群号读写等价，跨重启不丢。
   * @param {string|number} groupId - 群号
   * @returns {number} 秒级时间戳；从未在线/状态文件缺失损坏为 0；v1 迁移后进程内
   *   新出现的群回退旧单值
   */
  getLastSeenTs(groupId) {
    return this.lastSeenByGroup.get(String(groupId)) ?? this._legacyV1 ?? 0;
  }

  /**
   * 推进某群最后在线时间并落盘（每群取 max，单调不回退；群间水位互不影响）。
   * addMessage 每次落盘后都会调用；backfill 在该群整轮补偿结束后由 core/routing.js
   * 按群调用（见 data-format.md §2「addMessage 与 backfill 写入」）。
   * @param {string|number} groupId - 群号（String 归一存储）
   * @param {number} ts - 秒级时间戳（通常取刚落盘消息的 time）
   * @returns {void}
   * 副作用: 覆盖写 data/state/lastSeen.json（v2 {"byGroup"} 形状，含全部已记录群）；
   *   写失败静默忽略，内存值已先行推进
   */
  setLastSeenTs(groupId, ts) {
    const key = String(groupId);
    const cur = this.lastSeenByGroup.get(key) ?? this._legacyV1 ?? 0;
    this.lastSeenByGroup.set(key, Math.max(cur, ts));
    try {
      fs.writeFileSync(this._lastSeenFile(), JSON.stringify({ byGroup: Object.fromEntries(this.lastSeenByGroup) }));
    } catch {
      /* 忽略 */
    }
  }

  // 取群内存态（惰性建默认结构）——各公开方法的统一入口
  _group(groupId) {
    if (!this.groups.has(groupId)) {
      this.groups.set(groupId, { messages: new Map(), users: new Map(), lastSummaryAt: 0 });
    }
    return this.groups.get(groupId);
  }

  // JSONL 路径模板：data/messages/<群号>/<YYYY-MM-DD>.jsonl（按天分片，追加写）
  _fileFor(groupId, dateStr) {
    return path.join(this.msgsDir, String(groupId), `${dateStr}.jsonl`);
  }

  // 每群状态文件：data/state/<群号>.json，内容 {"lastSummaryAt": 秒}
  _stateFile(groupId) {
    return path.join(this.stateDir, `${groupId}.json`);
  }

  /**
   * 从磁盘按天把某群 [startTs, endTs) 时段的消息载入内存（同步），并顺带恢复该群
   * lastSummaryAt。两参都省略时只扫今天（core/runtime.js createApp 装配期预载路径）；日报按时间段传参。
   * 文件逐行解析：坏行跳过；同一文件内重复行会被剔除，发现重复/坏行时整文件重写
   * 去重一次（日志「已去重」）；载入的每条消息同时登记进 writtenIds
   * （重启后以此重建「防重复写」闸，见 data-format.md §1）。
   * @param {string} groupId - 群号
   * @param {number|null} [startTs=null] - 起始秒级时间戳（含），文件覆盖到其当天；null 视为今天
   * @param {number|null} [endTs=null] - 结束秒级时间戳（不含），文件覆盖到 endTs-1 当天；null 视为今天
   * @returns {Object} 该群内存态句柄 {messages, users, lastSummaryAt}（此后增删都反映在该对象上）
   * 副作用: 发现重复/坏行时重写对应日期 JSONL 文件
   */
  loadFromDisk(groupId, startTs = null, endTs = null) {
    const g = this._group(groupId);
    this.groupIds.add(groupId);

    const startDate = startTs ? localDate(startTs * 1000) : localDate(Date.now());
    const endDate = endTs ? localDate((endTs - 1) * 1000) : localDate(Date.now());

    // 日期游标逐天翻文件（含 startTs 当天到 endTs-1 当天，闭区间）
    let dateCursor = new Date(startDate + 'T00:00:00');
    const endDateObj = new Date(endDate + 'T00:00:00');
    let loaded = 0;

    while (dateCursor <= endDateObj) {
      const ds = localDate(dateCursor.getTime());
      const file = this._fileFor(groupId, ds);
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const seen = new Set();
        const uniqueLines = [];
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            if (!seen.has(rec.id)) {
              seen.add(rec.id);
              uniqueLines.push(line);
              g.messages.set(rec.id, rec);
              this.writtenIds.add(`${groupId}:${rec.id}`);
              this._learnUser(g, rec);
              loaded++;
            }
          } catch {
            /* 忽略损坏行 */
          }
        }
        // 存在重复或坏行：整文件重写为规范形态（每行唯一且可解析），保文件可重读
        if (uniqueLines.length !== lines.length) {
          fs.writeFileSync(file, uniqueLines.join('\n') + (uniqueLines.length ? '\n' : ''));
          log(`[store] 群 ${groupId} 文件 ${ds}.jsonl 已去重 (${lines.length} -> ${uniqueLines.length} 行)`);
        }
      }
      dateCursor.setDate(dateCursor.getDate() + 1);
    }

    if (loaded > 0) log(`[store] 群 ${groupId} 已从磁盘加载 ${loaded} 条消息 (${startDate} ~ ${endDate})`);

    const sf = this._stateFile(groupId);
    if (fs.existsSync(sf)) {
      try {
        g.lastSummaryAt = JSON.parse(fs.readFileSync(sf, 'utf8')).lastSummaryAt ?? 0;
      } catch {
        g.lastSummaryAt = 0;
      }
    }
    return g;
  }

  // 学习/更新群成员名片缓存：rec.card 非空且与缓存不一致时以新群名片为准（同步覆盖 name）；
  // 首次见到的用户按 姓名 + 名片(缺省用姓名) 建档
  _learnUser(g, rec) {
    if (!rec.userId || !rec.name) return;
    const u = g.users.get(rec.userId);
    if (u && rec.card && u.card !== rec.card) {
      u.card = rec.card;
      u.name = rec.card || rec.name;
      return;
    }
    if (!u) g.users.set(rec.userId, { name: rec.name, card: rec.card || rec.name });
  }

  /**
   * 落一条实时群消息（OneBot group_message 事件）→ 归一为记录 → 内存 + JSONL 追加。
   * 图片/表情等段会以 [图片] 等占位符形态正常入库；仅当归一文本为空串
   * （空消息段数组且无 raw_message）或该 (群, 消息id) 已写盘过时返回 null，且不落任何文件。
   * @param {Object} event - OneBot 群消息事件；用到的字段：group_id、message_id、user_id、
   *   time（缺省取当前秒）、message（段数组）、raw_message、sender.card/nickname
   * @returns {Object|null} 新记录 {id, time, userId, name, card, text}；
   *   返回 null 表示消息未入库（空文本或重复），下游无需再处理该消息
   * 副作用: 同步 appendFileSync 追加当天 JSONL（写失败向上抛，会中断该消息路由——
   *   现状行为勿"修复"，见 data-format.md §1）；更新内存态、推进 lastSeenTs、学名片
   */
  addMessage(event) {
    const g = this._group(event.group_id);
    this.groupIds.add(event.group_id);
    const text = extractText(event.message) || event.raw_message || '';
    if (!text) return null;
    const rec = {
      id: String(event.message_id),
      time: event.time ?? Math.floor(Date.now() / 1000),
      userId: event.user_id,
      name: event.sender?.card || event.sender?.nickname || '未知',
      card: event.sender?.card || '',
      text,
    };
    if (this.writtenIds.has(`${event.group_id}:${rec.id}`)) return null;
    return this._commit(event.group_id, g, rec, { touchLastSeen: true });
  }

  /**
   * 落一条 backfill 拉回的历史消息（get_group_msg_history 的消息项）。字段命名兼容
   * 两种来源：message_id/msgId、time/msgTime、user_id/sender.user_id（详见
   * external-apis.md §1 响应形状）。无 id / 文本为空 / 内存已有 / 已写盘过 → 返回 null。
   * 与 addMessage 不同：本方法不推进该群 lastSeen——历史补偿不应挪动在线水位，
   * 由 core/routing.js 的 backfillHistory 在整轮结束后按该群最新一条统一 setLastSeenTs。
   * @param {string} groupId - 群号
   * @param {Object} msg - 历史消息对象（结构见 data-format.md §1 记录形状）
   * @returns {Object|null} 新记录；id 缺失/文本为空/重复时返回 null
   * 副作用: 同步追加对应日期 JSONL；更新内存态与群名片缓存
   */
  addHistoryMessage(groupId, msg) {
    const g = this._group(groupId);
    this.groupIds.add(groupId);
    const id = String(msg.message_id ?? msg.msgId ?? '');
    if (!id) return null;
    if (g.messages.has(id)) return null;

    const text = extractText(msg.message) || msg.raw_message || '';
    if (!text) return null;
    const rec = {
      id,
      time: msg.time ?? msg.msgTime ?? Math.floor(Date.now() / 1000),
      userId: msg.user_id ?? msg.sender?.user_id ?? 0,
      name: msg.sender?.card || msg.sender?.nickname || '未知',
      card: msg.sender?.card || '',
      text,
    };
    if (this.writtenIds.has(`${groupId}:${rec.id}`)) return null;
    return this._commit(groupId, g, rec);
  }

  // 内部：两条落库路径共用的尾部（addMessage 实时事件 / addHistoryMessage 历史补偿）——
  // 写前查重 → 登记内存态 → 学名片 → JSONL 追加；touchLastSeen=true 时推进该群 lastSeen
  // （addMessage 用；历史补偿不移在线水位，见 addHistoryMessage 的 JSDoc）
  _commit(groupId, g, rec, { touchLastSeen = false } = {}) {
    if (this.writtenIds.has(`${groupId}:${rec.id}`)) return null;
    g.messages.set(rec.id, rec);
    this.writtenIds.add(`${groupId}:${rec.id}`);
    this._learnUser(g, rec);
    if (touchLastSeen) this.setLastSeenTs(groupId, rec.time);
    const file = this._fileFor(groupId, localDate(rec.time * 1000));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return rec;
  }

  /**
   * 收集某群 time 严格大于 sinceTs 的内存消息，按 (time, id) 稳定升序。
   * doSummary 的增量概括窗口即由它实现（since = getLastSummaryAt，0 时调用方
   * 会退化为 now-1h，见 plugins/summary.js doSummary）。只覆盖已载入内存的消息，
   * 使用前需先 loadFromDisk。
   * @param {string} groupId - 群号
   * @param {number} sinceTs - 起始秒级时间戳（不含）
   * @returns {Object[]} 升序记录数组（可能为空）
   */
  collectSince(groupId, sinceTs) {
    const g = this._group(groupId);
    const recs = [...g.messages.values()].filter((r) => r.time > sinceTs);
    recs.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return recs;
  }

  /**
   * 收集某群 [startTs, endTs) 半开区间内的内存消息，按 (time, id) 稳定升序。
   * 日报用（昨日全天：昨天 0 点 ~ 今天 0 点，见 plugins/report.js dailyReport）。
   * 只覆盖已载入内存的消息，使用前需先 loadFromDisk。
   * @param {string} groupId - 群号
   * @param {number} startTs - 区间起点（秒，含）
   * @param {number} endTs - 区间终点（秒，不含）
   * @returns {Object[]} 升序记录数组（可能为空）
   */
  collectRange(groupId, startTs, endTs) {
    const g = this._group(groupId);
    const recs = [...g.messages.values()].filter((r) => r.time >= startTs && r.time < endTs);
    recs.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return recs;
  }

  /**
   * 读某群最后概括时间（秒），doSummary 以它为增量概括窗口的起点
   * （返回 0 时 doSummary 会退化为起点 = now-1h，见 plugins/summary.js doSummary）。
   * @param {string} groupId - 群号
   * @returns {number} 秒级时间戳；从未概括/状态文件缺失损坏为 0
   */
  getLastSummaryAt(groupId) {
    return this._group(groupId).lastSummaryAt;
  }

  /**
   * 记录某群概括完成时间并落盘。约定只在概括消息发送成功后调用（plugins/summary.js
   * doSummary 在 sendGroupMsg 之后执行）——失败不推进，下次触发会重新覆盖该时段；
   * 手动删除 data/state/<群号>.json 即可强制重新概括（见 data-format.md §2）。
   * @param {string} groupId - 群号
   * @param {number} ts - 秒级时间戳（当前时刻）
   * @returns {void}
   * 副作用: 覆盖写 data/state/<群号>.json（本方法未包 try，写失败会向上抛）
   */
  setLastSummaryAt(groupId, ts) {
    const g = this._group(groupId);
    g.lastSummaryAt = ts;
    fs.writeFileSync(this._stateFile(groupId), JSON.stringify({ lastSummaryAt: ts }));
  }

  /**
   * 返回全部已知群号（内存出现过 + loadFromDisk 扫过）。backfill（core/routing.js）与
   * report/refresh 插件遍历群时，若配置里没有显式群列表，以它作枚举兜底。
   * @returns {string[]} 群号数组（副本快照，改它不影响内部状态）
   */
  trackedGroupIds() {
    return [...this.groupIds];
  }
}
