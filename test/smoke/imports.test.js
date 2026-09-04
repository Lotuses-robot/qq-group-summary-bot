/**
 * 冒烟测试：全部模块可导入且导出面完整。
 *
 * P1（core/ 迁移 + runtime 拆分）后 index.js 已是纯引导文件（main() 只在
 * argv[1] 命中入口时执行），import 无任何启动副作用——因此也纳入 import 冒烟；
 * 目录约定：core/*.js 在 src/core/，其余在 src/。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcFile = (name) => path.join(__dirname, '..', '..', 'src', ...name.split('/'));

// 模块 → 必须存在的导出名（与各文件头注释声明一致，防重构时少导/改名）
const EXPECTED_EXPORTS = {
  'core/analytics.js': ['Analytics'],
  'core/arkdb.js': ['ArkDB'],
  'core/cache.js': ['KnowledgeCache'],
  'core/filter.js': ['isSensitive', 'sanitizeText', 'filterMessages'],
  'core/lingo.js': ['LingoStore'],
  'core/logger.js': ['log', 'err'],
  'core/moegirl.js': ['MoegirlRetriever'],
  'core/napcat.js': ['NapCatClient'],
  'core/refresher.js': ['DataRefresher'],
  'core/registry.js': ['PluginRegistry', 'PRIORITY'],
  'core/runtime.js': ['createApp', 'main'],
  'core/scheduler.js': ['Scheduler'],
  'core/store.js': ['MessageStore', 'segmentToText', 'extractText', 'localDate', 'hhmm', 'fmtFull'],
  'core/summarizer.js': ['Summarizer'],
  'webui.js': ['WebUI'],
  'core/wiki.js': ['WikiRetriever', 'extractKeywords', 'isArknightsRelated'],
  'core/wikipedia.js': ['WikipediaRetriever'],
  'plugins/ark.js': ['createArkPlugin'],
  'plugins/chat.js': ['ChatBrain'],
  'plugins/gacha.js': ['createGachaPlugin'],
  'plugins/index.js': ['commandPlugins'],
  'plugins/lingo.js': ['createLingoPlugin'],
  'plugins/report.js': ['createReportPlugin'],
  'plugins/refresh.js': ['createRefreshPlugin'],
  'plugins/stats.js': ['createStatsPlugin'],
  'plugins/summary.js': ['createSummaryPlugin'],
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
    const { ArkDB } = await import(pathToFileURL(srcFile('core/arkdb.js')));
    for (const m of ['snapshotHighOps', 'snapshotGachaPools', 'isOperator', 'reload', 'load']) {
      assert.equal(typeof ArkDB.prototype[m], 'function', `ArkDB.prototype.${m}`);
    }
  });
});
