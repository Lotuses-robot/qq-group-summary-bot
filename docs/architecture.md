# 总体架构

> 覆盖：目录结构、模块职责、启动装配顺序、消息路由链（S1–S13）、后台编排流程、静态依赖图、**已知怪癖与坑**。
> 文中行号引用基于 2026-09 的当前代码，改动后可能漂移，仅供参考定位。

## 1. 顶层视角

```
QQ 群友 ──消息──▶ NapCat(OneBot11 WS 服务) ──WS 事件──▶ 本 bot
                                                          │ ① 入库（JSONL+SQLite）
                                                          │ ② @检测 → 静默门 → 指令/插件分发
                                                          │ ③ LLM(OpenAI兼容) / 本地数据 / 三个Wiki
                                                          └──回复──▶ 群 / 私聊
```

- **消息入口**：NapCat 正向 WebSocket（`ws://127.0.0.1:3001`），OneBot 11 协议。
- **处理出口**：`send_group_msg`（群回复）、`send_private_msg`（日报私聊）。
- **LLM**：DeepSeek（默认 `api.deepseek.com/v1`，OpenAI 兼容 `/chat/completions`）。
- **知识**：本地（词典 + 方舟库 + 缓存）优先，联网检索兜底。

## 2. 目录与模块职责

```
src/            Node ESM；入口 src/index.js
  index.js      上帝文件（449 行）：装配全部实例 + 事件路由链 + 三个编排流程 + 生命周期
  napcat.js     OneBot 11 正向 WS 客户端（连接/重连/echo 请求-响应/事件回调）
  store.js      消息存储层：JSONL 追加持久化 + state 状态 + 时段提取（含文本工具函数）
  summarizer.js LLM 群聊概括器（manual/daily 两套 prompt）
  chat.js       ChatBot：AI 群聊（上下文记忆 + 三级知识库编排 + 本地干员库）——同时是词典/缓存/干员库/三个检索器的"宿主"
  commands.js   确定性指令大分发表（150 行 if-else，14 条规则，5 个领域）
  wiki.js       PRTS.Wiki 检索器（方舟百科；带反爬冷却/重试/清洗）
  moegirl.js    萌娘百科检索器（社区梗 + 通用 ACG 百科；含 17 个方舟主词条兜底）
  wikipedia.js  维基百科检索器（可选，默认关；需要代理）
  arkdb.js      本地明日方舟数据库（干员/档案/藏品/卡池 + 语义模糊匹配 + 抽卡引擎）
  lingo.js      本地梗词典（可维护；命中即用，优先级最高的知识源）
  cache.js      知识缓存（同问题二次提问直接命中，TTL 168h）
  analytics.js  SQLite 分析层（node:sqlite；消息实时入库 + 抽卡记录 + 活跃榜/统计）
  refresher.js  数据定期更新（ArknightsGameData 下载：ETag 比对 + 结构校验 + 原子写入）
  scheduler.js  每日定时器（单任务 HH:MM，链式 setTimeout，防重入）
  webui.js      Web 管理面板（零依赖 node:http，页面内联，Bearer/query 鉴权）
  filter.js     敏感内容过滤（隐私正则 + 敏感词黑名单；纯函数，零 import）
  logger.js     日志（console + 按天轮转文件 logs/YYYY-MM-DD.log，自动清 14 天前）
data/           （.gitignore 排除）运行数据：消息/状态/词典/缓存/干员库/SQLite
logs/           日志
config.example.json / config.json   配置模板（脱敏）与实配（含密钥）
```

模块行数规模（2026-09）：合计约 3100 行，最大为 index.js(449)、arkdb.js(400)、chat.js(341)。

## 3. 启动装配顺序（index.js 顶部 = 一次成型，无懒加载）

