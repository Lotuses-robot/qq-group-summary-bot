/**
 * P3c 冒烟：createApp 全链集成——五插件（summary/refresh/chat/webui）在真实装配下与
 * S1–S13 路由链的接线面。所有服务经 overrides 注入 fake（全内存、零磁盘/网络），
 * fake client.onEvent 捕获路由回调 → 测试合成 OneBot 群消息事件走完整真实链
 * （S5 入库 → S6 @检测 → S7 静默门 → S9 剥 @ → S10 空@ → S12+S13 分发带）。
 *
 * 锁定面：① 分发带全量注册次序（summary…chat + report/webui 仅 hooks 垫底）；
 * ② chat 插件末端恒消费（指令落空文本最终到 brain.chat 且群发回复）；
 * ③ S10 空@ 固定回复不受插件化影响；④ 总结/刷新异步消费（true 不发送、无字符串）；
 * ⑤ start()/stop() 经 registry 生命周期（webui.enabled=false 不起面板、scheduler/refresh
 * hooks 不触发——真实定时行为已在 background-plugins.test.js 单测覆盖）；
 * ⑥ Scheduler 装配面（2026-09 修复坑 1）：report.hour/minute 传入构造、缺省回退 9:00、
 * 遗留 schedule.* 死键不再生效；
 * ⑦ 统计导入守卫（2026-09 修复坑 5）：importState==='running' 时活跃榜/群统计回
 * 「历史消息导入中，请稍后再试」；'done'（默认 fake）不误触发、正常走聚合。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../../src/core/runtime.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// 合成一条 @机器人 的群消息事件（at 段 qq=selfId + 文本段）
function atEvent(text, groupId = 9, userId = 555) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    sender: { card: '博士', nickname: '博士' },
    message: [
      { type: 'at', data: { qq: 10001 } },
      // 真实输入「@机器人 文本」的空格在 text 段内（OneBot 段式消息）
      ...(text ? [{ type: 'text', data: { text: ` ${text}` } }] : []),
    ],
  };
}

/** 全 fake 装配：store 语义最小化（addMessage 产出 rec.text = at@qq + 文本段拼接）；
 *  cfgOverrides/svcOverrides 增量覆盖基座（如传 { scheduler: null } 走真实 Scheduler——
 *  其构造零副作用，start() 才起定时器） */
function mkApp(cfgOverrides = {}, svcOverrides = {}) {
  const sent = [];
  const calls = { summarize: 0, learn: [], brainChat: null, schedulerStop: 0, close: 0 };
  let route;
  const client = {
    onEvent: (cb) => { route = cb; },
    connect: () => {},
    close: () => { calls.close++; },
    sendGroupMsg: async (gid, msg) => sent.push({ gid, msg }),
    getGroupInfo: async () => ({ group_name: '测试群' }),
    sendPrivateMsg: async () => {},
  };
  const store = {
    addMessage: (ev) => {
      const text = (ev.message || [])
        .map((s) => (s.type === 'at' ? `@${s.data?.qq}` : s.type === 'text' ? s.data?.text || '' : ''))
        .join('').trim();
      if (!text) return null;
      return { text, time: Math.floor(Date.now() / 1000) };
    },
    collectSince: () => [],
    getLastSummaryAt: () => 0,
    setLastSummaryAt: () => {},
    loadFromDisk: () => {},
    collectRange: () => [],
    trackedGroupIds: () => [],
    getLastSeenTs: () => 0,
    setLastSeenTs: () => {},
  };
  const scheduler = { start: () => {}, stop: () => { calls.schedulerStop++; } };
  const refresher = { refresh: async () => ({ updated: [], unchanged: [], failed: [] }) };
  const lingo = {
    learn: (t, m) => calls.learn.push([t, m]),
    delete: () => true,
    lookup: () => null,
    entries: new Map(),
  };
  const brain = { chat: async (gid, name, q, uid) => { calls.brainChat = { gid, name, q, uid }; return '回复内容'; } };

  const app = createApp({
    napcat: { wsUrl: 'ws://127.0.0.1:3001', selfId: 10001, accessToken: '' },
    llm: {},
    groups: [],
    minMessages: 1,
    includeSelf: false,
    quiet: { enabled: false },
    dataRefresh: { enabled: false },
    report: { userId: 0 },
    webui: { enabled: false }, // 面板不起（避免真实 listen 端口）
    ...cfgOverrides,
  }, {
    store, client, summarizer: { summarize: async () => { calls.summarize++; return 'S'; } },
    scheduler, analytics: {
      record: () => {}, countMessages: () => 0,
      importHistory: async () => {}, // 坑 5：start() 会调；importState 'done' 表示导入已完成
      importState: 'done',
      topActive: () => '【最近 7 天活跃榜】', groupStats: () => '【群消息统计】',
    },
    refresher, lingo, arkdb: { snapshotHighOps: () => [], snapshotGachaPools: () => [], reload: () => {} },
    cache: { get: () => null, set: () => {}, hit: () => {}, deleteByPrefix: () => 0 },
    wiki: {}, moegirl: {}, wikipedia: {},
    brain,
    ...svcOverrides,
  });
  return { app, send: (ev) => route(ev), sent, calls };
}

