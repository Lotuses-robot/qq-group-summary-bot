/**
 * P0 行为基线：MessageStore 与纯文本工具（src/store.js）。
 *
 * 锁定目标：JSONL 按群按天追加写、写入幂等闸、loadFromDisk 坏行去重重写、
 * lastSeen 全局单值只增不减、lastSummaryAt 持久化、collectSince/collectRange
 * 的窗口与排序语义——重构时这些文件级行为一字不许变。
 *
 * 时间基准说明：测试固定用 2026-01-05 当地时间（new Date(y, m, d) 构造，
 * 与 store 内 localDate/hhmm 同为本地时区口径，跑在哪个时区都确定）。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MessageStore, segmentToText, extractText, localDate, hhmm, fmtFull,
} from '../../src/store.js';
import { cleanupTmpDirs, makeTmp, seedMessages, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

// 本地时区 2026-01-05 午时的秒级时间戳（测试消息统一落这天）
const DAY_TS = new Date(2026, 0, 5, 12).getTime() / 1000;
const DAY_STR = localDate(DAY_TS * 1000);
const GID = 'g1';
const nextDayStart = () => new Date(2026, 0, 6).getTime() / 1000;

/** 组装一条 OneBot 群消息事件的最小形态 */
function makeEvent(over = {}) {
  return {
    group_id: GID,
    message_id: 1001,
    time: DAY_TS,
    user_id: 'u1',
    message: [{ type: 'text', data: { text: '测试消息' } }],
    sender: { card: '测试卡片', nickname: '测试昵称' },
    ...over,
  };
}

