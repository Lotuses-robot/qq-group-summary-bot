# 配置参考（config.json / 环境变量）

> 模板：`config.example.json`。实际配置 `config.json` 含密钥，已被 .gitignore 排除，**不要提交仓库**。
> 所有键的默认回退逻辑以代码为准（下表「默认」= 代码内兜底值）。

## 环境变量

| 变量 | 作用 | 优先级 |
|---|---|---|
| `CONFIG_PATH` | 指定配置文件路径（缺省 `<项目根>/config.json`） | 最高 |
| `LLM_API_KEY` | LLM API Key | **高于** `config.llm.apiKey`（仅当 config 内没写时回退） |

启动时校验：`llm.apiKey` 与 `LLM_API_KEY` 都为空 → 打印错误并 `process.exit(1)`。

## 顶层键

| 键 | 类型 | 默认 | 消费方 | 说明 |
|---|---|---|---|---|
| `napcat.wsUrl` | string | 无（缺失即异常） | NapCatClient | 正向 WS 地址，如 `ws://127.0.0.1:3001` |
| `napcat.selfId` | number | `0` | index（过滤/回填起点） | 机器人 QQ 号；为 0 时连接后经 `get_login_info` 回填 |
| `napcat.accessToken` | string | `''` | NapCatClient | 拼到 WS URL 的 `?access_token=` |
| `groups` | number[] | `[]` | index | 监控群白名单；**空数组 = 全部群**（还影响 backfill/日报/播报的目标群集合） |
| `schedule` | object | `{}` | Scheduler | ⚠️ **死配置**：只解构 `dailyHour/dailyMinute`，而 example 里是 `hour/minute`——日报实际恒 9:00（见 architecture §8 坑 1） |
| `report.userId` | number | `0`（= 不发送） | dailyReport | 日报私聊接收 QQ（**必填**才发日报） |
| `report.minMessages` | number | `100` | dailyReport | 昨日消息数 ≥ 该值的群才生成日报 |
| `report.hour` | number | `9` | — | ⚠️ **死配置**：index 里读了但从未使用（坑 1） |
| `quiet.enabled` | boolean | `true` | index | 静默时段开关 |
| `quiet.start` / `quiet.end` | number | `0` / `8` | index | 小时制 `[start, end)`；start>end 视为跨零点 |
| `minMessages` | number | `1` | doSummary | 手动总结低于该消息条数时跳过 |
| `includeSelf` | boolean | `false` | index | `true` 时机器人自己的消息也计入 |
| `commands.manualSummary` | string[] | `['总结','/总结','#总结']` | index | 手动总结触发关键词（完整文本 includes 子串匹配） |
| `backfill.maxHours` | number | `72` | backfillHistory | lastSeen 兜底上限；实际从 lastSeen 时刻起拉 |
| `dataRefresh.enabled` | boolean | `true` | index | 数据定期更新总开关（`!== false` 视为开） |
| `dataRefresh.intervalHours` | number | `24` | index | 自动刷新间隔 |
| `dataRefresh.firstDelayMinutes` | number | `30` | index | 首次刷新延迟（启动后） |
| `dataRefresh.announce` | boolean | `false` | index | `=== true` 才向群播报新增 6★/5★/新卡池 |
| `dataDir` | string | `./data` | index | 运行数据根目录（相对路径按进程 cwd 解析） |
| `filter.enabled` | boolean | `true` | index | 敏感内容过滤开关（总结/日报前） |
| `webui.enabled` | boolean | `true` | index | Web 面板开关 |
| `webui.host` / `webui.port` | string/number | `127.0.0.1` / `5210` | WebUI | listen 地址；host 留 127.0.0.1 仅本机可访问 |
| `webui.token` | string | `''` | WebUI | 面板口令；空 = 全开放；非空时要求 `Authorization: Bearer` 头或 `?token=` |

## llm.* 块（一个块喂给 Summarizer 与 ChatBot 两个消费者）

