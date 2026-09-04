/**
 * 冒烟测试：全部模块可导入且导出面完整。
 *
 * 说明：index.js 刻意不在 import 冒烟之列——它是「加载即启动」的装配者（顶层读
 * config.json、new 全部实例、client.connect()、起定时器），直接 import 会拉起真实
 * 网络与定时任务。这是 P1 拆 createApp()/main() 的动机；当前以 node --check 作语法门。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcFile = (name) => path.join(__dirname, '..', '..', 'src', name);

// 模块 → 必须存在的导出名（与各文件头注释声明一致，防重构时少导/改名）
const EXPECTED_EXPORTS = {
  'analytics.js': ['Analytics'],
  'arkdb.js': ['ArkDB'],
  'cache.js': ['KnowledgeCache'],
  'chat.js': ['ChatBot'],
  'commands.js': ['tryCommand'],
  'filter.js': ['isSensitive', 'sanitizeText', 'filterMessages'],
  'lingo.js': ['LingoStore'],
  'logger.js': ['log', 'err'],
  'moegirl.js': ['MoegirlRetriever'],
  'napcat.js': ['NapCatClient'],
  'refresher.js': ['DataRefresher'],
  'scheduler.js': ['Scheduler'],
  'store.js': ['MessageStore', 'segmentToText', 'extractText', 'localDate', 'hhmm', 'fmtFull'],
  'summarizer.js': ['Summarizer'],
  'webui.js': ['WebUI'],
  'wiki.js': ['WikiRetriever', 'extractKeywords', 'isArknightsRelated'],
  'wikipedia.js': ['WikipediaRetriever'],
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

  it('index.js：不做 import 冒烟（加载即启动），以 node --check 语法门兜底', () => {
    execFileSync(process.execPath, ['--check', srcFile('index.js')], { stdio: 'pipe' });
  });
});
