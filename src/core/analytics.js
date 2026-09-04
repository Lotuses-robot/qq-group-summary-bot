/**
 * SQLite 消息分析层。
 *
 * 职责：把 JSONL 消息镜像进 data/messages.db（node:sqlite 同步接口），提供活跃榜、
 * 群统计等聚合查询——按天分片的 JSONL 不适合这类全量聚合扫描。首次任一查询/写入时
 * _ensureImported 会把 data/messages/ 下全部 JSONL 惰性整库导入（INSERT OR IGNORE，
 * 靠 UNIQUE(group_id, msg_id) 去重；同步全量扫描，首次消息事件可能阻塞数百 ms）。
 * 库内两张表：messages（消息镜像）与 pulls（抽卡记录）；表结构与容错行为
 * 详见 docs/data-format.md §3（库文件损坏时构造即抛 → 启动崩溃，仅 countMessages
 * 单独有 try 兜底返回 0）。
 *
 * 对外导出：类 Analytics，仅在 src/index.js 被 new 一次
 * （dbPath = data/messages.db，messagesDir = data/messages）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

/**
 * 消息分析层（基于 SQLite）：从 JSONL 一次性导入，之后每条新消息实时记录；
 * 用于活跃榜、群统计等聚合查询（JSONL 不适合此类查询）。
 *
 * 惰性导入（_ensureImported，幂等）、表结构与容错行为见 data-format.md §3。
 */