describe('纯文本工具', () => {
  it('segmentToText：各段类型 → 占位符或原文', () => {
    assert.equal(segmentToText(null), '');
    assert.equal(segmentToText(''), '');
    assert.equal(segmentToText({}), '[undefined]'); // 未知类型且无 data.text → [<type>] 占位（type 缺省即 [undefined]，现状行为）
    assert.equal(segmentToText({ type: 'text', data: { text: '你好' } }), '你好');
    assert.equal(segmentToText({ type: 'face', data: {} }), '[表情]');
    assert.equal(segmentToText({ type: 'image', data: {} }), '[图片]');
    assert.equal(segmentToText({ type: 'at', data: { qq: '12345' } }), '@12345');
    assert.equal(segmentToText({ type: 'at', data: { qq: 'all' } }), '@全体成员');
    assert.equal(segmentToText({ type: 'at', data: { qq: '12345', name: '昵称' } }), '@昵称');
    assert.equal(segmentToText({ type: 'puke', data: { text: '啥' } }), '啥');
    assert.equal(segmentToText({ type: 'weird', data: {} }), '[weird]');
  });

  it('extractText：字符串直通 / 段数组逐段拼接后整体 trim / 其他形态空串', () => {
    assert.equal(extractText('  直接文本  '), '  直接文本  ');
    assert.equal(extractText([{ type: 'text', data: { text: ' 你好，' } }, { type: 'at', data: { qq: '1' } }, { type: 'image' }]), '你好，@1[图片]'); // join('') 不加分隔符，末段整体 trim
    assert.equal(extractText(''), '');
    assert.equal(extractText(123), '');
  });

  it('localDate/hhmm/fmtFull：单位与格式契约（localDate 收毫秒、hhmm 收秒）', () => {
    assert.equal(localDate(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
    assert.equal(hhmm(new Date(2026, 0, 5, 8, 30).getTime() / 1000), '08:30');
    assert.equal(fmtFull(new Date(2026, 0, 5, 8, 30)), '2026-01-05 08:30');
  });
});

describe('MessageStore 实时落盘（addMessage）', () => {
  it('落一条消息：返回记录、写对文件、学名片、推 lastSeenTs', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    const rec = store.addMessage(makeEvent());

    assert.equal(rec.text, '测试消息');
    assert.equal(rec.name, '测试卡片'); // card 优先
    assert.equal(rec.card, '测试卡片');
    assert.equal(rec.userId, 'u1');
    assert.equal(rec.time, DAY_TS);

    const file = path.join(dir, 'messages', GID, `${DAY_STR}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), rec);
    assert.equal(store.getLastSeenTs(), DAY_TS); // addMessage 每次推进水位
    assert.deepEqual(store.trackedGroupIds(), [GID]);

    // 群成员名片缓存
    const g = store.loadFromDisk(GID, DAY_TS, nextDayStart());
    assert.deepEqual(g.users.get('u1'), { name: '测试卡片', card: '测试卡片' });
  });

  it('同 (群,消息id) 二次写入返回 null 且文件不增长（单实例去重）', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    assert.ok(store.addMessage(makeEvent()));
    assert.equal(store.addMessage(makeEvent()), null);
    const file = path.join(dir, 'messages', GID, `${DAY_STR}.jsonl`);
    assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 1);
  });

  it('重启后由 loadFromDisk 重建去重闸：换新实例同 id 仍拒绝', (t) => {
    const dir = makeTmp();
    const store1 = new MessageStore(dir);
    store1.addMessage(makeEvent());

    const store2 = new MessageStore(dir);
    store2.loadFromDisk(GID, DAY_TS, nextDayStart());
    assert.equal(store2.addMessage(makeEvent()), null); // 盘上已有，不重复写
    const file = path.join(dir, 'messages', GID, `${DAY_STR}.jsonl`);
    assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 1);
  });

  it('纯图片消息以 [图片] 占位符入库；空段数组且无 raw_message 才返回 null', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    const img = store.addMessage(makeEvent({ message: [{ type: 'image' }] }));
    assert.equal(img.text, '[图片]'); // 占位符是有效文本：extractText 非空即入库（现状行为，勿当"无文本"过滤）

    assert.equal(store.addMessage(makeEvent({ message: [] })), null); // 空段数组 + 无 raw_message → null
    const rec = store.addMessage(makeEvent({
      message_id: 1002, // 换个 id：同 (群,id) 已写盘会被去重闸挡下（上一条 [图片] 用了 1001）
      message: [],
      raw_message: '补发文本',
    }));
    assert.equal(rec.text, '补发文本');
  });

  it('at 段归一成 "@昵称" 文本后才落盘', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    const rec = store.addMessage(makeEvent({
      message: [
        { type: 'text', data: { text: '你好，' } },
        { type: 'at', data: { qq: '123', name: '能天使' } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    }));
    assert.equal(rec.text, '你好，@能天使 在吗');
  });

  it('按事件 time 落对日期的文件（跨天消息不混文件）', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    const ts2 = new Date(2026, 0, 6, 1).getTime() / 1000; // 次日凌晨
    store.addMessage(makeEvent({ message_id: 1 }));
    store.addMessage(makeEvent({ message_id: 2, time: ts2 }));

    const f1 = path.join(dir, 'messages', GID, `${DAY_STR}.jsonl`);
    const day2 = localDate(ts2 * 1000);
    const f2 = path.join(dir, 'messages', GID, `${day2}.jsonl`);
    assert.equal(fs.readFileSync(f1, 'utf8').trimEnd().split('\n').length, 1);
    assert.equal(fs.readFileSync(f2, 'utf8').trimEnd().split('\n').length, 1);
  });

  it('lastSeenTs 全局单值、只增不减且落盘', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    store.setLastSeenTs(500);
    store.setLastSeenTs(400); // 回退被 max 钳住
    assert.equal(store.getLastSeenTs(), 500);

    const store2 = new MessageStore(dir);
    assert.equal(store2.getLastSeenTs(), 500); // 从 state/lastSeen.json 恢复
  });

  it('lastSeen/lastSummaryAt 状态文件损坏一律按 0 降级', (t) => {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'lastSeen.json'), '{broken');
    fs.writeFileSync(path.join(dir, 'state', `${GID}.json`), '{{');

    const store = new MessageStore(dir);
    assert.equal(store.getLastSeenTs(), 0);
    store.loadFromDisk(GID);
    assert.equal(store.getLastSummaryAt(GID), 0);
  });
});

describe('MessageStore 历史落盘（addHistoryMessage，backfill 用）', () => {
  it('兼容 message_id/user_id 与 msgId/msgTime/sender.user_id 两种形状', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    const r1 = store.addHistoryMessage(GID, {
      message_id: 'h1', time: DAY_TS, user_id: 'u9',
      message: [{ type: 'text', data: { text: '历史一' } }],
      sender: { card: '老名片', nickname: '旧昵称' },
    });
    assert.equal(r1.name, '老名片');
    const r2 = store.addHistoryMessage(GID, {
      msgId: 'h2', msgTime: DAY_TS,
      message: '历史二',
      sender: { user_id: 'u9' },
    });
    assert.equal(r2.userId, 'u9');
    assert.equal(r2.text, '历史二');
  });

  it('不推进 lastSeenTs（历史补偿不动在线水位），缺 id/重复返回 null', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    assert.equal(store.getLastSeenTs(), 0);
    store.addHistoryMessage(GID, { message_id: 'h1', time: DAY_TS, message: 'a' });
    assert.equal(store.getLastSeenTs(), 0); // 与 addMessage 的关键差异

    assert.equal(store.addHistoryMessage(GID, { time: DAY_TS, message: '无id' }), null);
    store.addHistoryMessage(GID, { message_id: 'h2', time: DAY_TS, message: 'b' });
    assert.equal(store.addHistoryMessage(GID, { message_id: 'h2', time: DAY_TS, message: 'b' }), null);
  });

  it('历史与实时消息同去重闸（同 id 历史后到也拒绝）', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    store.addMessage(makeEvent({ message_id: 77 }));
    assert.equal(store.addHistoryMessage(GID, { message_id: '77', time: DAY_TS, message: '想顶掉' }), null);
  });
});

describe('MessageStore loadFromDisk', () => {
  it('按日期窗口翻文件载入；坏行跳过、重复行剔除并整文件重写', (t) => {
    const dir = makeTmp();
    const rec = (id, text) => ({ id, time: DAY_TS, userId: 'u1', name: '甲', card: '甲', text });
    seedMessages(dir, GID, DAY_STR, [rec('a', '第一条'), rec('b', '第二条'), rec('b', '重复'), '这是坏行\n{半截json']);

    const store = new MessageStore(dir);
    const g = store.loadFromDisk(GID, DAY_TS, nextDayStart());
    assert.equal(g.messages.size, 2); // 坏行与重复不计

    // 文件被重写为规范形态：2 行可解析、无重复
    const file = path.join(dir, 'messages', GID, `${DAY_STR}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(JSON.parse).map((r) => r.id).sort(), ['a', 'b']);
  });

  it('窗口外日期文件不载入（今天预载/日报按段翻文件的语义基础）', (t) => {
    const dir = makeTmp();
    const rec = (id, text) => ({ id, time: DAY_TS, userId: 'u1', name: '甲', card: '甲', text });
    seedMessages(dir, GID, DAY_STR, [rec('a', '在窗口内')]);
    const otherDay = localDate(new Date(2026, 0, 3).getTime());
    seedMessages(dir, GID, otherDay, [rec('b', '窗口外')]);

    const store = new MessageStore(dir);
    store.loadFromDisk(GID, DAY_TS, nextDayStart());
    assert.equal(store.collectSince(GID, 0).length, 1);
    assert.equal(store.collectRange(GID, 0, 2e9).map((r) => r.id).join(), 'a');
  });

  it('恢复该群 lastSummaryAt（state/<群号>.json）', (t) => {
    const dir = makeTmp();
    const store1 = new MessageStore(dir);
    store1.setLastSummaryAt(GID, 123456);
    const store2 = new MessageStore(dir);
    store2.loadFromDisk(GID);
    assert.equal(store2.getLastSummaryAt(GID), 123456);
  });

  it('群相互隔离：trackedGroupIds 登记两个群，消息互不可见', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    store.addMessage(makeEvent({ group_id: GID, message_id: 1 }));
    store.addMessage(makeEvent({ group_id: 'g2', message_id: 2 }));
    const g2 = store.loadFromDisk('g2', DAY_TS, nextDayStart());
    assert.equal(g2.messages.size, 1);
    assert.equal(g2.messages.has('1'), false);
    assert.deepEqual([...store.trackedGroupIds()].sort(), ['g2', GID].sort());
  });
});