1. 读配置：`CONFIG_PATH` 环境变量 → `config.json`；`llm.apiKey` 缺失回退 `LLM_API_KEY` 环境变量；仍空 → `err` + `process.exit(1)`。
2. 依次构造（顺序即依赖关系）：
   - `MessageStore(dataDir)` → 建 `data/messages/`、`data/state/`
   - `NapCatClient(wsUrl, {selfId, accessToken})`（WS 客户端，此刻不连）
   - `Summarizer(config.llm)`（LLM 概括器）
   - `ChatBot(config.llm)`（AI 群聊；**内部 new 出 7 个子服务**：WikiRetriever / MoegirlRetriever / WikipediaRetriever / LingoStore / KnowledgeCache / ArkDB / Semaphore）
   - `Scheduler(config.schedule)`（注意：只解构 `dailyHour/dailyMinute`，见 §7 坑 1）
   - `Analytics(dataDir/messages.db, dataDir/messages)`（SQLite 建表）
   - `DataRefresher(dataDir/ark, config.dataRefresh)`（读 .etags.json）
3. 同步注册**数据自动刷新定时器**：首次启动后 `firstDelayMinutes`(30) 分钟 → 之后每 `intervalHours`(24) 小时（`dataRefresh.enabled !== false` 才注册；模块加载期即注册，先于 connect）。
4. `for (gid of config.groups) store.loadFromDisk(gid)`——仅预载**今天**窗口；`groups=[]` 则什么都不预载。
5. 注册 `SIGINT/SIGTERM`：`scheduler.stop() → client.close() → process.exit(0)`。
6. `client.connect()`（异步建 WS）；`scheduler.start(dailyReport)`（排下一个 9:00，不会立即跑）；`webui.enabled` 时 `webui.start({...})` 立即 listen。
7. WS open 后 NapCat 合成 `lifecycle/connect` 事件 → `ready=true` → 回填 selfId → `backfillHistory()`（仅一次）。

## 4. 消息路由链（index.js 事件处理，保真 S1–S13）

收到任意 WS 事件后按序执行；**一旦命中即 return**。表内行号为 index.js 现码。

| # | 判定 | 命中行为 | 未命中流向 |
|---|---|---|---|
| S1 | `meta_event` 且 `lifecycle/connect`（L326） | `ready/wsConnected=true`；回填 selfId（若 0）；异步 `backfillHistory()` | ↓ |
| S2 | 非 `message` 或非群消息（L345） | return | ↓ |
| S3 | 自己发的消息且 `includeSelf=false`（L346；selfId 为 0 时跳过本行） | return | ↓ |
| S4 | 群不在 `groups` 白名单（空数组 = 全部群）（L347） | return | ↓ |
| S5 | **消息入库先于一切**：`store.addMessage`（L349）；重复 id/空文本返回 null → return；随后 `analytics.record`（L351） | — | ↓ |
| S6 | @检测三方式（L353-357）：at 段全等 / 文本含 `@<selfId>` / 子串含 `@机器人` 或 `@PRTS` | — | 未 @ → return |
| S7 | 静默时段 `inQuietHours`（L361；默认 0:00–8:00；`enabled:false` 关闭） | log 后 return（**吞掉一切 @ 行为，入库照常**） | ↓ |
| S8 | 文本 **includes** 任一 `manualSummary` 关键词（默认 总结/`/总结`/`#总结`）（L366；对含 @ 的完整文本判） | fire-and-forget `triggerSummary`，return | ↓ |
| S9 | 剥前导 @（`extractQuestion`：先 `^@机器人\s*` 再 `^@[^\s@]{1,30}\s*`） | — | ↓ |
| S10 | 问题为空（纯 @ 无内容） | 回复「@昵称 艾特PRTS干什么呀喵」，return | ↓ |
| S11 | 问题整串锚定 `^(刷新数据\|更新数据\|更新数据库)$` | ack「正在更新本地数据库，稍候…」→ 异步 `refreshData(gid)`；失败发错误消息；return | ↓ |
| S12 | `tryCommand({lingo,arkdb,analytics,groupId,userId,userName}, question)` 确定性指令（L393） | 返回**非 null** → 发送回复，return | `null` → ↓ |
| S13 | AI 兜底 `chatBot.chat(...)`（L407）：**不 await**，`.then(reply→reply&&send).catch(err)` | — | — |

