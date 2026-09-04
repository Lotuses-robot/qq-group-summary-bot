# 总体架构

> 覆盖：目录结构、模块职责、启动装配顺序、消息路由链（S1–S7 + 插件分发带）、后台编排流程、静态依赖图、**已知怪癖与坑**。
> 代码已按「core 主运行库 + plugins」重构（P0–P3，2026-09，见 [refactor-proposal.md](refactor-proposal.md)），P5 再对 core 做子目录归类（platform/ + knowledge/）并把消息路由判定域从 runtime.js 拆到 core/routing.js（本文 §2 即 P5 后布局）；文中行号仅核心文件引用，改动后可能漂移。

## 1. 顶层视角

```
QQ 群友 ──消息──▶ NapCat(OneBot11 WS 服务) ──WS 事件──▶ 本 bot
                                                          │ ① 入库（JSONL+SQLite）
                                                          │ ② @检测 → 静默门 → 插件分发带
                                                          │ ③ LLM(OpenAI兼容) / 本地数据 / 三个Wiki
                                                          └──回复──▶ 群 / 私聊
```

- **消息入口**：NapCat 正向 WebSocket（`ws://127.0.0.1:3001`），OneBot 11 协议。
- **处理出口**：`send_group_msg`（群回复）、`send_private_msg`（日报私聊）。
- **LLM**：DeepSeek（默认 `api.deepseek.com/v1`，OpenAI 兼容 `/chat/completions`）。
- **知识**：本地（词典 + 方舟库 + 缓存）优先，联网检索兜底。

## 2. 目录与模块职责（P5 后：core 顶层三件 + platform/ + knowledge/ 两子目录 + plugins）

```
src/            Node ESM；入口 src/index.js（引导 17 行：import { main } 按入口判定执行）
  core/         主运行库——装配层 + 平台/公共服务 + 知识单例（原 src/ 平铺模块迁入；P5 按职责归类）
    runtime.js   createApp(config, overrides) 装配叙事 + start/stop 生命周期 + main()
                 （读 config、LLM_API_KEY 校验）；P5 拆块后不再含路由判定实现，只挂载
                 routing.js 产出的 onEvent（唯一 import 插件工厂的文件）
    registry.js  插件注册表：register/dispatch（priority 降序，string/true 短路）/
                 startAll/stopAll + PRIORITY 带常量（测试锁定 keys）
    routing.js   【P5b 新增】消息路由判定域工厂：createRouting(options) → {onEvent,
                 getAllGroupIds, backfillHistory}——S1–S7/S9/S10 判定链 + 离线补偿 +
                 群枚举（P5 自 runtime.js 逐字拆出）；服务全经 options 注入，仅静态
                 import platform/ 的 logger/store
    platform/    平台与公共服务（P5 归类，9 文件）
      napcat.js     OneBot 11 正向 WS 客户端（连接/重连/echo 请求-响应/事件回调）
      store.js      消息存储层：JSONL 追加持久化 + state 状态 + 时段提取（含文本工具纯函数）
      summarizer.js LLM 群聊概括器（manual/daily 两套 prompt）
      scheduler.js  每日定时器（单任务 HH:MM，链式 setTimeout，防重入）
      analytics.js  SQLite 分析层（node:sqlite；消息实时入库 + 抽卡记录 + 活跃榜/统计）
      refresher.js  数据定期更新（ArknightsGameData 下载：ETag 比对 + 结构校验 + 原子写入）
      filter.js     敏感内容过滤（隐私正则 + 敏感词黑名单；纯函数，零 import）
      logger.js     日志（console + 按天轮转文件 logs/YYYY-MM-DD.log，自动清 14 天前）
      http.js       fetch 包装：单次尝试超时 + 网络错误/超时/5xx 重试（fetchRetry；2026-09 起 summarizer/chat/moegirl 调用点共用）
    knowledge/   知识单例（P5 归类，6 文件；对 platform/ 只依赖 logger 与 http）
      lingo.js      本地梗词典（可维护；命中即用，优先级最高的知识源）
      arkdb.js      本地方舟数据库（干员/档案/藏品/卡池 + 语义模糊匹配 + 抽卡引擎）
      cache.js      知识缓存（同问题二次提问直接命中，TTL 168h）
      wiki.js       PRTS.Wiki 检索器（带反爬冷却/重试/清洗）+ 纯函数 extractKeywords/isArknightsRelated
      moegirl.js    萌娘百科检索器（社区梗 + 通用 ACG 百科；17 个方舟主词条兜底）
      wikipedia.js  维基百科检索器（可选，默认关；需要代理）
  plugins/       功能插件——互不 import；服务一律经 createApp 注入（构造注入 / dispatch ctx）
    index.js      commandPlugins 装配清单（4 个指令插件集中交付 runtime 注册）
    lingo.js      ◇ 词典指令（学习/忘记/查词/词典——规则 1–4，带 700）
    ark.js        ◇ 干员/藏品/生日指令（查干员/查藏品/生日——规则 5–8，带 600）
    gacha.js      ◇ 抽卡指令（卡池/抽卡记录/单抽十连/欧气榜——规则 9–11，带 500）
    stats.js      ◇ 统计指令（活跃榜/群统计——规则 12–14，带 400）
    summary.js    手动总结插件（带 900 = 原 S8；关键词认领 + per-group 互斥 + doSummary 编排）
    refresh.js    数据刷新插件（带 800 = 原 S11；指令认领 + hooks.start 自动定时器 + api.refresh 公共 runner）
    report.js     日报插件（仅 hooks：hooks.start 注册每日调度，时刻取 report.hour/minute，缺省 9:00）
    chat.js       AI 群聊（ChatBrain）+ 兜底分发插件（带 300 = 原 S13，分发带末端恒消费）
    webui.js      Web 管理面板（仅 hooks：hooks.start 按配置 listen；stop() 关停）
test/           node:test（npm test）
  baseline/      重构前行为基线（直测 store/analytics/lingo/arkdb/commands 语义）
  smoke/         import 面 / 注册表（含 PRIORITY keys 断言）/ 插件接线 / createApp 全链集成冒烟
data/           （.gitignore 排除）运行数据：消息/状态/词典/缓存/干员库/SQLite
logs/           日志
config.example.json / config.json   配置模板（脱敏）与实配（含密钥）
```

