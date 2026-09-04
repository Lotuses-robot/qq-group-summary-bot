/**
 * P1 冒烟：插件注册表（src/core/registry.js）——refactor-proposal Risk #10「注册顺序 +
 * 稳定排序须确定性」的验证面：名称/描述符校验、按 priority 降序的稳定分发（同分保注册序）、
 * 首响短路（string/true 即停）、null/undefined 落下一个、单插件异常隔离不中断分发。
 * P2 已把 commands.js 按领域拆成 4 个指令插件（plugins/），本文件是分发顺序契约的第一道防线。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PluginRegistry, PRIORITY } from '../../src/core/registry.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

describe('PRIORITY 优先级带', () => {
  it('常量表编码原路由链次序（数值越大越先分发）', () => {
    const order = ['summary', 'refresh', 'lingo', 'ark', 'gacha', 'stats', 'chat'];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(PRIORITY[order[i]] > PRIORITY[order[i + 1]], `${order[i]} > ${order[i + 1]}`);
    }
    assert.deepEqual(Object.keys(PRIORITY), order); // 键序即语义，别乱加/乱挪
  });
});

describe('PluginRegistry.register', () => {
  it('非法插件名 / 缺 handleMessage 抛错', () => {
    const reg = new PluginRegistry();
    for (const bad of ['', 'Foo', 'foo_bar', 'x'.repeat(33), null, undefined]) {
      assert.throws(() => reg.register({ name: bad, handleMessage: () => null }), /插件名非法/, `name=${JSON.stringify(bad)}`);
    }
    assert.throws(() => reg.register({ name: 'ok-name' }), /缺 handleMessage/);
    assert.throws(() => reg.register({}), /插件名非法/);
  });

  it('同名重复注册：后者覆盖前者（数组长度不变、新 handler 生效）', () => {
    const reg = new PluginRegistry();
    const first = reg.register({ name: 'dup', priority: 500, handleMessage: () => 'old' });
    const second = reg.register({ name: 'dup', priority: 900, handleMessage: () => 'new' });
    assert.equal(reg.plugins.length, 1);
    assert.equal(reg.dispatch({}), 'new');
    assert.equal(reg.sorted()[0].priority, 900);
    assert.equal(first, reg);
    assert.equal(second, reg); // 链式返回自身
  });
});

describe('PluginRegistry.sorted / dispatch', () => {
  it('sorted 按 priority 降序、同分保注册序（稳定）', () => {
    const reg = new PluginRegistry();
    reg.register({ name: 'mid1', priority: 700, handleMessage: () => null });
    reg.register({ name: 'high', priority: 900, handleMessage: () => null });
    reg.register({ name: 'mid2', priority: 700, handleMessage: () => null });
    reg.register({ name: 'low', priority: 300, handleMessage: () => null });
    assert.deepEqual(reg.sorted().map((p) => p.name), ['high', 'mid1', 'mid2', 'low']);
  });

  it('高优先级先分发；首个 string 短路（低优先级不被调用）', () => {
    const calls = [];
    const reg = new PluginRegistry();
    reg.register({ name: 'low', priority: 400, handleMessage: (c) => { calls.push('low'); return 'low-reply'; } });
    reg.register({ name: 'high', priority: 900, handleMessage: (c) => { calls.push('high'); return 'high-reply'; } });
    const got = reg.dispatch({ q: 1 });
    assert.equal(got, 'high-reply');
    assert.deepEqual(calls, ['high']); // 短路：low 一次未跑
  });

  it('enabled:false 跳过分发（hooks 不受 enabled 限制是 startAll 的事）', () => {
    const reg = new PluginRegistry();
    reg.register({ name: 'off', priority: 900, enabled: false, handleMessage: () => '不应命中' });
    reg.register({ name: 'on', priority: 300, handleMessage: () => 'on-reply' });
    assert.equal(reg.dispatch({}), 'on-reply');
  });

  it('null 与 undefined 都视为未命中 → 落下一个；全落空返回 null（S13 兜底判定依据）', () => {
    const reg = new PluginRegistry();
    reg.register({ name: 'first', handleMessage: () => undefined });
    reg.register({ name: 'second', handleMessage: () => null });
    assert.equal(reg.dispatch({}), null);
  });

  it('返回 true（已处理）同样短路', () => {
    const reg = new PluginRegistry();
    reg.register({ name: 'handle', priority: 500, handleMessage: () => true });
    reg.register({ name: 'after', priority: 300, handleMessage: () => '不应命中' });
    assert.equal(reg.dispatch({}), true);
  });

  it('单插件异常被吞并继续（不中断分发给 chat 兜底），ctx 原样透传', () => {
    const reg = new PluginRegistry();
    const seen = [];
    reg.register({ name: 'boom', priority: 900, handleMessage: () => { throw new Error('炸了'); } });
    reg.register({ name: 'listen', priority: 300, handleMessage: (c) => { seen.push(c); return '兜底-ok'; } });
    assert.equal(reg.dispatch({ q: '透传' }), '兜底-ok');
    assert.deepEqual(seen, [{ q: '透传' }]);

    // 全部插件都炸：不抛、返回 null
    const all = new PluginRegistry();
    all.register({ name: 'boom1', handleMessage: () => { throw new Error('e1'); } });
    assert.equal(all.dispatch({}), null);
  });
});

describe('PluginRegistry.startAll / stopAll', () => {
  it('start 按 priority 降序；stop 逆序（升序）', () => {
    const order = [];
    const mk = (name, priority) => ({
      name, priority,
      handleMessage: () => null,
      hooks: { start: () => order.push(`${name}.start`), stop: () => order.push(`${name}.stop`) },
    });
    const reg = new PluginRegistry();
    reg.register(mk('low', 300));
    reg.register(mk('high', 900));
    reg.register(mk('mid', 600));
    reg.startAll();
    reg.stopAll();
    assert.deepEqual(order, ['high.start', 'mid.start', 'low.start', 'low.stop', 'mid.stop', 'high.stop']);
  });

  it('start 钩子异常被吞并继续（与分发一致的容错）', () => {
    const order = [];
    const reg = new PluginRegistry();
    reg.register({ name: 'bad', priority: 900, handleMessage: () => null, hooks: { start: () => { throw new Error('x'); } } });
    reg.register({ name: 'ok', priority: 300, handleMessage: () => null, hooks: { start: () => order.push('ok') } });
    reg.startAll({ ctx: 1 });
    assert.deepEqual(order, ['ok']);
  });
});
