# CLAUDE.md — 项目规范（供 Claude Code 会话阅读）

> 本文件定义在本仓库内**如何做事**。详细的"是什么/为什么"见 [docs/](docs/index.md) 文档体系，本文件只放约束与指针，不复述全文。

## 项目速览

QQ 群聊机器人（NapCat / OneBot 11 / WS），Node ESM，LLM 生成群聊概括与日报，@机器人 触发指令与 AI 群聊（明日方舟主题）。
文档地图：[docs/index.md](docs/index.md)；快速开始：[README.md](README.md)。

## 运行与验证

- 运行环境：**Node ≥ 22.5**（用了 `node:sqlite`；engines 已按 ≥22.5 声明，2026-09 修正）。
- 依赖仅 `ws`；`npm install` 后 `npm start`（= `node src/index.js`）。
- `npm test`：node:test 全量 = `node --test "test/**/*.test.js"`——`test/baseline/` 行为基线（store/analytics/lingo/arkdb/commands 直测）+ `test/smoke/`（导入面/注册表/插件接线/全链冒烟）。改了路由链、插件、存储语义就跑全量；纯文档/注释改动可跳过。
- 改动语法自检：`node --check src/<file>.js`（core/ 与 plugins/ 同）。
- 启动需要 `config.json` 里 `llm.apiKey`（或 `LLM_API_KEY` 环境变量），缺失即 exit(1)；连不上 NapCat 只打重连日志不退出。
- 改代码前必读：[docs/architecture.md](docs/architecture.md)（§4 消息路由链、§6 三个后台流程、§8 已知坑）。

## 代码规范（vibe house style）

1. **注释**：每个文件顶部有"作用 + 导出 + 实例化点 + 读写数据"头注释；每个 `export` 符号与类公开方法前有中文 JSDoc（`@param`/`@returns`/副作用）。细节与示例见 [docs/index.md](docs/index.md) 的"源码注释规范"——**新代码必须遵守**，旧代码缺注释时顺手补上。
2. **语言/风格**：注释与日志文案中文；`camelCase` 变量/函数、`PascalCase` 类、`UPPER_SNAKE_CASE` 常量；函数保持短小（复杂流程拆小函数）；`import` 路径相对；不加类型体操（纯 JS）。
3. **依赖纪律**：优先 Node 内置能力（fetch/http/sqlite），**不引入新 npm 依赖**。需要新库或换架构先讨论再动手（见"结构方向"）。
4. **错误处理**：LLM/Wiki 网络调用显式处理失败；同步写盘失败大多"记日志继续"是本项目的容错惯例（除消息入库——见红线）。

## 行为红线（勿"顺手修复"，改行为必须先讨论）

来自 [docs/architecture.md](docs/architecture.md) §8 与 [docs/refactor-proposal.md](docs/refactor-proposal.md) 的探索结论：

1. **路由链次序即契约**：S1–S7（消息入库 → @检测 → 静默门）与 S9/S10（剥 @、空@ 固定回复）在 core/routing.js（P5 起自 runtime.js 拆出，runtime 装配期 createRouting 挂载，顺序与文案未改）；其后的产品行为全部经 registry 分发带（priority 降序）：summary 900（总结关键词）→ refresh 800（刷新指令）→ 四个指令插件 700–400 → chat 300 末端恒消费（report/webui 仅 hooks 不占带）。任何"看起来更合理"的重排都可能改变现网行为；带序常量在 core/registry.js 的 `PRIORITY`（**测试锁定 keys，新增占带名须同步 registry 测试**）。
2. **消息入库是同步 `appendFileSync` 且先于一切路由**——不得异步化或加锁（现状：写失败中断该消息路由）。
3. **@匹配语义**：at 段字符串全等；`@机器人`/`@PRTS` 大小写敏感子串匹配；剥 @ 只剥 1–2 段**前导**的，尾部 @ 原样保留。**关键词/指令判定统一基于剥 @ 后的有效文本**——紧贴 @ 无空格的整串（如 `@PRTS总结`）不触发任何指令/总结、落 S10 空@ 提示（既定语义，勿按旧「含 @ 全文判」回退）。
4. **死配置不要修**：`schedule.hour/minute`、`report.hour` 从未生效（定时恒 9:00）。修它需要立项决策（见 refactor-proposal 待办，runtime.js 装配处已标 TODO 注释），别在路过时改。
5. **语义保持**：知识缓存键 `q:<问题>` 跨群共享（勿加群号前缀）；`wsConnected` 断线不复位（面板状态假象，已知）；Summarizer 与 ChatBrain 的 LLM 默认值（maxTokens 2048/1024、temperature 0.7/0.8）与"无超时/无重试"现状别单方面"加固"。
6. **指令 14 条规则顺序即优先级**：规则按域拆在 4 个指令插件（plugins/lingo.js 词典、ark.js 干员藏品、gacha.js 抽卡、stats.js 统计）——域内序 = 文件内代码序、域间序 = PRIORITY 带（700 > 600 > 500 > 400）。抽卡记录必须先于单抽；负向前瞻正则勿合并。
7. **抽卡/干员/藏品的概率与过滤逻辑在 core/knowledge/arkdb.js 内**，命令层（插件）只做格式化与落库；概率/可获取性改动需走游戏数据事实，不拍脑袋。

