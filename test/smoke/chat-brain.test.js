/**
 * P3 冒烟：ChatBrain（src/plugins/chat.js，原 chat.js 服务上移改造）。
 *
 * 锁定面：① chatEnabled=false 整链短路（不触任何注入服务/网络）；② 构造注入的
 * lingo/arkdb/cache/wiki 等与装配层是同一对象引用（服务上移语义——指令插件 ctx 与
 * brain 共享单例）；③ buildMessages 的匿名机制：真实昵称绝不进入 messages（隐私红线）。
 * 14 步 chat() 联网主流程不做直测（需 LLM key 与网络），行为由逐字迁移 + 构造保真兜底。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ChatBrain } from '../../src/plugins/chat.js';

describe('ChatBrain 构造与开关（P3 服务上移）', () => {
  it('chatEnabled=false：chat() 整链短路返回 null，不触碰注入服务', async () => {
    const brain = new ChatBrain({ cfg: { chatEnabled: false } });
    assert.equal(await brain.chat('g1', '昵称', '随便问点什么'), null);
  });

  it('构造注入：知识服务与装配层共享同一引用（事实共享单例）', () => {
    const deps = {
      cfg: {},
      lingo: { name: 'lingo' },
      arkdb: { name: 'arkdb' },
      cache: { name: 'cache' },
      wiki: { name: 'wiki' },
      moegirl: { name: 'moegirl' },
      wikipedia: { name: 'wikipedia' },
    };
    const brain = new ChatBrain(deps);
    assert.equal(brain.lingo, deps.lingo);
    assert.equal(brain.arkdb, deps.arkdb);
    assert.equal(brain.cache, deps.cache);
    assert.equal(brain.wiki, deps.wiki);
    assert.equal(brain.moegirl, deps.moegirl);
    assert.equal(brain.wikipedia, deps.wikipedia);
    assert.equal(brain.enabled, true); // cfg 缺省 chatEnabled 视为开（与旧 ChatBot 一致）
    assert.equal(brain.historyLimit, 12);
  });
});

describe('ChatBrain buildMessages 匿名机制', () => {
  it('system 恒在首位；真实昵称/QQ 不进 messages，说话人记为 群友N 且同人稳定', () => {
    const brain = new ChatBrain({ cfg: {} });
    const msgs = brain.buildMessages('g1', '真实昵称XYZ', '波登可是谁', '知识上下文', 'u9');
    assert.equal(msgs[0].role, 'system');
    const user = msgs[msgs.length - 1];
    assert.ok(!JSON.stringify(msgs).includes('真实昵称XYZ'), '昵称不得泄露');
    assert.ok(!JSON.stringify(msgs).includes('u9'), 'QQ 不得泄露');
    assert.ok(user.content.startsWith('群友1：波登可是谁'));
    assert.ok(user.content.includes('知识上下文')); // wikiContext 拼在当前问题之后

    const again = brain.buildMessages('g1', '真实昵称XYZ', '再问一次', '', 'u9');
    assert.ok(again[again.length - 1].content.startsWith('群友1：')); // 同一人稳定代号
    const other = brain.buildMessages('g2', '真实昵称XYZ', '另一群', '', 'u9');
    assert.ok(other[other.length - 1].content.startsWith('群友1：')); // 群隔离：新群重新编号
  });
});
