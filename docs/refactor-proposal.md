# 重构提案（存档）：「core 主运行库 + 插件注册 + 插件」

> **状态：已实施**。P0–P3 迁移路线已于 2026-09 按本设计落地（P4 收尾同步文档）；P5（2026-09）对 core 做子目录归类（platform/ + knowledge/）并把消息路由判定域从 runtime.js 拆到 core/routing.js——**本树为 P5 后形态（文档先行提交在前，代码归类 P5a/P5b 紧随）**。本文档保留为**决策记录**：
> 目标架构与实施记录、行为保真清单（改造红线）、已知坑（与 architecture.md §8 互补）、仍开放的独立待办。
> 改结构前先读本节；行为红线以 CLAUDE.md 与 architecture.md §8 为准。

## 现状痛点（改造动机，已解决）

1. `src/index.js`（449 行）上帝文件：平台（WS/事件）与产品（总结/日报/刷新播报/回填）揉在一起，消息路由是写死的 if-else 链（S1–S13），加功能必须改这条链。
2. `commands.js` 150 行大 if-else 分发表，横跨 5 领域、14 条规则，带顺序敏感约束（"抽卡记录"必须先于"单抽"）。
3. `ChatBot`（chat.js）三职合一：LLM 聊天器 + 检索编排器 + **服务宿主**——LingoStore/ArkDB/KnowledgeCache/三个 Wiki 检索器全在它构造内 `new`，被 commands/webui/index 反向借用（`chatBot.lingo`、`chatBot.arkdb`）。

## 目标架构（= P5 后现状；P5 在 P0–P4 基础上加子目录归类与 routing.js 拆块）

```
src/
  index.js            # 引导（17 行）：import { main } 按入口判定执行
  core/               # 主运行库：装配层（顶层三件）+ platform/（平台服务）+ knowledge/（知识单例）；
                      # runtime.js 是唯一 import 插件工厂的例外（见下「关键设计决定」）
    runtime.js        # createApp(config, overrides)——纯装配/测试注入点；main()；start/stop 生命周期；
                      # P5 起路由判定实现已拆出，只挂载 routing.js 产出的 onEvent
    registry.js       # 插件注册表 + PRIORITY 带常量：register/dispatch/startAll/stopAll
    routing.js        # 【P5 新增】createRouting(options) 工厂：S1–S7/S9/S10 判定链 + backfillHistory +
                      # getAllGroupIds（自 runtime.js 逐字拆出，文本零改动；服务全经 options 注入）
    platform/         # 平台与公共服务（P5 归类）：napcat.js store.js summarizer.js scheduler.js
                      # analytics.js refresher.js filter.js logger.js
    knowledge/        # 知识单例（P5 归类）：lingo.js arkdb.js cache.js wiki.js moegirl.js wikipedia.js
  plugins/            # 功能插件（扁平文件式；互不 import）
    index.js          # commandPlugins 装配清单
    lingo.js ark.js gacha.js stats.js        # 4 指令插件（原 commands.js 按领域拆）
    summary.js report.js refresh.js chat.js webui.js   # 后台/服务插件
test/                 # node:test（无新依赖）：baseline/（行为基线）+ smoke/（冒烟）
```

**插件描述符**：`{ name, priority, enabled, handleMessage(ctx) → string|true|null, hooks:{start,stop}, api }`。

**分发语义**：按 priority 降序（稳定排序）逐插件同步调用，`string` → 发送并短路、`true` → 已处理短路、`null/undefined` → 继续；**不 await 任何返回值**（异步插件自驱 Promise 链，保持现状 fire-and-forget 时序）。

**优先级带**：summary 900 > refresh 800 > lingo 700 > ark 600 > gacha 500 > stats 400 > chat 300（report/webui 仅 hooks、priority 0）。把原 if-else 链顺序编码为确定性；core 管线保留：事件过滤 → 入库 → @检测 → 静默门 → extractQuestion → 空@固定回复（判定实现 P5 起在 core/routing.js）。

## 行为保真清单（改造红线，P4 复核仍全部成立；P5 拆块后再复核）

