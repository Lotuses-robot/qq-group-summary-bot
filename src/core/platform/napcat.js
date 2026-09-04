/**
 * NapCat（OneBot 11 正向 WebSocket）客户端。
 *
 * 职责：连接 NapCat 的 WS 端口（有 token 时拼 ?access_token=）并断线自动重连；
 * 把服务端推送的 post_type 事件逐条派发给 onEvent 注册的回调；出站 action 走
 * call(action, params)——echo 关联响应，15s 无响应按超时 reject、WS 未 OPEN
 * 直接 reject。注意本客户端无应用层心跳：NapCat 定期下发的心跳 meta_event 到达后
 * 因不含 lifecycle 分支而被上层事件处理函数忽略（详见 docs/external-apis.md §1）。
 *
 * 对外导出：类 NapCatClient，仅由 core/runtime.js 的 createApp 装配一次。
 * 连接建立（含重连）后本客户端会自己合成一个 lifecycle/connect 事件（非 NapCat
 * 原生下发），作为 core/routing.js S1 恢复就绪状态的锚点；WS 断开时同样合成
 * lifecycle/disconnect 事件供 S1 复位 wsConnected（2026-09 修复，见 §8 坑 2）。
 */
import WebSocket from 'ws';
import { log } from './logger.js';

/**
 * OneBot 11 正向 WS 客户端：事件推送（onEvent 回调）与出站调用（call）的一体封装，
 * 断线自动重连；进程退出用 close() 显式关停。
 */
export class NapCatClient {
  /**
   * @param {string} url - NapCat WS 地址（config.napcat.wsUrl，如 ws://127.0.0.1:3001）
   * @param {Object} [opts={}] - 可选配置
   * @param {number} [opts.selfId=0] - 机器人自身 QQ（未回填前为 0，routing S1 connect 后 getLoginInfo 回填）
   * @param {string} [opts.accessToken=''] - 连接鉴权 token；非空时拼 ?access_token= 查询参数
   * @param {number} [opts.reconnectDelay=3000] - 断线自动重连间隔（ms）
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.selfId = opts.selfId ?? 0;
    this.accessToken = opts.accessToken ?? '';
    this.reconnectDelay = opts.reconnectDelay ?? 3000;
    // 当前 WS 连接（未连接或正在等待重连期间为 null）
    this.ws = null;
    // 出站调用序号：每次 call 自增一次，作为该次调用的 echo 关联键
    this.seq = 0;
    // 在途调用表：echo → {resolve, reject}；收到对应响应帧或 15s 超时后删除
    this.pending = new Map();
    // onEvent 注册的事件回调列表（可多个，事件按注册顺序逐个派发）
    this.handlers = [];
    // 主动关闭标志：close() 置 true 后，断线回调不再触发自动重连
    this.closed = false;
  }

  /**
   * 注册事件回调：每条服务端 post_type 事件（消息/通知/请求/meta 心跳）都会按注册
   * 顺序派发给全部回调；单个回调抛错或返回 rejected Promise 只 console.error，
   * 不影响其他回调。连接（含重连）与断开时本客户端合成的 lifecycle/connect、
   * lifecycle/disconnect 事件也走这里——core/routing.js S1 以 connect 恢复就绪、
   * 以 disconnect 复位 wsConnected（见 external-apis.md §1）。
   * @param {Function} fn - 处理器 (event: Object) => void | Promise<void>
   * @returns {void}
   */
  onEvent(fn) {
    this.handlers.push(fn);
  }

