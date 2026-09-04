/**
 * P0 行为基线：确定性指令分发表 tryCommand（src/commands.js）。
 *
 * 锁定目标：14 条规则各自的命中文案、缺省守卫（analytics/groupId/userId 缺失时的
 * 「功能未启用」）、未命中返回严格 null（S12→S13 兜底判定依据）、以及**规则顺序即
 * 优先级**（「抽卡记录/我的抽卡」必须先于「单抽/十连/抽卡」；负向前瞻正则拒绝合并）。
 *
 * ctx 用真实实例组装（合成 ark 数据 + tmp 词典/SQLite），抽卡分支经 withRand 桩随机数。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { tryCommand } from '../../src/commands.js';
import { LingoStore } from '../../src/core/lingo.js';
import { ArkDB } from '../../src/core/arkdb.js';
import { Analytics } from '../../src/core/analytics.js';
import { makeTmp, cleanupTmpDirs, silenceLog, todayLabel, trackDbClose, withRand, writeArkTables } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

const SIX = '★★★★★★';

/** 组装命令 ctx：真实 lingo/arkdb/analytics + 群/用户上下文 */
function makeCtx({ withAnalytics = true } = {}) {
  const dir = makeTmp();
  const ctx = {
    lingo: new LingoStore(path.join(dir, 'lingo.json')),
    arkdb: new ArkDB(writeArkTables(dir)),
    analytics: null,
    groupId: '10001',
    userId: 'u1',
    userName: '测试群友',
  };
  if (withAnalytics) {
    ctx.analytics = new Analytics(path.join(dir, 'messages.db'), path.join(dir, 'messages'));
    trackDbClose(ctx.analytics); // Windows：不 close 的 sqlite 句柄让目录清理 EPERM
  }
  return ctx;
}

describe('词典学习/维护（规则 1-4）', () => {
  it('「学习 词=释义」与变体（纠正/记/定义；= ＝ ： :）', (t) => {
    const ctx = makeCtx();
    assert.equal(
      tryCommand(ctx, '学习 轮椅轴=用强力干员挂机过关的套路'),
      '已学习词条：轮椅轴 → 用强力干员挂机过关的套路'
    );
    assert.equal(tryCommand(ctx, '纠正 真香：指行为与先前表态相反'), '已学习词条：真香 → 指行为与先前表态相反');
    assert.equal(tryCommand(ctx, '定义 乌萨奇 ＝ 一种兔子'), '已学习词条：乌萨奇 → 一种兔子');
    assert.equal(tryCommand(ctx, '记 波登可 四星辅助干员'), '已学习词条：波登可 → 四星辅助干员'); // 空白分隔变体
    assert.equal(ctx.lingo.size(), 4);
  });

  it('释义太短拒学（不落库）；空词条/超长词不命中该规则', (t) => {
    const ctx = makeCtx();
    const reply = tryCommand(ctx, '学习 轮椅轴=x');
    assert.equal(reply, '释义太短了，请用「学习 词=释义」的格式，比如：学习 轮椅轴=指用强力干员挂机过关的套路');
    assert.equal(ctx.lingo.size(), 0);
    // 超过 20 字符的词不匹配空白分隔变体 → 落到 null（S13 兜底）
    assert.equal(tryCommand(ctx, `学习 ${'词'.repeat(21)} 释义`), null);
  });

  it('「忘记/删除/删 词」：存在则删、不存在如实提示', (t) => {
    const ctx = makeCtx();
    ctx.lingo.learn('过期梗', '旧释义');
    assert.equal(tryCommand(ctx, '忘记 过期梗'), '已忘记词条：过期梗');
    assert.equal(tryCommand(ctx, '删除 过期梗'), '词典中没有「过期梗」');
    ctx.lingo.learn('另一个', '释义');
    assert.equal(tryCommand(ctx, '删 另一个'), '已忘记词条：另一个');
  });

  it('「查词/词典查/释义 词」：命中回【词典】、未命中提示', (t) => {
    const ctx = makeCtx();
    ctx.lingo.learn('wifi', '网络连接');
    assert.equal(tryCommand(ctx, '查词 wifi'), '【词典】wifi：网络连接');
    assert.equal(tryCommand(ctx, '释义 没有的词'), '词典中没有「没有的词」');
  });

  it('整串「词典/词条数」：列全部词条，超过 30 条截断加省略号', (t) => {
    const ctx = makeCtx();
    assert.equal(tryCommand(ctx, '词典'), '当前词典共 0 条。\n');
    for (let i = 0; i < 32; i++) ctx.lingo.learn(`词条${i}`, `释义${i}`);
    const reply = tryCommand(ctx, '词条数');
    assert.ok(reply.startsWith('当前词典共 32 条。\n词条0、词条1'));
    assert.ok(reply.includes('词条29'));
    assert.ok(reply.endsWith(' …'));
  });
});

