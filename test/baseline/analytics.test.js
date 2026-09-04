/**
 * P0 行为基线：Analytics SQLite 分析层（src/core/platform/analytics.js）。
 *
 * 锁定目标：_ensureImported 惰性整库导入（坏行跳过、重复行 INSERT OR IGNORE 去重）、
 * record 实时镜像、topActive 的窗口与「排除 未知/空名」口径、groupStats 口径、
 * recordPull/myPulls 星级判定（按 ★ 串 LIKE，6★ 不与 5★ 互串）、luckiest 排序、
 * 库文件损坏「构造即抛」（已知行为，重构时不得悄悄改成降级）。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Analytics } from '../../src/core/platform/analytics.js';
import { localDate } from '../../src/core/platform/store.js';
import { cleanupTmpDirs, makeTmp, seedMessages, silenceLog, trackDbClose } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

const SIX = '★★★★★★';
const FIVE = '★★★★★';
const FOUR = '★★★★';

/** 新 tmp 目录 + Analytics（messagesDir 为空：走 record 注入路径，不触发文件导入） */
function makeAnalytics() {
  const dir = makeTmp();
  const messagesDir = path.join(dir, 'messages');
  const analytics = new Analytics(path.join(dir, 'messages.db'), messagesDir);
  trackDbClose(analytics); // Windows：不 close 的 sqlite 句柄让目录清理 EPERM
  return { dir, analytics, messagesDir };
}

let msgSeq = 0;
/** 造一条秒级 now 附近的记录并 record 进库 */
function recNow(analytics, gid, { userId = 'u1', name = '张三', text = 'hi', agoSec = 0 } = {}) {
  msgSeq += 1;
  const rec = {
    id: String(msgSeq),
    time: Math.floor(Date.now() / 1000) - agoSec,
    userId,
    name,
    text,
  };
  analytics.record(gid, rec);
  return rec;
}

describe('惰性导入（_ensureImported）', () => {
  it('首次查询前扫描 messages/ 下全部 JSONL：坏行跳过、重复 id 只入一次', (t) => {
    const dir = makeTmp();
    const gid = '10001';
    const date = localDate(Date.now());
    const rec = (id, text) => ({ id, time: Math.floor(Date.now() / 1000), userId: 'u1', name: '甲', card: '甲', text });
    seedMessages(dir, gid, date, [rec('a', '一'), rec('b', '二'), rec('b', '重复'), '坏行{{']);

    const analytics = new Analytics(path.join(dir, 'messages.db'), path.join(dir, 'messages'));
    trackDbClose(analytics);
    // countMessages 不触发导入（文档语义：仅计数），由首次 record 触发
    analytics.record(gid, { id: 'c', time: Math.floor(Date.now() / 1000), userId: 'u2', name: '乙', text: '新' });
    assert.equal(analytics.countMessages(), 3); // a/b 导入 + c 直录；坏行与重复 b 不占行
  });

  it('导入幂等：同 (群,id) 再 record 不产生第二行', (t) => {
    const dir = makeTmp();
    const gid = '10001';
    const date = localDate(Date.now());
    seedMessages(dir, gid, date, [{ id: 'dup', time: Math.floor(Date.now() / 1000), userId: 'u1', name: '甲', text: 'x' }]);
    const analytics = new Analytics(path.join(dir, 'messages.db'), path.join(dir, 'messages'));
    trackDbClose(analytics);
    analytics.record(gid, { id: 'dup', time: Math.floor(Date.now() / 1000), userId: 'u1', name: '甲', text: 'x' });
    assert.equal(analytics.countMessages(), 1);
  });
});

describe('活跃榜与群统计', () => {
  it('topActive：按人聚合计数、排除「未知」与空名、窗口外不统计', (t) => {
    const { analytics } = makeAnalytics(t);
    const gid = '10001';
    for (let i = 0; i < 3; i++) recNow(analytics, gid, { userId: 'uA', name: '张三' });
    for (let i = 0; i < 5; i++) recNow(analytics, gid, { userId: 'uX', name: '未知' }); // 不算
    recNow(analytics, gid, { userId: 'uB', name: '李四' });
    recNow(analytics, gid, { userId: 'uA', name: '张三', agoSec: 10 * 86400 }); // 10 天前，窗口外

    const text = analytics.topActive(7);
    assert.ok(text.startsWith('【最近 7 天活跃榜】'));
    assert.ok(text.includes('1. 张三（3 条）'));
    assert.ok(text.includes('2. 李四（1 条）'));
    assert.ok(!text.includes('未知'));
    assert.equal(analytics.topActive(30).includes('1. 张三（4 条）'), true); // 30 天窗口含 10 天前那条
  });

  it('topActive：窗口内无消息时返回「最近 N 天没有消息记录」', (t) => {
    const { analytics } = makeAnalytics(t);
    assert.equal(analytics.topActive(7), '最近 7 天没有消息记录');
  });

  it('groupStats：按群计数降序 + 最近活跃天数', (t) => {
    const { analytics } = makeAnalytics(t);
    for (let i = 0; i < 3; i++) recNow(analytics, '10001', { name: '张三' });
    recNow(analytics, '20002', { name: '李四' });

    const text = analytics.groupStats();
    assert.ok(text.startsWith('【群消息统计】'));
    assert.ok(text.includes('群 10001：3 条（最近活跃 0 天前）'));
    assert.ok(text.includes('群 20002：1 条'));
    assert.ok(text.indexOf('群 10001') < text.indexOf('群 20002')); // 按条数降序
  });

  it('groupStats：无记录时返回「暂无消息统计」', (t) => {
    const { analytics } = makeAnalytics(t);
    assert.equal(analytics.groupStats(), '暂无消息统计');
  });
});