模块行数规模（2026-09，P5 落地后实测，含注释/空行）：src/ 合计约 5.1k 行——core/ ≈3.5k（runtime.js 269 行装配叙事、routing.js 225 行路由判定域、registry.js 137、platform/ 1.5k、knowledge/ 1.4k）、plugins/ ≈1.6k。

## 3. 启动装配顺序（createApp 纯装配 → start() 副作用）

P1 起装配与启动拆两层：`createApp(config, overrides)` **纯装配零副作用**（不连网、不起定时器、不 listen；overrides 可注入测试替身），`start()` 才产生全部启动副作用；`main()`（core/runtime.js 内）读配置 → createApp → start（src/index.js 只引导）。

1. 读配置（main）：`CONFIG_PATH` 环境变量 → `config.json`；`llm.apiKey` 缺失回退 `LLM_API_KEY`；仍空 → `err` + `process.exit(1)`。
2. createApp 按依赖序构造（缺省全部实建，overrides 同名键覆盖实例）：
   `MessageStore(dataDir)`（建 data/messages/、data/state/）→ `NapCatClient(wsUrl, {selfId, accessToken})`（此刻不连）→ `Summarizer(llm)` → `Scheduler({dailyHour, dailyMinute})`（时刻取 `report.hour/minute`，缺省 9:00；旧 `schedule.*` 键废弃，见 §8 坑 1）→ `Analytics(dataDir/messages.db, dataDir/messages)`（SQLite 建表）→ `DataRefresher(dataDir/ark, dataRefresh)` → 知识服务上移为共享单例：`LingoStore / ArkDB / KnowledgeCache / WikiRetriever / MoegirlRetriever / WikipediaRetriever` → `ChatBrain({cfg, lingo, arkdb, cache, wiki, moegirl, wikipedia})`（构造注入，替代旧 ChatBot 构造内 new 7 子服务）→ `PluginRegistry` → `createRouting(...)`（P5b：S1–S13 路由判定域工厂，core/routing.js；**先于插件注册**——report 插件依赖其产出的 getAllGroupIds）→ 就地构造插件并 register：commandPlugins（plugins/index.js 静态交付）+ summary/refresh/report/chat/webui 五工厂（依赖本闭包实例与就绪标志，createApp 内 createXxxPlugin(deps)）→ 预载 → `client.onEvent(onEvent)` 挂载路由（判定域挂载点）。
