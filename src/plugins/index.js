/*
 * 插件装配清单（P2）：command 域的 4 个确定性指令插件在此集中交付 runtime 注册。
 *
 * runtime.js 在 createApp 内 new PluginRegistry 后逐个 register 本数组；注册顺序无关紧要
 * （registry 按 priority 降序稳定分发），但数组顺序保留声明可读性。dispatch 顺序即旧
 * commands.js 的 14 条线性规则顺序（域内序 + 域间 priority 带），见各插件文件头注释。
 *
 * 对外导出：commandPlugins（4 个插件描述符数组）；实例化点：core/runtime.js createApp。
 * P3 起 summary/refresh/chat 等插件并入本清单（或独立清单）——注册机制已就位。
 */
import { createLingoPlugin } from './lingo.js';
import { createArkPlugin } from './ark.js';
import { createGachaPlugin } from './gacha.js';
import { createStatsPlugin } from './stats.js';

/** 确定性指令插件集（注册顺序 = 声明顺序；实际分发次序由各插件 priority 决定） */
export const commandPlugins = [
  createLingoPlugin(),
  createArkPlugin(),
  createGachaPlugin(),
  createStatsPlugin(),
];
