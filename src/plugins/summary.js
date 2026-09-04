/*
 * 手动总结插件（P3b 由 runtime.js 迁入：原路由链 S8 关键词判定 + triggerSummary/doSummary
 * 整段搬移，门限与文案逐字保持）。
 *
 * 消息面：priority 900（PRIORITY.summary）——分发顺序 = 原 S8 位置（先于一切指令/刷新）。
 * 判定跑在 ctx.text（剥前导 @ 后的 question）上，与旧实现在「含 @ 的完整文本」上判定等价：
 * 关键词（总结//总结/#总结）不含 @、剥掉的前导段是 @机器人 与一个 @昵称——唯一差异是关键词
 * 恰出现在被剥 @昵称 段内（如昵称就叫「总结」）的极端情形，旧实现会误触发概括，此处不保真该
 * 误触发（行为保真清单注记）。命中即 fire-and-forget：handleMessage 同步返回 true 表示已消费
 * （调用方不 await），概括异步执行；isReady()=false 时照常消费消息但静默跳过执行（同旧 S8）。
 * risk #2 落地：per-group 互斥集（summaryInFlight）随插件实例走（工厂闭包），不放 runtime 全局。
 *
 * 依赖：logger + core/platform/store.js（fmtFull）；服务/配置经 createSummaryPlugin(deps) 注入——
 * 依赖 runtime 闭包内的就绪标志与配置派生量，故不随 plugins/index.js 静态数组交付，
 * 实例化点：core/runtime.js createApp 装配期就地构造。
 * 读写数据：读消息存储（getLastSummaryAt/collectSince）；经 summarizer 调 LLM 概括；
 * 群发经 client；成功后写 setLastSummaryAt。
 */
import { log, err } from '../core/platform/logger.js';
import { fmtFull } from '../core/platform/store.js';
import { PRIORITY } from '../core/registry.js';

/**
 * 手动总结插件描述符构造：{name:'summary', priority: PRIORITY.summary, handleMessage}。
 * @param {Object} deps - runtime 装配期注入
 * @param {Object} deps.store - MessageStore 实例（getLastSummaryAt/collectSince/setLastSummaryAt）
 * @param {Object} deps.summarizer - Summarizer 实例（LLM 概括，mode 'manual'）
 * @param {Object} deps.client - NapCatClient 实例（群发概括消息）
 * @param {Function} deps.filterMessages - (recs) => {kept, filtered} 敏感过滤包装
 *   （enabled 开关已由 runtime 按 config.filter 判定并包装）
 * @param {number} deps.minMessages - 概括消息数门槛（config.minMessages ?? 1）
 * @param {string[]} deps.manualCmds - 触发关键词表（config.commands.manualSummary，缺省 总结//总结/#总结）
 * @param {Function} deps.isReady - () => boolean，WS 就绪锚点（runtime ready 标志的读引用）
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createSummaryPlugin(deps) {
  const { store, summarizer, client, filterMessages, minMessages, manualCmds, isReady } = deps;
  // per-group 概括互斥：同群已有概括在跑时忽略重复指令（随插件实例，勿提升为全局，见 refactor-proposal risk #2）
  const summaryInFlight = new Set();

  /**
   * 概括执行体：起点 = 上次 setLastSummaryAt（无记录回退最近 1 小时）→ collectSince 收集 →
   * 依次过三守卫（无消息 / 少于 minMessages / 敏感过滤后为空）任一命中即跳过 →
   * summarizer.summarize(...,'manual') → 发送成功才推进 lastSummaryAt（失败不推进，下次重跑仍覆盖同一时段）。
   *
   * @param {string|number} groupId - 群号
   * @param {Object} [opts={}] - 透传保留（当前函数体未读取，仅保留调用形状——此处不顺手改）
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
   * 手动总结入口（S8 语义；handleMessage 命中即 fire-and-forget 调用本函数，不 await）：
   * ready 未就绪直接忽略；同群已有概括在跑（summaryInFlight）时忽略重复指令。
   *
   * @param {string|number} groupId - 群号
   * @param {Object} [opts={}] - 透传选项（当前函数体未读取，仅保留调用形状）
   * @returns {Promise<void>} 完成或忽略（调用方以 .catch 记录异常）
   * 副作用：可能经 doSummary 群发概括消息并推进 lastSummaryAt
   */
  async function triggerSummary(groupId, opts = {}) {
    if (!isReady()) return;
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

  return {
    name: 'summary',
    priority: PRIORITY.summary,
    /**
     * 手动总结判定与触发（原路由链 S8）：text 含任一关键词即消费消息并异步触发概括。
     * @param {Object} ctx - 消息上下文（runtime S12 分发）：{groupId, text, ...}
     * @returns {true|null} true = 命中（已异步触发，消息被消费）；null = 未命中（落下一插件）
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      if (!manualCmds.some((c) => t.includes(c))) return null;
      log(`[group ${ctx.groupId}] 收到手动总结指令 (@机器人)`);
      triggerSummary(ctx.groupId, { manual: true }).catch((e) => err('手动总结失败:', e.message));
      return true;
    },
  };
}