export class Analytics {
  /**
   * 打开（不存在则创建）SQLite 库并建表建索引（CREATE IF NOT EXISTS，幂等）。
   * 注意：库文件损坏时本构造直接抛错 → 进程启动崩溃（已知行为，见 data-format.md §3）。
   * @param {string} dbPath - 库文件路径（如 data/messages.db；父目录自动创建）
   * @param {string} messagesDir - 消息归档目录（data/messages），惰性导入的数据源
   */
  constructor(dbPath, messagesDir) {
    this.dbPath = dbPath;
    this.messagesDir = messagesDir;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        time INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        UNIQUE(group_id, msg_id)
      );
      CREATE INDEX IF NOT EXISTS idx_time ON messages(time);
      CREATE INDEX IF NOT EXISTS idx_group_user ON messages(group_id, user_id);
      CREATE TABLE IF NOT EXISTS pulls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL,
        pool_name TEXT NOT NULL DEFAULT '',
        star TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL DEFAULT '',
        is_up INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pulls_group_user ON pulls(group_id, user_id);
    `);
    } catch (err) {
      // 建表失败（典型：库文件损坏）时先关掉已打开的句柄再抛——「构造即抛」的对外
      // 行为不变，但避免 Windows 上残留句柄占住 dbPath 文件（node:sqlite 句柄
      // 不会随引用丢失自动释放，只能显式 close 或等进程退出）
      try { this.db.close(); } catch { /* 忽略 */ }
      throw err;
    }
    this._imported = false;
  }

  // 首次使用时从 JSONL 归档导入（幂等：UNIQUE 约束去重）
  _ensureImported() {
    if (this._imported) return;
    this._imported = true;
    try {
      const dirs = fs.existsSync(this.messagesDir) ? fs.readdirSync(this.messagesDir) : [];
      let total = 0;
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO messages (group_id, msg_id, time, user_id, name, text) VALUES (?,?,?,?,?,?)'
      );
      for (const gid of dirs) {
        const gdir = path.join(this.messagesDir, gid);
        if (!fs.statSync(gdir).isDirectory()) continue;
        for (const f of fs.readdirSync(gdir)) {
          if (!f.endsWith('.jsonl')) continue;
          const lines = fs.readFileSync(path.join(gdir, f), 'utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              stmt.run(String(gid), String(r.id), r.time ?? 0, String(r.userId ?? ''), r.name ?? '', r.text ?? '');
              total++;
            } catch { /* skip bad line */ }
          }
        }
      }
      if (total > 0) log(`[analytics] 已从 JSONL 导入 ${total} 条消息到 SQLite`);
    } catch (e) {
      log(`[analytics] 导入失败: ${e.message}`);
    }
  }

  /**
   * 实时镜像一条已落盘的消息进 SQLite（index.js 在 store.addMessage /
   * addHistoryMessage 成功后调用，backfill 循环与实时事件两处）。
   * 首次调用会先触发 _ensureImported 整库导入，可能阻塞数百 ms。
   * @param {string} groupId - 群号
   * @param {Object} rec - store 的记录 {id, time, userId, name, text}（缺字段各自有默认）
   * @returns {void}
   * 副作用: INSERT OR IGNORE 进 messages 表；重复 (群, msg_id) 与写失败均静默
   */
  record(groupId, rec) {
    this._ensureImported();
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO messages (group_id, msg_id, time, user_id, name, text) VALUES (?,?,?,?,?,?)'
      ).run(String(groupId), String(rec.id), rec.time ?? 0, String(rec.userId ?? ''), rec.name ?? '', rec.text ?? '');
    } catch { /* 忽略写入失败 */ }
  }

  /**
   * 「最近 N 天活跃榜」文案（群内指令输出，可直接发；指令插件调用）。
   * 窗口 = now - days×86400 秒；按 user_id 分组计数，排除空名与 '未知'，取前 10。
   * @param {number} [days=7] - 统计窗口天数
   * @returns {string} 榜单文案；窗口内无消息时返回提示语
   */
  topActive(days = 7) {
    this._ensureImported();
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db.prepare(
      `SELECT name, COUNT(*) AS cnt FROM messages WHERE time >= ? AND name != '' AND name != '未知'
       GROUP BY user_id ORDER BY cnt DESC LIMIT 10`
    ).all(since);
    if (!rows.length) return `最近 ${days} 天没有消息记录`;
    return `【最近 ${days} 天活跃榜】\n` + rows.map((r, i) => `${i + 1}. ${r.name}（${r.cnt} 条）`).join('\n');
  }

  /**
   * 库内消息总行数（Web 管理面板的统计用，见 index.js 状态接口）。
   * @returns {number} 总条数；查询异常（如库文件损坏）时返回 0 而非抛错
   */
  countMessages() {
    try {
      return this.db.prepare('SELECT COUNT(*) AS c FROM messages').get()?.c ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * 「群消息统计」文案（群内指令输出，可直接发；指令插件调用）。
   * 按群消息量降序，附每群总数与最近活跃距今天数。
   * @returns {string} 统计文案；库内无任何记录时返回 '暂无消息统计'
   */
  groupStats() {
    this._ensureImported();
    const rows = this.db.prepare(
      `SELECT group_id, COUNT(*) AS cnt, MAX(time) AS last FROM messages GROUP BY group_id ORDER BY cnt DESC`
    ).all();
    if (!rows.length) return '暂无消息统计';
    const now = Math.floor(Date.now() / 1000);
    return '【群消息统计】\n' + rows.map((r) => {
      const days = Math.floor((now - r.last) / 86400);
      return `群 ${r.group_id}：${r.cnt} 条（最近活跃 ${days} 天前）`;
    }).join('\n');
  }

  // ---- 抽卡记录 ----
  /**
   * 追加一条抽卡记录（指令插件在真实抽卡完成后调用），供「我的抽卡记录」
   * 与「欧气榜」查询。
   * @param {string} groupId - 群号
   * @param {string} userId - QQ 号
   * @param {string} userName - 展示名（可为空串，落库默认为 ''）
   * @param {string} poolName - 卡池名
   * @param {string} star - 星级文本（形如 '★★★★★★'）
   * @param {string} operator - 抽到的干员名
   * @param {boolean} isUp - 是否该卡池 UP 干员（落库转 0/1）
   * @returns {void}
   * 副作用: INSERT 进 pulls 表；写失败静默，不打断抽卡主流程
   */
  recordPull(groupId, userId, userName, poolName, star, operator, isUp) {
    try {
      this.db.prepare(
        'INSERT INTO pulls (group_id, user_id, name, time, pool_name, star, operator, is_up) VALUES (?,?,?,?,?,?,?,?)'
      ).run(String(groupId), String(userId), userName || '', Math.floor(Date.now() / 1000), poolName || '', star || '', operator || '', isUp ? 1 : 0);
    } catch { /* 忽略 */ }
  }

  /**
   * 某人在某群的抽卡汇总与最近记录（指令插件「我的抽卡记录」指令调用）。
   * 星级判定按文案包含的 ★ 个数：六星 = star 含 '★★★★★★'；五星 = 含 5 个★但
   * 不含 6 个★（★ 都落在连续串里，两种 LIKE 足以区分）。
   * @param {string} groupId - 群号
   * @param {string} userId - QQ 号
   * @param {number} [limit=10] - 明细条数上限（最新在前，id DESC）
   * @returns {Object} {rows: 明细数组, total, six, five}，三个计数均为 number
   */
  myPulls(groupId, userId, limit = 10) {
    const rows = this.db.prepare(
      'SELECT pool_name, star, operator, is_up, time FROM pulls WHERE group_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?'
    ).all(String(groupId), String(userId), limit);
    const total = this.db.prepare(
      'SELECT COUNT(*) AS c FROM pulls WHERE group_id = ? AND user_id = ?'
    ).get(String(groupId), String(userId))?.c ?? 0;
    const six = this.db.prepare(
      `SELECT COUNT(*) AS c FROM pulls WHERE group_id = ? AND user_id = ? AND star LIKE '%★★★★★★%'`
    ).get(String(groupId), String(userId))?.c ?? 0;
    const five = this.db.prepare(
      `SELECT COUNT(*) AS c FROM pulls WHERE group_id = ? AND user_id = ? AND star LIKE '%★★★★★%' AND star NOT LIKE '%★★★★★★%'`
    ).get(String(groupId), String(userId))?.c ?? 0;
    return { rows, total, six, five };
  }

  /**
   * 群内「欧气榜」行数据（指令插件取到后拼榜单一并发群）。
   * 排序：六星数降序 → 总抽数降序，取前 10。
   * @param {string} groupId - 群号
   * @returns {Object[]} 行数组 [{name, user_id, total, six}]；该群无抽卡记录时为空数组
   */
  luckiest(groupId) {
    const rows = this.db.prepare(
      `SELECT name, user_id, COUNT(*) AS total,
              SUM(CASE WHEN star LIKE '%★★★★★★%' THEN 1 ELSE 0 END) AS six
       FROM pulls WHERE group_id = ?
       GROUP BY user_id HAVING total > 0 ORDER BY six DESC, total DESC LIMIT 10`
    ).all(String(groupId));
    return rows;
  }
}
