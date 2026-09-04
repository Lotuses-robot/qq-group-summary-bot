/*
 * 统计领域指令插件（P2 由 commands.js 规则 12–14 整段搬移，正则与文案一字未改）。
 *
 * 域内规则按原代码顺序排列（顺序即优先级）：
 *   12. 活跃榜/活跃统计/活跃度 [N天]：近 N 天活跃排行（默认 7 天，收敛 1–90）；缺 analytics → 「统计功能未启用」
 *   13. 整串 群统计/消息统计：本群消息量统计；缺 analytics → 「统计功能未启用」
 * 全部不命中返回 null（含第 14 条「兜底边界」的语义：交给 S13 LLM 兜底判定）。
 * 跨域词头无碰撞（本域词头：活跃榜/活跃统计/活跃度/群统计/消息统计）。
 *
 * 导入守卫（2026-09 修复坑 5）：历史 JSONL 后台导入进行中（analytics.importState ===
 * 'running'）时，两条聚合指令回「历史消息导入中，请稍后再试」——此时查询会读到
 * 不完整库；'idle'（未启动/空库秒完）与 'done' 一律放行，绝不误触发。
 *
 * 依赖：零（不 new、不打日志）；服务经 ctx 注入（analytics 可为 null——守卫在规则内）。
 * 实例化点：src/plugins/index.js 以 descriptor 形式随 commandPlugins 数组交付 runtime 注册。
 */
import { PRIORITY } from '../core/registry.js';

/**
 * 插件描述符构造：{name:'stats', priority: PRIORITY.stats, handleMessage}。
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createStatsPlugin() {
  return {
    name: 'stats',
    priority: PRIORITY.stats,
    /**
     * 统计指令分发：命中返回回复文案，未命中返回 null（落 S13 LLM 兜底）。
     * @param {Object} ctx - 消息上下文：{analytics: Analytics|null, text: string, ...}
     * @returns {string|null} 回复文案或 null（未命中）
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      let m;

      // 活跃榜/活跃统计/活跃度 [N天]：近 N 天活跃排行（默认 7 天，收敛到 1–90）；依赖 analytics
      if ((m = t.match(/^(活跃榜|活跃统计|活跃度)\s*(\d*)$/))) {
        const days = Math.min(Math.max(parseInt(m[2] || '7', 10) || 7, 1), 90);
        if (ctx.analytics?.importState === 'running') return '历史消息导入中，请稍后再试'; // 坑 5：导入中查询读到不完整库
        return ctx.analytics ? ctx.analytics.topActive(days) : '统计功能未启用';
      }
      // 整串「群统计/消息统计」：本群消息量统计，依赖 analytics
      if (t === '群统计' || t === '消息统计') {
        if (ctx.analytics?.importState === 'running') return '历史消息导入中，请稍后再试'; // 坑 5：同上
        return ctx.analytics ? ctx.analytics.groupStats() : '统计功能未启用';
      }

      // 边界：本域全部未命中 → null（上层 registry 继续低优先级插件/chat 兜底）
      return null;
    },
  };
}