describe('干员/藏品/生日查询（规则 5-8）', () => {
  it('查干员：精确命中输出档案五行', (t) => {
    const ctx = makeCtx();
    assert.equal(
      tryCommand(ctx, '查干员 能天使'),
      ['【干员】能天使', '生日：5月25日', '性别：男', '种族：鲁珀', '身高：160cm'].join('\n')
    );
    assert.equal(tryCommand(ctx, '干员 预备干员'), '【干员】预备干员-近战'); // appellation 别名命中
  });

  it('查干员：模糊兜底（波登克→波登可）与未找到提示', (t) => {
    const ctx = makeCtx();
    assert.ok(tryCommand(ctx, '查干员 波登克').startsWith('【干员】波登可'));
    assert.equal(
      tryCommand(ctx, '查干员 不存在的人'),
      '未找到干员「不存在的人」，可以试试精确名字，或问「XX是谁」'
    );
  });

  it('查藏品：精确/模糊命中输出效果描述、未找到提示', (t) => {
    const ctx = makeCtx();
    assert.equal(
      tryCommand(ctx, '查藏品 高卢银行支票'),
      '【藏品】高卢银行支票\n效果：部署费用-2，再部署时间-15%\n描述：高卢的遗产，银行的金库深处。'
    );
    assert.equal(tryCommand(ctx, '查藏品 高卢的支票本'), tryCommand(ctx, '查藏品 高卢银行支票')); // 模糊=精确结果
    assert.equal(tryCommand(ctx, '藏品 不存在'), '未找到藏品「不存在」');
  });

  it('干员生日：档案有生日输出、无生日如实说明、找不到提示', (t) => {
    const ctx = makeCtx();
    assert.equal(tryCommand(ctx, '干员生日 能天使'), '【生日】能天使：5月25日');
    assert.equal(tryCommand(ctx, '生日 波登克'), '【生日】波登可：1月1日'); // 模糊兜底
    assert.equal(tryCommand(ctx, '生日 预备干员'), '资料中没有 预备干员-近战 的生日记录');
    assert.equal(tryCommand(ctx, '干员生日 不存在的人'), '未找到干员「不存在的人」');
  });

  it('今日生日：按本地日期列出（夹具保证每天都有生日干员）', (t) => {
    const ctx = makeCtx();
    for (const q of ['今日生日', '今天谁生日']) {
      const reply = tryCommand(ctx, q);
      assert.ok(reply.startsWith(`今天（${todayLabel()}）过生日的干员：`), reply);
      assert.ok(reply.includes('生日测试员'));
    }
  });
});

