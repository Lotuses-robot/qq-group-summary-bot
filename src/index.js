/*
 * 引导入口（唯一职责，原 index.js 的装配/路由/编排全部迁往 core/runtime.js，P1）：
 * import { main } from './core/runtime.js' 并在「作为入口文件被 node 执行」时调用它。
 *
 * 判定方式：argv[1] 与本文件真实路径比对（import.meta.main 需 Node ≥24.2，本仓库引擎下限 22.5，
 * 故用文件 URL 比对）；npm start = node src/index.js 必然命中 → main() 读配置并 createApp().start()；
 * 任何 import 本文件的场景（测试、工具）都不会触发启动副作用——这是 P1 拆分的核心收益。
 */
import { pathToFileURL } from 'node:url';
import { main } from './core/runtime.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

// 同时 re-export：程序化场景（测试/工具）可 import 本文件取 main()，import 本身仍无副作用
export { main };