3. 预载「今天」窗口：`for (gid of config.groups) store.loadFromDisk(gid)`（groups=[] 则什么都不预载；日报/概括按需另载日期段）。
4. `start()`：注册 `SIGINT/SIGTERM`（stop() → `process.exit(0)`）→ `registry.startAll()`（按 priority 降序调插件 hooks.start，实际执行序：refresh 注册数据自动刷新定时器[§6.3 触发源 a] → report 排下一个每日日报[经 scheduler.start，触发时刻取 report.hour/minute（缺省 9:00）] → webui 按 `webui.enabled !== false` 起面板；旧 start 内 setTimeout/scheduler.start/WebUI 直建段全部迁入插件）→ `client.connect()`。
5. WS open 后 NapCat 合成 `lifecycle/connect` 事件 → routing S1 段置 `state.ready/wsConnected`（state 为 runtime 与 routing 共享的可变状态对象）→ 回填 selfId（若 0）→ `backfillHistory()`（仅一次）。
6. `stop()`（信号路径与测试共用）：`registry.stopAll()`（priority 逆序：webui 关面板 → report 停调度 → refresh 清定时器）→ `client.close()`。

## 4. 消息路由链（core/routing.js 判定段 S1–S7/S9/S10 + 插件分发带）

收到任意 WS 事件后按序执行；**一旦命中即 return**。core 判定段全部在 core/routing.js 的 createRouting 产出 onEvent 回调内（runtime.js 装配期挂载到 client）；
原 S8/S11/S12/S13 的产品行为已迁插件，由分发带承接（priority 降序、首个 string/true 短路）。
S# 编号保留为行为契约锚点（CLAUDE.md 红线与 refactor-proposal 保真清单沿用同一套叫法）。

| # | 判定（core/routing.js） | 命中行为 | 未命中流向 |
|---|---|---|---|
| S1 | `meta_event` 且 `lifecycle/connect` | `state.ready/wsConnected=true`；回填 selfId（若 0）；异步 `backfillHistory()`（仅一次） | ↓ |
| S2 | 非 `message` 或非群消息 | return | ↓ |
| S3 | 自己发的消息且 `includeSelf=false`（selfId 为 0 时本行自动跳过） | return | ↓ |
| S4 | 群不在 `groups` 白名单（空数组 = 全部群） | return | ↓ |
| S5 | **消息入库先于一切**：`store.addMessage`（重复 id/空文本返回 null → return）；随后 `analytics.record` | — | ↓ |
| S6 | @检测三方式：at 段 qq 与 selfId 字符串全等 / 文本含 `@<selfId>` / 子串含 `@机器人` 或 `@PRTS` | — | 未 @ → return |
| S7 | 静默时段 `inQuietHours`（默认 0:00–8:00；`enabled:false` 关闭） | log 后 return（**吞掉一切 @ 行为，入库照常**） | ↓ |
| S9 | 剥前导 @（`extractQuestion`：先 `^@机器人\s*` 再 `^@[^\s@]{1,30}\s*`） | — | ↓ |
| S10 | 问题为空（纯 @ 无内容） | 回复「@昵称 艾特PRTS干什么呀喵」，return | ↓ |
| S12 | **插件分发带** `registry.dispatch(ctx)`（text = 剥 @ 后的问题文本） | 见下方分发表；string → routing 层发送 | — |

分发带（dispatch 内按 priority 降序逐插件调用，首个 string/true 即短路；ctx = {lingo, arkdb, analytics, groupId, userId, userName, text}）：

| 带 | 插件（文件） | 认领判定 | 命中行为 |
|---|---|---|---|
| 900 | summary（plugins/summary.js）＝原 S8 | 问题文本含任一 `manualSummary` 关键词 | 返回 true；自驱异步 doSummary（per-group 互斥） |
| 800 | refresh（plugins/refresh.js）＝原 S11 | 问题整串锚定 `^(刷新数据\|更新数据\|更新数据库)$` | 返回 true；先 ack「正在更新本地数据库，稍候…」再异步 api.refresh，失败补发错误消息 |
| 700 | lingo（plugins/lingo.js）＝原 S12 词典段 | 学习/忘记/查词/词典规则（规则 1–4） | 返回 string（待发送）或 null（未命中） |
| 600 | ark（plugins/ark.js） | 干员/藏品/生日规则（规则 5–8） | 同左 |
| 500 | gacha（plugins/gacha.js） | 抽卡/记录/欧气榜规则（规则 9–11） | 同左 |
| 400 | stats（plugins/stats.js） | 活跃榜/群统计规则（规则 12–14） | 同左 |
| 300 | chat（plugins/chat.js）＝原 S13 | 恒到达（分发带末端） | 返回 true；自驱异步 `brain.chat(...)`（不 await；reply 非空才群发） |

