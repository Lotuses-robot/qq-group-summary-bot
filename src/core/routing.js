/*
 * 消息路由判定域（core 主运行库；P5b 自 core/runtime.js 拆出，行为与文案零改动）。
 *
 * 职责：WS 事件路由链 S1–S13 判定（见 docs/architecture.md §4）+ 离线补偿 backfillHistory
 * （§6.1）+ 群集合 getAllGroupIds——原为 runtime.js createApp 闭包内的函数与 client.onEvent
 * 注册段，拆出后工厂化。正文逐字迁移：S 链判定次序/回复文案/静默门语义与拆出前完全一致
 * （红线见 CLAUDE.md）；机制差异仅两点：① 原依赖函数声明提升的闭包共享 → 现显式 options
 * 注入 + 返回值提供（runtime 装配段必须先 createRouting 再注册插件）；② 原并列 let 闭包 →
 * 共享 state 对象（本文件读写、runtime 的 isReady/getStatus 闭包读同一份）。
 *
 * 对外导出：createRouting(options)。实例化点：core/runtime.js createApp 装配段
 * （插件注册前创建、预载后挂 onEvent；report 插件经返回值取 getAllGroupIds）。
 * 读写数据：经注入的 store/analytics 写 data/（消息入库、SQLite 计数），经 client
 * 拉群列表/群历史、回填 selfId、发群消息（S10 纯 @ 提示与 S12 指令回复）。
 */
import { log, err } from './platform/logger.js';
import { fmtFull } from './platform/store.js';

/**
 * 路由判定域工厂：S1–S13 判定链 + 离线补偿。P5b 自 runtime.js createApp 逐字拆出——
 * 除下方 @param 列出的注入点与 state 对象化外，判定顺序与文案一字未改。
 *
 * @param {Object} options - runtime 装配段已构造的依赖与派生配置：
 *   store/analytics/client/registry/lingo/arkdb 服务句柄（S5 入库、S12 dispatch ctx 等）；
 *   state 共享可变对象 { selfId, ready, backfillDone, wsConnected }（S1/S3/backfill 读写，
 *   runtime 侧 isReady/getStatus 读同一对象）；includeSelf（S3 机器人自身消息）、
 *   tracksGroup（S4 群白名单判定）、trackedGroups（backfill 群集合，空数组 = 全部群）、
 *   quietEnabled/quietStart/quietEnd（S7 静默时段）、backfillMaxHours（sinceTs 兜底窗口）
 * @returns {{onEvent: Function, getAllGroupIds: Function, backfillHistory: Function}}
 *   onEvent 挂 client.onEvent（预载后）；getAllGroupIds 注入 report 插件；backfillHistory 由
 *   onEvent 的 S1 connect 分支调用（仅此一次），runtime 不再持有
 */
