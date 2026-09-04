// 知识缓存模块：内存 Map + JSON 落盘的知识条目缓存（默认 data/knowledge_cache.json），带 TTL 过期剔除与命中计数，服务 AI 回答的知识上下文缓存。
// 导出：KnowledgeCache（class；对外接口 get/set/hit/size）。
// 依赖：Node 内置 fs/path/url、./logger.js（log）；唯一实例化点 src/chat.js 的 ChatBot（new KnowledgeCache(cfg.cacheFile, { ttlHours: cfg.cacheTtlHours ?? 168 })）。
// 数据：读写 data/knowledge_cache.json（键为规范化查询串，值为 {…内容, cachedAt, hits}）；文件路径与 TTL 来自 ChatBot 配置 cfg.cacheFile / cfg.cacheTtlHours。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../platform/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// knowledge/（P5a 归类）比原 src/ 深两层：项目根 = __dirname/../../..（config 缺省时才用此默认）
const DEFAULT_CACHE_FILE = path.resolve(__dirname, '..', '..', '..', 'data', 'knowledge_cache.json');

/**
 * 知识缓存存储：键不区分大小写并去除首尾空白；每次 set 立即落盘，get 校验 TTL；缓存文件损坏时自动降级为空缓存（仅记日志）。
 */
export class KnowledgeCache {
  /**
   * @param {string} [filePath] - 缓存文件路径，缺省 data/knowledge_cache.json
   * @param {{ttlHours?: number}} [opts] - 条目的有效期小时数，缺省 168（7 天）
   * 副作用：确保缓存目录存在，并尝试加载既有缓存
   */
  constructor(filePath = DEFAULT_CACHE_FILE, { ttlHours = 168 } = {}) {
    this.filePath = filePath;
    this.ttlMs = ttlHours * 3600 * 1000;
    this.store = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._load();
  }

  // 内部：启动时从磁盘加载缓存到 Map；JSON 损坏仅记日志并保持空缓存
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.store = new Map(Object.entries(data));
      }
    } catch (e) {
      log(`[cache] 加载缓存失败: ${e.message}`);
    }
  }

  // 内部：把当前 Map 全量写回 JSON 文件；失败仅记日志，不向上抛出
  _save() {
    try {
      const obj = Object.fromEntries(this.store);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      log(`[cache] 保存缓存失败: ${e.message}`);
    }
  }

  // 内部：规范化查询键（小写 + 去首尾空白），get/set/hit 共用保证命中一致
  _normalizeKey(key) {
    return String(key).toLowerCase().trim();
  }

  /**
   * 读取缓存项；已过期的项会被当场删除并视为未命中。
   * @param {string} key - 查询键（内部自动规范化）
   * @returns {Object|null} 未过期时返回缓存对象（含 cachedAt 时间戳与 hits 命中数）；无记录或已过期返回 null
   */
  get(key) {
    const k = this._normalizeKey(key);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(k);
      return null;
    }
    return entry;
  }

  /**
   * 写入或覆盖一个缓存项并立即落盘，自动附带 cachedAt 时间戳。
   * @param {string} key - 缓存键（内部自动规范化）
   * @param {Object} value - 要缓存的任意对象（新条目的 hits 字段由后续 hit() 累计）
   * @returns {void} 副作用：同步写回缓存文件
   */
  set(key, value) {
    const k = this._normalizeKey(key);
    this.store.set(k, {
      ...value,
      cachedAt: Date.now(),
    });
    this._save();
  }

  /**
   * 对缓存项累加一次命中计数（只计次数，不刷新过期时间，避免热点被无限续期）。
   * @param {string} key - 缓存键（内部自动规范化）
   * @returns {number} 累加后的命中次数；条目不存在时返回 0
   */
  hit(key) {
    const k = this._normalizeKey(key);
    const entry = this.store.get(k);
    if (!entry) return 0;
    // 命中只计次数，不刷新 cachedAt，避免热点问题被无限续期
    entry.hits = (entry.hits || 0) + 1;
    return entry.hits;
  }

  /**
   * @returns {number} 当前缓存条目数（不做 TTL 扫描，可能含已过期但未被 get 访问的项）
   */
  size() {
    return this.store.size;
  }
}
