/**
 * P0 行为基线：知识缓存 KnowledgeCache（src/core/knowledge/cache.js）。
 *
 * 锁定目标：set/get 立即落盘、get 过期 TTL 剔除、hit 命中计数只计不续期、损坏文件降级
 * 空缓存（仅日志不抛）；deleteByPrefix 前缀清理（2026-09 修复坑 3——数据刷新实际有更新时
 * refresh 插件经它清 `q:` 检索缓存）：内存删 + 有删除才落盘（新实例读盘不复活）、
 * 前缀隔离（`q:` 不误删 `lingo:`）、前缀与键同款归一（小写去空白）、无匹配返回 0。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { KnowledgeCache } from '../../src/core/knowledge/cache.js';
import { cleanupTmpDirs, makeTmp, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

describe('知识缓存 deleteByPrefix（2026-09 修复坑 3）', () => {
  it('前缀删除：内存删 + 落盘（磁盘 JSON 同步消失），返回删除条数', () => {
    const file = path.join(makeTmp(), 'cache.json');
    const c = new KnowledgeCache(file);
    c.set('q:能天使几星', { context: 'a' });
    c.set('q:谁是六星', { context: 'b' });
    c.set('lingo:轮椅轴', { context: 'c' });
    assert.equal(c.size(), 3);

    assert.equal(c.deleteByPrefix('q:'), 2); // 命中 q: 两条，lingo: 不删
    assert.equal(c.size(), 1);
    assert.equal(c.get('q:能天使几星'), null);
    assert.equal(c.get('q:谁是六星'), null);
    assert.ok(c.get('lingo:轮椅轴')); // 前缀隔离

    // 落盘：新实例读同文件，q: 不复活
    const c2 = new KnowledgeCache(file);
    assert.equal(c2.size(), 1);
    assert.equal(c2.get('q:能天使几星'), null);
    assert.ok(c2.get('lingo:轮椅轴'));
  });

  it('前缀与键同款归一：小写/去空白后匹配（传「Q: 能天使几星」前缀照删大写键）', () => {
    const c = new KnowledgeCache(path.join(makeTmp(), 'cache.json'));
    c.set('Q: 能天使几星', { context: 'a' }); // set 归一存为小写
    c.set('lingo:KEY', { context: 'b' });
    assert.equal(c.deleteByPrefix('Q: '), 1); // 前缀归一小写去空白 → 命中 q:
    assert.equal(c.size(), 1);
    assert.ok(c.get('lingo:KEY'));
  });

  it('无匹配/删除数为 0：返回 0 且不落盘（不重写文件）', () => {
    const file = path.join(makeTmp(), 'cache.json');
    const c = new KnowledgeCache(file);
    c.set('lingo:轮椅轴', { context: 'a' });
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(c.deleteByPrefix('q:'), 0); // 只有 lingo: 键
    assert.equal(c.size(), 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before); // 文件未被重写
  });
});

describe('知识缓存基础契约（get/set/hit/size）', () => {
  it('set 立即落盘：新实例读盘可见；get 键归一小写命中', () => {
    const file = path.join(makeTmp(), 'cache.json');
    const c = new KnowledgeCache(file);
    c.set('Q:测试', { context: 'x', sources: [] }); // set 归一存为小写 q:测试
    const c2 = new KnowledgeCache(file);
    const e = c2.get('q:测试'); // get 同款归一（只小写+去首尾空白，不删键内空格）
    assert.ok(e);
    assert.equal(e.context, 'x');
    assert.ok(typeof e.cachedAt === 'number');
  });

  it('hit 只累计不续期（不判 TTL）；过期条目经 get 剔除后再 hit 返回 0', () => {
    const c = new KnowledgeCache(path.join(makeTmp(), 'cache.json'), { ttlHours: 1 });
    c.set('q:x', { context: 'x' });
    assert.equal(c.hit('q:x'), 1); // hit 只看存在性、只累计
    c.store.get('q:x').cachedAt -= 2 * 3600 * 1000; // cachedAt 拨回 2 小时 → 超 1h TTL
    assert.equal(c.get('q:x'), null); // 过期并当场剔除（确定性，避免同一毫秒内 set/get 的竞态）
    assert.equal(c.hit('q:x'), 0); // 已被 get 剔除
    assert.equal(c.size(), 0);
  });

  it('缓存文件损坏：构造降级为空缓存（仅日志，不抛）', () => {
    const file = path.join(makeTmp(), 'cache.json');
    fs.writeFileSync(file, '不是 JSON {{{');
    const c = new KnowledgeCache(file);
    assert.equal(c.size(), 0);
    c.set('q:y', { context: 'y' }); // 可继续写入
    assert.ok(c.get('q:y'));
  });
});
