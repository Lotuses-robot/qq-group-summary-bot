/*
 * 每日日报后台插件（P3b 由 runtime.js 迁入：原 dailyReport 编排正文 + getGroupName 群名查询，
 * 门限与文案逐字保持）。
 *
 * 无消息面：仅 hooks 插件（不参与 dispatch——本插件 handleMessage 恒 null；priority 0 使
 * startAll 时排在最后，仅 hooks 的 start/stop 次序有意义，见 refactor-proposal「report 仅 hooks」）。
 * hooks.start → scheduler.start(run)：注册每日 9:00 定时回调（调度循环由 core/scheduler.js 自驱，
 * 每天触发一次后自动排下一天）；hooks.stop → scheduler.stop()（停服收尾，旧实现由 runtime 直调，
 * 插件化后调度器归本插件所有，生命周期随 registry.stopAll 逆序停）。
 *
 * 编排口径（§6.2，逐字迁自 runtime）：守卫 isReady() 与 reportUserId（未配置则跳过）；
 * 口径 = 昨日本地自然日 [昨日00:00, 今日00:00) —— 每群 loadFromDisk(gid, yesterdayStart,
 * todayStart) 载入该日期段再 collectRange + 敏感过滤，消息数 ≥ reportMinMessages(100) 才算
 * 活跃群 → 逐群 summarize(...,'daily')（单群失败继续），全部失败则不发送；成功则私聊发给
 * reportUserId。全程不写 lastSummaryAt/lastSeen 状态。
 *
 * 依赖：logger；服务/配置经 createReportPlugin(deps) 注入（scheduler/就绪标志属 runtime 资产，
 * 经 deps 移交；getAllGroupIds 与 backfillHistory 共用、仍留在 runtime 并注入）；
 * 实例化点：core/runtime.js createApp 装配期。
 * 读写数据：读消息存储（loadFromDisk/collectRange）；经 summarizer 调 LLM 概括；私聊经 client。
 */
import { log, err } from '../core/logger.js';

/**
 * 每日日报插件描述符构造：{name:'report', priority: 0, handleMessage, hooks:{start,stop}}。
 * 仅 hooks 插件：priority 0 不占任何分发带（消息面恒 null）；hooks.start 起每日调度。
 * @param {Object} deps - runtime 装配期注入
 * @param {Object} deps.store - MessageStore 实例（loadFromDisk/collectRange）
 * @param {Object} deps.client - NapCatClient 实例（getGroupInfo 群名 / sendPrivateMsg 发送）
 * @param {Object} deps.summarizer - Summarizer 实例（LLM 概括，mode 'daily'）
 * @param {Object} deps.scheduler - Scheduler 实例（每日 9:00 循环调度，start 在 hooks.start 注册）
 * @param {Function} deps.filterMessages - (recs) => {kept, filtered} 敏感过滤包装（同 summary 插件）
 * @param {Function} deps.trackedGroups - () => Array，config.groups 访问器
 * @param {Function} deps.getAllGroupIds - () => Promise<Array>，活跃群集合（与 runtime backfill 共用）
 * @param {number} deps.reportUserId - 日报私聊收件人（config.report.userId；0/缺省 = 不启用）
 * @param {number} deps.reportMinMessages - 活跃群消息门槛（config.report.minMessages ?? 100）
 * @param {Function} deps.isReady - () => boolean，WS 就绪锚点
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createReportPlugin(deps) {
  const { store, client, summarizer, scheduler, filterMessages, trackedGroups, getAllGroupIds } = deps;
  const reportUserId = deps.reportUserId || 0;
  const reportMinMessages = deps.reportMinMessages ?? 100;
  const isReady = deps.isReady;

  /**
   * 日报标题用群名查询：get_group_info 失败或无群名时回退群号字符串，不向外抛。
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
   * 每日日报编排（§6.2；scheduler 每日 9:00 的回调）：守卫 isReady 与 reportUserId
   * （未配置则跳过）；口径 = 昨日本地自然日 [昨日00:00, 今日00:00) —— 每群
   * loadFromDisk(gid, yesterdayStart, todayStart) 载入该日期段再 collectRange + 敏感过滤，
   * 消息数 ≥ reportMinMessages(100) 才算活跃群 → 逐群 summarize(...,'daily')（单群失败继续），
   * 全部失败则不发送；成功则私聊发给 report.userId。全程不写 lastSummaryAt/lastSeen 状态。
   *
   * @returns {Promise<void>}
   * 副作用：私聊发送日报消息
   */
  async function dailyReport() {
    if (!isReady()) return;
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

  return {
    name: 'report',
    // 仅 hooks 插件：0 不占分发带（handleMessage 恒 null，永不认领消息）；start 次序排在最后无碍
    priority: 0,
    handleMessage() {
      return null;
    },
    hooks: {
      /** 注册每日 9:00 日报调度（scheduler 循环：每天触发 dailyReport 后自动排下一天） */
      start() {
        scheduler.start(dailyReport);
      },
      /** 停服：停掉每日调度器（原 runtime.stop/信号路径直调 scheduler.stop 的位置） */
      stop() {
        scheduler.stop();
      },
    },
  };
}
