# 数据文件与格式

> 根目录 `data/`（默认 `config.dataDir`）整体被 .gitignore 排除。下列「容错」列描述文件损坏/缺失时的行为，迁移与排障时依赖这些事实。

## 目录布局

```
data/
  messages/<群号>/<YYYY-MM-DD>.jsonl   消息记录（追加写，按群按天分片）
  state/<群号>.json                     每群最后概括时间
  state/lastSeen.json                   各群最后在线时间（backfill 按群起点，v2 byGroup 形状）
  messages.db                           SQLite 分析层（messages + pulls 两表）
  lingo.json                            群友教出来的梗词典（可手动编辑）
  knowledge_cache.json                  知识检索缓存
  ark/                                  ArknightsGameData 本地镜像（定期更新）
    character_table.json  handbook_info_table.json
    roguelike_topic_table.json  gacha_table.json
    .etags.json                         ETag 版本记录（HTTP 304 判断用）
    <表名>.tmp / <表名>.bak             刷新过程中的临时/备份文件
```

## 1. 消息 JSONL（data/messages/<群号>/<日期>.jsonl）

每行一条消息记录（`MessageStore.addMessage` / `addHistoryMessage` 追加；`loadFromDisk` 读取）：

```json
{"id": "消息message_id(字符串)", "time": 秒级时间戳, "userId": "QQ号(字符串)",
 "name": "card||nickname||'未知'", "card": "群名片原始值", "text": "消息纯文本"}
```

行为要点：

- **写入方**：`store.addMessage`（实时群事件）与 `addHistoryMessage`（backfill 历史）；同步 `appendFileSync`，写在一切路由判断之前。
- **读取方**：`loadFromDisk(gid, [startTs, endTs])`——启动预载只扫今天；日报按日期段载入。逐行去重入内存；发现坏行或重复行会**整文件重写去重**（日志「已去重」）。
- **去重闸**：内存 `writtenIds`（`"群号:消息id"`）防重复写；重启后靠 loadFromDisk 的文件级去重重建。
- **容错**：坏行跳过；写失败不包 try → 异常中断该消息路由（现状行为，勿"修复"）。

## 2. state 状态（JSON 覆盖写）

- `state/<群号>.json` → `{"lastSummaryAt": <秒>}`——summary 插件在**发送成功后**才推进（`store.setLastSummaryAt`）；删除即下次从当前时段重新概括。
- `state/lastSeen.json` → v2 形状 `{"byGroup": {"<群号>": <秒>}}`——**每群水位、只增不减、群间独立**（2026-09 修复坑 9：原为全局单值，单群 backfill 失败会把其他群水位推高、失败群缺口永久错过）；`addMessage` 每写一条都推进**该群**水位并全量覆盖写本文件，backfill 在该群整轮补偿结束后按群写入；**群号键统一 String 归一**（number/string 读写等价，跨重启不丢）。
- 旧 v1 形状 `{"lastSeenTs": <秒>}`（2026-09 前版本遗留）：启动时**迁移播种**——按 `messages/` 下已有群目录逐个播种该单值，并保留进程内回退（本次启动新出现的群在首写 v2 前也按它起水位）；首次 `setLastSeenTs` 落盘即转 v2（播种过的群全量写进 `byGroup`）。
- 解析失败按空（v2 各群按 0、迁移不播种）——backfill 退化为拉满 `backfill.maxHours`（默认 72h）；v2 形状存在时文件里残留的 v1 `lastSeenTs` 冗余键忽略不回退。

## 3. SQLite（data/messages.db，node:sqlite 同步接口）

`Analytics` 构造时建表（DatabaseSync）：

- `messages`：消息镜像（含 `UNIQUE(group_id, msg_id)`）；**首次**任一查询/写入时 `_ensureImported` 同步全量扫描 messages/ 下 JSONL `INSERT OR IGNORE`（首次消息事件可能阻塞数百 ms）。
- `pulls`：抽卡记录（`recordPull`：群/人/池/星级/干员/是否UP）；`myPulls` / `luckiest` 查询。
- 写失败吞掉只记日志；**文件损坏时构造即抛 → 启动崩溃**（countMessages 有 try 返 0）。

## 4. 词典与缓存（JSON 整文件覆盖写）

- `data/lingo.json` → `{"词条": "释义"}`——`learn`/`delete` 全量重写（2 空格缩进）；构造读取；损坏 → log + 空词典继续。
- `data/knowledge_cache.json` → `{"<小写key>": {context, sources, hits, cachedAt}}`——`set` 全量重写、`get` 超 TTL 仅内存删不落盘；key 两种：`q:<问题>`（联网检索结果，跨群共享）与 `lingo:<词条>`（命中计数）。

## 5. 方舟数据（data/ark/）

四个 JSON 来自 [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) `zh_CN/gamedata/excel/`：

| 文件 | 结构约定 | ArkDB 用途 |
|---|---|---|
| `character_table.json` | 对象（或含 `.characters`） | 干员基础表（星级/职业/标签/是否可获取等） |
| `handbook_info_table.json` | `.handbookDict` | 档案（从 storyText 正则抽 性别/生日/种族/身高…） |
| `roguelike_topic_table.json` | 递归收集 `type==='RELIC'` 节点 | 肉鸽藏品（807 个） |
| `gacha_table.json` | `.gachaPoolClient`（过滤非空） | 卡池列表（444 个历史池） |

- ArkDB 惰性加载（首次访问触发，`_loaded` 幂等）；缺文件仅日志、空表继续；`reload()` 供刷新后热替换。
- `DataRefresher` 更新流程：`If-None-Match: <etag>` → 304 视为未变化跳过；校验（<1024B / 首字节非 `{` / 结构计数 干员≥500、档案≥100、藏品≥500、池≥10）→ 写 `.tmp` → 旧文件复制为 `.bak` → rename 原子替换；`.etags.json` 在 4 表全部处理完后保存。失败路径可能残留 `.tmp`（无人清理，无害）。
