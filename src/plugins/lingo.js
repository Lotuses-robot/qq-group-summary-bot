/*
 * 词典领域指令插件（P2 由 commands.js 规则 1–4 整段搬移，正则与文案一字未改）。
 *
 * 域内 4 条规则按原代码顺序排列（顺序即优先级）：
 *   1. 学习/纠正/记/定义 词=释义（= ＝ ： : 或空白分隔，词 ≤20 字符，释义 trim 后不足 2 字拒学）
 *   2. 忘记/删除/删 词（存在则删、否则如实提示）
 *   3. 查词/词典查/释义 词（子串包含命中，忽略大小写，见 core/knowledge/lingo.js lookup）
 *   4. 整串 词典/词条数（列全部词条，最多展示前 30 条）
 * 全部不命中返回 null 交下一个优先级插件（ark 600），与旧分发表逐条判定等价——
 * 跨域词头无碰撞（本域词头：学习/纠正/记/定义/忘记/删除/删/查词/词典查/释义/词典/词条数）。
 *
 * 依赖：logger；服务经 ctx 注入（分发位置 = registry PRIORITY 的 lingo 带 700，见 core/registry.js）。
 * 实例化点：src/plugins/index.js 以 descriptor 形式随 commandPlugins 数组交付 runtime 注册。
 */
import { log } from '../core/platform/logger.js';
import { PRIORITY } from '../core/registry.js';

/**
 * 插件描述符构造：{name:'lingo', priority: PRIORITY.lingo, handleMessage}。
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createLingoPlugin() {
  return {
    name: 'lingo',
    priority: PRIORITY.lingo,
    /**
     * 词典维护分发：命中返回回复文案，未命中返回 null。
     * @param {Object} ctx - 消息上下文：{lingo: LingoStore, text: string, ...}
     * @returns {string|null} 回复文案或 null（未命中）
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      let m;

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

      return null;
    },
  };
}
