/*
 * 确定性指令大分发表：14 条规则的线性 if-else，代码顺序即优先级（领域内唯一顺序敏感点在抽卡域——
 * 「抽卡记录/我的抽卡/抽卡统计」必须先于「单抽/十连/抽卡」，勿合并两者正则）。
 * 命中即返回回复文案（string）并结束；全部不命中返回严格 null，由路由 S12 落到 S13 LLM 兜底。
 * 本文件只依赖 logger，不 new 任何实例——lingo/arkdb/analytics 全部经 ctx 注入（index.js S12 处组装）。
 *
 * ctx 契约：{ lingo: LingoStore, arkdb: ArkDB, analytics: Analytics|null, groupId?, userId?, userName? }
 * 缺省守卫：抽卡记录要求 analytics+groupId+userId 三者齐全，欧气榜要求 analytics+groupId，缺失返回
 * 「抽卡记录功能未启用」/「欧气榜功能未启用」；统计类（活跃榜/群统计）缺 analytics 返回「统计功能未启用」；
 * 单抽/十连的逐抽记库也仅在三字段齐全时执行（不齐不影响抽卡本身）。
 */
import { log } from './logger.js';

/**
 * 指令分发表入口：按代码顺序逐条匹配 14 条规则，命中即返回回复文案（顺序即优先级）。
 *
 * @param {Object} ctx - 注入的执行上下文（由 index.js 路由 S12 组装）；各字段缺省守卫见文件头
 * @param {Object} ctx.lingo - 本地梗词典（LingoStore）：词条学习/删除/查词/列表
 * @param {Object} ctx.arkdb - 本地方舟库（ArkDB）：干员/藏品/生日查询与抽卡引擎
 * @param {Object} [ctx.analytics] - SQLite 分析层（Analytics）：抽卡记录/欧气榜/活跃统计；未注入时相关规则返回「…功能未启用」
 * @param {string|number} [ctx.groupId] - 群号（抽卡记录/欧气榜的群维度键；undefined 视为未注入）
 * @param {string|number} [ctx.userId] - 提问者 QQ（抽卡记录的用户维度键）
 * @param {string} [ctx.userName] - 提问者显示名（写入抽卡记录作昵称）
 * @param {string} text - @ 剥离后的完整问题文本
 * @returns {string|null} 命中：回复文案；未命中：严格 null（调用方继续 S13 LLM 兜底）
 */