- 消息入库 + analytics.record 先于一切；非 @、静默时段消息照常入库。
- @检测：at 段字符串全等 + 文本`@selfId` + 子串`@机器人/@PRTS`。
- 静默吞掉全部 @ 行为；手动总结关键词对**剥 @ 后的问题文本** includes 判定（判定基准的旧序差异见下「行为差异与决策」，已定案不回退）。
- 空 @ → 固定回复「@sender 艾特PRTS干什么呀喵」（core/routing.js，分发前）。
- chat 恒在分发带末端（原「严格 null 才落 chat」内化，行为不变）；chat 不 await；`setLastSummaryAt` 在发送成功后；抽卡记录在回复前落库；chat 历史只在 LLM 成功后写。
- cache key `q:<question>` 跨群共享；知识缓存 set 在 LLM 调用前。
- refreshData 三触发源共用同一 runner（refresh 插件 api.refresh）；日报口径=昨日自然日、先 loadFromDisk 再 collectRange、不写状态；backfill 仅 connect 时一次、lastSeen 只增不减。
- Summarizer vs ChatBrain 的 LLM 默认值差异（maxTokens 2048/1024、temperature 0.7/0.8、有无信号量）保持。
- P5 拆块新增保真项：S1–S13 判定**顺序与文案一字不改**，仅实现位置从 runtime.js 闭包迁到 routing.js 工厂（state 共享对象化，读写点不变）；createApp 导出面与 services 键不变。

## 关键设计决定（实施记录 + 与设计的差异）

- **服务上移**：LingoStore/ArkDB/KnowledgeCache/Wiki/Moegirl/Wikipedia/Summarizer/Refresher 由 runtime 装配为 core 共享单例注入；ChatBot 改造为 ChatBrain（plugins/chat.js），构造注入、14 步 chat() 流程逐字迁移未重排；groupHistory/groupSpeakers 留在 brain 实例。✅ 已按此实施。
- **ArkDB 补 3 个公开方法**（纯增量）：`snapshotHighOps()` / `isOperator(c)` / `snapshotGachaPools()`——refresh 插件的 diff 对比不再直读私有字段与 `_isOperator`。✅
- **纯函数借道不动**：summarizer→store(hhmm)、moegirl/wikipedia→wiki(extractKeywords) 随文件整体平移进 core/，相对 import 一字未改。✅（P5 归类后同组同行，依旧一字未改）
- **config 键名/schema 完全不动**；原设计「新增可选 `plugins.<name>.enabled`（默认全开）」**未实施**（注册表描述符支持 enabled 字段、运行时未映射 config——需要时按此键补即可）。⚠️ 差异
- **14 条指令正则按域整段搬移、未合并**；跨插件无前缀碰撞（已逐对验证）。✅ 域内序 = 文件内代码序、域间序 = PRIORITY 带。
- **report/webui 仅 hooks、priority 0**（不占 300/200 带）：无消息面却要参与 startAll 排序的场景归 0 带，handleMessage 恒 null；registry 测试断言 PRIORITY keys，新增占带名须同步测试。✅
- **core/ 不 import 任何 plugins** ⚠️ 唯一豁免：runtime.js（装配者，位于 core/）必须 import 各插件工厂——插件侧仍零 core 服务 import（只 import logger/registry 常量/wiki 纯函数/store 工具）。P5 拆出的 core/routing.js **不 import 任何插件工厂**（S12 经注入的 registry 分发，options 注入其余全部服务）——豁免仍只落在 runtime.js。✅（P5 复核）

## P3 期间发现的行为差异（已决策：保持现语义，不回退）

- **总结关键词判定基准**（P3b 引入）：旧 S8 在剥 @ 前对**含 @ 的完整文本**判关键词、先于空 @ 判定；现 summary 插件对**剥 @ 后问题文本**判、在 S10 之后。常规「@机器人 总结」（带空格/@ 段后另起文本）等价；差异仅出现在**无空白紧贴 @ 的一整串**且整串含关键词（如文本「@PRTS总结」、at 段缺 name 时「@10001总结」）：旧代码触发手动总结，现代码整串被 extractQuestion 吞掉 → 回「艾特PRTS干什么呀喵」。
- **决策（2026-09）**：不回退——关键词/指令判定基准统一为剥 @ 后的有效文本，紧贴 @ 无空格的整串不应通过（更符合逻辑）。已由 runtime-dispatch 锁定测试固化（「紧贴 @ 无空格的整串不触发任何插件」），详见 architecture.md §8 坑 11。

