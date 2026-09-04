/*
 * HTTP 请求工具：带超时与重试的 fetch 包装（2026-09 立项加固——Summarizer/ChatBrain 的
 * LLM 调用与 moegirl 的 2 个 fetch 原本均「无超时、无重试」，统一改走本模块；动机与
 * 决策见 refactor-proposal「待办」与 docs/external-apis.md §2/§3）。
 *
 * 职责：fetchRetry 给每次请求尝试加 AbortSignal.timeout 超时，仅「网络错误/超时/HTTP 5xx」
 * 触发重试（间隔 retryDelayMs）；2xx/4xx 与最后一次尝试的 5xx **原样返回响应对象**——
 * 非 2xx 的错误文案提取仍由调用点完成（信息不因包装而丢失），5xx 的中间尝试不读响应体。
 * wiki/wikipedia/refresher 各自的既有超时/重试策略（带节流与反爬冷却）不迁入本模块。
 *
 * 对外导出：fetchRetry(url, opts, cfg)。实例化点：无实例——纯函数模块，调用方为
 * core/platform/summarizer.js、plugins/chat.js（LLM 60s × 2 重试）与
 * core/knowledge/moegirl.js（15s × 1 重试）；对 platform/ 组内只依赖 logger。
 * 读写数据：不读写文件；发生重试时写一条 [http] 日志。
 */
import { log } from './logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带超时与重试的 fetch：每次尝试独立计时（AbortSignal.timeout(timeoutMs)）；
 * 网络错误/超时/HTTP 5xx 触发重试，2xx/4xx 一律直接返回（retries 耗尽后的 5xx 也
 * 原样返回——调用点按既有非 2xx 分支提取 body 文案）。全部尝试耗尽仍失败时抛
 * 最后一次错误；超时错误的文案统一为「请求超时（<timeoutMs>ms）」。
 *
 * @param {string} url - 请求地址（同 fetch）
 * @param {Object} [opts={}] - fetch 选项（method/headers/body…）；signal 例外——
 *   本函数独占超时控制，调用方勿传
 * @param {Object} [cfg] - 重试配置
 * @param {number} [cfg.timeoutMs=30000] - 单次尝试超时毫秒数
 * @param {number} [cfg.retries=0] - 重试次数（初次尝试不计入；0 = 只试一次不重试）
 * @param {number} [cfg.retryDelayMs=1000] - 相邻两次尝试的间隔毫秒数
 * @returns {Promise<Response>} 2xx/4xx/最后尝试的 5xx 响应对象（同 fetch 返回值）
 * @throws {Error} 网络错误/超时重试耗尽后抛最后一次错误；5xx 重试耗尽抛「HTTP <status>」
 * 副作用: 每次实际重试写一条 [http] 日志（logger）
 */
export async function fetchRetry(url, opts = {}, { timeoutMs = 30000, retries = 0, retryDelayMs = 1000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    try {
      const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      // 5xx 且还有剩余重试：丢弃响应体（释放连接）后进入下一次尝试
      if (resp.status >= 500 && attempt < retries) {
        await resp.body?.cancel().catch(() => {});
        lastErr = new Error(`HTTP ${resp.status}`);
        log(`[http] ${url} 返回 ${resp.status}，${retryDelayMs}ms 后重试（第 ${attempt + 1}/${retries} 次）`);
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? new Error(`请求超时（${timeoutMs}ms）`) : e;
      if (attempt < retries) {
        log(`[http] ${url} 请求失败：${lastErr.message}，${retryDelayMs}ms 后重试（第 ${attempt + 1}/${retries} 次）`);
      }
    }
  }
  throw lastErr;
}