describe('MessageStore 内存收集（collectSince / collectRange）', () => {
  it('collectSince 取 time > since 的消息，按 (time, id) 稳定升序', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    const ts = (h, id) => ({ message_id: id, time: new Date(2026, 0, 5, h).getTime() / 1000, message: `m${id}` });
    store.addMessage(makeEvent(ts(10, 3)));
    store.addMessage(makeEvent(ts(12, 1))); // 乱序加入
    store.addMessage(makeEvent(ts(11, 2)));

    const base = new Date(2026, 0, 5).getTime() / 1000;
    const got = store.collectSince(GID, base + 10.5 * 3600); // 10:30 之后
    assert.deepEqual(got.map((r) => r.id), ['2', '1']); // 11 点(2)、12 点(1)；10 点(3)被排除
    // 边界：since 恰好等于消息 time 的不含（严格大于）
    assert.equal(store.collectSince(GID, new Date(2026, 0, 5, 12).getTime() / 1000).length, 0);
  });

  it('collectRange 半开区间 [start, end)，起点含终点不含', (t) => {
    const dir = makeTmp();
    const store = new MessageStore(dir);
    const ts = (h) => new Date(2026, 0, 5, h).getTime() / 1000;
    store.addMessage(makeEvent({ message_id: 'e1', time: ts(9) }));
    store.addMessage(makeEvent({ message_id: 'e2', time: ts(10) }));
    store.addMessage(makeEvent({ message_id: 'e3', time: ts(11) }));
    assert.deepEqual(store.collectRange(GID, ts(10), ts(11)).map((r) => r.id), ['e2']);
    assert.deepEqual(store.collectRange(GID, ts(9), ts(12)).map((r) => r.id), ['e1', 'e2', 'e3']);
  });
});
