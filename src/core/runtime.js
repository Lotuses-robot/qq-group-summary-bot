/*
 * 运行时装配与编排（core 主运行库入口；P1 由 src/index.js 拆出）。
 *
 * 职责：唯一装配者 + 消息路由链 + 三个后台编排流程（原 index.js 全文迁移，行为一字不改）：
 * 平台/服务实例（MessageStore/NapCatClient/Summarizer/ChatBot/Scheduler/Analytics/DataRefresher
 * 及按 webui.enabled 条件装配的 WebUI）都在 createApp 内 new；路由链 S1–S13 与
 * refreshData/backfillHistory/dailyReport 同址迁移。
 *
 * 拆分动机（docs/refactor-proposal.md）：index.js 原是「加载即启动」——import 即读
 * config、建连接、起定时器，无法被测试/工具 import。现 createApp(config, overrides)
 * 纯装配可注入，main() 才读配置与启动；src/index.js 只留引导三行。
 *
 * 对外导出：createApp(config, overrides) / main()。实例化点：index.js（main 启动路径）；
 * 测试与 P2+ 插件编排经 createApp 返回的 services 句柄取实例。
 * 读写数据：读 config.json（main 内）；写经 store/analytics/arkdb 落 data/，
 * 回复经 client 发群/私聊消息。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NapCatClient } from './napcat.js';
import { MessageStore, fmtFull } from './store.js';
import { Summarizer } from './summarizer.js';
import { Scheduler } from './scheduler.js';
import { filterMessages as filterMessagesRaw } from './filter.js';
import { Analytics } from './analytics.js';
import { DataRefresher } from './refresher.js';
import { ChatBot } from '../chat.js';
import { tryCommand } from '../commands.js';
import { WebUI } from '../webui.js';
import { log, err } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// core/ 比原 src/ 深一层：项目根 = __dirname/../..
const root = path.resolve(__dirname, '..', '..');

/**
 * 纯装配（无启动副作用）：按 config 组装全部服务实例与路由/编排闭包，
 * overrides 可注入替代实例（测试替身），但不会 connect/起定时器——由返回的
 * start() 负责全部启动副作用。config 键名/schema 与原 index.js 完全一致。
 *
 * @param {Object} config - 完整配置（见 config.example.json；llm.apiKey 已由 main 回填）
 * @param {Object} [overrides={}] - 测试注入点：store/client/summarizer/chatBot/scheduler/
 *   analytics/refresher 任一给值即代替内部 new（缺省各按 config 实建）
 * @returns {{config: Object, services: Object, refreshData: Function, start: Function,
 *   stop: Function, getStatus: Function}} 装配结果
 */
