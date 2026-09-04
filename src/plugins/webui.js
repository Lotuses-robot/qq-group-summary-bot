/*
 * Web 管理面板插件（P3c 由 src/webui.js 迁入并插件化：class WebUI 原样保留 + hooks 包装）。
 *
 * Web 管理面板：零依赖（node:http + 内联 HTML）的本地服务，提供运行状态、本地词典管理、
 * 手动数据刷新与脱敏配置查看；页面为 _html() 返回的内联模板字符串（勿改模板文案/脚本）。
 * start(ctx) 注入契约 4 成员：{ getStatus(): Object, getLingo(): LingoStore, getConfig(): Object,
 * refreshData(): Promise<string> }——由 core/runtime.js 装配期把闭包注入 createWebUiPlugin(deps)。
 *
 * 鉴权：_handle 入口由 _authorized 统一拦截（Authorization: Bearer <token> 或 URL ?token=；
 * token 为空则免鉴权）。脱敏：仅 /api/config 出口经 _maskedConfig（llm.apiKey 留首 6 尾 4 加
 * 省略号、napcat.accessToken 置 ***）。路由表：GET /、/index.html → 页面；GET /api/status →
 * 状态快照；GET /api/lingo → 词条列表；POST /api/lingo → 学词/删词；POST /api/refresh →
 * 手动刷新（共用 §6.3 refresh runner）；GET /api/config → 脱敏配置；其余 404；_handle 抛错
 * 由 start 内联 catch 兜成 500 JSON。
 *
 * 消息面：无（仅 hooks 插件——handleMessage 恒 null；priority 0 不占分发带，同 report）。
 * hooks.start → cfg.enabled !== false 时 new WebUI 并 listen（原 runtime.start 末段）；
 * hooks.stop → server.close()（原实现无停服路径、依赖 process.exit，插件化后补上，属无害增强）。
 *
 * 依赖：node:http、core/platform/logger；实例化点：core/runtime.js createApp（startCtx 4 成员闭包注入）。
 * 读写数据：读 lingo/arkdb/analytics（经 startCtx.getStatus/getLingo）；写词典经 getLingo()；
 * 刷新触发经 refreshData（桥接 refresh 插件 api，P3b）。
 */
import http from 'node:http';
import { log } from '../core/platform/logger.js';

/**
 * 管理面板 HTTP 服务（默认 127.0.0.1:5210；由 runtime 经 webui 插件 hooks.start 按 webui.enabled 条件装配）。
 *
 * @param {Object} [cfg={}] - config.webui 配置子集
 * @param {number} [cfg.port=5210] - 监听端口
 * @param {string} [cfg.host='127.0.0.1'] - 监听地址（仅本机访问，勿外网暴露）
 * @param {string} [cfg.token=''] - 访问 token；为空则免鉴权
 */
export class WebUI {
  constructor(cfg = {}) {
    this.port = cfg.port ?? 5210;
    this.host = cfg.host ?? '127.0.0.1';
    this.token = cfg.token ?? '';
    this.server = null;
    this.ctx = null;
  }