describe('createApp 全链（P3 五插件装配面）', () => {
  it('分发带全量注册且次序 = summary→refresh→lingo→ark→gacha→stats→chat→(hooks)report/webui', () => {
    const { app } = mkApp();
    const names = app.services.registry.sorted().map((p) => p.name);
    assert.deepEqual(names, ['summary', 'refresh', 'lingo', 'ark', 'gacha', 'stats', 'chat', 'report', 'webui']);
  });

  it('chat 兜底：指令全落空文本最终到 brain.chat（原 S13），回复经 client 群发', async () => {
    const { send, sent, calls } = mkApp();
    send(atEvent('波登可是谁'));
    await tick();
    assert.deepEqual(calls.brainChat, { gid: 9, name: '博士', q: '波登可是谁', uid: 555 });
    assert.deepEqual(sent, [{ gid: 9, msg: '回复内容' }]);
  });

  it('总结关键词：dispatch 返回 true 不发送（异步消费、无字符串文案）', async () => {
    const { send, sent, calls } = mkApp();
    send(atEvent('总结一下今天'));
    await tick();
    assert.equal(calls.brainChat, null); // 被 summary 消费，不落 chat
    assert.equal(calls.summarize, 0);    // 无消息时段守卫跳过
    assert.equal(sent.length, 0);
  });

  it('刷新指令：ack + 结果回执经插件自驱发送（不落 chat）', async () => {
    const { send, sent, calls } = mkApp();
    send(atEvent('刷新数据'));
    await tick(40);
    assert.equal(calls.brainChat, null);
    assert.deepEqual(sent.map((s) => s.msg), ['正在更新本地数据库，稍候…', '【数据更新】\n成功：无\n未变化：无\n全部成功']);
  });

  it('确定性指令（学习）返回 string：路由层发送、指令日志路径不变', async () => {
    const { send, sent, calls } = mkApp();
    send(atEvent('学习 轮椅轴=挂机套路'));
    await tick();
    assert.deepEqual(calls.learn, [['轮椅轴', '挂机套路']]);
    assert.equal(calls.brainChat, null);
    assert.deepEqual(sent, [{ gid: 9, msg: '已学习词条：轮椅轴 → 挂机套路' }]);
  });

  it('S10 纯 @（空问题）：固定提示回复不受插件化影响', async () => {
    const { send, sent } = mkApp();
    send(atEvent(''));
    assert.deepEqual(sent, [{ gid: 9, msg: '@博士 艾特PRTS干什么呀喵' }]);
  });

  it('紧贴 @ 无空格的整串不触发任何插件：落 S10 空@ 提示（2026-09 决策，见 architecture §8 坑 11）', async () => {
    // 输入形态：at 段（缺 name → rec.text 为 @10001）紧贴文本「总结」无空格——整串被
    // extractQuestion 前导正则吞掉 → 问题为空 → S10 固定回复；不回显旧 S8「全文判关键词」
    // 的触发（关键词/指令判定基准 = 剥 @ 后问题文本，属既定语义，勿按旧行为回退）
    const { send, sent, calls } = mkApp();
    send({
      post_type: 'message',
      message_type: 'group',
      group_id: 9,
      user_id: 555,
      sender: { card: '博士', nickname: '博士' },
      message: [
        { type: 'at', data: { qq: 10001 } },
        { type: 'text', data: { text: '总结' } }, // 无前导空格：紧贴 at 段
      ],
    });
    assert.deepEqual(sent, [{ gid: 9, msg: '@博士 艾特PRTS干什么呀喵' }]);
    assert.equal(calls.summarize, 0); // 不回显总结
    assert.equal(calls.brainChat, null);
  });

  it('start()/stop()：webui.enabled=false 不起面板，stop 走 registry 逆序并关 client', () => {
    const { app, calls } = mkApp();
    app.start(); // 不抛（webui 不 listen；refresh schedule disabled 不挂定时器；scheduler fake；analytics fake importHistory 即返）
    app.stop();
    assert.equal(calls.close, 1);
    assert.equal(calls.schedulerStop, 1); // report hooks.stop → scheduler.stop
  });

  it('统计导入守卫（2026-09 修复坑 5）：running 时活跃榜/群统计回「稍后再试」，done 不误触发', async () => {
    const running = mkApp({}, {
      analytics: {
        record: () => {}, countMessages: () => 0,
        importHistory: async () => {}, importState: 'running',
        topActive: () => '不应到达', groupStats: () => '不应到达',
      },
    });
    running.send(atEvent('活跃榜'));
    assert.deepEqual(running.sent.map((s) => s.msg), ['历史消息导入中，请稍后再试']);
    running.send(atEvent('群统计'));
    assert.deepEqual(running.sent.map((s) => s.msg), ['历史消息导入中，请稍后再试', '历史消息导入中，请稍后再试']);
    assert.equal(running.calls.brainChat, null); // 被 stats 消费，不落 chat

    const done = mkApp(); // 默认 fake importState:'done'：守卫放行、正常走聚合查询
    done.send(atEvent('活跃榜'));
    done.send(atEvent('群统计'));
    assert.deepEqual(done.sent.map((s) => s.msg), ['【最近 7 天活跃榜】', '【群消息统计】']);
  });
});

describe('Scheduler 装配（2026-09 修复坑 1：report.* 生效、schedule.* 废弃）', () => {
  it('report.hour/minute 传入 Scheduler 构造（{dailyHour, dailyMinute}）', () => {
    const { app } = mkApp(
      { report: { userId: 1, minMessages: 100, hour: 10, minute: 45 }, schedule: { hour: 3, minute: 30 } },
      { scheduler: null }, // 真实 Scheduler：构造零副作用，start() 才起定时器
    );
    assert.equal(app.services.scheduler.dailyHour, 10);
    assert.equal(app.services.scheduler.dailyMinute, 45);
  });

  it('report 未配触发时刻回退 9:00——遗留 schedule.* 键不再生效（死键废弃）', () => {
    const { app } = mkApp({ schedule: { hour: 3, minute: 30 } }, { scheduler: null });
    assert.equal(app.services.scheduler.dailyHour, 9);
    assert.equal(app.services.scheduler.dailyMinute, 0);
  });
});
