/*
 * 萌娘百科检索器（通用 ACG/社区梗百科）：ChatBrain（plugins/chat.js）三级知识库中「非方舟话题」的联网兜底，
 * 并带 17 个方舟主词条页的梗/世界观补充检索（见 ARK_LINGO_PAGES）。
 *
 * 对外导出：MoegirlRetriever 类（统一检索出口 retrieve）；复用 wiki.js 导出的
 * extractKeywords 做关键词清洗。类由 core/runtime.js 装配为知识共享单例
 * （三个 Wiki 检索器同此，注入 ChatBrain）；启用/节流等 moegirl 系配置键经构造参数注入。
 * 读写数据：无本地读写；抓取 zh.moegirl.org.cn 网页（浏览器 UA 防反爬 + 正文容器
 * 正则提取），仅 1.5s 最小间隔节流——fetch 无超时（见 architecture.md §8 坑 6）。
 */
import { log } from '../platform/logger.js';
import { extractKeywords } from './wiki.js';

const API_URL = 'https://zh.moegirl.org.cn/api.php';
const SITE_URL = 'https://zh.moegirl.org.cn';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 与明日方舟社区梗/黑话相关的萌娘百科主词条（梗/物品/世界观可能收录在这些页面中）
const ARK_LINGO_PAGES = [
  '明日方舟/梗',
  '明日方舟',
  '魔法Zc目录',
  '龙哥哥今天又鸽了',
  '明日方舟UP主',
  // 世界观/地区/阵营（含大量物品、货币、梗的记录）
  '高卢(明日方舟)',
  '龙门(明日方舟)',
  '维多利亚(明日方舟)',
  '乌萨斯(明日方舟)',
  '哥伦比亚(明日方舟)',
  '莱塔尼亚(明日方舟)',
  '谢拉格(明日方舟)',
  '炎国(明日方舟)',
  '卡西米尔(明日方舟)',
  '罗德岛(明日方舟)',
  '整合运动(明日方舟)',
  '明日方舟/世界观',
];

/**
 * 萌娘百科检索器：以「OpenSearch 直搜词条 → 抓 HTML 正文」为主，命中不足 topK 时
 * 从 ARK_LINGO_PAGES 兜底页中定位关键词所在段落补足。
 * enabled=false（moegirlEnabled）时检索类方法直接空转。
 */