  /**
   * 注入上下文并启动 HTTP 服务（立即 listen；端口占用等启动失败由 node:http 抛错冒泡给调用方）。
   *
   * @param {Object} ctx - 注入契约 4 成员（见文件头）
   * @param {Function} ctx.getStatus - () => Object，状态快照（/api/status）
   * @param {Function} ctx.getLingo - () => LingoStore，词典实例（/api/lingo 读写）
   * @param {Function} ctx.getConfig - () => Object，原始配置对象（脱敏在出口 _maskedConfig 做）
   * @param {Function} ctx.refreshData - () => Promise<string>，数据刷新编排（runtime.refreshData，桥接 refresh 插件 api.refresh）
   * 副作用：监听端口；处理器抛错内联兜成 500 JSON 响应
   */
  start(ctx) {
    this.ctx = ctx;
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => {
      try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); } catch { /* 忽略 */ }
    }));
    this.server.listen(this.port, this.host, () => {
      log(`[webui] 管理面板已启动: http://${this.host}:${this.port}${this.token ? ' （需 token）' : ''}`);
    });
  }

  /**
   * 停服：关闭 HTTP server（未 listen/已停时无操作；关闭是异步的，不再接受新连接）。
   * @returns {void}
   */
  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /** 鉴权判定：Header `Authorization: Bearer` 或 URL query token 任一等于配置 token 即放行；未配置 token 恒放行 */
  _authorized(req) {
    if (!this.token) return true;
    const url = new URL(req.url, 'http://localhost');
    const h = req.headers['authorization'] || '';
    const q = url.searchParams.get('token') || '';
    return h === `Bearer ${this.token}` || q === this.token;
  }

  // 读请求体 JSON（>1MB 直接销毁连接防内存放大）；解析失败按空对象 {}
  async _body(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    });
  }

  // 200 JSON 快捷响应
  _json(res, obj) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  /** /api/config 出口脱敏：深拷贝后抹掉 llm.apiKey（留首 6 尾 4 加省略号）与 napcat.accessToken（全掩为 ***） */
  _maskedConfig() {
    const cfg = this.ctx.getConfig();
    const masked = JSON.parse(JSON.stringify(cfg));
    if (masked.llm?.apiKey) masked.llm.apiKey = masked.llm.apiKey.slice(0, 6) + '…' + masked.llm.apiKey.slice(-4);
    if (masked.napcat?.accessToken) masked.napcat.accessToken = '***';
    return masked;
  }

  async _handle(req, res) {
    if (!this._authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method || 'GET';

    // 页面路由：返回内联 HTML
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this._html());
      return;
    }

    // 状态快照（getStatus 内会先 arkdb.load() 保证计数新鲜）
    if (p === '/api/status') {
      return this._json(res, this.ctx.getStatus());
    }

    // 词典：GET 列全部词条；POST {term,meaning} 学词 或 {action:'delete',term} 删词（与「学习/忘记」指令同走 lingo）
    if (p === '/api/lingo') {
      if (m === 'GET') {
        const entries = [...this.ctx.getLingo().entries.entries()].map(([term, meaning]) => ({ term, meaning }));
        return this._json(res, { entries });
      }
      if (m === 'POST') {
        const body = await this._body(req);
        if (body.action === 'delete') {
          const ok = this.ctx.getLingo().delete(String(body.term || ''));
          return this._json(res, { ok, term: body.term });
        }
        if (body.term && body.meaning) {
          this.ctx.getLingo().learn(String(body.term), String(body.meaning));
          return this._json(res, { ok: true, term: body.term });
        }
        return this._json(res, { ok: false, error: '缺少 term 或 meaning' });
      }
    }

    // 手动刷新（触发源：WebUI；与启动定时器/群指令 S11 共用 §6.3 refresh runner，此处不传群号）
    if (p === '/api/refresh' && m === 'POST') {
      const result = await this.ctx.refreshData();
      return this._json(res, { ok: true, result });
    }

    // 脱敏配置（密钥在 _maskedConfig 出口处打码）
    if (p === '/api/config') {
      return this._json(res, this._maskedConfig());
    }

    // 未命中路由 → 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  /** 管理面板页面：内联 HTML+CSS+JS 模板字符串（修改文案/脚本属模板改动，勿动；无外部资源依赖） */
  _html() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PRTS Bot 管理面板</title>
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #222; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .card { background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h2 { font-size: 15px; margin: 0 0 10px; border-left: 3px solid #4a6cf7; padding-left: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; }
  .stat { flex: 1; min-width: 110px; background: #f0f3ff; border-radius: 8px; padding: 10px; text-align: center; }
  .stat b { display: block; font-size: 20px; color: #4a6cf7; }
  .stat span { font-size: 12px; color: #666; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; }
  .term { font-weight: 600; }
  input, button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #ccc; }
  button { background: #4a6cf7; color: #fff; border: none; cursor: pointer; }
  button.danger { background: #e5484d; }
  button:hover { opacity: .9; }
  .muted { color: #888; font-size: 12px; }
  pre { background: #f7f8fa; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #222; color: #fff; padding: 10px 16px; border-radius: 8px; opacity: 0; transition: opacity .3s; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>PRTS Bot 管理面板</h1>

  <div class="card">
    <h2>运行状态</h2>
    <div class="row" id="status"></div>
  </div>

  <div class="card">
    <h2>数据更新</h2>
    <button onclick="doRefresh()">立即刷新本地数据</button>
    <span class="muted" id="refreshNote"></span>
  </div>

  <div class="card">
    <h2>本地词典管理 <span class="muted" id="lingoCount"></span></h2>
    <div class="row" style="margin-bottom:10px;">
      <input id="newTerm" placeholder="词条（如：轮椅轴）" style="flex:1;">
      <input id="newMeaning" placeholder="释义" style="flex:2;">
      <button onclick="addLingo()">添加</button>
    </div>
    <table><thead><tr><th>词条</th><th>释义</th><th style="width:60px;"></th></tr></thead><tbody id="lingoTbody"></tbody></table>
  </div>

  <div class="card">
    <h2>当前配置（密钥已脱敏）</h2>
    <pre id="configView">加载中…</pre>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function loadStatus() {
  const s = await api('/api/status');
  $('status').innerHTML = [
    stat('WS 连接', s.wsConnected ? '在线' : '离线'),
    stat('机器人 QQ', s.selfId || '-'),
    stat('干员数', s.operators),
    stat('藏品数', s.relics),
    stat('卡池数', s.pools),
    stat('消息数', s.messages),
    stat('词典数', s.lingoCount),
    stat('运行时长', s.uptime),
  ].join('');
}
function stat(label, val) { return '<div class="stat"><b>' + val + '</b><span>' + label + '</span></div>'; }
async function loadLingo() {
  const d = await api('/api/lingo');
  $('lingoCount').textContent = '（共 ' + d.entries.length + ' 条）';
  $('lingoTbody').innerHTML = d.entries.map((e) =>
    '<tr><td class="term">' + esc(e.term) + '</td><td>' + esc(e.meaning) + '</td><td><button class="danger" onclick="delLingo(\\'' + esc(e.term).replace(/'/g, "\\\\'") + '\\')">删除</button></td></tr>'
  ).join('');
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function addLingo() {
  const term = $('newTerm').value.trim(), meaning = $('newMeaning').value.trim();
  if (!term || !meaning) return toast('请填写词条和释义');
  await api('/api/lingo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term, meaning }) });
  $('newTerm').value = ''; $('newMeaning').value = '';
  toast('已添加：' + term);
  loadLingo();
}
async function delLingo(term) {
  await api('/api/lingo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', term }) });
  toast('已删除：' + term);
  loadLingo();
}
async function doRefresh() {
  $('refreshNote').textContent = '更新中…';
  try {
    const r = await api('/api/refresh', { method: 'POST' });
    toast('刷新完成');
    $('refreshNote').textContent = r.result;
    loadStatus();
  } catch (e) {
    $('refreshNote').textContent = '失败：' + e.message;
  }
}
async function loadConfig() {
  const c = await api('/api/config');
  $('configView').textContent = JSON.stringify(c, null, 2);
}
loadStatus(); loadLingo(); loadConfig();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
  }
}

/**
 * Web 管理面板插件描述符构造：{name:'webui', priority: 0, handleMessage, hooks:{start,stop}}。
 * 仅 hooks 插件（无消息面）：hooks.start 按 cfg.enabled !== false 起面板（原 runtime.start 末段）；
 * hooks.stop 关停（原实现无停服路径、依赖 process.exit——插件化后补上，属无害增强）。
 * @param {Object} deps - runtime 装配期注入
 * @param {Object} deps.cfg - config.webui 子集（{port?, host?, token?, enabled?}；enabled 缺省视为开）
 * @param {Object} deps.startCtx - start(ctx) 注入契约 4 成员（见 class WebUI JSDoc）——
 *   getStatus/getLingo/getConfig/refreshData 均为 runtime 闭包
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createWebUiPlugin(deps) {
  const { cfg, startCtx } = deps;
  let webui = null;
  return {
    name: 'webui',
    // 仅 hooks 插件：0 不占分发带（handleMessage 恒 null，永不认领消息）；start 次序无关
    priority: 0,
    handleMessage() {
      return null;
    },
    hooks: {
      /** 按配置起面板（webui.enabled !== false 时 listen；端口占用等错误冒泡由 registry 记日志） */
      start() {
        if (cfg.enabled !== false) {
          webui = new WebUI(cfg);
          webui.start(startCtx);
        }
      },
      /** 停服：关闭 HTTP server（未起/已停时无操作） */
      stop() {
        if (webui) {
          webui.stop();
          webui = null;
        }
      },
    },
  };
}
