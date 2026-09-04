/**
 * 冒烟测试：全部模块可导入且导出面完整。
 *
 * P1（core/ 迁移 + runtime 拆分）后 index.js 已是纯引导文件（main() 只在
 * argv[1] 命中入口时执行），import 无任何启动副作用——因此也纳入 import 冒烟；
 * P5 目录约定：core/{runtime,registry,routing}.js 在 src/core/ 顶层，platform/（服务）与
 * knowledge/（知识单例）分列 src/core/ 两个子目录，plugins/*.js 在 src/plugins/。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcFile = (name) => path.join(__dirname, '..', '..', 'src', ...name.split('/'));

// 模块 → 必须存在的导出名（与各文件头注释声明一致，防重构时少导/改名）
const EXPECTED_EXPORTS = {
  'core/runtime.js': ['createApp', 'main'],
  'core/registry.js': ['PluginRegistry', 'PRIORITY'],
  'core/routing.js': ['createRouting'],
  'core/platform/analytics.js': ['Analytics'],
  'core/platform/filter.js': ['isSensitive', 'sanitizeText', 'filterMessages'],
  'core/platform/http.js': ['fetchRetry'],
  'core/platform/logger.js': ['log', 'err'],
  'core/platform/napcat.js': ['NapCatClient'],
  'core/platform/refresher.js': ['DataRefresher'],
  'core/platform/scheduler.js': ['Scheduler'],
  'core/platform/store.js': ['MessageStore', 'segmentToText', 'extractText', 'localDate', 'hhmm', 'fmtFull'],
  'core/platform/summarizer.js': ['Summarizer'],
  'core/knowledge/arkdb.js': ['ArkDB'],
  'core/knowledge/cache.js': ['KnowledgeCache'],
  'core/knowledge/lingo.js': ['LingoStore'],
  'core/knowledge/moegirl.js': ['MoegirlRetriever'],
  'core/knowledge/wiki.js': ['WikiRetriever', 'extractKeywords', 'isArknightsRelated'],
  'core/knowledge/wikipedia.js': ['WikipediaRetriever'],
  'plugins/ark.js': ['createArkPlugin'],
  'plugins/chat.js': ['ChatBrain', 'createChatPlugin'],
  'plugins/gacha.js': ['createGachaPlugin'],
  'plugins/index.js': ['commandPlugins'],
  'plugins/lingo.js': ['createLingoPlugin'],
  'plugins/report.js': ['createReportPlugin'],
  'plugins/refresh.js': ['createRefreshPlugin'],
  'plugins/stats.js': ['createStatsPlugin'],
  'plugins/summary.js': ['createSummaryPlugin'],
  'plugins/webui.js': ['WebUI', 'createWebUiPlugin'],
};

describe('模块导入冒烟', () => {
  for (const [file, exports] of Object.entries(EXPECTED_EXPORTS)) {
    it(`${file}：import 成功、导出面完整`, async () => {
      const mod = await import(pathToFileURL(srcFile(file))); // Windows 下动态 import 需 file:// URL
      for (const name of exports) {
        assert.ok(name in mod, `${file} 缺少导出 ${name}`);
      }
    });
  }

  it('index.js：import 无启动副作用（main 仅按入口判定执行），导出 main', async () => {
    const mod = await import(pathToFileURL(srcFile('index.js')));
    assert.equal(typeof mod.main, 'function');
  });

  it('ArkDB 公开方法面：P1 为 runtime 新增的快照/判定 API 不得回退为私有', async () => {
    const { ArkDB } = await import(pathToFileURL(srcFile('core/knowledge/arkdb.js')));
    for (const m of ['snapshotHighOps', 'snapshotGachaPools', 'isOperator', 'reload', 'load']) {
      assert.equal(typeof ArkDB.prototype[m], 'function', `ArkDB.prototype.${m}`);
    }
  });
});