分发返回值处理（routing S12 段）：`string` → 路由层群发该文案（`auto_escape: true`、群内 at 为文本模拟，旧语义不变）并记指令日志；`true` → 插件自驱（总结/刷新/chat 均异步进行、本层不发送）。chat 插件恒 true 消费 → **dispatch 不再有落空路径**——原「严格 null 才落 chat」边界内化为带末端（行为不变：LLM 兜底仍最晚执行、仍不 await、brain 内失败回退 defaultReply 文案照发）。report/webui 插件 priority 0，不占任何带（handleMessage 恒 null，仅 hooks）。

要点：

- **@检测语义**：at 段 qq 用字符串全等比较；`@机器人`/`@PRTS` 是大小写敏感的**子串**匹配（"不要@机器人"也会命中）。
- **入库时机**：非 @ 消息、静默时段消息全部照常入库并计数，只是不回复。
- **指令 > chat**：指令带（700–400）未命中才轮到 chat 带末端消费；chatEnabled=false 时 chat 整链短路（@ 消息无回复，行为同旧 S13）。
- **静默时段优先级最高**：先于关键词与指令，后于入库。
- **关键词判定基准（2026-09 已决策，见 §8 坑 11）**：手动总结关键词在分发带内对**剥 @ 后的问题文本**判。常规「@机器人 总结」（带空格或 @ 段后另起文本）与旧 S8（对含 @ 完整文本判）等价；**紧贴 @ 无空格的整串**（如文本「@PRTS总结」、at 段缺 name 时「@10001总结」）整串被 extractQuestion 前导正则吞掉 → 落 S10 空 @ 提示、不触发总结——**既定语义**（旧 S8 会触发，属历史行为，不回退）。
- **S10 空@ 回复在分发带之前**：纯 @ 消息不经过任何插件（含 summary）——见上条差异。
- 刷新指令（refresh 插件）与总结关键词不冲突：前者整串锚定、后者子串包含，带序 900 > 800。

## 5. 指令分发表（4 个命令插件，域内序 = 文件内代码序、域间序 = priority 带）

规则按领域拆在 4 个插件文件（plugins/index.js 的 commandPlugins 数组交付 runtime 注册）；
**14 条规则的内部顺序即优先级**：域内代码序 + 域间带 700（词典）> 600（干员）> 500（抽卡）> 400（统计），
与旧 commands.js 线性分发表逐一对应（registry 测试断言 PRIORITY keys 锁定带序）。

| 域（插件文件） | 规则（按代码顺序） | 说明 |
|---|---|---|
| 词典（lingo.js） | 学习/纠正/记/定义 `词=释义` 或 `词 释义` | 命中 `lingo.learn` 并落盘 |
| 词典 | 忘记/删除/删 `词` | |
| 词典 | 查词/词典查/释义 `词` | |
| 词典 | 整串 词典 / 词条数 | 列前 30 条 |
| 干员（ark.js） | 查干员/干员 `名` | 模糊匹配兜底；未找到提示 |
| 干员 | 查藏品/藏品 `名` | 模糊匹配兜底 |
| 干员 | 干员生日/生日 `名` | |
| 干员 | 整串 今日生日 / 今天谁生日 | |
| 抽卡（gacha.js） | 整串 卡池 / 卡池列表 | 当前开放池 + UP 干员 |
| 抽卡 | 抽卡记录/我的抽卡/抽卡统计 `[N]` | **必须先于"单抽/十连"规则**（顺序敏感，勿合并正则） |
| 抽卡 | 整串 谁最欧/群欧皇/欧气榜 | SQLite 抽卡记录排行 |
| 抽卡 | 单抽/十连/抽卡 `[池]` | 真实卡池出率；无开放池降级常驻模拟；逐抽记库 |
| 统计（stats.js） | 活跃榜/活跃统计/活跃度 `[N天]` | 依赖 SQLite |
| 统计 | 整串 群统计/消息统计 | |

跨领域无前缀冲突；领域内顺序敏感点集中在抽卡域（记录先于抽卡）。

## 6. 三个后台编排流程

### 6.1 离线补偿 backfillHistory（core/routing.js createRouting 内，connect 生命周期内，仅一次）

