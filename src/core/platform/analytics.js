/**
 * SQLite 消息分析层。
 *
 * 职责：把 JSONL 消息镜像进 data/messages.db（node:sqlite 同步接口），提供活跃榜、
 * 群统计等聚合查询——按天分片的 JSONL 不适合这类全量聚合扫描。历史 JSONL 由公开的
 * importHistory() 后台整库导入（INSERT OR IGNORE，靠 UNIQUE(group_id, msg_id) 去重；
 * 约每 1000 行一组事务、组间 setImmediate 让出事件循环——2026-09 修复坑 5：原
 * _ensureImported 在首次写/查时同步全量扫描导入，首条消息事件可能阻塞数百 ms）。
 * 实时 record 只做单行 INSERT，不再触发任何导入（导入归 runtime.start() 统一启动，
 * 状态机 importState: idle → running → done；WebUI 状态行与统计指令按 'running' 提示）。
 * 库内两张表：messages（消息镜像）与 pulls（抽卡记录）；表结构与容错行为
 * 详见 docs/data-format.md §3（库文件损坏时构造即抛 → 启动崩溃，仅 countMessages
 * 单独有 try 兜底返回 0）。
 *
 * 对外导出：类 Analytics，仅由 core/runtime.js 的 createApp 装配一次
 * （dbPath = data/messages.db，messagesDir = data/messages）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

// messages 表镜像 INSERT（importHistory 的批次导入 _importFile 与 record 实时镜像共用同一语句）
const INSERT_MSG_SQL = 'INSERT OR IGNORE INTO messages (group_id, msg_id, time, user_id, name, text) VALUES (?,?,?,?,?,?)';

/**
 * 消息分析层（基于 SQLite）：历史 JSONL 由 importHistory()（runtime.start() 触发）
 * 整库导入，之后每条新消息实时记录；用于活跃榜、群统计等聚合查询（JSONL 不适合此类查询）。
 *
 * 导入状态机 importState（idle/running/done）与容错行为见 data-format.md §3；
 * record/topActive/groupStats 均不触发导入。
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
    this.importState = 'idle';
    // 共享导入 promise：'running' 与 'done' 后重复调用返回同一实例——进程内只跑一轮，
    // 重启才重新评估（INSERT OR IGNORE 幂等，重跑不产生重复行）
    this._importPromise = null;
  }

  /**
   * 后台整库导入 data/messages/ 下全部 JSONL（2026-09 修复坑 5：替代旧 record/
   * topActive/groupStats 里的同步惰性 _ensureImported——现由 runtime.start() 在
   * connect 前异步触发，不阻塞消息热路径）。
   *
   * 容错与并发：按 群目录 × 日期文件 × 行 三巡；坏 JSON 行跳过；单文件读取失败记日志
   * 继续其余文件；约每 1000 行一组事务（BEGIN/COMMIT），组间让出事件循环；批异常
   * 记日志后继续。实时 record 与导入共用同一 db 句柄（单进程同步 API）：批次内
   * BEGIN→COMMIT 全程同步不中途让出，record 只可能落在批间（autocommit 直写），
   * 不存在混入未提交事务窗口的情况；批次提交失败回滚的只是该批历史行，幂等留待
   * 下次进程启动整库重导自愈。
   *
   * 状态机：'idle'（未启动）→ 'running' → 'done'（finally 恒置位，含整体异常路径）；
   * countMessages() 不触发导入（文档语义：仅计数），导入中返回部分行数。
   * @returns {Promise<void>} 完成即 resolve（内部已吞全部失败仅记日志）
   */
  importHistory() {
    if (this._importPromise) return this._importPromise;
    this.importState = 'running';
    this._importPromise = (async () => {
      let total = 0;
      try {
        const dirs = fs.existsSync(this.messagesDir) ? fs.readdirSync(this.messagesDir) : [];
        for (const gid of dirs) {
          const gdir = path.join(this.messagesDir, gid);
          if (!fs.statSync(gdir).isDirectory()) continue;
          for (const f of fs.readdirSync(gdir)) {
            if (!f.endsWith('.jsonl')) continue;
            try {
              const lines = fs.readFileSync(path.join(gdir, f), 'utf8').split('\n').filter(Boolean);
              total += await this._importFile(String(gid), lines);
            } catch (e) {
              // 单文件级容错：坏文件/读取竞态不中断其余文件（原实现整库中途失败即永远跳过）
              log(`[analytics] 文件 ${f} 导入失败已跳过: ${e.message}`);
            }
          }
        }
        if (total > 0) log(`[analytics] 已从 JSONL 导入 ${total} 条消息到 SQLite`);
      } catch (e) {
        log(`[analytics] 导入失败: ${e.message}`);
      } finally {
        this.importState = 'done';
      }
    })();
    return this._importPromise;
  }

  // 内部：importHistory 的单文件批次单元。约每 1000 行一组事务（BEGIN/COMMIT），
  // 组间 setImmediate 让出事件循环（期间到达的实时消息可经 record 直写）；坏行跳过；
  // 组内单行写失败静默（同旧吞错语义）；批次提交失败回滚整组（组内已 run 的行一并
  // 放弃，幂等留待下次进程启动重导）。返回实际插入行数
  async _importFile(gid, lines) {
    const stmt = this.db.prepare(INSERT_MSG_SQL);
    const BATCH = 1000;
    let inserted = 0;
    let inBatch = 0;
    for (let i = 0; i < lines.length; i++) {
      if (inBatch === 0) this.db.exec('BEGIN');
      inBatch++;
      let r = null;
      try { r = JSON.parse(lines[i]); } catch { /* 坏行跳过 */ }
      if (r) {
        try {
          stmt.run(gid, String(r.id), r.time ?? 0, String(r.userId ?? ''), r.name ?? '', r.text ?? '');
          inserted++;
        } catch { /* 单行写失败静默 */ }
      }
      if (inBatch === BATCH || i === lines.length - 1) {
        try {
          this.db.exec('COMMIT');
        } catch (e) {
          log(`[analytics] 批次提交失败，回滚该批: ${e.message}`);
          try { this.db.exec('ROLLBACK'); } catch { /* 忽略 */ }
        }
        inBatch = 0;
        await new Promise((res) => setImmediate(res));
      }
    }
    return inserted;
  }

  /**
   * 实时镜像一条已落盘的消息进 SQLite（core/routing.js 在 store.addMessage /
   * addHistoryMessage 成功后调用——实时事件（S5）与 backfillHistory 两处）。
   * 纯单行 INSERT，不触发历史整库导入（导入由 runtime.start() 的 importHistory 负责，
   * 见 data-format.md §3）。
   * @param {string} groupId - 群号
   * @param {Object} rec - store 的记录 {id, time, userId, name, text}（缺字段各自有默认）
   * @returns {void}
   * 副作用: INSERT OR IGNORE 进 messages 表；重复 (群, msg_id) 与写失败均静默
   */
  record(groupId, rec) {
    try {
      this.db.prepare(INSERT_MSG_SQL).run(String(groupId), String(rec.id), rec.time ?? 0, String(rec.userId ?? ''), rec.name ?? '', rec.text ?? '');
    } catch { /* 忽略写入失败 */ }
  }

  /**
   * 「最近 N 天活跃榜」文案（群内指令输出，可直接发；指令插件调用）。
   * 窗口 = now - days×86400 秒；按 user_id 分组计数，排除空名与 '未知'，取前 10。
   * @param {number} [days=7] - 统计窗口天数
   * @returns {string} 榜单文案；窗口内无消息时返回提示语
   */
  topActive(days = 7) {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db.prepare(
      `SELECT name, COUNT(*) AS cnt FROM messages WHERE time >= ? AND name != '' AND name != '未知'
       GROUP BY user_id ORDER BY cnt DESC LIMIT 10`
    ).all(since);
    if (!rows.length) return `最近 ${days} 天没有消息记录`;
    return `【最近 ${days} 天活跃榜】\n` + rows.map((r, i) => `${i + 1}. ${r.name}（${r.cnt} 条）`).join('\n');
  }

  /**
   * 库内消息总行数（Web 管理面板 /api/status 统计用，见 core/runtime.js getStatus）。
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
