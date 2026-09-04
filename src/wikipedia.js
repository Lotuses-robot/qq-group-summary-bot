/*
 * 维基百科检索器（可选知识源，默认关闭）：通用「非方舟话题」的联网兜底之一。
 *
 * 对外导出：WikipediaRetriever 类（统一检索出口 retrieve）；复用 wiki.js 导出的
 * extractKeywords 做关键词清洗。与另两个 Wiki 检索器一样只在 chat.js 的 ChatBot
 * 构造内 new；cfg.wikipediaEnabled 须严格为 true 才启用（zh.wikipedia 需代理，
 * 启用/话题门约定见 external-apis.md §3）。
 * 读写数据：无本地读写；调 zh.wikipedia.org/w/api.php 的段落 extract 纯文本，
 * 单请求 10s 超时 + 1.5s 最小间隔节流，失败由 retrieve 捕获记日志。
 */
import { log } from './logger.js';
import { extractKeywords } from './wiki.js';

const API_URL = 'https://zh.wikipedia.org/w/api.php';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';

/**
 * 维基百科检索器：search → 前 topK 页取引言（intro）纯文本 → 拼 context。
 * enabled 默认 false，须配置显式开启（wikipediaEnabled === true）。
 */
export class WikipediaRetriever {
  /**
   * @param {Object} cfg - 配置（config.json 的 wikipedia.* 键）
   * @param {boolean} [cfg.wikipediaEnabled=false] - 是否启用（须显式为 true）
   * @param {string} [cfg.wikipediaApiUrl] - 维基百科的 w/api.php 地址
   * @param {number} [cfg.wikipediaMaxCharPerPage=2000] - 单页正文并入上限字符
   * @param {number} [cfg.wikipediaTopK=2] - 并入 context 的页数上限
   * @param {number} [cfg.wikipediaMinInterval=1500] - 相邻请求最小间隔 ms
   */
  constructor(cfg = {}) {
    this.enabled = cfg.wikipediaEnabled === true;
    this.apiUrl = cfg.wikipediaApiUrl || API_URL;
    this.maxCharPerPage = cfg.wikipediaMaxCharPerPage ?? 2000;
    this.topK = cfg.wikipediaTopK ?? 2;
    this._minInterval = cfg.wikipediaMinInterval ?? 1500;
    this._lastRequestAt = 0;
  }

  // 节流：距上次请求不足 _minInterval 时 sleep 到满间隔
  async _wait() {
    const now = Date.now();
    if (now < this._lastRequestAt + this._minInterval) {
      await new Promise((r) => setTimeout(r, this._lastRequestAt + this._minInterval - now));
    }
    this._lastRequestAt = Date.now();
  }

  // 节流后的 MediaWiki GET：10s 超时；响应非 2xx 抛错（由 retrieve 兜底记日志），无重试
  async _get(params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    await this._wait();
    const resp = await fetch(`${this.apiUrl}?${qs}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Wikipedia ${resp.status}`);
    return resp.json();
  }

  /**
   * list=search 标题搜索（取 topK+2 条标题，供 retrieve 取页后按有效内容筛到 topK）。
   * @param {string} keyword - 检索词（调用方负责清洗）
   * @returns {Promise<string[]>} 命中标题；空数组 = 无结果；请求失败抛错由 retrieve 捕获
   */
  async search(keyword) {
    const data = await this._get({
      action: 'query',
      list: 'search',
      srsearch: keyword,
      srlimit: String(this.topK + 2),
      format: 'json',
    });
    return (data?.query?.search || []).map((r) => r.title);
  }

  /**
   * 取单页引言段落纯文本（prop=extracts + exintro + explaintext）。
   * @param {string} title - 页面标题
   * @returns {Promise<string>} 引言纯文本；空串 = 该页无 extract
   */
  async getExtract(title) {
    const data = await this._get({
      action: 'query',
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      titles: title,
      format: 'json',
    });
    const pages = data?.query?.pages || {};
    return Object.values(pages)[0]?.extract || '';
  }

  /**
   * 检索总入口（chat.js 调用点）：仅 enabled 时检索；对前 topK 个标题取引言，
   * 长度 >50 字才并入，拼成「【标题】正文…」context。
   * @param {string} question - 原始提问（内部经 extractKeywords 清洗成 core 再搜）
   * @returns {Promise<{context: string, sources: string[]}>} context='' 且 sources=[]
   *   表示未启用 / 空关键词 / 检索失败（记日志不抛）或全部页引言过短
   */
  async retrieve(question) {
    if (!this.enabled) return { context: '', sources: [] };
    const core = extractKeywords(question) || String(question).trim();
    if (!core) return { context: '', sources: [] };

    try {
      const titles = await this.search(core);
      const pages = [];
      for (const title of titles.slice(0, this.topK)) {
        const extract = await this.getExtract(title);
        if (extract && extract.length > 50) {
          pages.push({ title, content: extract.slice(0, this.maxCharPerPage) });
        }
      }
      const context = pages.map((p) => `【${p.title}】\n${p.content}`).join('\n\n---\n\n');
      log(`[wikipedia] 关键词 "${core}" → ${pages.length} 个词条`);
      return { context, sources: pages.map((p) => p.title) };
    } catch (e) {
      log(`[wikipedia] 检索失败: ${e.message}`);
      return { context: '', sources: [] };
    }
  }
}
