# QQ 群聊概括机器人 (NapCat)

基于 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 OneBot 11 协议，通过正向 WebSocket 连接，
实时接收群消息、本地持久化，并通过 LLM 生成群聊概括与每日日报。

> 📚 **深入文档见 [`docs/`](docs/index.md)**：架构与消息路由、配置参考、数据格式、对外接口面、重构提案。

## 功能

- 实时接收群消息并持久化到 `data/messages/<群号>/<日期>.jsonl`
- 群里发「@机器人 总结 / @机器人 /总结 / @机器人 #总结」可手动触发概括（**必须 @ 机器人**，防止误触发）
- **AI 群聊**：群里 @机器人 说其他内容时，调用 DeepSeek 以群友身份回复（带上下文记忆，每群保留最近 N 条）
- **三级知识库**：回答时自动检索资料，覆盖新信息与社区梗/黑话
  - **本地梗词典** `data/lingo.json`：可手动维护 + 命中即用（最快）
  - **PRTS.Wiki**：明日方舟数据（干员/关卡/机制，仅方舟问题时检索）
  - **萌娘百科**：社区梗/黑话/文化词条 + **通用 ACG/人物/作品百科**（无论是否方舟问题都检索，覆盖初音未来、魔法少女小圆等，降低非方舟问题的幻觉）
  - **维基百科**（可选）：`wikipediaEnabled: true` 时作为非方舟问题的通用知识源（需代理访问 zh.wikipedia.org）
- **本地干员数据库**（`data/ark/`）：来自 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)，含全量干员信息、官方档案（生日/种族/身高/简介）与 **807 个肉鸽藏品**（含效果/描述，如"高卢银行支票"），干员生日、藏品效果、资料类问题**本地秒回**（约 1-2s，提速约 10 倍），不依赖联网
- **方舟物品检索**：问题涉及干员名、材料（凝胶/聚合剂/D32钢等）、敌人、关卡时会自动触发 PRTS.Wiki 检索，降低 LLM 凭空回答的幻觉
- **健壮性**：LLM 请求并发限流（默认 3）、概括 per-group 互斥、WS 连接校验、日志按天轮转、缓存命中不续期
- **语义模糊匹配**：本地干员/藏品名支持 bigram Dice 相似度匹配（如"高卢的支票本"→"高卢银行支票"、"波登克"→"波登可"）
- **群友纠错学习闭环**：群友可教 bot 新梗（`@机器人 学习 词=释义`）、忘记（`@机器人 忘记 词`）、查词（`@机器人 查词 词`）、看词典（`@机器人 词典`），自动写入 `data/lingo.json`
- **确定性任务指令**：`查干员 X` / `查藏品 X` / `干员生日 X` / `今日生日` / `单抽` / `十连` / `活跃榜 N` / `群统计`
- **SQLite 分析层**（`data/messages.db`）：消息实时入库（JSONL 幂等导入），支持活跃榜、群统计等聚合查询
- **知识缓存**：检索结果缓存到 `data/knowledge_cache.json`，同问题二次提问直接命中缓存（提速约 6 倍），缓存 TTL 可配置
- **按可信度/热度排序**：多来源结果按来源可信度（词典>PRTS>萌娘）与热度（页面篇幅）综合评分排序，优先用最可能相关的资料
- **每日 9:00** 自动统计昨日各群消息，将「昨日活跃群（≥100 条）日报」**私聊发送**给指定 QQ
- **静默时段**（默认 0:00-8:00）：不响应任何总结请求
- **离线补偿**：每次启动时自动从**上次下线时刻**（持久化的最后在线时间）拉取错过的历史消息，重启/掉线也能补齐
- **敏感内容过滤**：隐私信息（手机号/身份证/银行卡/邮箱/地址/IP/密码）和色情/暴力/违法等不当内容在送 LLM 前自动过滤，概括中不会出现
- 消息量少于阈值（`minMessages`）时手动总结自动跳过，避免打扰
- 断线自动重连；概括进度写入 `data/state/`，重启不重复
- 已端到端验证：收消息 → 存记录 → 调 DeepSeek → 概括发送，全程正常

## 目录结构