describe('抽卡记录（pulls 表）', () => {
  it('recordPull + myPulls：明细最新在前、total/six/five 计数口径（★ 串 LIKE 互斥）', (t) => {
    const { analytics } = makeAnalytics(t);
    const gid = '10001';
    // 10 抽 4★ → 3 抽 5★ → 2 抽 6★（最后一抽是 6★ 能天使）
    for (let i = 0; i < 10; i++) analytics.recordPull(gid, 'u1', '张三', '深池纪念', FOUR, `四星${i}`, false);
    for (let i = 0; i < 3; i++) analytics.recordPull(gid, 'u1', '张三', '深池纪念', FIVE, `五星${i}`, false);
    analytics.recordPull(gid, 'u1', '张三', '深池纪念', SIX, '能天使', true);
    analytics.recordPull(gid, 'u1', '张三', '深池纪念', SIX, '史尔特尔', false);

    const r = analytics.myPulls(gid, 'u1');
    assert.equal(r.total, 15);
    assert.equal(r.six, 2);
    assert.equal(r.five, 3);
    assert.equal(r.rows.length, 10); // 默认 limit 10
    assert.equal(r.rows[0].operator, '史尔特尔'); // id DESC 最新在前
    assert.equal(r.rows[0].is_up, 0);
    assert.equal(r.rows[1].operator, '能天使');
    assert.equal(r.rows[1].is_up, 1);
    assert.deepEqual(Object.keys(r.rows[0]), ['pool_name', 'star', 'operator', 'is_up', 'time']); // 行形状锁定

    assert.equal(analytics.myPulls(gid, 'u1', 50).rows.length, 15); // 上限内全量
    assert.equal(analytics.myPulls(gid, 'u1', 3).rows.length, 3);
    assert.equal(analytics.myPulls(gid, 'nobody').rows.length, 0); // 他人视角为空
  });

  it('pulls 群隔离：同人不同群/同群不同人互不串', (t) => {
    const { analytics } = makeAnalytics(t);
    analytics.recordPull('10001', 'u1', '张三', '池A', SIX, '能天使', false);
    analytics.recordPull('10001', 'u2', '李四', '池A', FOUR, '四星', false);
    analytics.recordPull('20002', 'u1', '张三', '池B', FOUR, '四星', false);

    assert.equal(analytics.myPulls('10001', 'u1').total, 1);
    assert.equal(analytics.myPulls('20002', 'u1').total, 1);
    assert.equal(analytics.myPulls('10001', 'u2').total, 1);
  });

  it('luckiest：6★ 数降序 → 总抽数降序，按群聚合', (t) => {
    const { analytics } = makeAnalytics(t);
    for (let i = 0; i < 30; i++) analytics.recordPull('10001', 'uA', '欧皇甲', '池A', i < 3 ? SIX : FOUR, `x${i}`, false);
    for (let i = 0; i < 5; i++) analytics.recordPull('10001', 'uB', '非酋乙', '池A', i < 1 ? SIX : FOUR, `y${i}`, false);
    analytics.recordPull('20002', 'uA', '欧皇甲', '池B', SIX, '别群', false); // 别群不计

    const rows = analytics.luckiest('10001');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, '欧皇甲');
    assert.equal(rows[0].six, 3);
    assert.equal(rows[0].total, 30);
    assert.equal(rows[1].name, '非酋乙');
    assert.equal(analytics.luckiest('99999').length, 0);
  });
});

describe('容错（锁定已知行为）', () => {
  it('库文件损坏：构造即抛（现状：进程启动崩溃，勿降级成静默）', (t) => {
    const dir = makeTmp();
    const dbPath = path.join(dir, 'messages.db');
    fs.writeFileSync(dbPath, '这不是 SQLite 数据库 {{{');
    assert.throws(() => new Analytics(dbPath, path.join(dir, 'messages')));
  });

  it('record/recordPull 写失败静默：正常路径下重复写入不抛错', (t) => {
    const { analytics } = makeAnalytics(t);
    analytics.record('10001', { id: '1', time: 1, userId: 'u1', name: 'n', text: 't' });
    analytics.recordPull('10001', 'u1', 'n', 'p', FOUR, 'o', false); // 不抛即过
  });
});