export function createRouting(options) {
  const {
    store, analytics, client, registry, lingo, arkdb, state,
    includeSelf, tracksGroup, trackedGroups,
    quietEnabled, quietStart, quietEnd, backfillMaxHours,
  } = options;

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
   * 群集合（backfill/日报插件在 config.groups 为空数组时使用）：优先 get_group_list 拉全量；
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
   * 每群独立起点 sinceTs = max(该群 lastSeenTs, now − backfill.maxHours×3600)
   * （默认 72h 兜底；2026-09 修复坑 9：原为全局单值——单群拉取失败会把别群水位推高，
   * 该群缺口永远错过，现按群独立、互不钳制）；
   * 群集合 = trackedGroups 非空用之，否则 get_group_list（失败回退磁盘已跟踪群）；
   * 每群 get_group_msg_history(messageSeq:0, count:1000) → 过滤 time<sinceTs 与批内重复 id →
   * addHistoryMessage（内存/磁盘双去重，仅返回真才算新增）→ analytics.record；
   * 该群有新增才 setLastSeenTs(gid, latest)（只增不减）；单群失败记日志继续。
   *
   * @returns {Promise<void>}
   * 副作用：写消息存储/状态文件/SQLite（analytics.record 仅实时镜像单行；历史整库导入
   * 由 runtime.start() 的 importHistory 后台执行，此处不触发——2026-09 修复坑 5）
   */
  async function backfillHistory() {
    if (!state.ready || state.backfillDone) return;
    state.backfillDone = true;
    const nowSec = Math.floor(Date.now() / 1000);
    const maxHours = backfillMaxHours;
    const maxAgo = nowSec - maxHours * 3600;
    const groups = trackedGroups().length > 0 ? trackedGroups() : await getAllGroupIds();

    log(`[backfill] 启动后补偿拉取：共 ${groups.length} 个群（各群独立起点水位）`);
    for (const gid of groups) {
      try {
        const sinceTs = Math.max(store.getLastSeenTs(gid), maxAgo);
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
        if (added > 0) store.setLastSeenTs(gid, latest);
        log(`[backfill] 群 ${gid} 自 ${fmtFull(new Date(sinceTs * 1000))} 起补偿 ${added} 条离线消息${added ? `（最早 ${fmtFull(new Date(earliest * 1000))}）` : ''}`);
      } catch (e) {
        err(`[backfill] 群 ${gid} 拉取失败:`, e.message);
      }
    }
  }

  // 事件路由链 S1–S13（architecture §4）：收到任意 WS 事件按序逐条判定，命中即 return；
  // 注意 S5「入库先于一切」——非 @、静默时段的消息也照常入库计数，只是不回复
  function onEvent(event) {
    if (event.post_type === 'meta_event') {
      // S1 lifecycle/connect（WS open 后 napcat 自行合成）：置 ready/wsConnected，回填 selfId（若为 0），
      // 随后异步 backfillHistory（仅此一次）
      if (event.meta_event_type === 'lifecycle' && event.sub_type === 'connect') {
        state.ready = true;
        state.wsConnected = true;
        (async () => {
          if (!state.selfId) {
            try {
              const info = await client.getLoginInfo();
              state.selfId = info.user_id;
              log(`[napcat] 机器人 QQ: ${state.selfId}`);
            } catch (e) {
              err('获取登录信息失败:', e.message);
            }
          }
          await backfillHistory();
        })();
        return;
      }
      // WS 断开（napcat close 回调合成的 lifecycle/disconnect）：仅复位 wsConnected——
      // 状态页不再显示「在线」假象（2026-09 修复坑 2）。ready/backfillDone 不动：
      // 断线期间无入站消息，重连后的 connect 事件会重新置位；backfillDone 保持「离线
      // 补偿仅一次」语义
      if (event.meta_event_type === 'lifecycle' && event.sub_type === 'disconnect') {
        state.wsConnected = false;
        log('[napcat] WS 断开，连接状态已复位');
      }
      return;
    }

    // S2 只处理群消息（其余 post_type / 私聊消息在此 return）
    if (event.post_type !== 'message' || event.message_type !== 'group') return;
    // S3 机器人自己的消息：includeSelf=false 时不理会（selfId 为 0 未回填时本行自动跳过）
    if (state.selfId && event.user_id === state.selfId && !includeSelf) return;
    // S4 群白名单：groups 空数组 = 全部群（tracksGroup 内特判）
    if (!tracksGroup(event.group_id)) return;

    // S5 入库先于一切路由判定：store.addMessage 对重复 id / 空文本返回 null → 直接 return（也不入 analytics）
    const rec = store.addMessage(event);
    if (!rec) return;
    analytics.record(event.group_id, rec);

    // S6 @ 检测：at 段与 selfId 字符串全等；或整串文本包含 @<selfId> / @机器人 / @PRTS（子串、大小写敏感）
    const mentionedSelf = Array.isArray(event.message) &&
      event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(state.selfId));
    const cmd = rec.text.trim();
    const mentionedByText = cmd.includes(`@${state.selfId}`) || cmd.includes('@机器人') || cmd.includes('@PRTS');
    const isMentioned = mentionedSelf || mentionedByText;

    if (!isMentioned) return; // 未被 @：消息已入库计数，路由到此结束

    // S7 静默时段吞掉一切 @ 行为（消息已入库，只是不回复）
    if (inQuietHours()) {
      log(`[group ${event.group_id}] 收到 @机器人 消息但处于静默时段(${quietStart}:00-${quietEnd}:00)，忽略`);
      return;
    }

    // S8 手动总结关键词：P3b 已迁 summary 插件（priority 900）——文本含总结关键词时由分发带内
    // 最先的插件认领并异步触发概括，路由此处不再单独判定（见 plugins/summary.js）。
    // S9 剥前导 @ 得到问题文本
    const question = extractQuestion(rec, true);
    // S10 纯 @（问题为空）：回「@昵称 艾特PRTS干什么呀喵」提示并 return
    if (!question) {
      log(`[group ${event.group_id}] 收到仅@机器人（无内容）的消息`);
      const senderName = event.sender?.card || event.sender?.nickname || '群友';
      client.sendGroupMsg(event.group_id, `@${senderName} 艾特PRTS干什么呀喵`).catch((e) => err(`[group ${event.group_id}] 发送提示失败:`, e.message));
      return;
    }

    // S11 数据刷新指令：P3b 已迁 refresh 插件（priority 800，整串锚定正则 + ack + 异步执行，
    // 见 plugins/refresh.js）——路由不再单独判定，同 S8 一并由分发带认领。
    // S12+S13 确定性指令与 LLM 兜底统一经 registry 分发（summary 900/refresh 800 原 S8/S11 带 +
    // 指令 700–400 + chat 300 兜底带，带群与用户上下文）：dispatch 返回 string → 本层发送；
    // true = 插件自驱已处理（总结/刷新/chat 异步进行、不 await）。chat 插件恒返回 true 消费消息，
    // 故分发不再有落空路径——原「严格 null 才落 chat」边界内化为分发带末端（行为不变：LLM 兜底
    // 仍最晚执行、仍不 await、失败回退文案照发），见 plugins/chat.js
    const senderName = event.sender?.card || event.sender?.nickname || '群友';
    const cmdReply = registry.dispatch({
      lingo: lingo,
      arkdb: arkdb,
      analytics,
      groupId: event.group_id,
      userId: event.user_id,
      userName: senderName,
      text: question,
    });
    if (typeof cmdReply === 'string') {
      log(`[group ${event.group_id}] 指令响应: ${question.slice(0, 30)}`);
      client.sendGroupMsg(event.group_id, cmdReply).catch((e) => err(`[group ${event.group_id}] 指令发送失败:`, e.message));
    }
    return;
  }

  return { onEvent, getAllGroupIds, backfillHistory };
}