  /**
   * 建立（或重连）WS 连接并挂接 open/message/error/close 处理器。
   * open → 合成并派发 lifecycle/connect 事件；close 且未被 close() 关停 →
   * reconnectDelay 后递归重连（重复调用本方法即为一次重连）。
   * @returns {void}
   * 副作用: 打开 WS 连接；断线时安排自动重连定时器
   */
  connect() {
    if (this.closed) return; // close() 后残留的重连定时器不得再建连（closed 守卫，header 语义）
    const wsUrl = this.accessToken
      ? `${this.url}?access_token=${encodeURIComponent(this.accessToken)}`
      : this.url;
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      log(`[napcat] 已连接 ${wsUrl}`);
      this.emit({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });
    });
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('error', (e) => console.error('[napcat] ws error:', e.message));
    this.ws.on('close', () => {
      if (this.closed) return;
      // 合成 lifecycle/disconnect（与 connect 同例）：routing S1 收到后复位 wsConnected，
      // 状态页不再显示断线「在线」假象（2026-09 立项修复，见 architecture §8 坑 2）
      this.emit({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disconnect' });
      log(`[napcat] 连接断开，${this.reconnectDelay / 1000}s 后重连...`);
      setTimeout(() => this.connect(), this.reconnectDelay);
    });
  }

  // 分发一条 WS 帧：带 post_type 的是服务端事件 → emit；带 echo 的是某次 call 的
  // 响应 → 从 pending 取回 {resolve, reject} 按 status/retcode 结算；两者皆无的
  // 响应（无 echo，并发下无法可靠关联）只记日志忽略，防错配
  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.post_type) {
      this.emit(msg);
      return;
    }

    if (msg.echo !== undefined && this.pending.has(msg.echo)) {
      const { resolve, reject } = this.pending.get(msg.echo);
      this.pending.delete(msg.echo);
      if (msg.status === 'ok' && msg.retcode === 0) resolve(msg.data ?? {});
      else reject(new Error(`OneBot 返回错误: retcode=${msg.retcode} ${msg.message || ''}`));
      return;
    }

    // 无 echo 的响应：忽略（并发下无法可靠关联，避免错配）
    if (msg.retcode !== undefined || msg.status !== undefined) {
      log(`[napcat] 收到无 echo 的响应（已忽略）: ${msg.status || ''} ${msg.retcode ?? ''}`);
    }
  }

  /**
   * 把一条事件派发给全部注册回调（内部实现；onEvent 之上无任何过滤）。
   * @param {Object} event - 事件对象（带 post_type 字段）
   * @returns {void}
   */
  emit(event) {
    for (const h of this.handlers) {
      try {
        Promise.resolve(h(event)).catch((e) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * 调用一个 OneBot action：分配自增 echo 挂入 pending 后发送；带同 echo 的响应帧
   * 到达时结算——status === 'ok' 且 retcode === 0 → resolve(data)，否则 reject；
   * 15s 内无响应按超时 reject 并清出 pending。
   * @param {string} action - OneBot action 名，如 'send_group_msg'
   * @param {Object} [params={}] - action 参数
   * @returns {Promise<Object>} 响应 data 载荷；WS 未 OPEN / 超时 / OneBot 报错均 reject
   * 副作用: 向 NapCat 发送一帧 JSON；pending 表增删一项
   */
  call(action, params = {}) {
    const echo = String(++this.seq);
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`WS 未连接，无法调用 ${action}`));
        return;
      }
      this.pending.set(echo, { resolve, reject });
      this.ws.send(JSON.stringify({ action, params, echo }));
      setTimeout(() => {
        if (this.pending.has(echo)) {
          this.pending.delete(echo);
          reject(new Error(`调用 ${action} 超时`));
        }
      }, 15000);
    });
  }

  /**
   * 查机器人自身信息（routing S1 connect 时用来回填 selfId）。
   * @returns {Promise<Object>} 形如 {user_id, nickname}
   */
  async getLoginInfo() {
    return this.call('get_login_info');
  }

  /**
   * 发群消息（auto_escape: true——纯文本按原样转义发送，消息里的 CQ 码不会被解析；
   * 本 bot 不做真 @，见 external-apis.md §1 用法表）。
   * @param {string|number} groupId - 目标群号
   * @param {string} message - 纯文本内容
   * @returns {Promise<Object>} 发送结果（含 message_id）
   */
  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: groupId, message, auto_escape: true });
  }

  /**
   * 私聊发消息（每日日报推送用，plugins/report.js dailyReport）。
   * @param {string|number} userId - 目标 QQ 号
   * @param {string} message - 纯文本内容
   * @returns {Promise<Object>} 发送结果（含 message_id）
   */
  sendPrivateMsg(userId, message) {
    return this.call('send_private_msg', { user_id: userId, message, auto_escape: true });
  }

  /**
   * 查群资料（日报取群名作标题用，plugins/report.js dailyReport）。
   * @param {string|number} groupId - 群号
   * @returns {Promise<Object>} 形如 {group_id, group_name}
   */
  getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: groupId });
  }

  /**
   * 拉取群历史消息（backfill 补偿拉取用，core/routing.js backfillHistory）。
   * @param {string|number} groupId - 群号
   * @param {Object} [opts] - 查询选项
   * @param {number} [opts.messageSeq=0] - 起始 message_seq；0 = 从最新一条往前
   * @param {number} [opts.count=50] - 拉取条数上限（routing backfillHistory 实际传 1000）
   * @returns {Promise<Object>} 形如 {messages: [...]}（消息项结构见 data-format.md §1）
   */
  getGroupMsgHistory(groupId, { messageSeq = 0, count = 50 } = {}) {
    return this.call('get_group_msg_history', { group_id: groupId, message_seq: messageSeq, count });
  }

  /**
   * 主动关停：置 closed 标志后关闭 WS——此后断线回调不再自动重连（进程退出路径）。
   * @returns {void}
   * 副作用: 关闭当前 WS 连接
   */
  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}