要点：

- **@检测语义**：at 段用字符串全等比较；`@机器人`/`@PRTS` 是大小写敏感的**子串**匹配（"不要@机器人"也会命中）。
- **入库时机**：非 @ 消息、静默时段消息全部照常入库并计数，只是不回复。
- **指令 > chat**：只有 14 条规则全部不命中（返回严格 `null`）才会落 LLM 兜底。
- **静默时段优先级最高**：先于关键词与指令，后于入库。
- 回复发送用 `auto_escape: true`，群内 at 为文本模拟。

## 5. 指令分发表（commands.js，14 条规则的内部顺序 = 优先级）

| 域 | 规则（按代码顺序） | 说明 |
|---|---|---|
| 词典 | 学习/纠正/记/定义 `词=释义` 或 `词 释义` | 命中 `lingo.learn` 并落盘 |
| 词典 | 忘记/删除/删 `词` | |
| 词典 | 查词/词典查/释义 `词` | |
| 词典 | 整串 词典 / 词条数 | 列前 30 条 |
| 干员 | 查干员/干员 `名` | 模糊匹配兜底；未找到提示 |
| 干员 | 查藏品/藏品 `名` | 模糊匹配兜底 |
| 干员 | 干员生日/生日 `名` | |
| 干员 | 整串 今日生日 / 今天谁生日 | |
| 抽卡 | 整串 卡池 / 卡池列表 | 当前开放池 + UP 干员 |
| 抽卡 | 抽卡记录/我的抽卡/抽卡统计 `[N]` | **必须先于"单抽/十连"规则**（顺序敏感，勿合并正则） |
| 抽卡 | 整串 谁最欧/群欧皇/欧气榜 | SQLite 抽卡记录排行 |
| 抽卡 | 单抽/十连/抽卡 `[池]` | 真实卡池出率；无开放池降级常驻模拟；逐抽记库 |
| 统计 | 活跃榜/活跃统计/活跃度 `[N天]` | 依赖 SQLite |
| 统计 | 整串 群统计/消息统计 | |

跨领域无前缀冲突；领域内顺序敏感点集中在抽卡域（记录先于抽卡）。

## 6. 三个后台编排流程

### 6.1 离线补偿 backfillHistory（connect 生命周期内，仅一次）

`sinceTs = max(store.getLastSeenTs(), now − backfill.maxHours×3600)`（默认 72h）；群集合 = `config.groups` 非空用之，否则 `get_group_list`（失败回退磁盘已跟踪群）；每群 `get_group_msg_history(message_seq:0, count:1000)` → 过滤 `time ≥ sinceTs` 与批内重复 → 逐条 `store.addHistoryMessage`（与内存/磁盘双去重）+ `analytics.record`；整批有新增才 `setLastSeenTs(latest)`（全局单值，只增不减）；单群失败记日志继续。

### 6.2 每日日报 dailyReport（scheduler 9:00 回调）

守卫：`ready` + 配置了 `report.userId`。口径：**昨日本地自然日** `[昨日00:00, 今日00:00)`；每群 `store.loadFromDisk(gid, yesterdayStart, todayStart)` 载入该日期段再 `collectRange` + 敏感过滤；消息数 ≥ `report.minMessages`(100) 才算活跃群；逐群 `summarizer.summarize(...,'daily')`，单群失败继续；全部失败则不发送；成功则私聊发给 `report.userId`。**不写任何 lastSummaryAt/lastSeen 状态**。

### 6.3 数据自动/手动刷新 refreshData（3 个触发源共用同一函数）

触发源：(a) §3 的启动定时器；(b) 群内指令「刷新数据」（S11）；(c) WebUI POST `/api/refresh`。

