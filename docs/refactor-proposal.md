# 重构提案：「core 主运行库 + 插件注册 + 插件」（未实施）

> **状态：提案存档**。目标架构与迁移路线已完成设计与代码级探索（2026-09），但**尚未实施**、未获批准。当前仓库仍是平铺结构。
> 此文档的价值：① 记录结构改造的完整思路；② 保存探索得到的行为保真清单与已知坑（与 architecture.md §8 互补）；③ 作为未来立项的需求说明书。

## 现状痛点

1. `src/index.js`（449 行）上帝文件：平台（WS/事件）与产品（总结/日报/刷新播报/回填）揉在一起，消息路由是写死的 if-else 链（S1–S13），加功能必须改这条链。
2. `commands.js` 150 行大 if-else 分发表，横跨 5 领域、14 条规则，带顺序敏感约束（"抽卡记录"必须先于"单抽"）。
3. `ChatBot`（chat.js）三职合一：LLM 聊天器 + 检索编排器 + **服务宿主**——LingoStore/ArkDB/KnowledgeCache/三个 Wiki 检索器全在它构造内 `new`，被 commands/webui/index 反向借用（`chatBot.lingo`、`chatBot.arkdb`）。

## 目标架构

```
src/
  index.js            # 引导：import { main } from './core/runtime.js'; main();
  core/               # 主运行库：平台+公共服务+注册表+装配（不 import 任何 plugins）
    runtime.js        # main() / createApp(config, overrides)——测试注入点
    registry.js       # 插件注册表：register/getRegistry/dispatch/startAll/stopAll
    napcat.js store.js analytics.js summarizer.js scheduler.js refresher.js
    filter.js logger.js lingo.js arkdb.js cache.js wiki.js moegirl.js wikipedia.js
  plugins/            # 功能插件：声明式自注册（插件间零互 import）
    lingo/ ark/ gacha/ stats/      # 4 指令插件（原 commands.js 按领域拆）
    summary/ report/ refresh/ chat/ webui/
test/                 # node:test（无新依赖），先写基线再重构
```

**插件描述符**：`{ name, priority, enabled, handleMessage(ctx) → string|true|null, hooks:{start,stop}, api }`。

**分发语义**：按 priority 降序（稳定排序）逐插件同步调用，`string` → 发送并短路、`true` → 已处理短路、`null/undefined` → 继续；**不 await 任何返回值**（异步插件自驱 Promise 链，保持现状 fire-and-forget 时序）。

**优先级带**：summary 900 > refresh 800 > lingo 700 > ark 600 > gacha 500 > stats 400 > chat 300（report/webui 仅 hooks）。把原 if-else 链顺序编码为确定性；core 管线保留：事件过滤 → 入库 → @检测 → 静默门 → extractQuestion → 空@固定回复。

## 行为保真清单（探索结论，改造红线）

- 消息入库 + analytics.record 先于一切；非 @、静默时段消息照常入库。
- @检测：at 段字符串全等 + 文本`@selfId` + 子串`@机器人/@PRTS`。
- 静默吞掉全部 @ 行为；手动总结关键词对**完整文本**（ctx.text）includes 判定。
- 空 @ → 固定回复「@sender 艾特PRTS干什么呀喵」（core，分发前）。
- 指令严格 `null` 才落 chat；chat 不 await；`setLastSummaryAt` 在发送成功后；抽卡记录在回复前落库；chat 历史只在 LLM 成功后写。
- cache key `q:<question>` 跨群共享；知识缓存 set 在 LLM 调用前。
- refreshData 三触发源共用同一 runner；日报口径=昨日自然日、先 loadFromDisk 再 collectRange、不写状态；backfill 仅 connect 时一次、lastSeen 只增不减。
- Summarizer vs ChatBot 的 LLM 默认值差异（maxTokens 2048/1024、temperature 0.7/0.8、有无信号量）保持。

## 关键设计决定

- **服务上移**：LingoStore/ArkDB/KnowledgeCache/Wiki/Moegirl/Wikipedia/Summarizer/Refresher 由 runtime 装配为 core 单例注入；ChatBot 改造为 ChatBrain（plugins/chat），构造注入、14 步 chat() 流程逐字迁移不重排；groupHistory/groupSpeakers 留在 brain 实例。
- **ArkDB 补 3 个公开方法**（纯增量）：`snapshotHighOps()` / `isOperator(c)` / `snapshotGachaPools()`——refresh 插件的 diff 对比不再直读私有字段与 `_isOperator`。
- **纯函数借道不动**：summarizer→store(hhmm)、moegirl/wikipedia→wiki(extractKeywords) 四文件整体平移进 core/ 同目录，相对 import 一字不改。
- **config 键名/schema 完全不动**；仅新增可选 `plugins.<name>.enabled`（默认全开）。
- **14 条指令正则按域整段搬移、禁止合并**；跨插件无前缀碰撞（已逐对验证），"每条规则最短命中文本恰被一个插件 claim"写成防回归测试。

## 迁移路线（每阶段独立 commit、可运行可验证）

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | 测试先行：node:test + 直测旧 `commands.tryCommand`/store/analytics/lingo/arkdb 的行为基线 | `npm test` 全绿 |
| P1 | 14 文件 git mv 进 core/；arkdb 补公开方法；registry 骨架；index.js 拆 main() 进 runtime.js（createApp 注入点） | 基线绿 + 冒烟 + 默认路径核对（仍指根 data/） |
| P2 | 4 指令插件 + registry dispatch 替换路由段；git rm commands.js | 命令基线改走插件断言文本原样 |
| P3 | summary/report/refresh/chat/webui 五插件（可拆 3 小步）；git rm chat.js/webui.js | 基线绿 + 真机冒烟五路径 |
| P4 | README 更新 + 死配置 TODO + 收尾 | 全量测试 + 端到端验收 |

## 风险清单（迁移时逐条对照）

1. store 同步 IO 热路径不得异步化（routing 测试断言 jsonl 行数=事件数）
2. summary 的 per-group 互斥 Set 随插件走，勿放全局
3. cache 跨群键语义勿"顺手加群号前缀"
4. chat 历史 pushMessage 位置保持在 LLM 成功之后
5. gacha 记录先于单抽、负向前瞻正则勿合并
6. extractQuestion 只剥 1–2 前导 @，尾部 @ 原样入 chat——勿"修复"
7. 手动总结按 ctx.text 判（防漏尾部 @ 消息）
8. 空@回复与关键词检查的旧序差异仅当关键词含 @ 时出现 → README 注明
9. core/ 下移后默认路径核对（`__dirname/..` 仍指根 data/）
10. 注册顺序 + 稳定排序须确定性（registry 测试）

## 待办（与重构无强耦合，可独立立项）

- **死配置修复**：`schedule.hour/minute` 与 `report.hour` 从未生效（Scheduler 只读 `dailyHour/dailyMinute`），日报恒 9:00——修复需决策"让哪个键生效"并保持默认 9:00。
- **加固**：Summarizer 与 ChatBot 的 LLM 调用、moegirl fetch 均无 HTTP 超时/重试；wsConnected 断线不复位（面板状态假象）；首次 SQLite 导入同步阻塞；`package.json` engines(≥18) 与 node:sqlite(≥22.5) 不符。
