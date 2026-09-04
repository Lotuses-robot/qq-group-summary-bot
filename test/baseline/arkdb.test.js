/**
 * P0 行为基线：ArkDB 本地方舟库（src/arkdb.js）。
 *
 * 锁定目标（全部用 test/helpers.js 的合成夹具，无真实 17MB 数据依赖）：
 * 四表懒加载与缺表容错、alias 索引（名称/代号/档案名）、findByName 短名约束与子串匹配、
 * bigram Dice 模糊（波登克→波登可、高卢的支票本→高卢银行支票）、抽卡引擎的出率与排除
 * 语义（isNotObtainable 预备干员、TRAP 召唤物、isSpChar 异格限定仅 UP 池可出）、
 * currentGachaPools 时间窗过滤、poolRateUps 提取、reload 热重载、todayBirthdays。
 *
 * 确定性：randomPull / pullFromPool 经 withRand 桩掉 Math.random，断言在固定序列上成立。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ArkDB } from '../../src/arkdb.js';
import { cleanupTmpDirs, makeTmp, silenceLog, todayLabel, withRand, writeArkTables } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

/** 建一个装有合成数据的 ArkDB（每用例独立 tmp 目录） */
function makeArk() {
  const dir = makeTmp();
  return { dir, ark: new ArkDB(writeArkTables(dir)) };
}

const SIX = '★★★★★★';
const FIVE = '★★★★★';
const THREE = '★★★';

describe('ArkDB 加载', () => {
  it('四表懒加载：计数正确、_loaded 幂等', (t) => {
    const { ark } = makeArk(t);
    ark.load();
    assert.equal(ark.characters.size, 9);
    assert.equal(ark.handbooks.size, 4);
    assert.equal(ark.relics.size, 2); // 非 RELIC 节点被递归过滤掉
    assert.equal(ark.gachaPools.length, 4); // 含已关闭/未开放的池（过滤属查询层职责）
    ark.load(); // 二次 load 不重复
    assert.equal(ark.characters.size, 9);
  });

  it('数据目录缺文件/为空：不抛错、空表可用、查询返回 null', (t) => {
    const ark = new ArkDB(makeTmp());
    ark.load();
    assert.equal(ark.characters.size, 0);
    assert.equal(ark.findByName('能天使'), null);
    assert.equal(ark.currentGachaPools().length, 0);
  });

  it('reload() 热重载：文件更新后重读，旧表清空', (t) => {
    const { dir, ark } = makeArk(t);
    ark.load(); // characters/gachaPools 等表惰性填充：读字段前先 load（与 commands 运行路径一致）
    assert.equal(ark.characters.size, 9);

    const charFile = path.join(dir, 'data', 'ark', 'character_table.json');
    const table = JSON.parse(fs.readFileSync(charFile, 'utf8'));
    table.char_new = { name: '新干员', appellation: '新干员', rarity: 'TIER_5', profession: 'MEDIC' };
    fs.writeFileSync(charFile, JSON.stringify(table));

    ark.reload();
    assert.equal(ark.characters.size, 10);
    assert.equal(ark.findByName('新干员').rarity, 'TIER_5');
  });
});