步骤：快照旧 6★/5★ 干员与卡池 id → `refresher.refresh()`（依次 干员表→档案→藏品→卡池；ETag 304 跳过、校验失败抛错）→ 有更新则 `arkdb.reload()` 热重载并 diff 出新增 6★/5★/新开放卡池 → 播报仅当 `dataRefresh.announce === true`；带 `notifyGroupId`（群指令）时**必发**「【数据更新】…」结果消息，否则把新增播报广播给全部跟踪群。发送失败全部吞掉只记日志。

## 7. 静态依赖图（import 边，箭头 = 被依赖）

```
logger ← 几乎所有模块（napcat/store/analytics/summarizer/chat/wiki/moegirl/wikipedia/
         arkdb/lingo/cache/scheduler/webui/refresher/commands/index）
store ← summarizer（仅借 hhmm 函数）、index
wiki  ← moegirl、wikipedia、chat（共享 extractKeywords/isArknightsRelated）
chat  ← wiki/moegirl/wikipedia/lingo/cache/arkdb（构造内 new；lingo/arkdb 被 index/commands/webui 反向借用）
index ← 除 logger 外全部（唯一装配者）
filter.js 零 import；commands.js 只 import logger
```

**实例化关系**：`index.js` new 出 MessageStore / NapCatClient / Summarizer / ChatBot / Scheduler / Analytics / DataRefresher / WebUI 共 8 个顶层实例；`ChatBot` 构造内再 new 7 个子服务，其中 **LingoStore 与 ArkDB 是事实上的共享单例**——commands.js（经 ctx 注入）与 WebUI（经 `getLingo()`）都在用 `chatBot.lingo` / `chatBot.arkdb`。这是结构上最大的耦合点（详见 [refactor-proposal.md](refactor-proposal.md)）。

## 8. 已知怪癖与坑（改代码前必读）

1. **死配置（bug）**：`config.schedule.hour/minute` 与 `config.report.hour` **从未生效**——`Scheduler` 解构的是 `dailyHour/dailyMinute`，index 传的是 `schedule` 对象，实际恒为 **9:00**。README 声称可配，实为假象。修复见 refactor-proposal 待办，勿在此处顺手改。
2. **wsConnected 永不复位**：WS 断线自动重连成功后不回调 index，`wsConnected` 一旦 true 不再变 false → WebUI 状态页可能显示在线（假象）。napcat 内部重连正常。
3. **缓存键跨群共享**：知识缓存 `q:<question>` 不含群号/提问人前缀，同问题在不同群命中同一缓存（含内容已过 TTL 判定）。属既有语义。
4. **store 同步 IO 在路由热路径**：`addMessage` 同步 `appendFileSync`，写在一切路由判断之前；写失败异常会中断该消息的路由（不入 analytics、不回复）。异步化或加锁会改变现有行为。
5. **首次消息可能卡顿**：Analytics 的 SQLite 首次写入会同步全量扫描导入 `data/messages/` 下全部 JSONL（`_ensureImported`）。
6. **Summarizer 与 ChatBot 的 LLM 默认值不同**：maxTokens 2048 vs 1024、temperature 0.7 vs 0.8、失败兜底文案仅 chat 有、仅 chat 有并发信号量（3）——两处都是独立 fetch、**都无 HTTP 超时/重试**；moegirl 的 fetch 也无超时（wiki/wikipedia 有）。
7. **extractQuestion 只剥 1–2 段前导 @**：`内容 @机器人` 这类尾部/中部 @ 会原样进入问题文本。
8. **命令未命中也会进 LLM**：任何 @ 且非空文本，若 14 条规则与刷新/总结关键词都不命中，都会消耗一次 LLM 调用（`chatEnabled:false` 时不发不耗）。
9. **lastSeenTs 是全局单值**（非按群），backfill 的起点由任一群的最后消息推进。
10. **node:sqlite 需 Node ≥22.5**；`package.json` engines 写的 ≥18 过宽（2026-09 现状）。
