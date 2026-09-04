/**
 * P0 行为基线：LingoStore 词典（src/lingo.js）。
 *
 * 锁定目标：lookup 忽略大小写子串包含匹配（插入序首命中）、learn/delete 全量覆写落盘、
 * 损坏文件降级空词典、entries 公开 Map——commands 与 webui 直读 entries 依赖此面。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LingoStore } from '../../src/core/lingo.js';
import { cleanupTmpDirs, makeTmp, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

describe('LingoStore', () => {
  it('learn 新增词条：立即落盘，重启后新实例可读回', (t) => {
    const dir = makeTmp();
    const file = path.join(dir, 'lingo.json');
    const store = new LingoStore(file);
    store.learn('轮椅轴', '用强力干员挂机过关的套路');
    assert.equal(store.size(), 1);
    assert.equal(store.entries.get('轮椅轴'), '用强力干员挂机过关的套路');

    const store2 = new LingoStore(file);
    assert.equal(store2.size(), 1);
    assert.equal(store2.entries.get('轮椅轴'), '用强力干员挂机过关的套路');
  });

  it('learn 覆盖同名词条；词条与释义去首尾空白；空词条忽略', (t) => {
    const dir = makeTmp();
    const store = new LingoStore(path.join(dir, 'lingo.json'));
    store.learn(' 轮椅轴 ', '  旧释义  ');
    assert.equal(store.entries.get('轮椅轴'), '旧释义'); // key trim 后再覆盖
    store.learn('轮椅轴', '新释义');
    assert.equal(store.size(), 1);
    assert.equal(store.entries.get('轮椅轴'), '新释义');
    store.learn('', '空词条被忽略');
    assert.equal(store.size(), 1);
  });

  it('lookup：子串包含命中（插入序首个命中）、忽略大小写', (t) => {
    const dir = makeTmp();
    const store = new LingoStore(path.join(dir, 'lingo.json'));
    store.learn('轮椅轴', '挂机套路');
    store.learn('wifi', '网络连接');
    store.learn('能天使', '六星狙击');

    assert.deepEqual(store.lookup('这个轮椅轴真好用'), { term: '轮椅轴', meaning: '挂机套路' });
    // 忽略大小写：存储小写键，查询大写形态
    assert.deepEqual(store.lookup('我的WiFi又断了'), { term: 'wifi', meaning: '网络连接' });
    // 多词命中取先插入者：文本同时含轮椅轴与能天使 → 先学到的轮椅轴胜出
    assert.deepEqual(store.lookup('轮椅轴不如能天使强'), { term: '轮椅轴', meaning: '挂机套路' });
    assert.equal(store.lookup('完全不相关的内容'), null);
    assert.equal(store.lookup(''), null);
    assert.equal(store.lookup(null), null);
  });

  it('delete：命中返回 true 并落盘；未命中 false；跨实例删除立即生效', (t) => {
    const dir = makeTmp();
    const file = path.join(dir, 'lingo.json');
    const store = new LingoStore(file);
    store.learn('过期梗', '旧的');
    assert.equal(store.delete('过期梗'), true);
    assert.equal(store.size(), 0);
    assert.equal(store.delete('不存在'), false);

    store.learn('保留词', '还在');
    const store2 = new LingoStore(file);
    assert.equal(store2.delete('保留词'), true);
    assert.equal(store2.lookup('保留词'), null);
  });

  it('词典文件损坏：构造不抛错、降级空词典', (t) => {
    const dir = makeTmp();
    const file = path.join(dir, 'lingo.json');
    fs.writeFileSync(file, '这不是 JSON {{{');
    const store = new LingoStore(file); // 不抛
    assert.equal(store.size(), 0);
    store.learn('修好后', '还能写'); // 损坏文件上的写入也应可用
    const store2 = new LingoStore(file);
    assert.equal(store2.entries.get('修好后'), '还能写');
  });

  it('词典文件缺失：目录自动建好，构造即用', (t) => {
    const dir = makeTmp();
    const file = path.join(dir, '深层', '嵌套', 'lingo.json');
    const store = new LingoStore(file);
    assert.equal(store.size(), 0);
    store.learn('深层词', '值');
    assert.ok(fs.existsSync(file));
  });
});
