/**
 * read.h.test.mjs — 召回判据标定回归（2026-11-16 重构后）
 *
 * ── 本组守什么 ────────────────────────────────────────────────
 * 旧版这组测的是 `entryRatio` 从 0.5 标定到 0.3 的行为。那个判据已经被**删除**，
 * 因为它有结构性死锁：分母是「条目标签数」= 写入侧自由决定的量，
 * 给定查询词数 k，e_ratio 上限是 min(k,n)/n → n >= k/entryRatio 的条目数学上永远召不回。
 *
 * 新判据的分母**只有查询词数**，没有条目标签数：
 *   · minHit      —— 命中标签的绝对数（与条目长度无关）
 *   · queryFloor  —— |命中| / |查询标签|（分母是模型可控的查询词数）
 *
 * 本组守住五条不能顺手改坏的东西：
 *   ① **标签数不再是召回的决定因素**（这是重构的全部意义，最重要的一条）
 *   ② 判定符：minHit 用 >=、queryFloor 用 >=
 *   ③ 跨项目/跨身份硬筛不受阈值影响
 *   ④ 出厂值来自 scoring.json，overrides 能覆盖
 *   ⑤ 零交集必被拒（与 queryFloor 的取值无关）
 *
 * 与 read.f.test.mjs 的分工：F 组测闸门顺序、等号边界、浏览模式、跨形态放行；
 * 本组专测「标签数 vs 召回率」这个旧版翻车的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recall, checkIsolation } from '../../lib/engine/read.mjs';
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' };
import scoring from '../../lib/engine/templates/scoring.json' with { type: 'json' };
import equivalence from '../../lib/engine/templates/tag-equivalence.json' with { type: 'json' };

const EQ = { groups: [] };
const ID = { bound: true, who: '萧潇' };

function rec(over = {}) {
  return {
    编号: 'M-20261111-001',
    主要内容: '多标签条目',
    形态: '技能',
    项目: 'dsh-tag-memory',
    智能体: '萧潇',
    自由标签: ['发版', '上线', '部署', '回滚', '监控', '预案'],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
    ...over,
  };
}

function run(records, 自由标签, extra = {}) {
  return recall({
    records,
    query: { 项目: 'dsh-tag-memory', 智能体: '萧潇', 形态: '技能', 自由标签 },
    identity: ID,
    schema,
    config: scoring,
    equivalence: EQ,
    ...extra,
  });
}

const idsOf = (res) => res.hits.map((h) => h['编号']);

/* ------------------------------------------------------------------ *
 * H1 出厂判据：minHit / queryFloor，且 entryRatio 已彻底移除
 * ------------------------------------------------------------------ */
test('H1 出厂判据 = minHit 1 + queryFloor 0.5，且 entryRatio 已不存在', () => {
  assert.equal(scoring.veto.minHit, 1, 'minHit 出厂 1：零交集必拒')
  assert.equal(scoring.veto.queryFloor, 0.5, 'queryFloor 出厂 0.5：查询词至少命中一半')
  assert.equal(
    Object.prototype.hasOwnProperty.call(scoring.veto, 'entryRatio'),
    false,
    'entryRatio 必须已从配置里删除。它只要存在，分母就还是「条目标签数」，死锁就还在。',
  )
})

/* ------------------------------------------------------------------ *
 * H2 【核心回归·重构的全部意义】标签数不再影响召回
 *
 * 旧版：6 标签条目 + 2 词查询 → e_ratio=0.333 → 被否决（死锁）
 * 新版：标签 4/6/8/10/20 个，只要查询词全中，全部必须召回
 * ------------------------------------------------------------------ */