```
src/
  index.js      引导入口（import { main }，按入口判定执行）
  core/         主运行库：平台 + 公共服务 + 插件注册表 + 唯一装配者（原 src/ 平铺模块迁入）
    runtime.js    createApp(config, overrides) 纯装配 + 消息路由链（core 判定 + 插件分发带）+ start/stop 生命周期
    registry.js   插件注册表（按优先级带分发消息 / hooks 起停插件）
    napcat.js / store.js / summarizer.js / scheduler.js / analytics.js / refresher.js
    filter.js / logger.js
    lingo.js / arkdb.js / cache.js / wiki.js / moegirl.js / wikipedia.js   知识服务共享单例
  plugins/      功能插件（互不 import；服务一律经 createApp 注入）
    lingo.js / ark.js / gacha.js / stats.js   确定性指令（原 commands.js 按领域拆）
    summary.js / refresh.js / report.js   手动总结 / 数据刷新 / 每日日报（后台流程插件）
    chat.js      AI 群聊（ChatBrain）+ LLM 兜底分发
    webui.js     Web 管理面板（状态/词典/刷新/配置）
test/           node:test 测试（npm test）
  baseline/     行为基线（重构前直测 store/analytics/lingo/arkdb/commands 语义）
  smoke/        import 面 / 注册表 / 插件接线 / 全链集成冒烟
config.example.json  配置模板（脱敏，可提交仓库）
config.json          实际配置（含密钥，已被 .gitignore 排除）
start_bot.bat        Windows 快捷启动脚本
logs/                日志（按天轮转，自动清理 14 天前）
data/                运行数据（消息记录 + 概括进度 + 干员库 + 词典 + 最后在线时间）
```

## 快速开始

### 1. 准备 NapCat（推荐用 NCD 桌面管理工具）

1. 安装 [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop/releases)（NCD）。
2. NCD 里「组件」页依次安装 **Node.js / QQ / NapCat**。
3. 「机器人」页点「创建第一个实例」，填写：
   - **QQ 账号**：机器人 QQ 号
   - **底座类型**：NapCat（不带 QQ GUI）
   - **连接**：新增「WS 正向服务器」，端口 `3001`（记下 token）
4. 保存并「启动」，手机 QQ 扫码登录机器人账号。

> 提示：若电脑上残留过其他 QQ 账号的登录态，NapCat 可能错误复用旧账号导致连接配置不生效。
> 到 `C:\Users\<你>\AppData\Roaming\QQ\Partitions` 删除旧账号的 `qqnt_<旧号>` 目录，
> 并清理 NapCat 配置目录里旧账号的 `onebot11_<旧号>.json`，再重启机器人账号。
>
> 若扫码登录提示 `serverErrorCode: 168`（"账号近期存在安全风险"），是 QQ 风控所致：
> 需用手机 QQ 登录该账号完成安全验证后再扫码。机器人建议使用小号，主号频繁异常登录易触发风控。

### 2. 修改配置 `config.json`

```bash
cp config.example.json config.json   # 复制模板
```

- `napcat.wsUrl`：NapCat 正向 WebSocket 地址（默认 `ws://127.0.0.1:3001`）
- `napcat.selfId`：机器人 QQ 号
- `napcat.accessToken`：NCD 里 WS 服务器生成的 token（连 WS 需携带）
- `groups`：要监控的群号列表，例如 `[123456, 789012]`；留空 `[]` 表示监控所有群
- `llm.apiKey`：**必填**，也可用环境变量 `LLM_API_KEY` 设置（优先级更高）
- `llm.baseUrl` / `llm.model`：OpenAI 兼容接口（默认 DeepSeek，可换 OpenAI / 通义 / 其他）
- `llm.chatEnabled`：AI 群聊开关（默认 `true`）
- `llm.chatHistoryLimit`：每群保留的上下文条数（默认 12）
- `llm.defaultReply`：AI 调用失败时的兜底回复
- `llm.wikiEnabled`：PRTS.Wiki 知识库开关（默认 `true`）
- `llm.wikiApiUrl` / `wikiMaxResults` / `wikiMaxCharPerPage` / `wikiTopK`：PRTS.Wiki 检索参数
- `llm.moegirlEnabled` / `moegirlMaxCharPerPage` / `moegirlTopK`：萌娘百科检索参数
- `llm.lingoFile`：本地梗词典文件路径（默认 `data/lingo.json`，可手动编辑维护）
- `llm.cacheFile` / `cacheTtlHours`：知识缓存文件与 TTL（默认 168 小时）
- `llm.arkdbDir`：本地干员数据库目录（默认 `data/ark/`，放 `character_table.json` 与 `handbook_info_table.json`）