| 键 | 类型 | 默认 | 消费方 | 说明 |
|---|---|---|---|---|
| `llm.apiKey` | string | env `LLM_API_KEY` | Summarizer + ChatBot | 两构造器各自再兜底 env |
| `llm.baseUrl` | string | `https://api.openai.com/v1` | 两者 | 尾部 `/` 会被剥掉；example 配 DeepSeek `https://api.deepseek.com/v1` |
| `llm.model` | string | `gpt-3.5-turbo` | 两者 | example：`deepseek-chat` |
| `llm.maxTokens` | number | **Summarizer `2048` / ChatBot `1024`（默认不同！）** | 两者 | 见 architecture §8 坑 6 |
| `llm.maxMessages` | number | `3000` | Summarizer | 概括时取最近 N 条（`\|\|` 语义：0 也会变 3000） |
| `llm.chatEnabled` | boolean | `true` | ChatBot | AI 群聊开关；false 时 @ 未命中指令 → 静默 |
| `llm.chatHistoryLimit` | number | `12` | ChatBot | 每群保留的上下文条数 |
| `llm.chatConcurrency` | number | `3` | ChatBot | LLM 请求并发上限（信号量） |
| `llm.defaultReply` | string | 内置文案 | ChatBot | LLM 调用失败时的兜底回复（照发） |
| `llm.lingoFile` | string | `<root>/data/lingo.json` | LingoStore | 相对路径按 cwd 解析（与 arkdbDir/cacheFile 一致） |
| `llm.cacheFile` | string | `<root>/data/knowledge_cache.json` | KnowledgeCache | 同上 |
| `llm.cacheTtlHours` | number | `168` | KnowledgeCache | 缓存 TTL；命中不续期 |
| `llm.arkdbDir` | string | `<root>/data/ark` | ArkDB | 方舟数据目录 |
| `llm.wikiEnabled` | boolean | `true` | WikiRetriever | PRTS.Wiki 检索开关（`!== false`） |
| `llm.wikiApiUrl` | string | `https://prts.wiki/api.php` | WikiRetriever | |
| `llm.wikiMaxResults` | number | `5` | WikiRetriever | search 返回条数上限 |
| `llm.wikiMaxCharPerPage` | number | `4000` | WikiRetriever | 单页内容截断 |
| `llm.wikiTopK` | number | `3` | WikiRetriever | 最终并入上下文的页数 |
| `llm.wikiMinInterval` | number | `2000` | WikiRetriever | 请求最小间隔 ms（example 未列，代码支持） |
| `llm.wikiCooldownMs` | number | `10000` | WikiRetriever | 反爬探测后的冷却 ms（同上） |
| `llm.moegirlEnabled` | boolean | `true` | MoegirlRetriever | |
| `llm.moegirlMaxCharPerPage` | number | `5000` | MoegirlRetriever | |
| `llm.moegirlTopK` | number | `2` | MoegirlRetriever | |
| `llm.moegirlMinInterval` | number | `1500` | MoegirlRetriever | （example 未列） |
| `llm.wikipediaEnabled` | boolean | `false` | WikipediaRetriever | **opt-in**（`=== true` 才开）；需代理访问 zh.wikipedia.org |
| `llm.wikipediaApiUrl` | string | `https://zh.wikipedia.org/w/api.php` | WikipediaRetriever | |
| `llm.wikipediaMaxCharPerPage` | number | `2000` | WikipediaRetriever | |
| `llm.wikipediaTopK` | number | `2` | WikipediaRetriever | |
| `llm.wikipediaMinInterval` | number | `1500` | WikipediaRetriever | （example 未列） |

## 配置怪癖备忘

- llm.* 是「一个块、两类消费者」——总结与聊天共享 key 但各自读字段，改造配置时两者都要考虑。
- wiki/moegirl/wikipedia 三个检索器共享 `config.llm` 整对象作为构造参数，各自只挑自己前缀的键。
- `dataRefresh.announce`、`llm.chatEnabled`、`webui.token` 等"看起来是开关"的键语义不一：有的 `!== false`（默认开）、有的 `=== true`（默认关）、有的按 truthy——改动前对照上表默认列。
