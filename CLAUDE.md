# CLAUDE.md — 项目规范（供 Claude Code 会话阅读）

> 本文件定义在本仓库内**如何做事**。详细的"是什么/为什么"见 [docs/](docs/index.md) 文档体系，本文件只放约束与指针，不复述全文。

## 项目速览

QQ 群聊机器人（NapCat / OneBot 11 / WS），Node ESM，LLM 生成群聊概括与日报，@机器人 触发指令与 AI 群聊（明日方舟主题）。
文档地图：[docs/index.md](docs/index.md)；快速开始：[README.md](README.md)。

## 运行与验证

- 运行环境：**Node ≥ 22.5**（用了 `node:sqlite`；`package.json` engines ≥18 偏宽，勿信）。
- 依赖仅 `ws`；`npm install` 后 `npm start`（= `node src/index.js`）。
- 无 `npm test`（仓库零测试脚手架，见 [docs/refactor-proposal.md](docs/refactor-proposal.md) P0 提议）。
- 改动语法自检：`node --check src/<file>.js`。
- 启动需要 `config.json` 里 `llm.apiKey`（或 `LLM_API_KEY` 环境变量），缺失即 exit(1)；连不上 NapCat 只打重连日志不退出。
- 改代码前必读：[docs/architecture.md](docs/architecture.md)（§4 消息路由链、§6 三个后台流程、§8 已知坑）。

## 代码规范（vibe house style）

1. **注释**：每个文件顶部有"作用 + 导出 + 实例化点 + 读写数据"头注释；每个 `export` 符号与类公开方法前有中文 JSDoc（`@param`/`@returns`/副作用）。细节与示例见 [docs/index.md](docs/index.md) 的"源码注释规范"——**新代码必须遵守**，旧代码缺注释时顺手补上。
2. **语言/风格**：注释与日志文案中文；`camelCase` 变量/函数、`PascalCase` 类、`UPPER_SNAKE_CASE` 常量；函数保持短小（复杂流程拆小函数）；`import` 路径相对；不加类型体操（纯 JS）。
3. **依赖纪律**：优先 Node 内置能力（fetch/http/sqlite），**不引入新 npm 依赖**。需要新库或换架构先讨论再动手（见"结构方向"）。
4. **错误处理**：LLM/Wiki 网络调用显式处理失败；同步写盘失败大多"记日志继续"是本项目的容错惯例（除消息入库——见红线）。

## 行为红线（勿"顺手修复"，改行为必须先讨论）

来自 [docs/architecture.md](docs/architecture.md) §8 与 [docs/refactor-proposal.md](docs/refactor-proposal.md) 的探索结论：

1. **路由链次序即契约**：消息入库 → @检测 → 静默门 → 总结关键词 → 空@回复 → 刷新指令 → 确定性指令（**严格 null 才落 chat**）→ chat 兜底。任何"看起来更合理"的重排都可能改变现网行为。
2. **消息入库是同步 `appendFileSync` 且先于一切路由**——不得异步化或加锁（现状：写失败中断该消息路由）。
3. **@匹配语义**：at 段字符串全等；`@机器人`/`@PRTS` 大小写敏感子串匹配；剥 @ 只剥 1–2 段**前导**的，尾部 @ 原样保留。
4. **死配置不要修**：`schedule.hour/minute`、`report.hour` 从未生效（定时恒 9:00）。修它需要立项决策（见 refactor-proposal 待办），别在路过时改。
5. **语义保持**：知识缓存键 `q:<问题>` 跨群共享（勿加群号前缀）；`wsConnected` 断线不复位（面板状态假象，已知）；Summarizer 与 ChatBot 的 LLM 默认值（maxTokens 2048/1024、temperature 0.7/0.8）与"无超时/无重试"现状别单方面"加固"。
6. **commands.js 的 14 条规则顺序即优先级**（抽卡记录必须先于单抽；负向前瞻正则勿合并）。
7. **抽卡/干员/藏品的概率与过滤逻辑在 arkdb.js 内**，命令层只做格式化与落库；概率/可获取性改动需走游戏数据事实，不拍脑袋。

## 功能扩展入口（现在长什么样，去哪儿加）

- **新群指令**：`src/commands.js` 的 `tryCommand`——沿既有分隔段按域插入，遵守顺序约束。
- **新知识源 / 调整检索编排**：`src/chat.js` 的 `chat()` 主流程（本地快路 → 缓存 → 联网检索 → 排序 → `_reply`）。
- **新本地数据表**：`src/arkdb.js` 读 + `src/refresher.js` 下载/校验；数据文件约定见 [docs/data-format.md](docs/data-format.md)。
- **面板新接口**：`src/webui.js`（零依赖 node:http，页面内联）。
- **@机器人 人设与回复规则**：chat.js 的 system prompt 与 summarizer.js 的两套 prompt。

## 结构方向（重要）

本仓库当前是"平铺模块 + index.js 上帝文件"。**已有一份完整的 core+插件重构提案**（[docs/refactor-proposal.md](docs/refactor-proposal.md)）：目标架构、行为保真清单、P0–P4 迁移路线、风险清单均已设计完毕，**但尚未实施**。约束：

- 不要在无讨论的情况下启动大规模结构重构或目录搬家；
- 新增功能时**不必**为了未来插件化而提前抽象——按当前惯例写进对应模块即可（重构时会整体迁移）；
- 若你发现"为加一个小功能必须改动 index.js 路由链 + commands.js 分发表"的摩擦，这正是提案要解决的问题——提醒用户看提案，而不是自己临时发明注册机制。

## 仓库约定

- `config.json`、`data/`、`logs/`、`start_bot.bat` 均 .gitignore 排除（密钥与运行时数据**永不提交**）；配置模板是 `config.example.json`（脱敏）。
- 用户全局另有 ROUTER.md「Pro-Plan, Flash-Execute」混合工作流要求（用户级 CLAUDE.md 引入）：**重要改动先出方案 → 等确认 → 再执行**；本仓库内同理，先讨论再动手。
