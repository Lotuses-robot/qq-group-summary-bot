/*
 * 干员/藏品领域指令插件（P2 由 commands.js 规则 5–8 整段搬移，正则与文案一字未改）。
 *
 * 域内 4 条规则按原代码顺序排列（顺序即优先级）：
 *   5. 查干员/干员 名（≤10 字符）：精确匹配优先 → 语义模糊兜底 → 未找到提示（输出档案五行）
 *   6. 查藏品/藏品 名：精确 → 模糊（findRelicFuzzy 把模糊结果规整为精确命中）
 *   7. 干员生日/生日 名：查单人生日（精确→模糊，库无生日时如实说明）
 *   8. 整串 今日生日/今天谁生日：按本地日期列出（夹具保证每天都有生日干员）
 * 全部不命中返回 null 交下一个优先级插件（gacha 500）——跨域词头无碰撞（本域词头：
 * 查干员/干员/查藏品/藏品/干员生日/生日/今日生日/今天谁生日；「干员生日」与「生日」同域互斥无碍）。
 *
 * 依赖：零（不 new、不打日志）；服务经 ctx 注入。
 * 实例化点：src/plugins/index.js 以 descriptor 形式随 commandPlugins 数组交付 runtime 注册。
 */
import { PRIORITY } from '../core/registry.js';

/**
 * 插件描述符构造：{name:'ark', priority: PRIORITY.ark, handleMessage}。
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createArkPlugin() {
  return {
    name: 'ark',
    priority: PRIORITY.ark,
    /**
     * 干员/藏品/生日查询分发：命中返回回复文案，未命中返回 null。
     * @param {Object} ctx - 消息上下文：{arkdb: ArkDB, text: string, ...}
     * @returns {string|null} 回复文案或 null（未命中）
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      let m;

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

      // 查藏品/藏品 名：精确匹配优先，未中走语义模糊匹配
      if ((m = t.match(/^(查藏品|藏品)\s+(\S.{0,14})$/))) {
        const relic = ctx.arkdb.findRelic(m[2]) || ctx.arkdb.findRelicFuzzy(m[2]);
        if (relic && relic.name && relic.usage) {
          return `【藏品】${relic.name}\n效果：${relic.usage}\n描述：${relic.description || ''}`;
        }
        return `未找到藏品「${m[2]}」`;
      }

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

      return null;
    },
  };
}
