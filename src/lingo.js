// 本地梗词典模块：维护「词条 → 释义」映射（内存 Map + JSON 落盘，默认 data/lingo.json），供 AI 回答前的本地查词、群内「学习/删除词条」指令与管理面板使用。
// 导出：LingoStore（class；公开字段 entries，公开方法 lookup/learn/delete/size）。
// 依赖：Node 内置 fs/path/url、./logger.js（log）；实例化于 src/chat.js 的 ChatBot（new LingoStore(cfg.lingoFile)），经其上下文供 src/commands.js 与 src/webui.js 访问。
// 数据：读写 data/lingo.json（词条 → 释义的 JSON 对象）；文件路径来自 ChatBot 配置 cfg.lingoFile。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LINGO_FILE = path.resolve(__dirname, '..', 'data', 'lingo.json');

/**
 * 词典存储：lookup 为忽略大小写的子串包含匹配（按插入序返回首个命中）；每次 learn/delete 后立即落盘；磁盘文件损坏时降级为空词典（仅记日志）。
 */
export class LingoStore {
  /**
   * @param {string} [filePath] - 词典文件路径，缺省 data/lingo.json
   * 副作用：确保词典目录存在，并尝试加载既有词典
   */
  constructor(filePath = DEFAULT_LINGO_FILE) {
    this.filePath = filePath;
    // 公开字段 entries：词条 → 释义 的 Map。外部直读方：commands.js（词条列表/总数）、webui.js 管理面板（经 entries.entries() 遍历展示与编辑）
    this.entries = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._load();
  }

  // 内部：启动时从磁盘加载词典到 Map；JSON 损坏仅记日志并保持空词典
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.entries = new Map(Object.entries(data));
      }
    } catch (e) {
      log(`[lingo] 加载词典失败: ${e.message}`);
    }
  }

  // 内部：把当前 Map 全量写回 JSON 文件；失败仅记日志，不向上抛出
  _save() {
    try {
      const obj = Object.fromEntries(this.entries);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      log(`[lingo] 保存词典失败: ${e.message}`);
    }
  }

  /**
   * 在词典中查找与文本匹配的词条：忽略大小写的子串包含匹配，按插入顺序返回第一个命中。
   * @param {string} text - 待查文本
   * @returns {{term: string, meaning: string}|null} 命中返回 {term: 存储时的词条原样, meaning: 释义}；空文本或未命中返回 null
   */
  lookup(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();
    for (const [key, value] of this.entries) {
      if (lower.includes(String(key).toLowerCase())) {
        return { term: key, meaning: value };
      }
    }
    return null;
  }

  /**
   * 学习（新增或覆盖）一个词条并立即落盘。
   * @param {string} term - 词条文本；空值直接忽略，存盘前去除首尾空白
   * @param {string} meaning - 对应释义（存盘前去除首尾空白）
   * @returns {void} 副作用：写回 lingo.json 并打印学习日志
   */
  learn(term, meaning) {
    if (!term) return;
    this.entries.set(String(term).trim(), String(meaning).trim());
    this._save();
    log(`[lingo] 已学习新词条: ${term}`);
  }

  /**
   * 删除一个词条。
   * @param {string} term - 词条文本（与存储键一致，均已去首尾空白）
   * @returns {boolean} 词条存在且删除成功返回 true；不存在返回 false
   */
  delete(term) {
    if (this.entries.delete(String(term))) {
      this._save();
      return true;
    }
    return false;
  }

  /**
   * @returns {number} 当前词条总数
   */
  size() {
    return this.entries.size;
  }
}