export class MoegirlRetriever {
  /**
   * @param {Object} cfg - 配置（config.json 的 moegirl.* 键，缺省用默认值）
   * @param {boolean} [cfg.moegirlEnabled=true] - 是否启用本检索器
   * @param {number} [cfg.moegirlMaxCharPerPage=5000] - 单页正文并入上限字符
   * @param {number} [cfg.moegirlTopK=2] - 并入 context 的页数上限
   * @param {number} [cfg.moegirlMinInterval=1500] - 相邻请求最小间隔 ms（无超时，仅靠它限流）
   */
  constructor(cfg = {}) {
    this.enabled = cfg.moegirlEnabled !== false;
    this.maxCharPerPage = cfg.moegirlMaxCharPerPage ?? 5000;
    this.topK = cfg.moegirlTopK ?? 2;
    this._minInterval = cfg.moegirlMinInterval ?? 1500;
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

  /**
   * OpenSearch 接口搜索词条（返回标题与词条链接）。
   * 副作用: 请求前节流等待（_wait）；失败直接抛错，由调用方 try/catch 兜底。
   * @param {string} keyword - 检索词
   * @param {number} [limit=5] - 返回条数上限
   * @returns {Promise<{title: string, url: string}[]>} 联想词条；空数组 = 无结果
   */
  async searchOpensearch(keyword, limit = 5) {
    const url = `${API_URL}?action=opensearch&search=${encodeURIComponent(keyword)}&format=json&limit=${limit}`;
    await this._wait();
    const resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const data = await resp.json();
    // opensearch 返回 [query, titles[], desc[], urls[]]
    return (data?.[1] || []).map((title, i) => ({ title, url: data?.[3]?.[i] }));
  }

  // 生成关键词的匹配变体：325 → ["325", "3-25", "三二五", "3 2 5"]
  _keywordVariants(keyword) {
    const variants = new Set([String(keyword).trim()]);
    const t = String(keyword).trim();
    // 从混合文本中提取纯数字（如 "325 意思" → "325"）
    const pureNum = t.match(/\d+/);
    if (pureNum) variants.add(pureNum[0]);
    const numMatch = t.match(/^(\d+)$/);
    if (numMatch) {
      const digits = numMatch[1];
      variants.add(digits.split('').join('-'));
      variants.add(digits.split('').join(' '));
      const cn = digits.split('').map((d) => '零一二三四五六七八九'[Number(d)]).join('');
      variants.add(cn);
    }
    return [...variants];
  }

  /**
   * 以浏览器 UA 抓取词条整页 HTML（萌娘百科对默认 UA 有反爬拦截）。
   * 副作用: 请求前节流等待；响应非 2xx 抛错，由调用方捕获跳过该词条。
   * @param {string} title - 词条标题
   * @returns {Promise<string>} 整页 HTML
   */
  async getPageHtml(title) {
    await this._wait();
    const url = `${SITE_URL}/${encodeURIComponent(title)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    if (!resp.ok) throw new Error(`Moegirl ${resp.status}`);
    return resp.text();
  }

  /**
   * 从整页 HTML 提取正文纯文本：按优先级尝试 4 种正文容器正则，全部不中则退回
   * 截取 mw-content-text 至页尾的片段，再统一剥 script/style/标签并压缩空白。
   * @param {string} html - getPageHtml 的返回
   * @returns {string} 正文纯文本；容器与 mw-content-text 都不在时近似为全页清洗结果
   */
  extractBody(html) {
    let body = html;
    // 优先匹配正文容器（MediaWiki 常见结构）
    const patterns = [
      /<div class="mw-parser-output">([\s\S]*?)<\/div>\s*<\/div>/,
      /<div id="mw-content-text"[^>]*>([\s\S]*?)<div class="printfooter"|/,
      /<div class="mw-body-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/,
      /<div id="bodyContent"[^>]*>([\s\S]*?)<div class="printfooter"|/,
    ];
    for (const p of patterns) {
      const m = body.match(p);
      if (m && m[1] && m[1].length > 500) {
        body = m[1];
        break;
      }
    }
    // 若上面都没匹配到，尝试截取 mw-content-text 之后、页面底部之前的内容
    if (body.length === html.length) {
      const start = body.indexOf('id="mw-content-text"');
      if (start > 0) {
        const cut = body.indexOf('id="catlinks"', start);
        const end = cut > start ? cut : Math.min(start + 200000, body.length);
        body = body.slice(start, end);
      }
    }
    body = body
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return body;
  }

  // 词条相关性过滤：标题含关键词即算相关；纯数字/代号关键词可放宽到命中方舟系标题
  _isRelevantHit(title, keyword) {
    const t = String(title).toLowerCase();
    const kw = String(keyword).toLowerCase();
    if (t.includes(kw)) return true;
    // 关键词是短数字/代号时，允许命中方舟相关词条（含明日方舟标记）
    if (/^[0-9a-z\-]+$/.test(kw) && /明日方舟|方舟|罗德岛|prts|干员/.test(t)) return true;
    return false;
  }

  /**
   * 检索总入口（ChatBrain 调用点）：先用核心词 OpenSearch 直搜词条抓正文，不足 topK
   * 时从 ARK_LINGO_PAGES 兜底页中全文扫关键词所在段落（最多扫 5 个兜底页防慢）。
   * 副作用: 兜底定位命中、搜索失败与最终汇总均写 [moegirl] 日志；单页抓取失败静默跳过。
   * @param {string} keyword - 提问/关键词（内部经 extractKeywords 清洗出 core 再搜）
   * @returns {Promise<{context: string, sources: string[], scoreSize: number}>}
   *   context='' 且 sources=[] = 未启用或空关键词（此时无 scoreSize 字段）；
   *   有命中时 scoreSize = 各页实际并入 content 的字符数合计
   */
  async retrieve(keyword) {
    if (!this.enabled || !keyword) return { context: '', sources: [] };

    const pages = [];
    const seen = new Set();
    const core = extractKeywords(keyword) || String(keyword).trim();
    const variants = this._keywordVariants(core);

    // 1. 尝试直接搜关键词对应词条（用核心词，如"波登可生日"→"波登可"）
    try {
      const hits = await this.searchOpensearch(core);
      for (const hit of hits) {
        if (seen.has(hit.title)) continue;
        seen.add(hit.title);
        if (pages.length >= this.topK) break;
        if (!this._isRelevantHit(hit.title, core)) continue;
        try {
          const html = await this.getPageHtml(hit.title);
          const body = this.extractBody(html);
          if (body.length > 200) pages.push({ title: hit.title, content: body.slice(0, this.maxCharPerPage) });
        } catch {
          /* 跳过抓取失败 */
        }
      }
    } catch (e) {
      log(`[moegirl] 搜索失败: ${e.message}`);
    }

    // 2. 若不足，从方舟梗主页面补充检索相关段落
    if (pages.length < this.topK) {
      // 先在所有兜底页面中寻找关键词命中（优先级最高），最多扫描 5 个避免太慢
      let hitPage = null;
      let scanned = 0;
      for (const page of ARK_LINGO_PAGES) {
        if (seen.has(page)) continue;
        seen.add(page);
        if (++scanned > 5) break;
        try {
          const html = await this.getPageHtml(page);
          const body = this.extractBody(html);
          for (const v of variants) {
            const kwIdx = body.indexOf(v);
            if (kwIdx > 0) {
              const start = Math.max(0, kwIdx - 200);
              hitPage = { title: page, content: body.slice(start, start + this.maxCharPerPage) };
              log(`[moegirl] 在 "${page}" 中定位到 "${v}"`);
              break;
            }
          }
          if (hitPage) break;
        } catch {
          /* 跳过 */
        }
      }
      if (hitPage) {
        pages.unshift(hitPage);
      }
    }

    const context = pages.map((p) => `【${p.title}】\n${p.content}`).join('\n\n---\n\n');
    log(`[moegirl] 关键词 "${keyword}" → ${pages.length} 个词条`);
    const totalSize = pages.reduce((acc, p) => acc + (p.content?.length || 0), 0);
    return { context, sources: pages.map((p) => p.title), scoreSize: totalSize };
  }
}
