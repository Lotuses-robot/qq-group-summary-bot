/*
 * 运行时装配与编排（core 主运行库入口；P1 由 src/index.js 拆出）。
 *
 * 职责：唯一装配者 + 消息路由链 + 生命周期编排（原 index.js 全文迁移，行为一字不改）：
 * 平台/服务实例（MessageStore/NapCatClient/Summarizer/Scheduler/Analytics/DataRefresher +
 * lingo/arkdb/cache/wiki/moegirl/wikipedia 知识服务共享单例）都在 createApp 内装配；
 * P3b 起手动总结/数据刷新/每日日报三个后台流程迁入 plugins/ 插件（summary/refresh/report，
 * 经 registry 分发带与 hooks.start 启定时器/调度），本文件只留 backfillHistory（WS connect
 * 一次性离线补偿）与 S1–S13 路由链骨架。WebUI 按 webui.enabled 条件装配（P3c 收尾后并入插件）。
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
import { LingoStore } from './lingo.js';
import { ArkDB } from './arkdb.js';
import { KnowledgeCache } from './cache.js';
import { WikiRetriever } from './wiki.js';
import { MoegirlRetriever } from './moegirl.js';
import { WikipediaRetriever } from './wikipedia.js';
import { ChatBrain, createChatPlugin } from '../plugins/chat.js';
import { createSummaryPlugin } from '../plugins/summary.js';
import { createRefreshPlugin } from '../plugins/refresh.js';
import { createReportPlugin } from '../plugins/report.js';
import { createWebUiPlugin } from '../plugins/webui.js';
import { commandPlugins } from '../plugins/index.js';
import { PluginRegistry } from './registry.js';
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
 * @param {Object} [overrides={}] - 测试注入点：store/client/summarizer/scheduler/analytics/
 *   refresher/brain（或 lingo/arkdb/cache/wiki/moegirl/wikipedia 任一单例）给值即代替内部
 *   new（缺省各按 config 实建）
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
  // TODO(死配置，见 refactor-proposal.md 待办)：config.schedule.hour/minute 从未生效——Scheduler
  // 只解构 dailyHour/dailyMinute（config 里没人写这两个键），日报恒 9:00。修复需立项决策，勿顺手改。
  const scheduler = overrides.scheduler || new Scheduler(config.schedule || {});
  const analytics = overrides.analytics || new Analytics(path.join(dataDir, 'messages.db'), path.join(dataDir, 'messages'));
  const refresher = overrides.refresher || new DataRefresher(path.join(dataDir, 'ark'), config.dataRefresh || {});

  // 检索与知识服务上移为共享单例（P3，refactor-proposal「服务上移」）：原 ChatBot 构造内 new 的
  // lingo/arkdb/cache 与三检索器改在此装配——注入 ChatBrain（字段引用同旧，chat() 正文零改动），
  // 同时供指令插件 ctx（S12）与 getStatus/refreshData/WebUI 借用同一实例（事实共享单例语义不变）
  const lingo = overrides.lingo || new LingoStore(llm.lingoFile);
  const arkdb = overrides.arkdb || new ArkDB(llm.arkdbDir);
  const cache = overrides.cache || new KnowledgeCache(llm.cacheFile, { ttlHours: llm.cacheTtlHours ?? 168 });
  const wiki = overrides.wiki || new WikiRetriever(llm);
  const moegirl = overrides.moegirl || new MoegirlRetriever(llm);
  const wikipedia = overrides.wikipedia || new WikipediaRetriever(llm);
  const brain = overrides.brain || new ChatBrain({ cfg: llm, lingo, arkdb, cache, wiki, moegirl, wikipedia });

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

  // 日报配置（report.*）：userId 私聊收件人、minMessages 活跃群消息门槛（默认 100）。
  // TODO(死配置，同 refactor-proposal.md 待办)：report.hour 从未生效——下行 dailyHour 是无消费方
  // 的遗读（report 插件只注入 userId/minMessages，触发时刻恒 9:00 由 Scheduler 缺省），勿顺手删/改。
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
  // ready（WS 就绪锚点）、backfillDone（离线补偿仅执行一次）
  let selfId = config.napcat.selfId || 0;
  let ready = false;
  let backfillDone = false;

  // 插件注册（P3 唯一装配点）：P2 四指令（commandPlugins 静态交付）+ 后台/服务插件
  // （依赖本闭包内的服务实例、配置派生量与就绪标志 → 在 createApp 内就地构造，不随静态数组）。
  // 分发次序由 priority 带决定：summary 900 = 原 S8、refresh 800 = 原 S11、指令 700–400、
  // chat 300 = 原 S13 LLM 兜底（分发带末端恒消费）；report/webui 仅 hooks（priority 0 无消息面）。
  const registry = new PluginRegistry();
  const summaryPlugin = createSummaryPlugin({
    store, summarizer, client, filterMessages,
    minMessages,
    manualCmds,
    isReady: () => ready,
  });
  const refreshPlugin = createRefreshPlugin({
    arkdb, refresher, client, store, trackedGroups,
    broadcast: config.dataRefresh?.announce === true,
    schedule: config.dataRefresh || {},
  });
  const reportPlugin = createReportPlugin({
    store, client, summarizer, scheduler, filterMessages,
    trackedGroups, getAllGroupIds,
    reportUserId, reportMinMessages,
    isReady: () => ready,
  });
  const chatPlugin = createChatPlugin({ brain, client });
  const webuiPlugin = createWebUiPlugin({
    cfg: config.webui || {},
    startCtx: { getStatus, getLingo: () => lingo, getConfig: () => config, refreshData },
  });
  for (const p of [commandPlugins, summaryPlugin, refreshPlugin, reportPlugin, chatPlugin, webuiPlugin].flat()) registry.register(p);

  /**
   * 数据更新编排公共入口（桥接层；P3b 起正文归 refresh 插件的 api.refresh——自动定时器/S11/WebUI
   * 三触发源共用同一 runner，见 plugins/refresh.js。本包装仅为 app 返回面与 WebUI ctx 保持旧句柄）。
   * @param {string|null} [notifyGroupId=null] - 透传 refresh 插件（同插件 JSDoc）
   * @returns {Promise<string>} 「【数据更新】…」结果文本
   */
  function refreshData(notifyGroupId = null) {
    return refreshPlugin.api.refresh(notifyGroupId);
  }

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
  });

  /** WebUI/状态页共享的状态快照（characters/relics/pools 计数前先确保 arkdb 已 load） */
  function getStatus() {
    arkdb.load();
    return {
      wsConnected,
      selfId,
      operators: arkdb.characters.size,
      relics: arkdb.relics.size,
      pools: arkdb.gachaPools.length,
      lingoCount: lingo.size(),
      messages: analytics.countMessages(),
      uptime: `${Math.floor((Date.now() - startedAt) / 60000)} 分钟`,
    };
  }

  /**
   * 启动（全部启动副作用在此，createApp 本身不碰网络/定时器）：
   * 挂退出信号 → registry.startAll（P3 收尾：refresh 数据自动更新定时器 + report 每日 9:00
   * 调度 + webui 面板按配置起停均经插件 hooks，原 start 内 setTimeout/scheduler.start/WebUI
   * 直建段已全部迁出）→ client.connect() 建 WS。
   * @returns {void}
   */
  function start() {
    // 生命周期收尾（注册先于一切启动副作用）：registry.stopAll 逆序停插件（webui 先关面板、
    // report 停每日调度器、refresh 清自动更新定时器），再关 WS，随后退出进程
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        log('收到退出信号，正在关闭...');
        stop();
        process.exit(0);
      });
    }

    // 后台插件启动（§3 步骤 3+6）：refresh hooks.start 注册数据自动更新定时器（先于 connect，
    // 与旧顺序相同；仅 dataRefresh.enabled !== false 时启用）→ report hooks.start 排下一个
    // 9:00 → webui hooks.start 按 webui.enabled !== false 起面板
    registry.startAll();

    // 启动收尾：connect 异步建 WS（置 closed 后不再重连）
    client.connect();

    log('QQ 群聊概括机器人已启动（仅 @ 触发总结；每日 9:00 发送昨日日报）');
  }

  /** 优雅停服（退出信号与测试共用）：registry.stopAll（webui 关面板、report 停调度、refresh 清定时器）→ 关 WS；不 exit（信号路径自行 exit） */
  function stop() {
    registry.stopAll();
    client.close();
  }

  return {
    config,
    services: { dataDir, llm, store, client, summarizer, brain, lingo, arkdb, cache, wiki, moegirl, wikipedia, scheduler, analytics, refresher, registry },
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