describe('干员查找', () => {
  it('findByName：名称/代号/档案名三源索引，精确命中', (t) => {
    const { ark } = makeArk(t);
    assert.equal(ark.findByName('能天使').id, 'char_141_night');
    assert.equal(ark.findByName('预备干员').name, '预备干员-近战'); // appellation 别名命中
    assert.equal(ark.findByName('归溟幽灵鲨').id, 'char_701_sp');
    assert.equal(ark.findByName('不存在的人'), null);
  });

  it('findByName：≤2 字短词拒绝子串模糊（防「山」「可」误配），3 字以上允许互相包含', (t) => {
    const { ark } = makeArk(t);
    assert.equal(ark.findByName('可'), null); // 波登可的子串，但短词不模糊
    assert.equal(ark.findByName('山'), null);
    assert.equal(ark.findByName('克萨斯').name, '德克萨斯'); // 3 字子串允许
  });

  it('getById 合并档案与干员表：档案字段补全、name 以干员表为准、desc 剥 HTML', (t) => {
    const { ark } = makeArk(t);
    ark.load(); // getById 不自动 load（现状：commands 运行时前序 findByName 已触发）——基线锁此语义
    const op = ark.getById('char_141_night');
    assert.equal(op.name, '能天使');
    assert.equal(op.rarity, 'TIER_6');
    assert.equal(op.birthday, '5月25日'); // 来自档案 storyText 正则抠取
    assert.equal(op.gender, '男');
    assert.equal(op.race, '鲁珀');
    assert.equal(ark.getById('char_701_sp').desc, '异格干员'); // <span> 被剥
    assert.equal(ark.getById('no_such_id'), null);
  });

  it('findOperatorFuzzy：bigram Dice 兜底（波登克→波登可），阈值外返回 null', (t) => {
    const { ark } = makeArk(t);
    const hit = ark.findOperatorFuzzy('波登克');
    assert.equal(hit.name, '波登可');
    assert.equal(ark.findOperatorFuzzy('波登克', 0.9), null); // 0.5 < 0.9
    assert.equal(ark.findOperatorFuzzy('完全不沾边的词'), null);
    assert.equal(ark.findOperatorFuzzy('单'), null); // ≤1 字直接拒绝
  });

  it('searchBirthday：提问文本内找已收录干员名并返回档案生日', (t) => {
    const { ark } = makeArk(t);
    ark.load(); // searchBirthday 不自动 load（现状：chat 检索路径前已有其他查询触发）——基线锁此语义
    assert.deepEqual(ark.searchBirthday('能天使今天过生日吗'), { name: '能天使', birthday: '5月25日' });
    assert.equal(ark.searchBirthday('随便问问而已'), null);
  });

  it('todaysBirthdays：按「M月D日」精确比对，支持注入日期', (t) => {
    const { ark } = makeArk(t);
    const today = ark.todaysBirthdays();
    assert.ok(today.includes('生日测试员'), `今天(${todayLabel()})应有生日测试员，实际: ${today.join()}`);
    const jan1 = ark.todaysBirthdays(new Date(2026, 0, 1));
    assert.ok(jan1.includes('波登可')); // 夹具里波登可档案生日默认 1月1日
    const none = ark.todaysBirthdays(new Date(2026, 6, 15));
    assert.deepEqual(none, []);
  });

  it('containsOperatorName / containsRelicName：文本内名字探测', (t) => {
    const { ark } = makeArk(t);
    assert.equal(ark.containsOperatorName('给我上能天使'), true);
    assert.equal(ark.containsOperatorName('今天天气不错'), false);
    assert.equal(ark.containsRelicName('这个高卢银行支票厉害吗'), true);
    assert.equal(ark.containsRelicName('今天天气不错'), false);
  });
});

describe('藏品查找', () => {
  it('findRelic：全等 → ≥3 字包含匹配；≤2 字短词不模糊', (t) => {
    const { ark } = makeArk(t);
    const r = ark.findRelic('高卢银行支票');
    assert.equal(r.name, '高卢银行支票');
    assert.ok(r.usage.includes('部署费用'));
    assert.equal(ark.findRelic('银行支票').name, '高卢银行支票'); // 4 字包含
    assert.equal(ark.findRelic('支票'), null); // 2 字短词拒绝
    assert.equal(ark.findRelic('高卢'), null);
    assert.equal(ark.findRelic('不存在'), null);
  });

  it('findRelicFuzzy：bigram Dice 兜底（高卢的支票本→高卢银行支票）', (t) => {
    const { ark } = makeArk(t);
    assert.equal(ark.findRelicFuzzy('高卢的支票本').name, '高卢银行支票');
    assert.equal(ark.findRelicFuzzy('高卢的支票本', 0.9), null);
    assert.equal(ark.findRelicFuzzy('随便'), null);
  });
});