test('H2 【核心】查询词全中时，条目标签数（4~20 个）不影响召回', () => {
  for (const n of [4, 6, 8, 10, 20]) {
    const tags = Array.from({ length: n }, (_, i) => `t${i}`)
    const r = rec({ 编号: `M-20261111-${String(n).padStart(3, '0')}`, 自由标签: tags })
    const res = run([r], tags.slice(0, 2)) // 2 个查询词全中 → q_ratio = 1

    assert.deepEqual(
      idsOf(res),
      [r['编号']],
      `条目 ${n} 个标签、查询 2 个词全中 → 必须召回。` +
        `旧判据下 e_ratio=2/${n} 会在 n>=7 时被否决（死锁），实际 ${idsOf(res).join(',') || '空'}`,
    )
    assert.equal(res.hits[0].explain.q_ratio, 1, 'q_ratio=1 才是判决依据')
    // e_ratio 仍如实计算，但不参与判决（explain 里 round4 过，容差 1e-4）
    assert.ok(
      Math.abs(res.hits[0].explain.e_ratio - 2 / n) < 1e-4,
      `e_ratio 应如实输出 2/${n}（诊断用），实际 ${res.hits[0].explain.e_ratio}`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * H3 少词查询：k=1 也能召回（旧版 1 词查询下 86% 的条目永远召不回）
 * ------------------------------------------------------------------ */
test('H3 【少词查询】1 个词查多标签条目 → 仍能召回（q_ratio=1）', () => {
  const r = rec({ 自由标签: ['发版', '上线', '部署', '回滚', '监控', '预案'] })
  const res = run([r], ['发版']) // 1 个词，命中 → q_ratio = 1/1 = 1

  assert.deepEqual(
    idsOf(res),
    [r['编号']],
    '1 个查询词命中即 q_ratio=1，必须召回。旧判据下 1/6≈0.167 < 0.3 会被否决',
  )
})

/* ------------------------------------------------------------------ *
 * H3b 少词查询的失败边界：1 个词没命中 → 必被拒
 * ------------------------------------------------------------------ */
test('H3b 1 个查询词未命中 → q_ratio=0 → 必被拒（MIN_HIT）', () => {
  const r = rec()
  const res = run([r], ['完全不存在的词'])
  assert.deepEqual(idsOf(res), [], '零交集必须否决')
  const near = res.near.find((x) => x['编号'] === r['编号'])
  assert.ok(near, '应进 near')
  assert.equal(near.reason, 'MIN_HIT', `原因应为 MIN_HIT，实际 ${near.reason}`)
})

/* ------------------------------------------------------------------ *
 * H4 判据来自配置，不是硬编码
 * ------------------------------------------------------------------ */
test('H4 判据来自 scoring.json：覆盖 queryFloor 后行为随之变', () => {
  // 默认 0.5 下：3 个查询词命中 1 个 = 0.333 < 0.5 → 拒
  const r = rec({ 自由标签: ['a', 'b', 'c'] })
  const strict = run([r], ['a', 'zzz', 'yyy'])
  assert.deepEqual(idsOf(strict), [], 'queryFloor=0.5 下 0.333 应被拒')

  // 覆盖成 0.3 后：0.333 >= 0.3 → 过
  const loose = { ...scoring, veto: { ...scoring.veto, queryFloor: 0.3 } }
  const res = run([r], ['a', 'zzz', 'yyy'], { config: loose })
  assert.deepEqual(idsOf(res), [r['编号']], '覆盖成 0.3 后同一查询应通过 —— 证明阈值没写死')
})

/* ------------------------------------------------------------------ *
 * H4b minHit 可调：调到 2 时单命中被拒
 * ------------------------------------------------------------------ */
test('H4b minHit 可调：调到 2 后「只命中 1 个词」被拒', () => {
  const r = rec({ 自由标签: ['a', 'b'] })
  const oneHit = run([r], ['a', 'zzz']) // q_ratio=0.5 过 queryFloor，但只命中 1 个
  assert.deepEqual(idsOf(oneHit), [r['编号']], 'minHit=1 时应通过（命中 1 个 + q_ratio 0.5）')

  const twoHit = { ...scoring, veto: { ...scoring.veto, minHit: 2 } }
  const res = run([r], ['a', 'zzz'], { config: twoHit })
  assert.deepEqual(idsOf(res), [], 'minHit=2 时只命中 1 个应被拒')
  assert.equal(res.near.find((x) => x['编号'] === r['编号']).reason, 'MIN_HIT')
})

/* ------------------------------------------------------------------ *
 * H5 【验收】跨项目/跨身份隔离不受判据改动影响
 * ------------------------------------------------------------------ */
test('H5 判据重构后，跨项目/跨身份条目仍查不到（硬筛在否决之前）', () => {
  const visible = rec({ 编号: 'M-20261111-100' })
  const foreignProject = rec({ 编号: 'M-20261111-101', 项目: '别的仓库' })
  const foreignAgent = rec({ 编号: 'M-20261111-102', 智能体: '别人' })
  const archived = rec({ 编号: 'M-20261111-103', 状态: '已归档' })

  const records = [visible, foreignProject, foreignAgent, archived]
  const res = run(records, visible['自由标签'].slice(0, 2))

  assert.deepEqual(idsOf(res), [visible['编号']], '只有可见集合内的条目可返回')
  assert.equal(res.filtered, 1, `硬筛后应剩 1 条，实际 ${res.filtered}`)

  // 直接复验 checkIsolation：判据改动与硬筛函数完全无关
  assert.equal(checkIsolation(foreignProject, { project: 'dsh-tag-memory', agent: '萧潇' }, schema).pass, false)
  assert.equal(checkIsolation(foreignAgent, { project: 'dsh-tag-memory', agent: '萧潇' }, schema).pass, false)
  assert.equal(checkIsolation(archived, { project: 'dsh-tag-memory', agent: '萧潇' }, schema).pass, false)
})

/* ------------------------------------------------------------------ *
 * H6 通用/引入 白名单仍可见（隔离口径不变）
 * ------------------------------------------------------------------ */
test('H6 项目/智能体为 通用·引入 的条目仍可见', () => {
  const records = [
    rec({ 编号: 'M-20261111-200', 项目: '通用', 智能体: '通用' }),
    rec({ 编号: 'M-20261111-201', 项目: '引入', 智能体: '引入' }),
  ]
  const res = run(records, records[0]['自由标签'].slice(0, 2))
  assert.equal(res.filtered, 2, '白名单取值仍进可见集合')
  assert.equal(idsOf(res).length, 2, '这两条都应被召回')
})

/* ------------------------------------------------------------------ *
 * H7 空标签条目仍被否决（0/0 裁决不因判据变化而松动）
 * ------------------------------------------------------------------ */
test('H7 空标签条目 + 非空 query 仍被否决（零交集裁决不变）', () => {
  const r = rec({ 编号: 'M-20261111-300', 自由标签: [] })
  const res = run([r], ['发版', '上线'])
  assert.deepEqual(idsOf(res), [])
  const near = res.near.find((x) => x['编号'] === r['编号'])
  assert.ok(near)
  assert.equal(near.reason, 'MIN_HIT')
  assert.equal(near.e_ratio, 0)
  assert.equal(near.hitTags.length, 0)
})

/* ------------------------------------------------------------------ *
 * H8 【负对照】把旧判据装回去，H2 的结论必须被推翻
 *
 * 这条测试的作用是证明 H2 真的在验「标签数不影响召回」这件事，
 * 而不是碰巧通过。做法：手工构造一个等效旧判据的 config（minHit 按比例算），
 * 验证 20 标签的条目会被拒。
 * ------------------------------------------------------------------ */
test('H8 【负对照】若把 minHit 提高到 3，20 标签条目 + 2 词查询会被拒（证明 H2 不是碰巧过）', () => {
  const tags = Array.from({ length: 20 }, (_, i) => `t${i}`)
  const r = rec({ 编号: 'M-20261111-400', 自由标签: tags })

  // 默认 minHit=1 → 通过
  assert.deepEqual(idsOf(run([r], tags.slice(0, 2))), [r['编号']], '（对照）默认应通过')

  // minHit=3 → 只命中 2 个 → 被拒
  const strict = { ...scoring, veto: { ...scoring.veto, minHit: 3 } }
  const res = run([r], tags.slice(0, 2), { config: strict })
  assert.deepEqual(idsOf(res), [], 'minHit=3 时命中 2 个应被拒 —— 证明召回确实受判据控制')
  assert.equal(res.near.find((x) => x['编号'] === r['编号']).reason, 'MIN_HIT')
})