// 群友纠错/学习循环 + 确定性任务指令。
// ctx: { lingo, arkdb, analytics }
export function tryCommand(ctx, text) {
  const t = String(text || '').trim();
  let m;

  // ---- 词典学习 / 维护 ----
  // 「学习/纠正/记/定义 词=释义」（分隔符 = ＝ ： : 均可）或「词 释义」空白分隔变体（词 ≤20 字符）；释义 trim 后不足 2 字拒学
  if ((m = t.match(/^(学习|纠正|记|定义)\s+(.+?)\s*[=＝：:]\s*(.+)$/)) || (m = t.match(/^(学习|纠正|记|定义)\s+(\S{1,20})\s+(.+)$/))) {
    const term = m[2].trim();
    const meaning = m[3].trim();
    if (meaning.length < 2) return '释义太短了，请用「学习 词=释义」的格式，比如：学习 轮椅轴=指用强力干员挂机过关的套路';
    ctx.lingo.learn(term, meaning);
    log(`[cmd] 学习词条: ${term} → ${meaning.slice(0, 30)}`);
    return `已学习词条：${term} → ${meaning}`;
  }

  // 忘记/删除/删 词（词为 ≤20 个非空白字符）
  if ((m = t.match(/^(忘记|删除|删)\s+(\S{1,20})$/))) {
    const ok = ctx.lingo.delete(m[2].trim());
    return ok ? `已忘记词条：${m[2].trim()}` : `词典中没有「${m[2].trim()}」`;
  }

  // 查词/词典查/释义 词（词为 ≤31 字符的非空白开头串）
  if ((m = t.match(/^(查词|词典查|释义)\s+(\S.{0,30})$/))) {
    const hit = ctx.lingo.lookup(m[2].trim());
    return hit ? `【词典】${hit.term}：${hit.meaning}` : `词典中没有「${m[2].trim()}」`;
  }

  // 整串「词典」/「词条数」：列出全部词条（最多展示前 30 条）
  if (t === '词典' || t === '词条数') {
    const keys = [...ctx.lingo.entries.keys()];
    return `当前词典共 ${keys.length} 条。\n${keys.slice(0, 30).join('、')}${keys.length > 30 ? ' …' : ''}`;
  }

  // ---- 干员查询 ----
  // 查干员/干员 名（≤10 字符）：精确匹配优先，未中走语义模糊匹配兜底；都未中找到则提示
  if ((m = t.match(/^(查干员|干员)\s+(\S{1,10})$/))) {
    const op = ctx.arkdb.findByName(m[2]) || ctx.arkdb.findOperatorFuzzy(m[2]);
    if (op) {
      const lines = [
        `【干员】${op.name}`,
        op.birthday ? `生日：${op.birthday}` : '',
        op.gender ? `性别：${op.gender}` : '',
        op.race ? `种族：${op.race}` : '',
        op.height ? `身高：${op.height}` : '',
        op.desc ? `简介：${op.desc.slice(0, 120)}` : '',
      ].filter(Boolean);
      return lines.join('\n');
    }
    return `未找到干员「${m[2]}」，可以试试精确名字，或问「XX是谁」`;
  }

  // ---- 藏品查询 ----
  // 查藏品/藏品 名：精确匹配优先，未中走语义模糊匹配
  if ((m = t.match(/^(查藏品|藏品)\s+(\S.{0,14})$/))) {
    const relic = ctx.arkdb.findRelic(m[2]) || ctx.arkdb.findRelicFuzzy(m[2]);
    if (relic && relic.name && relic.usage) {
      return `【藏品】${relic.name}\n效果：${relic.usage}\n描述：${relic.description || ''}`;
    }
    return `未找到藏品「${m[2]}」`;
  }

  // ---- 生日 ----
  // 干员生日/生日 名：查单人生日（精确→模糊，库无记录时如实提示）
  if ((m = t.match(/^(干员生日|生日)\s+(\S{1,10})$/))) {
    const op = ctx.arkdb.findByName(m[2]) || ctx.arkdb.findOperatorFuzzy(m[2]);
    if (op) return op.birthday ? `【生日】${op.name}：${op.birthday}` : `资料中没有 ${op.name} 的生日记录`;
    return `未找到干员「${m[2]}」`;
  }

  // 整串「今日生日/今天谁生日」：按今天（服务器本地时区）列出过生日的干员
  if (t === '今日生日' || t === '今天谁生日') {
    const now = new Date();
    const list = ctx.arkdb.todaysBirthdays(now);
    return list.length
      ? `今天（${now.getMonth() + 1}月${now.getDate()}日）过生日的干员：\n${list.join('、')}`
      : '今天没有干员过生日';
  }

  // ---- 抽卡（真实卡池）----
  // 整串「卡池/卡池列表」：列出当前开放的卡池（无开放池则提示），每个池附 UP 干员与用法提示
  if (t === '卡池' || t === '卡池列表') {
    const pools = ctx.arkdb.currentGachaPools();
    if (!pools.length) return '当前没有开放的卡池';
    const lines = pools.map((p, i) => {
      const { up6, up5 } = ctx.arkdb.poolRateUps(p);
      const up6Names = up6.map((id) => ctx.arkdb.characters.get(id)?.name || id);
      const up5Names = up5.map((id) => ctx.arkdb.characters.get(id)?.name || id);
      const ups = [];
      if (up6Names.length) ups.push(`6★UP：${up6Names.join('/')}`);
      if (up5Names.length) ups.push(`5★UP：${up5Names.join('/')}`);
      const label = p.guaranteeName || p.gachaRuleType || '';
      return `${i + 1}. ${label ? `[${label}] ` : ''}${p.gachaPoolName}${ups.length ? `（${ups.join('，')}）` : ''}`;
    });
    return '【当前卡池】\n' + lines.join('\n') + '\n\n用法：十连 1 / 单抽 卡池名关键字';
  }

  // ---- 抽卡记录 / 欧气榜（先于抽卡命令，避免"抽卡记录"被"抽卡"匹配）----
  // 抽卡记录/我的抽卡/抽卡统计 [N]：最近 N 抽明细+累计统计（默认 10，收敛到 1–50）；
  // 缺 analytics/groupId/userId 任一 → 「抽卡记录功能未启用」（本规则必须先于下方单抽/十连规则）
  if ((m = t.match(/^(抽卡记录|我的抽卡|抽卡统计)\s*(\d*)$/))) {
    if (!ctx.analytics || ctx.groupId === undefined || ctx.userId === undefined) return '抽卡记录功能未启用';
    const limit = Math.min(Math.max(parseInt(m[2] || '10', 10) || 10, 1), 50);
    const { rows, total, six, five } = ctx.analytics.myPulls(ctx.groupId, ctx.userId, limit);
    if (!rows.length) return '你还没有抽卡记录，试试「十连」吧';
    const list = rows.map((r) => `${r.star} ${r.operator}${r.is_up ? ' ↑UP' : ''}（${r.pool_name}）`).join('\n');
    return `【你的抽卡记录（最近 ${rows.length} 抽）】\n${list}\n\n累计 ${total} 抽 | 6★ ×${six} | 5★ ×${five}`;
  }
  // 整串「谁最欧/群欧皇/欧气榜」：本群欧气排行（按 6★ 数量）；守卫只查 analytics 与 groupId
  if (t === '谁最欧' || t === '群欧皇' || t === '欧气榜') {
    if (!ctx.analytics || ctx.groupId === undefined) return '欧气榜功能未启用';
    const rows = ctx.analytics.luckiest(ctx.groupId);
    if (!rows.length) return '本群还没有抽卡记录';
    return '【本群欧气榜（按6★数量）】\n' + rows.map((r, i) => `${i + 1}. ${r.name}：${r.six} 个6★ / ${r.total} 抽`).join('\n');
  }

  // 单抽/十连/抽卡 [池]：池参数 = 数字序号（1 起）或池名关键字（负向断言排除「记录/统计/历史」开头的歧义）；
  // 无开放池降级常驻模拟 randomPull；有池则 pullFromPool，且 analytics+groupId+userId 齐全时逐抽记库
  if ((m = t.match(/^(单抽|十连|抽卡)(?:\s+(?!记录|统计|历史)(.*))?$/))) {
    const kind = m[1];
    const arg = (m[2] || '').trim();
    const count = kind === '单抽' ? 1 : 10;
    const pools = ctx.arkdb.currentGachaPools();
    if (!pools.length) {
      const results = ctx.arkdb.randomPull(count);
      return `【${kind}·常驻模拟】\n${results.map((r) => `${r.star} ${r.name}`).join('\n')}`;
    }
    let pool = pools[0];
    if (arg) {
      if (/^\d+$/.test(arg)) {
        pool = pools[parseInt(arg, 10) - 1] || pools[0];
      } else {
        const hit = pools.find((p) => p.gachaPoolName.includes(arg) || String(p.gachaPoolId).toLowerCase().includes(arg.toLowerCase()));
        if (hit) pool = hit;
      }
    }
    const { up6, up5 } = ctx.arkdb.poolRateUps(pool);
    const up6Names = up6.map((id) => ctx.arkdb.characters.get(id)?.name || id);
    const up5Names = up5.map((id) => ctx.arkdb.characters.get(id)?.name || id);
    const upDesc = up6Names.length || up5Names.length
      ? `（6★UP：${up6Names.join('/') || '无'}；5★UP：${up5Names.join('/') || '无'}）`
      : '';
    const poolName = pool?.gachaPoolName || '常驻模拟';
    const results = ctx.arkdb.pullFromPool(pool, count);
    // 记录抽卡历史
    if (ctx.analytics && ctx.groupId !== undefined && ctx.userId !== undefined) {
      for (const r of results) {
        ctx.analytics.recordPull(ctx.groupId, ctx.userId, ctx.userName || '', poolName, r.star, r.name, r.up);
      }
    }
    const formatted = results.map((r) => `${r.star} ${r.name}${r.up ? ' ↑UP' : ''}`).join('\n');
    return `【${kind}·${poolName}】${upDesc}\n${formatted}`;
  }

  // ---- 统计（依赖 SQLite 分析层）----
  // 活跃榜/活跃统计/活跃度 [N天]：近 N 天活跃排行（默认 7 天，收敛到 1–90）；依赖 analytics
  if ((m = t.match(/^(活跃榜|活跃统计|活跃度)\s*(\d*)$/))) {
    const days = Math.min(Math.max(parseInt(m[2] || '7', 10) || 7, 1), 90);
    return ctx.analytics ? ctx.analytics.topActive(days) : '统计功能未启用';
  }
  // 整串「群统计/消息统计」：本群消息量统计，依赖 analytics
  if (t === '群统计' || t === '消息统计') {
    return ctx.analytics ? ctx.analytics.groupStats() : '统计功能未启用';
  }

  // 边界：14 条规则全部未命中 → 严格 null（S12 的判定依据，调用方据此落 S13 LLM 兜底）
  return null;
}
