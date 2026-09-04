/*
 * 运行时装配与编排（core 主运行库入口；P1 由 src/index.js 拆出）。
 *
 * 职责：唯一装配者 + 生命周期编排（原 index.js 全文迁移，行为一字不改）：
 * 平台/服务实例（MessageStore/NapCatClient/Summarizer/Scheduler/Analytics/DataRefresher +
 * lingo/arkdb/cache/wiki/moegirl/wikipedia 知识服务共享单例）都在 createApp 内装配；
 * 消息路由判定域（S1–S13 + backfillHistory + getAllGroupIds）P5b 起拆至 core/routing.js
 * （createRouting 工厂：装配段创建实例、预载后挂 onEvent，判定正文见 architecture §4/§6.1）——
 * P3b 起手动总结/数据刷新/每日日报三个后台流程迁入 plugins/ 插件（summary/refresh/report，
 * 经 registry 分发带与 hooks.start 启定时器/调度）。WebUI 按 webui.enabled 条件装配（P3c 收尾后并入插件）。
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

import { NapCatClient } from './platform/napcat.js';
import { MessageStore } from './platform/store.js';
import { Summarizer } from './platform/summarizer.js';
import { Scheduler } from './platform/scheduler.js';
import { filterMessages as filterMessagesRaw } from './platform/filter.js';
import { Analytics } from './platform/analytics.js';
import { DataRefresher } from './platform/refresher.js';
import { LingoStore } from './knowledge/lingo.js';
import { ArkDB } from './knowledge/arkdb.js';
import { KnowledgeCache } from './knowledge/cache.js';
import { WikiRetriever } from './knowledge/wiki.js';
import { MoegirlRetriever } from './knowledge/moegirl.js';
import { WikipediaRetriever } from './knowledge/wikipedia.js';
import { ChatBrain, createChatPlugin } from '../plugins/chat.js';
import { createSummaryPlugin } from '../plugins/summary.js';
import { createRefreshPlugin } from '../plugins/refresh.js';
import { createReportPlugin } from '../plugins/report.js';
import { createWebUiPlugin } from '../plugins/webui.js';
import { commandPlugins } from '../plugins/index.js';
import { PluginRegistry } from './registry.js';
import { createRouting } from './routing.js';
import { log, err } from './platform/logger.js';

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

  // 日报配置（report.*）：触发时刻 hour/minute（默认 9:00）——2026-09 立项修复：旧
  // schedule.hour/minute 与 report.hour 遗读均为死键，现 report.* 生效、schedule.* 废弃
  // （见 config.example 与 refactor-proposal 待办）；userId 私聊收件人、minMessages 活跃群门槛
  const report = config.report || {};
  const reportHour = report.hour ?? 9;
  const reportMinute = report.minute ?? 0;
  const reportUserId = report.userId || 0;
  const reportMinMessages = report.minMessages ?? 100;

  const store = overrides.store || new MessageStore(dataDir);
  const client = overrides.client || new NapCatClient(config.napcat.wsUrl, {
    selfId: config.napcat.selfId || 0,
    accessToken: config.napcat.accessToken || '',
  });
  const summarizer = overrides.summarizer || new Summarizer(llm);
  // 触发时刻取 report.hour/minute（上段派生）；Scheduler 内部参数名仍为 dailyHour/dailyMinute
  const scheduler = overrides.scheduler || new Scheduler({ dailyHour: reportHour, dailyMinute: reportMinute });
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

  // startedAt：启动时刻（供 WebUI 状态页 uptime）；WS 在线标志 wsConnected 并入下方 state
  //（断开经 napcat 合成 disconnect 事件复位、重连后 connect 事件置回——2026-09 修复坑 2）
  const startedAt = Date.now();

  // 静默时段配置（quiet.*）：默认 0:00–8:00；enabled !== false 视为开启（S7 判定用）
  const quiet = config.quiet || {};
  const quietEnabled = quiet.enabled !== false;
  const quietStart = quiet.start ?? 0;
  const quietEnd = quiet.end ?? 8;
  // 敏感内容过滤开关（filter.*，默认开）与包装函数：关闭时原样放行（kept=全部、filtered=空）
  const filterEnabled = config.filter?.enabled !== false;
  const filterMessages = (recs) => (filterEnabled ? filterMessagesRaw(recs) : { kept: recs, filtered: [] });

  // 生命周期内共享可变状态（P5b 起单点 state 对象：路由链 core/routing.js 读写、runtime 侧
  // isReady/getStatus 闭包读同一对象——取代原并列 let 闭包）：selfId（初始取配置，connect 后
  // 以 get_login_info 回填）、ready（WS 就绪锚点）、backfillDone（离线补偿仅执行一次）、
  // wsConnected（WS 在线标志）
  const state = { selfId: config.napcat.selfId || 0, ready: false, backfillDone: false, wsConnected: false };

  // 插件注册（P3 唯一装配点）：P2 四指令（commandPlugins 静态交付）+ 后台/服务插件
  // （依赖本闭包内的服务实例、配置派生量与就绪标志 → 在 createApp 内就地构造，不随静态数组）。
  // 分发次序由 priority 带决定：summary 900 = 原 S8、refresh 800 = 原 S11、指令 700–400、
  // chat 300 = 原 S13 LLM 兜底（分发带末端恒消费）；report/webui 仅 hooks（priority 0 无消息面）。
  const registry = new PluginRegistry();
  // 路由判定域实例（P5b 起 = core/routing.js 工厂）：S1–S13 判定链 + backfillHistory +
  // getAllGroupIds 原是下方函数声明（依赖提升），拆出后为工厂返回值属性——故必须先于插件
  // 注册创建（report 插件注册参数 getAllGroupIds 取之）；state 对象由装配段构造，路由与插件
  // 注册段（isReady 闭包）读写同一份
  const routing = createRouting({
    store, analytics, client, registry, lingo, arkdb, state,
    includeSelf, tracksGroup, trackedGroups,
    quietEnabled, quietStart, quietEnd,
    backfillMaxHours: config.backfill?.maxHours ?? 72,
  });
  const summaryPlugin = createSummaryPlugin({
    store, summarizer, client, filterMessages,
    minMessages,
    manualCmds,
    isReady: () => state.ready,
  });
  const refreshPlugin = createRefreshPlugin({
    arkdb, refresher, client, store, trackedGroups,
    broadcast: config.dataRefresh?.announce === true,
    schedule: config.dataRefresh || {},
  });
  const reportPlugin = createReportPlugin({
    store, client, summarizer, scheduler, filterMessages,
    trackedGroups, getAllGroupIds: routing.getAllGroupIds,
    reportUserId, reportMinMessages,
    isReady: () => state.ready,
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

  // 事件路由链挂载：S1–S13 判定域全在 core/routing.js（P5b 拆出：S 链次序/文案/静默门语义
  // 零改动，见 architecture §4——S8/S11 关键词与刷新指令早已内化为 summary/refresh 插件分发带）。
  // 路由实例在插件注册前已创建（report 插件经 routing.getAllGroupIds 取群集合），此处预载完成后
  // 才挂 onEvent；connect/selfId 回填/backfillDone 等状态变更在 routing 内经共享 state 对象完成
  // （runtime 侧 getStatus/isReady 闭包读同一份，见 getStatus）
  client.onEvent(routing.onEvent);

  /** WebUI/状态页共享的状态快照（characters/relics/pools 计数前先确保 arkdb 已 load） */
  function getStatus() {
    arkdb.load();
    return {
      wsConnected: state.wsConnected,
      selfId: state.selfId,
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

    log(`QQ 群聊概括机器人已启动（仅 @ 触发总结；每日 ${reportHour}:${String(reportMinute).padStart(2, '0')} 发送昨日日报）`);
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
