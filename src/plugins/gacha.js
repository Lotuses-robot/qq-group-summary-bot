/*
 * 抽卡/卡池领域指令插件（P2 由 commands.js 规则 9–11 整段搬移，正则与文案一字未改）。
 *
 * 域内 5 个 if 块按原代码顺序排列（**顺序即优先级，禁止重排/合并正则**）：
 *   9.  整串 卡池/卡池列表：只列当前开放池（currentGachaPools），附 UP 干员与用法提示
 *   10a. 抽卡记录/我的抽卡/抽卡统计 [N]：最近 N 抽明细+累计（默认 10，收敛 1–50）；
 *        缺 analytics/groupId/userId 任一 → 「抽卡记录功能未启用」
 *   10b. 整串 谁最欧/群欧皇/欧气榜：本群 6★ 排行；守卫只查 analytics 与 groupId
 *   11.  单抽/十连/抽卡 [池]：池参数 = 数字序号（1 起）或池名关键字；
 *        负向前瞻 (?!记录|统计|历史) 排除歧义——「单抽记录/十连记录/抽卡统计」绝不能落到本规则
 * ——「抽卡记录/我的抽卡/抽卡统计」必须先于「单抽/十连/抽卡」是本域唯一顺序敏感点。
 * 抽卡/记库调 arkdb.pullFromPool + analytics.recordPull（概率与过滤逻辑在 arkdb.js 内，本文件只做格式化与落库）。
 * 全部不命中返回 null 交下一个优先级插件（stats 400）——跨域词头无碰撞（本域词头：
 * 卡池/卡池列表/抽卡记录/我的抽卡/抽卡统计/谁最欧/群欧皇/欧气榜/单抽/十连/抽卡）。
 *
 * 依赖：零（不 new、不打日志）；服务经 ctx 注入。
 * 实例化点：src/plugins/index.js 以 descriptor 形式随 commandPlugins 数组交付 runtime 注册。
 */
import { PRIORITY } from '../core/registry.js';

/**
 * 插件描述符构造：{name:'gacha', priority: PRIORITY.gacha, handleMessage}。
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createGachaPlugin() {
  return {
    name: 'gacha',
    priority: PRIORITY.gacha,
    /**
     * 卡池/抽卡分发：命中返回回复文案，未命中返回 null。
     * @param {Object} ctx - 消息上下文：{arkdb, analytics, groupId, userId, userName, text}
     * @returns {string|null} 回复文案或 null（未命中）
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      let m;

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

      return null;
    },
  };
}