## 功能扩展入口（现在长什么样，去哪儿加）

- **新群指令**：先归领域 → 在对应指令插件内沿既有分隔段插入（域内代码序 = 优先级）：词典 → plugins/lingo.js、干员/藏品 → plugins/ark.js、抽卡 → plugins/gacha.js、统计 → plugins/stats.js。全新领域：新建 createXxxPlugin 工厂 + 加入 plugins/index.js 的 `commandPlugins` 数组 + 在 core/registry.js `PRIORITY` 加带（须同步 registry 测试对 keys 的断言）。
- **整类消息判定（非指令）**：仿 summary/refresh/chat 插件写 handleMessage(ctx)（ctx = {groupId, userId, userName, text, lingo, arkdb, analytics}；返回 string = runtime 代发、true = 插件自驱、null = 让位）；描述符语义见 core/registry.js 头注释。
- **新定时/后台流程**：在 core/runtime.js createApp 的插件装配段就地构造 createXxxPlugin({依赖闭包}) 并 register（hooks.start 注册定时/调度，hooks.stop 清理）；后台服务依赖注入与就绪标志模式见 plugins/report.js。
- **新知识源 / 调整检索编排**：plugins/chat.js 的 `ChatBrain.chat()` 主流程（本地快路 → 缓存 → 联网检索 → 排序 → `_reply`）；检索器本体按惯例放 core/knowledge/ 并由 runtime 装配为共享单例注入。
- **新本地数据表**：core/knowledge/arkdb.js 读 + core/platform/refresher.js 下载/校验；数据文件约定见 [docs/data-format.md](docs/data-format.md)。
- **面板新接口**：plugins/webui.js（零依赖 node:http，页面内联）。
- **@机器人 人设与回复规则**：plugins/chat.js 的 system prompt 与 core/platform/summarizer.js 的两套 prompt。

## 结构方向（重要）

重构（P0–P3，2026-09 落地，方案存档见 [docs/refactor-proposal.md](docs/refactor-proposal.md)）已完成，P5 再对 core 子目录归类并把 S 链判定拆到 core/routing.js：**core 主运行库 + PluginRegistry + plugins**。
- core/ 顶层 = 装配与判定三件：runtime.js（createApp 唯一装配者 + 生命周期 + main）、registry.js（分发带）、routing.js（S1–S7/S9/S10 判定链 + backfill，P5 自 runtime.js 拆出）；core/platform/ = 平台服务与基础设施（napcat/store/summarizer/scheduler/analytics/refresher/filter/logger）；core/knowledge/ = 知识单例（lingo/arkdb/cache/wiki/moegirl/wikipedia）。
- plugins/ = 9 个插件：4 指令（lingo/ark/gacha/stats）+ summary/refresh/report（后台流程）+ chat（LLM 兜底）+ webui（面板）；插件间零互 import，服务一律经 createApp 注入。

约束：

- 不要在无讨论的情况下启动大规模结构改动（core/plugins 边界的移动会牵动注入面与测试）；
- 新增功能时**不必**为未来抽象提前设计——指令/后台流程按当前惯例写进对应插件与装配段即可；
- 若你发现"为加一个小功能必须动 runtime 路由链 + registry 分发语义"，先对照 refactor-proposal 剩余待办讨论，而不是临时发明第二套注册机制；
- 独立待办（死配置修复、LLM 无超时/重试加固、wsConnected 复位、engines 修正）尚未立项，别顺手修——见 refactor-proposal「待办」。

## 仓库约定

- `config.json`、`data/`、`logs/`、`start_bot.bat` 均 .gitignore 排除（密钥与运行时数据**永不提交**）；配置模板是 `config.example.json`（脱敏）。
- 用户全局另有 ROUTER.md「Pro-Plan, Flash-Execute」混合工作流要求（用户级 CLAUDE.md 引入）：**重要改动先出方案 → 等确认 → 再执行**；本仓库内同理，先讨论再动手。