describe('抽卡引擎', () => {
  it('randomPull：星级出率区间正确（6★2% 5★8% 4★50% 3★40%）', (t) => {
    const { ark } = makeArk(t);
    // r=0.01 → TIER_6；r2=0 → 6★候选第一个（能天使；异格限定归溟被排除）
    assert.deepEqual(withRand([0.01, 0], () => ark.randomPull(1)[0]), { star: SIX, name: '能天使', up: false });
    // r=0.02 → TIER_5；5★候选 [阿米娅, 德克萨斯]，r2=0.5 → 德克萨斯
    assert.deepEqual(withRand([0.02, 0.5], () => ark.randomPull(1)[0]), { star: FIVE, name: '德克萨斯', up: false });
    // r=0.61 → TIER_3；3★候选须排除预备干员(isNotObtainable)与铁拳卫(TRAP)：r2=0.5 → 候选[玫兰莎,生日测试员] 取生日测试员
    // （不用 0.6：pickOne 是累减式区间 0.6-0.02-0.08=0.4999…94 < 0.5，浮点使 r=0.6 落 TIER_4——边界值不承诺）
    assert.deepEqual(withRand([0.61, 0.5], () => ark.randomPull(1)[0]), { star: THREE, name: '生日测试员', up: false });
  });

  it('randomPull：不可获取/召唤物永远不出（统计 500 抽无违规）', (t) => {
    const { ark } = makeArk(t);
    const names = new Set();
    for (let i = 0; i < 500; i++) {
      for (const r of ark.randomPull(10)) names.add(r.name);
    }
    assert.ok(!names.has('预备干员-近战'));
    assert.ok(!names.has('铁拳卫'));
    assert.ok(!names.has('归溟幽灵鲨')); // 异格限定不进常驻池
    assert.ok(names.has('能天使'));
  });

  it('currentGachaPools：openTime≤now≤endTime 窗口过滤（缺时间字段视为不设限）', (t) => {
    const { ark } = makeArk(t);
    const pools = ark.currentGachaPools();
    assert.equal(pools.length, 2);
    assert.deepEqual(pools.map((p) => p.gachaPoolName), ['深池纪念', '愚人号']);
  });

  it('poolRateUps：从 dynMeta 合并 6★/5★ UP（main6RarityCharId + rare5CharList）', (t) => {
    const { ark } = makeArk(t);
    ark.load(); // gachaPools/characters 惰性填充；poolRateUps 自身不自动 load
    const pool = ark.gachaPools.find((p) => p.gachaPoolId === 'pool_open_1');
    assert.deepEqual(ark.poolRateUps(pool), { up6: ['char_141_night'], up5: ['char_502_amiya'] });
  });

  it('pullFromPool：单 UP 池命中 UP（星级掷中后 50% UP 分支）', (t) => {
    const { ark } = makeArk(t);
    ark.load(); // 取池对象前先 load（gachaPools 惰性填充；池对象由调用方 currentGachaPools 取得）
    const pool = ark.gachaPools.find((p) => p.gachaPoolId === 'pool_open_1');
    const seq = [0.01, 0.4, 0, 0.01, 0.4, 0]; // 两抽：6★ → UP分支(0.4<0.5) → 索引0
    const out = withRand(seq, () => ark.pullFromPool(pool, 2));
    assert.deepEqual(out, [
      { star: SIX, name: '能天使', up: true },
      { star: SIX, name: '能天使', up: true },
    ]);
  });

  it('pullFromPool：异格限定仅在其 UP 池可出，非 UP 池被排除、UP 池里非 UP 分支出常驻干员', (t) => {
    const { ark } = makeArk(t);
    ark.load(); // 取池对象前先 load
    const pool = ark.gachaPools.find((p) => p.gachaPoolId === 'pool_open_2'); // UP: 归溟幽灵鲨
    // 池2 内 UP 分支 → 归溟幽灵鲨
    const up = withRand([0.01, 0.4, 0], () => ark.pullFromPool(pool, 1)[0]);
    assert.equal(up.name, '归溟幽灵鲨');
    assert.equal(up.up, true);
    // 池2 内非 UP 分支 → 常驻 6★ 能天使（异格限定不在非 UP 候选里）
    const nonUp = withRand([0.01, 0.6, 0], () => ark.pullFromPool(pool, 1)[0]);
    assert.equal(nonUp.name, '能天使');
    assert.equal(nonUp.up, false);
    // 池1（非归溟 UP 池）：6★ 候选只剩能天使——归溟被 spChar 规则排除
    const pool1 = ark.gachaPools.find((p) => p.gachaPoolId === 'pool_open_1');
    const got = withRand([0.01, 0.99, 0.99], () => ark.pullFromPool(pool1, 1)[0]);
    assert.equal(got.name, '能天使');
  });

  it('pullFromPool(null) 降级 randomPull；无数据目录时输出「未知」兜底名', (t) => {
    const { ark } = makeArk(t);
    assert.equal(withRand([0.01, 0], () => ark.pullFromPool(null, 1)[0]).name, '能天使');

    const empty = new ArkDB(makeTmp());
    const r = withRand([0.99, 0], () => empty.randomPull(1)[0]);
    assert.equal(r.star, THREE);
    assert.equal(r.name, '（未知）');
  });
});