`sinceTs = max(store.getLastSeenTs(), now − backfill.maxHours×3600)`（默认 72h）；群集合 = `config.groups` 非空用之，否则 `get_group_list`（失败回退磁盘已跟踪群）；每群 `get_group_msg_history(message_seq:0, count:1000)` → 过滤 `time ≥ sinceTs` 与批内重复 → 逐条 `store.addHistoryMessage`（与内存/磁盘双去重）+ `analytics.record`；整批有新增才 `setLastSeenTs(latest)`（全局单值，只增不减）；单群失败记日志继续。

### 6.2 每日日报 dailyReport（report 插件，hooks.start 经 scheduler.start 注册每日回调，时刻取 `report.hour/minute`，缺省 9:00）

调度器实例归 report 插件所有：hooks.start → `scheduler.start(dailyReport)`（core/platform/scheduler.js 自驱每日循环），hooks.stop → `scheduler.stop()`（旧实现由 runtime 信号路径直调）。编排口径：守卫 `ready` + 配置了 `report.userId`。**昨日本地自然日** `[昨日00:00, 今日00:00)`；每群 `store.loadFromDisk(gid, yesterdayStart, todayStart)` 载入该日期段再 `collectRange` + 敏感过滤；消息数 ≥ `report.minMessages`(100) 才算活跃群；逐群 `summarizer.summarize(...,'daily')`，单群失败继续；全部失败则不发送；成功则私聊发给 `report.userId`。**不写任何 lastSummaryAt/lastSeen 状态**。

### 6.3 数据刷新（refresh 插件 api.refresh，3 个触发源共用同一 runner）

runner = refresh 插件闭包内 `refresh(notifyGroupId)`（经 `api.refresh` 暴露；runtime.refreshData 仅为 app 返回面/WebUI ctx 保持的桥接包装）。触发源：(a) refresh 插件 hooks.start 注册的自动刷新定时器（启动后 `firstDelayMinutes` 30 分钟 → 每 `intervalHours` 24 小时；`dataRefresh.enabled !== false` 才注册）；(b) 群内指令「刷新数据」（分发带 800 带）；(c) WebUI POST `/api/refresh`。

步骤：快照旧 6★/5★ 干员与卡池 id → `refresher.refresh()`（依次 干员表→档案→藏品→卡池；ETag 304 跳过、校验失败抛错）→ 有更新则 `arkdb.reload()` 热重载并 diff 出新增 6★/5★/新开放卡池 → 播报仅当 `dataRefresh.announce === true`；带 `notifyGroupId`（群指令）时**必发**「【数据更新】…」结果消息，否则把新增播报广播给全部跟踪群。发送失败全部吞掉只记日志。

## 7. 静态依赖图（import 边，箭头 = 被依赖；P5 归类后）

```
logger（core/platform/logger.js）← core 全部服务 + 全部插件（runtime/plugins 都经它记日志；
       platform/ 内与 knowledge/ 内同组引用为同级/上跳一级，plugins 经 ../core/platform/logger.js）
wiki（knowledge 组纯函数 extractKeywords/isArknightsRelated）← moegirl、wikipedia、chat 插件
store（platform 组 fmtFull/hhmm）← summarizer、summary 插件、routing（fmtFull）
http（platform 组 fetchRetry，2026-09 加固）← summarizer、moegirl、chat 插件（_reply 的 LLM 调用）
registry（core 顶层，PRIORITY 常量）← lingo/ark/gacha/stats/chat/refresh/summary 插件（读带号）
routing（core 顶层）← platform 组 logger/store（静态，fmtFull/log）+ 其余服务全经 createRouting
        options 注入（零插件工厂 import；S12 经注入的 registry 分发）
runtime（core 顶层）← platform/knowledge/registry/routing 全部 + plugins 全部工厂（唯一装配者）
        ——core 对 plugins 的唯一反向依赖：runtime 装配期 import 各 createXxxPlugin
platform/ 与 knowledge/ 组间：knowledge → platform 仅两条——logger（../platform/logger.js）与 http（moegirl 调 fetchRetry，../platform/http.js），无反向
filter.js 零 import；plugins 间零互 import（服务一律经 createApp 注入/ctx 注入）
```