export function createApp(config, overrides = {}) {
  const dataDir = path.resolve(root, config.dataDir || './data');
  const llm = config.llm || {};

  const store = overrides.store || new MessageStore(dataDir);
  const client = overrides.client || new NapCatClient(config.napcat.wsUrl, {
    selfId: config.napcat.selfId || 0,
    accessToken: config.napcat.accessToken || '',
  });
  const summarizer = overrides.summarizer || new Summarizer(llm);
  const chatBot = overrides.chatBot || new ChatBot(llm);
  const scheduler = overrides.scheduler || new Scheduler(config.schedule || {});
  const analytics = overrides.analytics || new Analytics(path.join(dataDir, 'messages.db'), path.join(dataDir, 'messages'));
  const refresher = overrides.refresher || new DataRefresher(path.join(dataDir, 'ark'), config.dataRefresh || {});

  /**
   * 数据自动/手动刷新编排（architecture §6.3）：三个触发源共用同一函数——启动定时器 / 群指令 S11 / WebUI POST /api/refresh。
   * 先快照旧 6★/5★ 干员与卡池 id（走 arkdb 公开快照 API）→ refresher.refresh()
   * （依次 干员→档案→藏品→卡池；ETag 304 跳过、结构校验失败抛错）→ 有更新则
   * arkdb.reload() 热重载并 diff 出新增干员/新开放卡池 → 按 dataRefresh.announce 组「【数据更新播报】」。
   *
   * @param {string|null} [notifyGroupId=null] - 群指令触发时传群号：必向该群回执「【数据更新】…」结果消息
   *  （另在 announce===true 时附播报）；为 null（定时器/WebUI 触发）时仅当 announce===true 把播报广播给全部跟踪群
   * @returns {Promise<string>} 「【数据更新】…」结果文本（供群回执与 WebUI /api/refresh 复用）
   * 副作用：联网下载写盘 data/ark/（原子写入+旧文件 .bak 备份）、arkdb 内存热重载、可能群发播报；发送失败吞掉只记日志
   */
  // 定期更新本地数据库（ArknightsGameData），带新增内容播报
  async function refreshData(notifyGroupId = null) {
    log('[refresh] 开始更新本地数据...');

    // 快照旧数据（用于新增播报对比；走公开快照 API，不再直读 characters/_isOperator/gachaPools）
    const oldHighOps = new Map(chatBot.arkdb.snapshotHighOps().map((o) => [o.id, o.name]));
    const oldPoolIds = new Set(chatBot.arkdb.snapshotGachaPools().map((p) => p.gachaPoolId));

    const { updated, unchanged, failed } = await refresher.refresh();

    let announce = '';
    if (updated.length > 0) {
      chatBot.arkdb.reload();
      log('[refresh] 内存数据已重新加载');

      // 对比新增内容
      const new6 = [];
      const new5 = [];
      for (const c of chatBot.arkdb.snapshotHighOps()) {
        if (!oldHighOps.has(c.id)) {
          if (c.rarity === 'TIER_6') new6.push(c.name);
          else if (c.rarity === 'TIER_5') new5.push(c.name);
        }
      }
      const now = Math.floor(Date.now() / 1000);
      const newPools = [];
      for (const p of chatBot.arkdb.snapshotGachaPools()) {
        if (!oldPoolIds.has(p.gachaPoolId) && (!p.openTime || p.openTime <= now) && (!p.endTime || p.endTime >= now)) {
          newPools.push(p.gachaPoolName);
        }
      }
      const parts = [];
      if (new6.length) parts.push(`新增 6★ 干员：${new6.join('、')}`);
      if (new5.length) parts.push(`新增 5★ 干员：${new5.join('、')}`);
      if (newPools.length) parts.push(`新开放卡池：${[...new Set(newPools)].join('、')}`);
      if (parts.length) announce = `【数据更新播报】\n${parts.join('\n')}`;
    }

    const msg = `【数据更新】\n成功：${updated.length ? updated.join('、') : '无'}\n未变化：${unchanged.length ? unchanged.join('、') : '无'}\n${failed.length ? '失败：' + failed.join('、') : '全部成功'}`;
    if (notifyGroupId) {
      client.sendGroupMsg(notifyGroupId, msg).catch((e) => err(`[refresh] 通知发送失败:`, e.message));
      if (announce && config.dataRefresh?.announce === true) {
        client.sendGroupMsg(notifyGroupId, announce).catch(() => {});
      }
    } else if (announce && config.dataRefresh?.announce === true) {
      // 自动更新时向所有监控群播报新增内容（默认关闭，需 announce: true 显式开启）
      const targets = trackedGroups().length ? trackedGroups() : store.trackedGroupIds();
      for (const gid of targets) {
        client.sendGroupMsg(gid, announce).catch(() => {});
      }
      log('[refresh] 已向群聊播报新增内容');
    }
    return msg;
  }

  // 群路由相关配置常量（自 config.json 派生；groups 空数组 = 跟踪全部群）
  const trackedGroups = () => (Array.isArray(config.groups) ? config.groups : []);
  const tracksGroup = (id) => trackedGroups().length === 0 || trackedGroups().includes(id);
  const minMessages = config.minMessages ?? 1;
  const includeSelf = config.includeSelf === true;
  const manualCmds = config.commands?.manualSummary ?? ['总结', '/总结', '#总结'];

  // startedAt/wsConnected：启动时刻与 WS 在线标志，供 WebUI 状态页
  //（wsConnected 断线重连成功不回调 createApp、一旦 true 不复位，见 architecture §8 坑 2——此处不修）
  const startedAt = Date.now();
  let wsConnected = false;

  // 日报配置（report.*）：userId 私聊收件人、minMessages 活跃群消息门槛（默认 100）
  const report = config.report || {};
  const reportUserId = report.userId || 0;
  const reportMinMessages = report.minMessages ?? 100;
  const dailyHour = report.hour ?? 9;

  // 静默时段配置（quiet.*）：默认 0:00–8:00；enabled !== false 视为开启（S7 判定用）
  const quiet = config.quiet || {};
  const quietEnabled = quiet.enabled !== false;
  const quietStart = quiet.start ?? 0;
  const quietEnd = quiet.end ?? 8;
  // 敏感内容过滤开关（filter.*，默认开）与包装函数：关闭时原样放行（kept=全部、filtered=空）
  const filterEnabled = config.filter?.enabled !== false;
  const filterMessages = (recs) => (filterEnabled ? filterMessagesRaw(recs) : { kept: recs, filtered: [] });

  // 生命周期内可变的运行时状态：selfId（初始取配置，connect 后以 get_login_info 回填）、
  // ready（WS 就绪锚点）、backfillDone（离线补偿仅执行一次）、summaryInFlight（同群概括防重入）
  let selfId = config.napcat.selfId || 0;
  let ready = false;
  let backfillDone = false;
  const summaryInFlight = new Set();

  // 预载「今天」窗口到内存（§3 步骤 4）：groups 为空数组时什么都不预载；日报/概括按需另载日期段
  for (const gid of trackedGroups()) {
    store.loadFromDisk(gid);
  }

  /**
   * 静默时段判定（路由 S7；优先级高于总结关键词与指令、低于入库——静默只是不回，消息照常入库）：
   * 处于 quiet.start(默认 0)–quiet.end(默认 8) 之间视为静默；跨零点时段（start > end）按「晚于 start 或早于 end」判。
   *
   * @param {Date} [date=new Date()] - 判定时刻，默认当前时间
   * @returns {boolean} 静默中返回 true；quiet.enabled === false 时恒 false
   */
  function inQuietHours(date = new Date()) {
    if (!quietEnabled) return false;
    const h = date.getHours();
    if (quietStart < quietEnd) return h >= quietStart && h < quietEnd;
    return h >= quietStart || h < quietEnd;
  }

  /**
   * 从 @ 消息剥前导 @ 提取问题文本（路由 S9）。只剥 1–2 段前缀：先「@机器人」（可带空白），再任意「@昵称」；
   * 中部/尾部 @ 原样保留进问题（见 architecture §8 坑 7，此处不修）。
   *
   * @param {Object} rec - store.addMessage 产出的消息记录（含 text 字段）
   * @param {boolean} mentionedSelf - 是否按 @ 消息剥离；false 时仅 trim 原样返回
   * @returns {string} 问题文本；可能为空串（由 S10 的纯 @ 分支兜住）
   */
  function extractQuestion(rec, mentionedSelf) {
    if (!mentionedSelf) return rec.text.trim();
    let text = rec.text.trim();
    text = text.replace(/^@机器人\s*/, '');
    text = text.replace(/^@[^\s@]{1,30}\s*/, '');
    return text.trim();
  }

  /**
   * 手动总结入口（S8，调用方 fire-and-forget 不 await）：ready 未就绪直接忽略；同群已有概括在跑
   * （summaryInFlight 集合）时忽略重复指令。
   *
   * @param {string|number} groupId - 群号
   * @param {Object} [opts={}] - 透传选项；当前函数体未读取，仅保留调用形状（此处不顺手改）
   * @returns {Promise<void>} 完成或忽略；调用方以 .catch 记录异常
   * 副作用：可能经 doSummary 群发概括消息并推进 lastSummaryAt
   */
  async function triggerSummary(groupId, opts = {}) {
    if (!ready) return;
    if (summaryInFlight.has(groupId)) {
      log(`[group ${groupId}] 已有概括进行中，忽略重复指令`);
      return;
    }
    summaryInFlight.add(groupId);
    try {
      await doSummary(groupId, opts);
    } finally {
      summaryInFlight.delete(groupId);
    }
  }

  /**
   * 概括执行体：起点 = 上次 lastSummaryAt（无记录回退最近 1 小时）→ collectSince 收集 → 依次过三守卫
   * （无消息 / 少于 minMessages / 敏感过滤后为空）任一命中即跳过 → summarizer.summarize(...,'manual')
   * → 发送成功才推进 lastSummaryAt（失败不推进，下次重跑仍覆盖同一时段）。
   *
   * @param {string|number} groupId - 群号
   * @param {Object} [opts={}] - 透传保留（当前函数体未读取）
   * @returns {Promise<void>} 生成完成或中途跳过
   * 副作用：群发概括消息；发送成功后写 state（store.setLastSummaryAt）
   */
  async function doSummary(groupId, opts = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    let since = store.getLastSummaryAt(groupId);
    if (!since) since = nowSec - 60 * 60;

    const recs = store.collectSince(groupId, since);
    if (recs.length === 0) {
      log(`[group ${groupId}] 该时段无消息，跳过概括`);
      return;
    }
    if (recs.length < minMessages) {
      log(`[group ${groupId}] 消息数(${recs.length})少于 minMessages(${minMessages})，跳过`);
      return;
    }

    const { kept, filtered } = filterMessages(recs);
    if (kept.length === 0) {
      log(`[group ${groupId}] 该时段消息均含敏感内容，跳过概括`);
      return;
    }
    if (filtered.length > 0) {
      log(`[group ${groupId}] 已过滤 ${filtered.length} 条敏感/隐私消息`);
    }

    const span = `从 ${fmtFull(new Date(since * 1000))} 到 ${fmtFull(new Date(recs[recs.length - 1].time * 1000))}`;
    log(`[group ${groupId}] 开始概括 ${kept.length} 条消息 (${span})`);

    const summary = await summarizer.summarize(groupId, kept, span, 'manual');
    const msg = `【群聊概括】\n${span}｜共 ${kept.length} 条消息\n\n${summary}`;

    await client.sendGroupMsg(groupId, msg);
    // 边界点：发送成功后才推进 lastSummaryAt（失败不写 → 下次重跑仍覆盖同一时段）
    store.setLastSummaryAt(groupId, nowSec);
    log(`[group ${groupId}] 概括已发送`);
  }

  /**
   * 日报标题用群名查询：get_group_info 失败或无群名时回退群号字符串，不向外抛。
   *
   * @param {string|number} groupId - 群号
   * @returns {Promise<string>} 群名或 String(groupId)
   */
  async function getGroupName(groupId) {
    try {
      const info = await client.getGroupInfo(groupId);
      return info?.group_name || String(groupId);
    } catch {
      return String(groupId);
    }
  }

  /**
   * 群集合（backfill/日报在 config.groups 为空数组时使用）：优先 get_group_list 拉全量；
   * 空结果或调用失败回退 store 已跟踪群（磁盘记录的群）。
   *
   * @returns {Promise<Array<number|string>>} 群号列表
   */
  async function getAllGroupIds() {
    try {
      const list = await client.call('get_group_list');
      const ids = (list || []).map((g) => g.group_id).filter(Boolean);
      return ids.length > 0 ? ids : store.trackedGroupIds();
    } catch {
      return store.trackedGroupIds();
    }
  }

  /**
   * 离线补偿拉取（§6.1；仅 WS connect 生命周期回调内执行一次，backfillDone 置位后不再跑）：
   * sinceTs = max(全局 lastSeenTs, now − backfill.maxHours×3600)（默认 72h；lastSeenTs 是全局单值非按群，§8 坑 9）；
   * 群集合 = config.groups 非空用之，否则 get_group_list（失败回退磁盘已跟踪群）；
   * 每群 get_group_msg_history(messageSeq:0, count:1000) → 过滤 time<sinceTs 与批内重复 id →
   * addHistoryMessage（内存/磁盘双去重，仅返回真才算新增）→ analytics.record；整批有新增才 setLastSeenTs(latest)
   * （只增不减）；单群失败记日志继续。
   *
   * @returns {Promise<void>}
   * 副作用：写消息存储/状态文件/SQLite（可能触发 analytics 首写全量导入，§8 坑 5）
   */
  async function backfillHistory() {
    if (!ready || backfillDone) return;
    backfillDone = true;
    const nowSec = Math.floor(Date.now() / 1000);
    const maxHours = config.backfill?.maxHours ?? 72;
    const sinceTs = Math.max(store.getLastSeenTs(), nowSec - maxHours * 3600);
    const groups = trackedGroups().length > 0 ? trackedGroups() : await getAllGroupIds();

    log(`[backfill] 启动后补偿拉取：自 ${fmtFull(new Date(sinceTs * 1000))} 起，共 ${groups.length} 个群`);
    for (const gid of groups) {
      try {
        const resp = await client.getGroupMsgHistory(gid, { messageSeq: 0, count: 1000 });
        const msgs = resp?.messages ?? resp?.data ?? [];
        let added = 0;
        let earliest = 0;
        let latest = 0;
        const seen = new Set();
        for (const m of Array.isArray(msgs) ? msgs : []) {
          if (!m) continue;
          const t = m.time ?? m.msgTime ?? 0;
          if (t < sinceTs) continue;
          if (seen.has(m.message_id)) continue;
          seen.add(m.message_id);
          const rec = store.addHistoryMessage(gid, m);
          if (rec) {
            added++;
            analytics.record(gid, rec);
          }
          if (!earliest || t < earliest) earliest = t;
          if (t > latest) latest = t;
        }
        if (added > 0) store.setLastSeenTs(latest);
        log(`[backfill] 群 ${gid} 补偿 ${added} 条离线消息${added ? `（最早 ${fmtFull(new Date(earliest * 1000))}）` : ''}`);
      } catch (e) {
        err(`[backfill] 群 ${gid} 拉取失败:`, e.message);
      }
    }
  }

  /**
   * 每日日报编排（§6.2；scheduler 每日 9:00 的回调）：守卫 ready 与 report.userId（未配置则跳过）；
   * 口径 = 昨日本地自然日 [昨日00:00, 今日00:00) —— 每群 loadFromDisk(gid, yesterdayStart, todayStart) 载入
   * 该日期段再 collectRange + 敏感过滤，消息数 ≥ reportMinMessages(100) 才算活跃群 → 逐群 summarize(...,'daily')
   *（单群失败继续），全部失败则不发送；成功则私聊发给 report.userId。全程不写 lastSummaryAt/lastSeen 状态。
   *
   * @returns {Promise<void>}
   * 副作用：私聊发送日报消息
   */
  async function dailyReport() {
    if (!ready) return;
    if (!reportUserId) {
      log('[report] 未配置 report.userId，跳过日报');
      return;
    }

    const now = new Date();
    const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime() / 1000;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const yesterdayLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate() - 1).padStart(2, '0')}`;

    const groups = trackedGroups().length > 0 ? trackedGroups() : await getAllGroupIds();
    const activeGroups = [];

    for (const gid of groups) {
      store.loadFromDisk(gid, yesterdayStart, todayStart);
      const recs = store.collectRange(gid, yesterdayStart, todayStart);
      const { kept, filtered } = filterMessages(recs);
      if (filtered.length > 0) {
        log(`[report] 群 ${gid} 已过滤 ${filtered.length} 条敏感/隐私消息`);
      }
      if (kept.length >= reportMinMessages) activeGroups.push({ gid, recs: kept });
    }

    if (activeGroups.length === 0) {
      log(`[report] 昨日(${yesterdayLabel})无活跃群（≥${reportMinMessages}条），跳过`);
      return;
    }

    log(`[report] 昨日(${yesterdayLabel})活跃群 ${activeGroups.length} 个，正在生成日报...`);
    const parts = [];
    for (const { gid, recs } of activeGroups) {
      try {
        const name = await getGroupName(gid);
        const summary = await summarizer.summarize(gid, recs, yesterdayLabel, 'daily');
        parts.push(`【${name}】${recs.length} 条消息\n${summary}`);
        log(`[report] 群 ${gid}(${name}) 日报已生成`);
      } catch (e) {
        err(`[report] 群 ${gid} 日报失败:`, e.message);
      }
    }

    if (parts.length === 0) {
      log('[report] 所有群日报生成失败，跳过发送');
      return;
    }

    const msg = `【昨日群聊日报 ${yesterdayLabel}】\n共 ${parts.length} 个活跃群\n\n${parts.join('\n\n---\n\n')}`;
    await client.sendPrivateMsg(reportUserId, msg);
    log(`[report] 日报已私聊发送给 ${reportUserId}`);
  }

  // 事件路由链 S1–S13（architecture §4）：收到任意 WS 事件按序逐条判定，命中即 return；
  // 注意 S5「入库先于一切」——非 @、静默时段的消息也照常入库计数，只是不回复
  client.onEvent((event) => {
    if (event.post_type === 'meta_event') {
      // S1 lifecycle/connect（WS open 后 napcat 自行合成）：置 ready/wsConnected，回填 selfId（若为 0），
      // 随后异步 backfillHistory（仅此一次；非 connect 的 meta 事件直接 return 不处理）
      if (event.meta_event_type === 'lifecycle' && event.sub_type === 'connect') {
        ready = true;
        wsConnected = true;
        (async () => {
          if (!selfId) {
            try {
              const info = await client.getLoginInfo();
              selfId = info.user_id;
              log(`[napcat] 机器人 QQ: ${selfId}`);
            } catch (e) {
              err('获取登录信息失败:', e.message);
            }
          }
          await backfillHistory();
        })();
      }
      return;
    }

    // S2 只处理群消息（其余 post_type / 私聊消息在此 return）
    if (event.post_type !== 'message' || event.message_type !== 'group') return;
    // S3 机器人自己的消息：includeSelf=false 时不理会（selfId 为 0 未回填时本行自动跳过）
    if (selfId && event.user_id === selfId && !includeSelf) return;
    // S4 群白名单：groups 空数组 = 全部群（tracksGroup 内特判）
    if (!tracksGroup(event.group_id)) return;

    // S5 入库先于一切路由判定：store.addMessage 对重复 id / 空文本返回 null → 直接 return（也不入 analytics）
    const rec = store.addMessage(event);
    if (!rec) return;
    analytics.record(event.group_id, rec);

    // S6 @ 检测：at 段与 selfId 字符串全等；或整串文本包含 @<selfId> / @机器人 / @PRTS（子串、大小写敏感）
    const mentionedSelf = Array.isArray(event.message) &&
      event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(selfId));
    const cmd = rec.text.trim();
    const mentionedByText = cmd.includes(`@${selfId}`) || cmd.includes('@机器人') || cmd.includes('@PRTS');
    const isMentioned = mentionedSelf || mentionedByText;

    if (!isMentioned) return; // 未被 @：消息已入库计数，路由到此结束

    // S7 静默时段吞掉一切 @ 行为（消息已入库，只是不回复）
    if (inQuietHours()) {
      log(`[group ${event.group_id}] 收到 @机器人 消息但处于静默时段(${quietStart}:00-${quietEnd}:00)，忽略`);
      return;
    }

    // S8 手动总结关键词：对「含 @ 的完整文本」做 includes 判定（默认 总结、/总结、#总结），
    // 命中即 fire-and-forget 触发 triggerSummary 并 return
    if (manualCmds.some((c) => cmd.includes(c))) {
      log(`[group ${event.group_id}] 收到手动总结指令 (@机器人)`);
      triggerSummary(event.group_id, { manual: true }).catch((e) => err('手动总结失败:', e.message));
      return;
    }

    // S9 剥前导 @ 得到问题文本
    const question = extractQuestion(rec, true);
    // S10 纯 @（问题为空）：回「@昵称 艾特PRTS干什么呀喵」提示并 return
    if (!question) {
      log(`[group ${event.group_id}] 收到仅@机器人（无内容）的消息`);
      const senderName = event.sender?.card || event.sender?.nickname || '群友';
      client.sendGroupMsg(event.group_id, `@${senderName} 艾特PRTS干什么呀喵`).catch((e) => err(`[group ${event.group_id}] 发送提示失败:`, e.message));
      return;
    }

    // S11 数据刷新指令：整串锚定（非包含匹配），先 ack「正在更新…」再异步 refreshData(gid)，失败补发错误消息
    // 手动刷新本地数据（联网更新 ArknightsGameData）
    if (/^(刷新数据|更新数据|更新数据库)$/.test(question)) {
      log(`[group ${event.group_id}] 收到数据刷新指令`);
      client.sendGroupMsg(event.group_id, '正在更新本地数据库，稍候…').catch(() => {});
      refreshData(event.group_id).catch((e) => {
        err('[refresh] 手动刷新失败:', e.message);
        client.sendGroupMsg(event.group_id, `数据更新失败：${e.message}`).catch(() => {});
      });
      return;
    }

    // S12 确定性指令分发表（commands.js，14 条规则）：返回严格 null 才算未命中 → 落到 S13 LLM 兜底
    // 确定性指令路由（词典学习/干员查询/藏品查询/统计/抽卡等，带群与用户上下文）
    const senderName = event.sender?.card || event.sender?.nickname || '群友';
    const cmdReply = tryCommand({
      lingo: chatBot.lingo,
      arkdb: chatBot.arkdb,
      analytics,
      groupId: event.group_id,
      userId: event.user_id,
      userName: senderName,
    }, question);
    if (cmdReply !== null) {
      log(`[group ${event.group_id}] 指令响应: ${question.slice(0, 30)}`);
      client.sendGroupMsg(event.group_id, cmdReply).catch((e) => err(`[group ${event.group_id}] 指令发送失败:`, e.message));
      return;
    }

    // S13 AI 兜底：不 await；reply 非空才发送（chat 内部失败已回退 defaultReply 文案照发，仅发送失败走 catch）
    chatBot.chat(event.group_id, senderName, question, event.user_id)
      .then((reply) => {
        if (reply) return client.sendGroupMsg(event.group_id, reply);
      })
      .catch((e) => err(`[chat] 群 ${event.group_id} 发送失败:`, e.message));
  });

  /** WebUI/状态页共享的状态快照（characters/relics/pools 计数前先确保 arkdb 已 load） */
  function getStatus() {
    chatBot.arkdb.load();
    return {
      wsConnected,
      selfId,
      operators: chatBot.arkdb.characters.size,
      relics: chatBot.arkdb.relics.size,
      pools: chatBot.arkdb.gachaPools.length,
      lingoCount: chatBot.lingo.size(),
      messages: analytics.countMessages(),
      uptime: `${Math.floor((Date.now() - startedAt) / 60000)} 分钟`,
    };
  }

  /**
   * 启动（全部启动副作用在此，createApp 本身不碰网络/定时器）：
   * 注册数据自动刷新定时器（仅 dataRefresh.enabled !== false 时）→ 挂退出信号 →
   * client.connect() 建 WS → scheduler.start 排下一个 9:00 日报 → 按 webui.enabled 起面板。
   * @returns {void}
   */
  function start() {
    // 数据自动刷新定时器（§3 步骤 3）：注册先于 client.connect()；仅 dataRefresh.enabled !== false
    // 时启用（默认开：首次 firstDelayMinutes(30) 分钟后，此后每 intervalHours(24) 小时；与 S11/WebUI 共用 refreshData）
    const dr = config.dataRefresh || {};
    if (dr.enabled !== false) {
      const firstMs = (dr.firstDelayMinutes ?? 30) * 60 * 1000;
      const intervalMs = (dr.intervalHours ?? 24) * 3600 * 1000;
      setTimeout(() => {
        refreshData().catch((e) => err('[refresh] 更新失败:', e.message));
        setInterval(() => refreshData().catch((e) => err('[refresh] 更新失败:', e.message)), intervalMs);
      }, firstMs);
      log(`[refresh] 数据定期更新已启用：首次 ${dr.firstDelayMinutes ?? 30} 分钟后，此后每 ${dr.intervalHours ?? 24} 小时`);
    }

    // 生命周期收尾：先停每日定时器（防退出前再触发），再关 WS（置 closed 后不再重连），随后退出进程
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        log('收到退出信号，正在关闭...');
        scheduler.stop();
        client.close();
        process.exit(0);
      });
    }

    // 启动收尾（§3 步骤 6）：connect 异步建 WS；scheduler.start 只排下一个 9:00，不会立即跑日报
    client.connect();
    scheduler.start(dailyReport);

    // Web 管理面板
    if (config.webui?.enabled !== false) {
      const webui = new WebUI(config.webui || {});
      webui.start({
        getStatus,
        getLingo: () => chatBot.lingo,
        getConfig: () => config,
        refreshData,
      });
    }

    log('QQ 群聊概括机器人已启动（仅 @ 触发总结；每日 9:00 发送昨日日报）');
  }

  /** 优雅停服（退出信号与测试共用）：停日报定时器 + 关 WS；不 exit（信号路径自行 exit） */
  function stop() {
    scheduler.stop();
    client.close();
  }

  return {
    config,
    services: { dataDir, llm, store, client, summarizer, chatBot, scheduler, analytics, refresher },
    refreshData,
    getStatus,
    start,
    stop,
  };
}

/**
 * 启动入口（npm start = node src/index.js → 本函数）：读 config（CONFIG_PATH 环境变量
 * 可覆盖；llm.apiKey 缺失回退 LLM_API_KEY，仍空则报错 exit(1)）→ createApp → app.start()。
 * config 读取与退出判定只发生在真实启动路径——import core/runtime.js 或 createApp 均无副作用。
 *
 * @returns {Object} createApp 的装配结果（进程常驻；返回仅供程序化调用方持有句柄）
 */
export function main() {
  const configPath = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const llm = config.llm || {};
  if (!llm.apiKey) llm.apiKey = process.env.LLM_API_KEY || '';
  if (!llm.apiKey) {
    err('未配置 LLM API Key：请在 config.json 的 llm.apiKey 或环境变量 LLM_API_KEY 中设置。');
    process.exit(1);
  }

  const app = createApp(config);
  app.start();
  return app;
}