describe('卡池与抽卡（规则 9-11）', () => {
  it('「卡池/卡池列表」：只列当前开放池、附 UP 干员与用法', (t) => {
    const ctx = makeCtx();
    const expected = '【当前卡池】\n'
      + '1. [限定寻访] 深池纪念（6★UP：能天使，5★UP：阿米娅）\n'
      + '2. 愚人号（6★UP：归溟幽灵鲨，5★UP：德克萨斯）\n'
      + '\n用法：十连 1 / 单抽 卡池名关键字';
    assert.equal(tryCommand(ctx, '卡池'), expected);
    assert.equal(tryCommand(ctx, '卡池列表'), expected);
  });

  it('规则顺序：抽卡记录/我的抽卡/抽卡统计必须先于 单抽/抽卡（不被吞）', (t) => {
    // analytics 缺失：三词都回「记录功能未启用」——若被「抽卡」规则先吞则会是抽卡结果
    const bare = makeCtx({ withAnalytics: false });
    assert.equal(tryCommand(bare, '抽卡记录'), '抽卡记录功能未启用');
    assert.equal(tryCommand(bare, '我的抽卡'), '抽卡记录功能未启用');
    assert.equal(tryCommand(bare, '抽卡统计 5'), '抽卡记录功能未启用');
    // 有 analytics 但没记录：落到「还没有抽卡记录」分支
    const ctx2 = makeCtx();
    assert.equal(tryCommand(ctx2, '抽卡记录'), '你还没有抽卡记录，试试「十连」吧');
  });

  it('负向前瞻边界：无空格的「单抽记录/十连记录」与「单抽 统计」都不命中抽卡规则', (t) => {
    const ctx = makeCtx();
    assert.equal(tryCommand(ctx, '单抽记录'), null);
    assert.equal(tryCommand(ctx, '十连记录'), null);
    assert.equal(tryCommand(ctx, '单抽 统计'), null);
  });

  it('单抽：默认第一个开放池，命中 UP（确定性随机序列）', (t) => {
    const ctx = makeCtx();
    const reply = withRand([0.01, 0.4, 0], () => tryCommand(ctx, '单抽'));
    assert.equal(reply, '【单抽·深池纪念】（6★UP：能天使；5★UP：阿米娅）\n★★★★★★ 能天使 ↑UP');
    // 抽卡结果自动记库（回复前已落 pulls；昵称经欧气榜查询可见）
    const { total, six, rows } = ctx.analytics.myPulls('10001', 'u1');
    assert.equal(total, 1);
    assert.equal(six, 1);
    assert.equal(rows[0].operator, '能天使');
    assert.equal(rows[0].is_up, 1);
    assert.equal(rows[0].pool_name, '深池纪念');
  });

  it('十连：按序号/池名关键字选池，序号越界与未知关键字静默回落第一池', (t) => {
    const ctx = makeCtx();
    const seq = Array(30).fill(0).flatMap(() => [0.01, 0.4, 0]);
    const reply = withRand(seq, () => tryCommand(ctx, '十连 2')); // 池2：归溟幽灵鲨 UP 池
    const lines = reply.split('\n');
    assert.equal(lines.length, 11); // 1 行头 + 10 抽
    assert.ok(lines[0].startsWith('【十连·愚人号】（6★UP：归溟幽灵鲨'));
    assert.equal(lines[1], '★★★★★★ 归溟幽灵鲨 ↑UP');
    assert.ok(lines.every((l, i) => i === 0 || l === '★★★★★★ 归溟幽灵鲨 ↑UP'));

    assert.equal(withRand([0.01, 0.4, 0], () => tryCommand(ctx, '单抽 深池')).split('\n')[0], '【单抽·深池纪念】（6★UP：能天使；5★UP：阿米娅）');
    assert.equal(withRand([0.01, 0.4, 0], () => tryCommand(ctx, '单抽 不存在的池子')).split('\n')[0], '【单抽·深池纪念】（6★UP：能天使；5★UP：阿米娅）');
    assert.equal(withRand([0.01, 0.4, 0], () => tryCommand(ctx, '单抽 99')).split('\n')[0], '【单抽·深池纪念】（6★UP：能天使；5★UP：阿米娅）');
  });

  it('抽卡记录 [N]：明细+累计统计；欧气榜按 6★ 排行', (t) => {
    const ctx = makeCtx();
    const seq = Array(30).fill(0).flatMap(() => [0.01, 0.4, 0]);
    withRand(seq, () => tryCommand(ctx, '十连'));

    const mine = tryCommand(ctx, '抽卡记录');
    assert.ok(mine.startsWith('【你的抽卡记录（最近 10 抽）】'));
    assert.equal(mine.split('\n').length, 13); // 头 + 10 明细 + 空行 + 累计行
    assert.ok(mine.endsWith('累计 10 抽 | 6★ ×10 | 5★ ×0'));
    assert.ok(mine.includes('★★★★★★ 能天使 ↑UP（深池纪念）'));

    assert.ok(tryCommand(ctx, '抽卡记录 3').startsWith('【你的抽卡记录（最近 3 抽）】'));
    assert.ok(tryCommand(ctx, '抽卡统计 99').startsWith('【你的抽卡记录（最近 10 抽）】')); // 收敛 1-50，总量不足时取实际

    const luck = tryCommand(ctx, '谁最欧');
    assert.equal(luck, '【本群欧气榜（按6★数量）】\n1. 测试群友：10 个6★ / 10 抽');
    assert.equal(tryCommand(ctx, '欧气榜'), luck);
    // 无 analytics 的守卫
    const bare = makeCtx({ withAnalytics: false });
    assert.equal(tryCommand(bare, '谁最欧'), '欧气榜功能未启用');
  });
});

describe('统计类指令与兜底边界（规则 12-14）', () => {
  it('活跃榜 [N天] / 群统计：走 analytics 聚合', (t) => {
    const ctx = makeCtx();
    for (let i = 0; i < 3; i++) {
      ctx.analytics.record('10001', { id: `m${i}`, time: Math.floor(Date.now() / 1000), userId: 'uA', name: '张三', text: 'hi' });
    }
    const top = tryCommand(ctx, '活跃榜');
    assert.ok(top.startsWith('【最近 7 天活跃榜】'));
    assert.ok(top.includes('1. 张三（3 条）'));
    assert.ok(tryCommand(ctx, '活跃榜 30').startsWith('【最近 30 天活跃榜】'));

    const stats = tryCommand(ctx, '群统计');
    assert.ok(stats.startsWith('【群消息统计】'));
    assert.ok(stats.includes('群 10001：3 条'));
  });

  it('统计守卫：缺 analytics 回「统计功能未启用」', (t) => {
    const ctx = makeCtx({ withAnalytics: false });
    assert.equal(tryCommand(ctx, '活跃榜'), '统计功能未启用');
    assert.equal(tryCommand(ctx, '群统计'), '统计功能未启用');
  });

  it('兜底边界：14 条规则全不中 → 严格 null（S13 判定依据）', (t) => {
    const ctx = makeCtx();
    for (const q of ['随便聊聊', '你好呀', '查', '学习', '总结一下今天', '@全体成员 晚上好', '波登可', '']) {
      assert.equal(tryCommand(ctx, q), null, `"${q}" 应为 null`);
    }
  });
});
