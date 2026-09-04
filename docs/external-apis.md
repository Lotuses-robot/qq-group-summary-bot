# 对外接口面

> 本 bot 与外部系统交互的全部接口：NapCat（OneBot 11 WS）、LLM（OpenAI 兼容）、三个 Wiki（MediaWiki API 家族）、ArknightsGameData 下载。调试联调时对照本节。

## 1. NapCat / OneBot 11（core/napcat.js）

**连接**：正向 WebSocket `ws://127.0.0.1:3001`（`napcat.wsUrl`），有 token 时拼 `?access_token=`。断线后 `reconnectDelay`(3s) 自动重连；`close()` 置 closed 标志后不再重连。**注意：无应用层心跳处理——心跳 meta_event 到达后因不含 lifecycle 分支被事件处理函数忽略。**

**入站事件**：所有带 `post_type` 的帧逐条派发给 `onEvent` 注册的回调（多回调；回调抛错仅 console.error，不影响其他回调）。WS open 时 NapCat 客户端**自己合成**一个 `lifecycle/connect` 事件（非 NapCat 原生下发，是本 bot 重连后恢复 ready 的锚点）。

**出站调用**（`call(action, params)`，echo 关联，**15s 超时**，WS 未 OPEN 直接 reject）：

| 方法 | action | 参数 | 用途 |
|---|---|---|---|
| `getLoginInfo` | `get_login_info` | — | 回填 selfId |
| `sendGroupMsg` | `send_group_msg` | `auto_escape: true` | 群回复（纯文本，不真 at） |
| `sendPrivateMsg` | `send_private_msg` | `auto_escape: true` | 日报私聊 |
| `getGroupInfo` | `get_group_info` | — | 日报标题取群名 |
| `getGroupMsgHistory` | `get_group_msg_history` | `message_seq:0, count:1000` | backfill 补偿拉取 |

响应处理：`status==='ok' && retcode===0` → resolve data；否则 reject。**无 echo 的响应仅记日志忽略**（并发下无法可靠关联，防错配）。

## 2. LLM（OpenAI 兼容 /chat/completions）

两个调用点（Summarizer 与 ChatBrain 各自独立 fetch，**都无 HTTP 超时/重试**）：

```
POST {llm.baseUrl}/chat/completions
Authorization: Bearer {apiKey}
{ model, messages: [system, user], temperature, max_tokens }
```

| 维度 | Summarizer（概括/日报） | ChatBrain（群聊，plugins/chat.js） |
|---|---|---|
| 请求形状 | system=「严谨简洁的群聊分析助手」+ user=完整结构化 prompt | system=长人设提示（PRTS + 群聊规则 + 匿名机制 + 知识上下文段） |
| temperature | 0.7 | 0.8 |
| max_tokens 默认 | 2048 | 1024 |
| 并发限制 | 无 | 信号量 3（llm.chatConcurrency） |
| 失败兜底 | 抛错冒泡（调用方处理） | 返回 `defaultReply` 文案（照发） |
| 成功副作用 | 无 | 追加群上下文历史（失败不写） |
| 响应取值 | `choices[0].message.content.trim()`；空则抛错 | 同左 |

错误统一为 `LLM API 错误 <status>: <body 前 N 字>`（Summarizer 500 / ChatBrain 300）。

## 3. 三个 Wiki 检索器（MediaWiki 家族）

共同点：均为"search → 取页内容 → 关键词定位截段 → `【标题】…` 拼接"，输出 `{context, sources, scoreSize}`；请求间有最小间隔节流。

| | WikiRetriever (PRTS.Wiki) | MoegirlRetriever (萌娘百科) | WikipediaRetriever (维基) |
|---|---|---|---|
| search | MediaWiki API（12s 超时、1.5s×3 重试、**HTML 反爬探测→10s 冷却**） | OpenSearch API | API search |
| 取页 | wikitext + 白名单清洗（去 ref/标签，保关键参数行） | **浏览器 UA 抓 HTML** + mw-parser-output 容器正则 | 段落 extract 纯文本 |
| 截断 | `wikiMaxCharPerPage`(4000) | `moegirlMaxCharPerPage`(5000) | 2000 |
| 超时 | 12s/请求（AbortSignal） | **无超时**（仅节流） | 10s/请求 |
| 话题门 | 仅方舟相关问题（`isArknightsRelated` 词表+关卡正则）才检索 | 无条件检索（萌娘命中方舟梗兜底 17 个主词条页） | 仅**非**方舟问题且 `enabled===true`（需代理） |
| 并入上下文 | topK=3 | topK=2 | topK=2 |

共享纯函数（core/wiki.js 导出，moegirl/wikipedia 检索器与 chat 插件复用）：`extractKeywords`（问句剥语气词）、`isArknightsRelated`。

## 4. ArknightsGameData 下载（core/refresher.js）

- 镜像源（按序 fallback）：jsDelivr CDN → GitHub raw。
- 4 表：干员表 / 档案 / 藏品 / 卡池（`zh_CN/gamedata/excel/`）。
- 版本比对：`If-None-Match: <etag>` → **304 = 未变化**，跳过下载。
- 结构校验：文件 <1024B / 首字节非 `{` / 计数（干员≥500、档案≥100、藏品≥500、卡池≥10）任一不过 → 拒绝写入并抛错。
- 原子写入：`.tmp` → 旧文件备份 `.bak` → rename；90s 请求超时。
- 上游数据结构约定（ArkDB 消费面）：character_table（`.characters` 或扁平）、handbook `.handbookDict`、藏品递归找 `type==='RELIC'`、卡池 `.gachaPoolClient`。

## 5. 匿名机制（plugins/chat.js ChatBrain 内部约定）

群上下文与 LLM prompt 中不出现真实昵称：`_speakerLabel` 按群维护「昵称/QQ → 群友N」映射（每群上限 200，先到先得，满了才逐出）；system prompt 明确告知模型「群友N 是匿名代号」。该状态只存内存、不落盘、重启即清。