**实例化关系**：`createApp` new 出 MessageStore / NapCatClient / Summarizer / Scheduler / Analytics / DataRefresher 6 个平台服务 + LingoStore / ArkDB / KnowledgeCache / 三个 Wiki 检索器 6 个知识单例，共 12 个实例；`ChatBrain`（注入 6 个知识单例）、`createRouting`（注入判定所需服务与 state 共享状态对象）与 9 个插件描述符随后装配。**重构前最大耦合点「ChatBot 是 lingo/arkdb 等服务宿主、commands/webui 反向借用 chatBot.lingo」已拆**：知识服务现在是 runtime 装配的事实共享单例，brain（字段引用）与指令插件（dispatch ctx）与 webui（getLingo）注入/借用的都是同一批实例（详见 refactor-proposal「服务上移」）。

## 8. 已知怪癖与坑（改代码前必读）

1. ~~**死配置（bug）**~~（2026-09 已修复）：`config.schedule.hour/minute` 与 `config.report.hour` 曾**从未生效**——`Scheduler` 解构的是 `dailyHour/dailyMinute` 而装配传的是 `schedule` 对象、`report.hour` 遗读无消费方，日报恒 **9:00**。2026-09 立项决策「`report.*` 生效」：现 runtime 装配处从 `config.report.hour/minute`（缺省 9/0）取值构造 `Scheduler`；`schedule.*` 整块废弃不再读取（example 已移除该节）。
2. ~~**wsConnected 永不复位**~~（2026-09 已修复）：WS 断开时 napcat 合成 `lifecycle/disconnect` 事件，routing S1 复位 `wsConnected`——WebUI 状态页如实显示离线；重连后 connect 事件置回 true。断线期间无入站事件，`ready`/`backfillDone` 语义不受影响。
3. **缓存键跨群共享**：知识缓存 `q:<question>` 不含群号/提问人前缀，同问题在不同群命中同一缓存（含内容已过 TTL 判定）。属既有语义。
4. **store 同步 IO 在路由热路径**：`addMessage` 同步 `appendFileSync`，写在一切路由判断之前；写失败异常会中断该消息的路由（不入 analytics、不回复）。异步化或加锁会改变现有行为。
5. **首次消息可能卡顿**：Analytics 的 SQLite 首次写入会同步全量扫描导入 `data/messages/` 下全部 JSONL（`_ensureImported`）。
6. **Summarizer 与 ChatBrain 的 LLM 默认值不同**：maxTokens 2048 vs 1024、temperature 0.7 vs 0.8、失败兜底文案仅 chat 有、仅 chat 有并发信号量（3）。LLM 两调用点与 moegirl 的 fetch 原**均无超时/重试**，2026-09 统一改经 core/platform/http.js fetchRetry（LLM 60s×2 次、moegirl 15s×1 次，仅网络错误/超时/5xx 重试，2xx/4xx 原样返回）；wiki/wikipedia 各自的超时/重试/反爬策略不变。
7. **extractQuestion 只剥 1–2 段前导 @**：`内容 @机器人` 这类尾部/中部 @ 会原样进入问题文本；无空格紧贴 @ 的整串（如文本「@昵称问题…」）会被 `^@[^\s@]{1,30}\s*` 整体吞掉。
8. **命令未命中也会进 LLM**：任何 @ 且非空文本，若各指令带与刷新/总结关键词都不命中，都会消耗一次 LLM 调用（chatEnabled:false 时不发不耗）。
9. **lastSeenTs 是全局单值**（非按群），backfill 的起点由任一群的最后消息推进。
10. **node:sqlite 需 Node ≥22.5**：engines 已声明 ≥22.5（原 ≥18 过宽，2026-09 修复）。
11. **总结关键词判定基准（既定语义，勿按旧行为回退）**：旧 S8 在剥 @ 前对**含 @ 的完整文本**判关键词（先于空 @ 判定）；现 summary 插件对**剥 @ 后问题文本**判（在 S10 之后）——详见 §4 要点。输入形态「紧贴 @ 无空格的整串且整串含关键词」（如文本「@PRTS总结」、at 段缺 name 时「@10001总结」）：旧代码触发手动总结，现代码回「艾特PRTS干什么呀喵」。**2026-09 决策：不回退**——有效文本必须与 @ 分隔，紧贴无空格的整串不应通过（更符合逻辑）；锁定测试在 test/smoke/runtime-dispatch.test.js（「紧贴 @ 无空格的整串不触发任何插件」）。剥 @ 后关键词仍完整（如「@机器人总结」被 `^@机器人\s*` 单独剥掉）时触发不受影响。