### 本地干员数据库（可选，强烈推荐）

从 [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 下载两个文件到 `data/ark/`：

```bash
# 干员基础数据（约 14MB）
curl -o data/ark/character_table.json \
  https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/character_table.json

# 干员档案（含生日/种族/简介，约 5.5MB）
curl -o data/ark/handbook_info_table.json \
  https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/handbook_info_table.json

# 肉鸽藏品（含效果/描述，约 17MB，可选）
curl -o data/ark/roguelike_topic_table.json \
  https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/roguelike_topic_table.json

# 真实卡池数据（卡池列表 + UP干员，约 436KB，可选，用于抽卡指令）
curl -o data/ark/gacha_table.json \
  https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/gacha_table.json
```

部署后，干员生日、档案类问题（如"能天使生日"、"波登可是谁"）以及肉鸽藏品问题（如"高卢银行支票是什么"）将**本地秒回**（约 1-2s），无需联网检索。

> 仓库提供 `lingo.example.json` 词典模板（含常用干员绰号、方舟梗、知名 UP 主等 38 条），
> 可复制到 `data/lingo.json` 使用。`data/` 目录已被 `.gitignore` 排除，你的本地词典不会误传。
> 新增梗时向词典加一条 `"梗名": "解释"` 即可（重启 bot 生效）。
- `schedule`：⚠️ **死配置**——`hour`/`minute` 从未生效，日报实际恒 9:00（详见 [docs/config-reference.md](docs/config-reference.md)）
- `minMessages`：手动总结低于该消息条数时跳过
- `report`：日报配置
  - `userId`：日报私聊接收人 QQ 号（**必填**）
  - `minMessages`：昨日消息数达到该值的群才生成日报（默认 100）
  - `hour`：⚠️ **死配置**（恒 9:00，同上；仅为历史兼容读取，无实际效果）
- `quiet`：静默时段（默认 `enabled: true, start: 0, end: 8`，即 0:00-8:00 不响应总结；设 `enabled: false` 可关闭）
- `backfill`：离线补偿（`maxHours` 默认 72，为 lastSeen 的兜底上限；实际从上次下线的 lastSeen 时刻开始补偿）
- `dataRefresh`：数据定期更新（`enabled` 默认 true，`intervalHours` 默认 24，`firstDelayMinutes` 默认 30，`announce` 默认 false 关闭新增播报）
- `webui`：Web 管理面板（`enabled` 默认 true，`host` 默认 127.0.0.1 仅本机，`port` 默认 5210，`token` 可选访问口令）
- `filter`：敏感内容过滤（`enabled: true` 默认开启）
- `commands.manualSummary`：手动触发概括的关键词（需 @机器人 且消息包含其中任一关键词）

### 3. 安装依赖并运行

```bash
npm install
npm start
```

开发验证：`npm test`（node:test 全量——行为基线 + 冒烟，无第三方测试依赖）。

Windows 下也可直接双击 `start_bot.bat`（后台运行，日志写入 `logs/` 目录，按天轮转）。

> `config.json` 含敏感信息（API Key、token），已被 `.gitignore` 排除，不会提交到仓库；
> 仓库中提供脱敏模板 `config.example.json`。

看到 `QQ 群聊概括机器人已启动（仅 @ 触发总结；每日 9:00 发送昨日日报）` 即正常运行。

## 使用方式

- **手动总结**：在群里发「@机器人 总结」（静默时段 0:00-8:00 内不响应）
- **AI 群聊**：在群里 @机器人 直接说话（如「@机器人 你好」「@机器人 阿米娅是谁」），机器人以 AI 群友身份回复，能记住群内最近对话；涉及明日方舟的问题会自动检索 PRTS.Wiki 作为参考
- **每日日报**：每天 9:00 自动把昨日活跃群（≥100 条消息）的概括私聊发给 `report.userId`
- **词典学习**：`@机器人 学习 词=释义`（教新梗）、`@机器人 忘记 词`、`@机器人 查词 词`、`@机器人 词典`
- **任务指令**：`查干员 X`、`查藏品 X`、`干员生日 X`、`今日生日`、`活跃榜 [N天]`、`群统计`
- **真实卡池抽卡**：`卡池`（列出当前开放卡池及 UP 干员）、`十连 [池号/名称]`、`单抽 [池号/名称]`（基于游戏真实卡池数据与出率：6★2% 5★8% 4★50% 3★40%，UP 干员占其星级概率 50%）、`抽卡记录 [N]`、`谁最欧`
- **数据定期更新**：每 24 小时自动从 ArknightsGameData（jsDelivr 镜像）更新干员表/档案/藏品/卡池数据，ETag 版本比对（未变化跳过）、结构校验（防上游数据损坏）+ 旧文件备份（.bak）、原子写入 + 内存热重载；群内 `刷新数据` 可手动触发；新增内容播报默认关闭（`dataRefresh.announce`）
- **抽卡记录互动**：抽卡结果自动记入 SQLite，支持 `抽卡记录 [N]`（个人记录与统计）、`谁最欧`（本群欧气榜）
- **Web 管理面板**（`http://127.0.0.1:5210`）：运行状态、数据统计、词典增删、数据刷新、配置查看（密钥脱敏）

## Windows 开机自启（可选）

用计划任务实现登录后自动启动：

```powershell
# 管理员 PowerShell 中执行
$action = New-ScheduledTaskAction -Execute "C:\path\to\start_bot.bat" -WorkingDirectory "C:\path\to\project"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "QQSummaryBot" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
```

> 注：计划任务在**用户登录后**触发（若设了开机密码需登录后）。NapCat（NCD）需另行开启或设为自启。

## 发送效果示例

手动总结（发到群里）：

```
【群聊概括】
从 2026-08-13 22:00 到 2026-08-13 23:00｜共 86 条消息

1. 主要话题
   - 后端接口联调问题，讨论了超时与重试策略
   - 下午茶团购，准备预定奶茶
2. 关键信息
   - 明早 10 点开会，会议号 123-456-789
3. 待办或提醒
   - 张三需要在下班前提交 PR
4. 活跃概况
   - 整体活跃，技术讨论为主，间杂闲聊
```

每日日报（私聊发送给配置的 QQ）：

```
【昨日群聊日报 2026-08-12】
共 2 个活跃群

【技术交流群】123 条消息
1. 主要话题
   - 新框架选型讨论...
...

---
【摸鱼群】150 条消息
1. 主要话题
   - 今天吃什么...
...
```

## 日常管理

- 停止机器人：`taskkill /f /pid <node 的 PID>`（在任务管理器或 `Get-Process node` 里查）
- 重启：双击 `start_bot.bat`
- 查看日志：`logs/` 目录（按天轮转，如 `logs/2026-08-16.log`，自动清理 14 天前的日志）
- NapCat 与 QQ 登录：用 NCD 管理，别直接用本机器人脚本去动 NapCat 配置
- 数据文件：`data/messages/<群号>/<日期>.jsonl`（消息）、`data/state/lastSeen.json`（最后在线时间）

## 常见问题

- **连不上 NapCat**：确认 NapCat 已登录并开启正向 WebSocket 服务，检查 `wsUrl` 端口与 `accessToken`。
- **机器人收不到群消息 / @机器人 不响应**：确认机器人已加入对应群、已登录且状态正常。若「@昵称」方式不响应但「@QQ号」可以，是 NapCat 对 at 段解析差异所致——本机器人已兼容「文本含 @机器人/@昵称」的识别。检查 `groups` 是否留空（空=全部）或包含目标群。
- **LLM 调用报错**：确认 `apiKey` 与 `baseUrl` 正确、模型名有效。
- **重启后重复概括**：`lastSummaryAt` 已持久化到 `data/state/`，正常不会重复；若手动删除了 state 文件，会从当前时段重新概括。
- **日报没发送**：确认 `report.userId` 已配置、昨日消息数达到 `report.minMessages`（默认 100）。数据按日期存于 `data/messages/<群号>/<日期>.jsonl`，机器人会自动从磁盘读取昨日数据。注意日报**只统计昨日**（当天消息不计入）。
- **NapCat 提示 `未找到对应版本的偏移数据`**：NapCat 对最新版 QQ 的适配可能滞后（本机为 QQ 9.9.33 时 NapCat 4.18.18 提示过）。消息收发已验证正常，个别高级 API 可能受限；可关注 NapCat 更新。

## 说明

- 摘要内容由 LLM 生成，仅供群内成员参考，不作为事实依据。
- 聊天记录保存在本地 `data/` 目录，请妥善保管，注意隐私。
- 敏感内容过滤依赖内置关键词/正则规则（见 `src/core/filter.js`），请按需调整。
