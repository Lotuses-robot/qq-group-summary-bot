/*
 * 插件注册表与消息分发中枢（P1 落地骨架；P2/P3 已接入全部 9 插件与 dispatch 调用方）。
 *
 * 目标架构的注册/分发中枢（docs/refactor-proposal.md §目标架构）：
 * 插件声明式自注册，core 管线按确定性顺序驱动。插件描述符：
 *   { name, priority, enabled, handleMessage(ctx) → string|true|null, hooks:{start,stop}, api }
 * 分发语义：按 priority 降序（同分保插入序——Array#sort 稳定）逐插件同步调用
 * handleMessage；string → 命中待发送、true → 已处理、null/undefined → 继续下一个；
 * **调用方不 await 任何返回值**（异步插件自驱 Promise 链，保持现状 fire-and-forget 时序）。
 *
 * 依赖：零（只依赖 JS 标准）；实例化点：core/runtime.js 装配时 new 一次；
 * 对外导出：class PluginRegistry + PRIORITY 常量表。
 * 读写数据：不直接读写任何数据；插件的消息/数据能力由 runtime 注入的 ctx 提供。
 */
import { log } from './platform/logger.js';

/** 插件优先级带（原 index.js 路由链顺序的编码；数值越大越先分发，见 refactor-proposal） */
export const PRIORITY = Object.freeze({
  summary: 900, // 手动总结关键词（S8）——路由链最前的产品行为
  refresh: 800, // 数据刷新指令（S11）
  lingo: 700,   // 词典学习/维护（commands 规则 1-4）
  ark: 600,     // 干员/藏品/生日查询（规则 5-8）
  gacha: 500,   // 卡池/抽卡/抽卡记录（规则 9-11，含顺序敏感正则）
  stats: 400,   // 活跃榜/群统计（规则 12-14）
  chat: 300,    // LLM 兜底（S13）
});

/** 是否合法插件名（防注册时空名/重名把分发表搞乱） */
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * 插件注册表：register 校验描述符并登记，dispatch 按优先级确定性分发给各插件。
 * startAll/stopAll 依次调各插件的 hooks.start/stop（start 按优先级降序、stop 逆序）。
 */
export class PluginRegistry {
  /** 建一个空注册表（runtime 进程级单实例） */
  constructor() {
    /** @type {Array<{name: string, priority: number, enabled: boolean, handleMessage: Function, hooks: Object}>} */
    this.plugins = [];
  }

  /**
   * 登记一个插件描述符。重复 name 时后者覆盖前者（重载/热启用场景）。
   * @param {Object} plugin - 描述符 {name, priority?, enabled?, handleMessage, hooks?, api?}
   *   - name: 小写连字符插件名（必填，命名校验不过抛错）
   *   - priority: 数字，默认 0（同分按注册顺序，稳定）
   *   - enabled: 布尔，默认 true（false 时 dispatch 跳过，hooks 仍可被 startAll 调用）
   *   - handleMessage: (ctx) => string|true|null|undefined
   *   - hooks: {start(ctx?), stop()} 可选
   *   - api: 任意导出对象（供 runtime/其他插件经 registry 取用）
   * @returns {PluginRegistry} this（链式）
   */
  register(plugin) {
    if (!plugin || typeof plugin.name !== 'string' || !NAME_RE.test(plugin.name)) {
      throw new Error(`插件名非法: ${plugin?.name}（须匹配 ${NAME_RE}）`);
    }
    if (typeof plugin.handleMessage !== 'function') {
      throw new Error(`插件 ${plugin.name} 缺 handleMessage(ctx) 函数`);
    }
    const idx = this.plugins.findIndex((p) => p.name === plugin.name);
    const entry = {
      name: plugin.name,
      priority: plugin.priority ?? 0,
      enabled: plugin.enabled !== false,
      handleMessage: plugin.handleMessage,
      hooks: plugin.hooks || {},
      api: plugin.api,
    };
    if (idx >= 0) this.plugins[idx] = entry;
    else this.plugins.push(entry);
    log(`[registry] 插件 ${plugin.name} 已注册 (priority=${entry.priority})`);
    return this;
  }

  /**
   * 按 priority 降序的稳定排序视图（同分保注册序，Array#sort 稳定；不改变登记序）。
   * @returns {Object[]} 排序后的插件数组（直接引用，勿改）
   */
  sorted() {
    return [...this.plugins].sort((a, b) => b.priority - a.priority);
  }

  /**
   * 依次分发一条消息给所有 enabled 插件：首个返回 string/true 的插件短路。
   * @param {Object} ctx - 消息上下文（由 runtime 构造：群号/用户/文本/共享服务句柄）
   * @returns {string|true|null} string = 待发送文案、true = 已处理（发送由调用方负责）、
   *   null = 无人认领（全部插件让位——正常配置下末端 chat 300 恒消费，不会落 null）
   */
  dispatch(ctx) {
    for (const p of this.sorted()) {
      if (!p.enabled) continue;
      let r = null;
      try {
        r = p.handleMessage(ctx);
      } catch (e) {
        // 单插件异常不得中断整条分发给 chat 兜底（保持旧分发表 tryCommand 的容错语义）
        log(`[registry] 插件 ${p.name} 分发异常: ${e.message}`);
        continue;
      }
      if (r !== null && r !== undefined) return r;
    }
    return null;
  }

  /**
   * 依 priority 降序调全部插件的 hooks.start（插件自身异步回调可自行 Promise 链，
   * 注册表不 await——与分发语义一致）。
   * @param {Object} [ctx] - 透传给 start 的上下文
   */
  startAll(ctx) {
    for (const p of this.sorted()) {
      if (typeof p.hooks.start === 'function') {
        try {
          p.hooks.start(ctx);
        } catch (e) {
          log(`[registry] 插件 ${p.name} start 异常: ${e.message}`);
        }
      }
    }
  }

  /**
   * 依 priority 升序（stop 与 start 反向）调全部插件的 hooks.stop。
   * @param {Object} [ctx] - 透传给 stop 的上下文
   */
  stopAll(ctx) {
    for (const p of this.sorted().reverse()) {
      if (typeof p.hooks.stop === 'function') {
        try {
          p.hooks.stop(ctx);
        } catch (e) {
          log(`[registry] 插件 ${p.name} stop 异常: ${e.message}`);
        }
      }
    }
  }
}