## 迁移路线（已全部执行；每阶段独立 commit、可运行可验证）

| 阶段 | 内容 | 验证 | 状态 |
|---|---|---|---|
| P0 | 测试先行：node:test + 直测旧 `commands.tryCommand`/store/analytics/lingo/arkdb 的行为基线 | `npm test` 全绿（93 用例） | ✅ 完成（commit 1a3f138） |
| P1 | 14 文件 git mv 进 core/；arkdb 补公开方法；registry 骨架；index.js 拆 main() 进 runtime.js（createApp 注入点） | 基线绿 + 冒烟 + 默认路径核对（仍指根 data/） | ✅ 完成（0079e9e） |
| P2 | 4 指令插件 + registry dispatch 替换路由段；git rm commands.js | 命令基线改走插件断言文本原样 | ✅ 完成（ce1e1f0） |
| P3 | summary/report/refresh/chat/webui 五插件（P3a chat / P3b 后台三件 / P3c webui + 分发带收尾）；git rm chat.js/webui.js | 基线绿 + 冒烟 134 例 + **真机冒烟五路径待用户执行** | ✅ 完成（1724822/f98d760/42b5192） |
| P4 | README 更新 + 死配置 TODO + 收尾 | 全量测试 + 端到端验收 | ✅ 完成（6da34e5） |
| P5 | core 子目录归类（platform/ 8 + knowledge/ 6，runtime/registry/routing 留顶层）+ 路由判定域拆 core/routing.js（文档先行） | 全量测试持续全绿；文档对账 grep | ✅ 本行随 P5c' 文档先行提交；代码落地 P5a/P5b 后进行中，复核段（「行为保真清单」P5 项与 §7 依赖图）收尾时改为完成 |

## 风险清单（迁移时逐条对照，P4 复核；P5 拆块复核项加粗）

1. store 同步 IO 热路径不得异步化（routing 测试断言 jsonl 行数=事件数）——已由 baseline 直测锁定
2. summary 的 per-group 互斥 Set 随插件走，勿放全局——已随 summary 插件（background-plugins 测试锁定）
3. cache 跨群键语义勿"顺手加群号前缀"
4. chat 历史 pushMessage 位置保持在 LLM 成功之后
5. gacha 记录先于单抽、负向前瞻正则勿合并（gacha 插件内）
6. extractQuestion 只剥 1–2 前导 @，尾部 @ 原样入 chat——勿"修复"（连带 §P3 差异项）
7. 手动总结按 ctx.text（剥 @ 后）判：尾部 @ 文本不阻断关键词命中；与旧 S8 完整文本判的差异已定案不回退（见「P3 期间发现的行为差异」）
8. 空@回复与关键词检查的旧序差异仅当关键词含 @ 时出现 → README/architecture 已注明
9. core/ 下移后默认路径核对（`__dirname/..` 仍指根 data/）——P1 已核对；P5 归类未再加深 core/ 深度（platform/knowledge 不涉 dataDir 相对计算，runtime 留顶层）→ 无需复核对
10. 注册顺序 + 稳定排序须确定性（registry 测试）
11. **P5 拆块**：S 链判定顺序与文案零改动（runtime-dispatch 锁 S10 文案/紧贴@ 语义/learn/chat 兜底）；createRouting 必须先于插件注册段（getAllGroupIds 失去函数声明提升）；state 对象化后读取点（isReady/getStatus/S1）无漏网闭包引用；imports.test 键表随归类同 commit 同步

## 待办（与重构无强耦合，可独立立项；P4 收尾后仍开放）

- **死配置修复**：`schedule.hour/minute` 与 `report.hour` 从未生效（Scheduler 只读 `dailyHour/dailyMinute`），日报恒 9:00——修复需决策"让哪个键生效"并保持默认 9:00（runtime.js 装配处已标 TODO 注释；README 已如实标注死配置）。
- **加固**：Summarizer 与 ChatBrain 的 LLM 调用、moegirl fetch 均无 HTTP 超时/重试；wsConnected 断线不复位（面板状态假象）；首次 SQLite 导入同步阻塞；`package.json` engines(≥18) 与 node:sqlite(≥22.5) 不符。
