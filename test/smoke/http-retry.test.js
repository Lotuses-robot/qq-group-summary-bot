/**
 * 冒烟测试：core/platform/http.js fetchRetry 行为直测（2026-09 加固新模块）。
 *
 * 覆盖：2xx 直接返回不重试；5xx 重试至成功（中间尝试不读响应体）；4xx 不重试、
 * 响应原样返回；5xx 重试耗尽后最后一次原样返回（body 仍可提取，调用点错误文案不丢）；
 * 连接错误触发重试并最终抛错；超时触发重试、耗尽后抛「请求超时（Nms）」。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchRetry } from '../../src/core/platform/http.js';

const servers = [];

// 起一个本地 HTTP 服务，handler 收到 (req, res) 自行应答；测试结束后统一关闭
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      try {
        handler(req, res);
      } catch {
        /* 客户端提前断开等写入错误忽略 */
      }
    });
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}/`;
// 默认关闭 keep-alive，让每请求独立连接，避免中断的连接句柄拖慢测试进程
const closeSrv = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

after(async () => {
  await Promise.all(servers.map((srv) => closeSrv(srv)));
});

describe('fetchRetry', () => {
  it('2xx 直接返回、不重试', async () => {
    const srv = await startServer((req, res) => { res.end('ok'); });
    const resp = await fetchRetry(urlOf(srv), {}, { timeoutMs: 1000, retries: 2, retryDelayMs: 5 });
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), 'ok');
  });

  it('5xx 触发重试直到成功（中间尝试不读响应体）', async () => {
    let calls = 0;
    const srv = await startServer((req, res) => {
      calls++;
      if (calls < 3) res.writeHead(502).end('boom');
      else res.end('recovered');
    });
    const resp = await fetchRetry(urlOf(srv), {}, { timeoutMs: 1000, retries: 2, retryDelayMs: 5 });
    assert.equal(calls, 3);
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), 'recovered');
  });

  it('4xx 不重试、响应原样返回', async () => {
    let calls = 0;
    const srv = await startServer((req, res) => { calls++; res.writeHead(404).end('not found'); });
    const resp = await fetchRetry(urlOf(srv), {}, { timeoutMs: 1000, retries: 2, retryDelayMs: 5 });
    assert.equal(calls, 1);
    assert.equal(resp.status, 404);
    assert.equal(await resp.text(), 'not found');
  });

  it('5xx 重试耗尽后最后一次原样返回（调用点仍可提取 body）', async () => {
    let calls = 0;
    const srv = await startServer((req, res) => { calls++; res.writeHead(502).end('bad gateway'); });
    const resp = await fetchRetry(urlOf(srv), {}, { timeoutMs: 1000, retries: 1, retryDelayMs: 5 });
    assert.equal(calls, 2);
    assert.equal(resp.status, 502);
    assert.equal(await resp.text(), 'bad gateway');
  });

  it('连接错误触发重试，耗尽后抛最后一次错误', async () => {
    const srv = await startServer((req, res) => res.end('x'));
    const url = urlOf(srv);
    await closeSrv(srv); // 端口随即关闭 → 连接被拒
    await assert.rejects(
      fetchRetry(url, {}, { timeoutMs: 1000, retries: 1, retryDelayMs: 5 }),
      /fetch failed/,
    );
  });

  it('超时触发重试，耗尽后抛「请求超时（Nms）」', async () => {
    let calls = 0;
    const srv = await startServer((req, res) => {
      calls++;
      setTimeout(() => { try { res.end('late'); } catch { /* 连接已断 */ } }, 200);
    });
    await assert.rejects(
      fetchRetry(urlOf(srv), {}, { timeoutMs: 30, retries: 1, retryDelayMs: 5 }),
      /请求超时（30ms）/,
    );
    assert.equal(calls, 2); // 两次尝试都真实发出
  });
});
