/**
 * P5b 冒烟：core/routing.js 直测——S1 connect/disconnect/backfill/getAllGroupIds 空档补锁。
 *
 * 背景：connect/backfill/群枚举原是 runtime.js createApp 闭包（依赖函数声明提升），P5b
 * 拆出后工厂化；此前**无任何测试覆盖**这些路径——拆块恰好是补行为锁的时机（disconnect
 * 复位分支系 2026-09 坑 2 修复新增，一并在此锁定）。S2–S13 其余判定（@检测/静默门/剥
 * @/分发带）已由 runtime-dispatch 全链测试锁定，此处不重复。
 *
 * 锁定目标：① S1 connect 置位 state（ready/wsConnected/selfId 回填）并仅执行一次
 * backfill（backfillDone 置位后二次 connect 不再拉）；② backfill 语义：time<sinceTs 过滤、
 * 批内重复 message_id 去重、addHistoryMessage 真值才 analytics.record、有新增才
 * setLastSeenTs（取批内最新 time）；③ get_login_info 失败：记日志继续 backfill（原 S1
 * catch 语义，selfId 保持 0）；④ getAllGroupIds：get_group_list 成功取 group_id 列表，
 * 调用失败回退 store.trackedGroupIds；⑤ S1 disconnect：仅复位 wsConnected（ready/
 * backfillDone 不动；重连后 connect 置回且不重复 backfill）。
 *
 * 直接构造 createRouting（不经 createApp），fake 全内存；连接工厂参数以 over 覆盖默认。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRouting } from '../../src/core/routing.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

/** 等 S1 内异步 IIFE（selfId 回填 + backfillHistory）落定 */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** 造一套全 fake 的 createRouting（over 可覆盖默认行为） */
function mkRouting(over = {}) {
  const state = { selfId: 0, ready: false, backfillDone: false, wsConnected: false };
  const calls = { getHistory: 0, added: [], recorded: [], lastSeenSet: null };
  const client = {
    call: async () => {
      if (over.groupListError) throw new Error('get_group_list 失败');
      return over.groupList ?? [];
    },
    getLoginInfo: async () => {
      if (over.loginError) throw new Error('get_login_info 失败');
      return { user_id: over.selfIdResult ?? 424242 };
    },
    getGroupMsgHistory: async () => { calls.getHistory++; return { messages: over.messages ?? [] }; },
    sendGroupMsg: async () => {},
  };
  const store = {
    getLastSeenTs: () => over.lastSeenTs ?? 0,
    addHistoryMessage: (gid, m) => { calls.added.push([gid, m]); return { text: '历史消息', time: m.time }; }, // 恒真值 = 新增
    setLastSeenTs: (t) => { calls.lastSeenSet = t; },
    trackedGroupIds: () => [111, 222],
  };
  const analytics = { record: (gid, rec) => calls.recorded.push([gid, rec]) };
  const routing = createRouting({
    store, analytics, client,
    registry: { dispatch: () => null },
    lingo: {}, arkdb: {},
    state,
    includeSelf: false,
    tracksGroup: () => true,
    trackedGroups: () => over.tracked ?? [],
    quietEnabled: false, quietStart: 0, quietEnd: 8,
    backfillMaxHours: over.backfillMaxHours ?? 72,
  });
  return { routing, state, client, calls };
}

/** S1 合成 connect meta 事件（napcat 在 WS open 后自行合成，见 napcat.js） */
const connectEvent = () => ({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });

describe('routing：S1 connect → selfId 回填 + backfill 单次执行', () => {
  it('connect 置位 ready/wsConnected、selfId 回填；backfill 过滤/去重/计数/记 lastSeen；二次 connect 不再拉', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { routing, state, calls } = mkRouting({
      tracked: [7],
      messages: [
        { message_id: 'a', time: now },
        { message_id: 'b', time: now },
        { message_id: 'a', time: now },          // 批内重复 id：seen 跳过
        { message_id: 'old', time: now - 300000 }, // 早于 sinceTs(now−72h)：time 过滤
      ],
    });

    routing.onEvent(connectEvent());
    assert.equal(state.ready, true);      // 同步置位（不待 backfill 异步落定）
    assert.equal(state.wsConnected, true);
    assert.equal(state.backfillDone, false); // backfill 内部异步首行才置位
    await flush();

    assert.equal(state.selfId, 424242);   // get_login_info 回填
    assert.equal(state.backfillDone, true);
    assert.equal(calls.getHistory, 1);    // 只拉群 7 一次
    assert.equal(calls.added.length, 2);  // a、b 两条新增（重复 a 与超窗 old 均不计）
    assert.equal(calls.recorded.length, 2);
    assert.equal(calls.lastSeenSet, now); // 有新增 → setLastSeenTs(批内最新 time)

    // 二次 connect：backfillDone 置位后不再拉取
    routing.onEvent(connectEvent());
    await flush();
    assert.equal(calls.getHistory, 1);
  });

  it('非 connect 的 meta 事件直接 return：不置位、不拉取', async () => {
    const { routing, state, calls } = mkRouting();
    routing.onEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' });
    await flush();
    assert.equal(state.ready, false);
    assert.equal(calls.getHistory, 0);
  });

  it('get_login_info 失败：记日志后继续 backfill（selfId 保持 0，S1 catch 语义）', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { routing, state, calls } = mkRouting({
      loginError: true,
      tracked: [7],
      messages: [{ message_id: 'a', time: now }],
    });
    const origErr = console.error; // logger.err → console.error，本例预期触发，临时静默
    console.error = () => {};
    try {
      routing.onEvent(connectEvent());
      await flush();
    } finally {
      console.error = origErr;
    }
    assert.equal(state.selfId, 0);
    assert.equal(state.ready, true);
    assert.equal(calls.added.length, 1); // backfill 不受 selfId 回填失败影响
  });
});

describe('routing：getAllGroupIds 与 backfill 群集合选择', () => {
  it('getAllGroupIds：get_group_list 成功 → 取 group_id 列表', async () => {
    const { routing } = mkRouting({ groupList: [{ group_id: 12, group_name: '甲' }, { group_id: 34, group_name: '乙' }] });
    assert.deepEqual(await routing.getAllGroupIds(), [12, 34]);
  });

  it('getAllGroupIds：调用失败 → 回退 store.trackedGroupIds', async () => {
    const { routing } = mkRouting({ groupListError: true });
    assert.deepEqual(await routing.getAllGroupIds(), [111, 222]);
  });

  it('backfill：trackedGroups 为空数组时经 getAllGroupIds 决定群集合', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { routing, calls } = mkRouting({ messages: [{ message_id: 'a', time: now }] });
    routing.onEvent(connectEvent());
    await flush();
    assert.equal(calls.getHistory, 2); // 111、222 两群（get_group_list 返回空 → 回退磁盘群）
    assert.equal(calls.added.length, 2);
  });
});

describe('routing：S1 disconnect → wsConnected 复位（2026-09 修复坑 2）', () => {
  it('disconnect 仅复位 wsConnected；ready/backfillDone 不动；重连置回且不重复 backfill', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { routing, state, calls } = mkRouting({
      tracked: [7],
      messages: [{ message_id: 'a', time: now }],
    });
    routing.onEvent(connectEvent());
    await flush();
    assert.equal(state.ready, true);
    assert.equal(state.wsConnected, true);
    assert.equal(state.backfillDone, true);

    // WS 断开（napcat close 回调合成 lifecycle/disconnect 事件，见 napcat.js）：同步复位在线标志
    routing.onEvent({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disconnect' });
    assert.equal(state.wsConnected, false);
    assert.equal(state.ready, true);      // 断线期间无入站消息：就绪锚点不回落
    assert.equal(state.backfillDone, true);

    // 重连后 connect 事件置回在线；backfillDone 保持「仅一次」→ 不重复补偿拉取
    routing.onEvent(connectEvent());
    await flush();
    assert.equal(state.wsConnected, true);
    assert.equal(state.ready, true);
    assert.equal(calls.getHistory, 1);
  });
});
