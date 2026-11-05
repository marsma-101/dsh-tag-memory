// 闸门① F 组：三道闸门与顺序（13 条）
//
// 依据：《功能说明》§七.3、《架构说明》§十一、《流程_读取》§4.3、
//       Lead 裁定 Q4（浏览跳否决、不跳及格线）+ 疑点 2/3（e_ratio 0/0、形态为空）。
//
// 本组的价值全在「顺序」和「等号边界」——这两处最容易糊弄过去。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { recall } from '../../lib/engine/read.mjs'
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' }
import scoring from '../../lib/engine/templates/scoring.json' with { type: 'json' }

const CONFIG = scoring
const EQ = { groups: [] }

/** 造条目 */
function rec(over = {}) {
  return {
    编号: 'M-20261105-001',
    主要内容: '测试条目',
    形态: '技能',
    项目: 'P',
    智能体: 'A',
    自由标签: ['a', 'b'],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
    ...over,
  }
}

/** 跑一次召回 */
function run(records, query, extra = {}) {
  return recall({
    records,
    query,
    identity: { bound: true, who: 'A' },
    schema,
    config: CONFIG,
    equivalence: EQ,
    ...extra,
  })
}

const idsOf = (res) => res.hits.map((h) => h['编号'])

/* ------------------------------------------------------------------ *
 * F1 硬筛：被取代 / 已归档 一律不返回
 * ------------------------------------------------------------------ */
test('F1 硬筛：状态=被取代 / 已归档 → 一律不返回', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 状态: '生效' }),
    rec({ 编号: 'M-20261105-002', 状态: '被取代' }),
    rec({ 编号: 'M-20261105-003', 状态: '已归档' }),
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.deepEqual(idsOf(res), ['M-20261105-001'], `只有生效条目可返回，实际 ${idsOf(res).join(',')}`)
  assert.equal(res.filtered, 1, `硬筛后应剩 1 条，实际 ${res.filtered}`)
})

/* ------------------------------------------------------------------ *
 * F2 【规格原文反例】条目 6 标签、query 2 个全中 → e_ratio=0.333 → 不返回
 * ------------------------------------------------------------------ */
test('F2 【规格原文反例】条目 6 标签 / query 2 个全中 → e_ratio=0.333 → 不返回', () => {
  const records = [
    rec({
      编号: 'M-20261105-001',
      形态: '技能', // 形态命中 50 分，本来能过及格线
      自由标签: ['发版检查', '需先build', '部署', 'csv', 'token', '迁移'], // 6 个
    }),
  ]
  const res = run(records, {
    项目: 'P',
    智能体: 'A',
    形态: '技能',
    自由标签: ['发版检查', '部署'], // 2 个，全中
  })

  // 规格原文：「条目 6 个标签、query 2 个全中但只占 33% → 不返回」
  assert.deepEqual(idsOf(res), [], `e_ratio=2/6≈0.333 ≤ 0.5，必须不返回，实际返回了 ${idsOf(res).join(',')}`)

  // near 里应有该条，且 reason 是 ENTRY_RATIO（证明确实是被命中否决拦的，不是分数不够）
  assert.equal(res.near.length, 1, '该条应进 near（擦边物证）')
  assert.equal(res.near[0]['编号'], 'M-20261105-001')
  assert.equal(res.near[0].reason, 'ENTRY_RATIO', `near.reason 应为 ENTRY_RATIO，实际 ${res.near[0].reason}`)
  assert.ok(Math.abs(res.near[0].e_ratio - 0.3333) < 0.001, `e_ratio 应为 0.333，实际 ${res.near[0].e_ratio}`)
})

/* ------------------------------------------------------------------ *
 * F3 【等号边界·条目侧】e_ratio 恰 0.5 → 不返回（严格大于）
 * ------------------------------------------------------------------ */
test('F3 【等号边界】e_ratio 恰为 0.5 → 不返回（判据是 > 0.5，等号不算过）', () => {
  const records = [
    rec({
      编号: 'M-20261105-001',
      形态: '技能',
      自由标签: ['a', 'b', 'c', 'd'], // 4 个
    }),
  ]
  const res = run(records, {
    项目: 'P',
    智能体: 'A',
    形态: '技能',
    自由标签: ['a', 'b'], // 命中 2 → e_ratio = 2/4 = 0.5
  })

  assert.deepEqual(idsOf(res), [], `e_ratio=0.5 必须不返回（严格大于），实际返回了 ${idsOf(res).join(',')}`)

  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '该条应进 near')
  assert.equal(near.reason, 'ENTRY_RATIO')
  assert.equal(near.e_ratio, 0.5, `e_ratio 应恰为 0.5，实际 ${near.e_ratio}`)
})

/* ------------------------------------------------------------------ *
 * F4 e_ratio=0.667 → 进入打分并通过
 * ------------------------------------------------------------------ */
test('F4 e_ratio 刚过线（条目 3 标签中 2 → 0.667）→ 进入打分并返回', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a', 'b', 'c'] }),
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.deepEqual(idsOf(res), ['M-20261105-001'], 'e_ratio=0.667 > 0.5，且形态命中 50 ≥ 40，应返回')
  assert.ok(Math.abs(res.hits[0].explain.e_ratio - 0.6667) < 0.001)
  assert.equal(res.hits[0].explain.shapeHit, true)
})

/* ------------------------------------------------------------------ *
 * F5a 【等号边界·query 侧】q_ratio = 0.15 恰好 → 通过
 * F5b q_ratio = 0.14 → 不过
 *     注意与 F3 不对称：条目侧 >（等号不过），query 侧 >=（等号过）
 * ------------------------------------------------------------------ */
test('F5a 【等号边界·query侧】q_ratio 恰为 0.15 → 通过（判据是 >=，与条目侧相反）', () => {
  // 构造 q_ratio 恰为 0.15：query 20 个标签，命中 3 个 → 3/20 = 0.15
  const entryTags = ['a', 'b', 'c']
  const queryTags = ['a', 'b', 'c', ...Array.from({ length: 17 }, (_, i) => `q${i + 1}`)]
  assert.equal(queryTags.length, 20, '（前提）query 20 个标签')

  const records = [rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: entryTags })]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: queryTags })

  // e_ratio = 3/3 = 1 > 0.5 ✅ ；q_ratio = 3/20 = 0.15 >= 0.15 ✅
  assert.deepEqual(idsOf(res), ['M-20261105-001'], `q_ratio=0.15 应通过（>= 判定），实际未返回`)
  assert.ok(Math.abs(res.hits[0].explain.q_ratio - 0.15) < 1e-6, `q_ratio 应恰为 0.15，实际 ${res.hits[0].explain.q_ratio}`)
})

test('F5b 【等号边界·query侧】q_ratio 低于 0.15（=0.14）→ 被否决，不返回', () => {
  // 构造 q_ratio ≈ 0.1428：query 21 个标签，命中 3 个 → 3/21 ≈ 0.1428 < 0.15
  const entryTags = ['a', 'b', 'c']
  const queryTags = ['a', 'b', 'c', ...Array.from({ length: 18 }, (_, i) => `q${i + 1}`)]
  assert.equal(queryTags.length, 21, '（前提）query 21 个标签')

  const records = [rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: entryTags })]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: queryTags })

  assert.deepEqual(idsOf(res), [], `q_ratio≈0.143 < 0.15 应被否决，实际返回了 ${idsOf(res).join(',')}`)

  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '该条应进 near')
  assert.equal(near.reason, 'QUERY_FLOOR', `near.reason 应为 QUERY_FLOOR，实际 ${near.reason}`)
})

/* ------------------------------------------------------------------ *
 * F6 【顺序核心】否决先于及格线
 *     构造"分数本可过 40 但 e_ratio 不过" → 必须不返回
 * ------------------------------------------------------------------ */
test('F6 【顺序】命中否决先于及格线：分数够 50 但 e_ratio 不过 → 仍不返回', () => {
  const records = [
    rec({
      编号: 'M-20261105-001',
      形态: '技能', // 形态命中 = 50 分，已过及格线 40
      自由标签: ['a', 'b', 'c', 'd', 'e', 'f'], // 6 个
      时距: 32, // + 10 分 → 总分 50（若标签也被扣，仍 >= 40）
    }),
  ]
  // query 只命中 2 个 → e_ratio = 2/6 ≈ 0.333 ≤ 0.5 → 否决
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.deepEqual(
    idsOf(res),
    [],
    `形态分 50 已过及格线，但 e_ratio=0.333 不过 → 必须被否决拦下（若返回则说明顺序反了：先算分后否决）`,
  )

  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '该条应进 near')
  assert.equal(near.reason, 'ENTRY_RATIO', '被拦原因必须是 ENTRY_RATIO，不能是 BELOW_PASS_LINE')
  assert.ok(near.score >= 40, `（反证）它的分数其实已过及格线：${near.score} 分——正因为否决在前才没返回`)
})

/* ------------------------------------------------------------------ *
 * F7 及格线：39 不返回 / 40 返回 / 41 返回
 * ------------------------------------------------------------------ */
test('F7 及格线 >= 40：39 不返回、40 返回、41 返回', () => {
  // 精确构造 40 分：形态不中(0) + q_ratio=1(40) + 时距 1(0) = 40
  const exact40 = [
    rec({
      编号: 'M-20261105-001',
      形态: '规则', // query 形态=技能 → 不命中 → 0
      自由标签: ['a', 'b'],
      时距: 1, // 0 分
    }),
  ]
  const res40 = run(exact40, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })
  assert.deepEqual(idsOf(res40), ['M-20261105-001'], '总分恰 40 必须返回（>= 判定）')
  assert.equal(res40.hits[0].score, 40, `总分应恰为 40，实际 ${res40.hits[0].score}`)

  // 39 分：形态不中(0) + q_ratio=0.75(30) + 时距 4(4) = 34；再试 39 → 需要非整数，改用精确构造
  // 形态不中 + q_ratio=1(40) 已是最低的"标签满"分；要 39 需分数带小数
  // 用 q_ratio=0.975 → 0.975*40=39
  const almost = [
    rec({ 编号: 'M-20261105-002', 形态: '规则', 自由标签: ['a', 'b'], 时距: 1 }),
  ]
  const q39 = ['a', 'b', ...Array.from({ length: 78 }, (_, i) => `z${i}`)] // 80 个，中 2 → 2/80=0.025
  // 换个更稳的构造：q_ratio = 39/40 = 0.975 → query 40 个，中 39 个
  const entry39 = Array.from({ length: 39 }, (_, i) => `t${i}`)
  const query39 = [...entry39] // 39 个全中 → q_ratio = 39/39 = 1 → 40 分，不是 39
  // 最直接：用形态不中 + 时距分制造 39 → 标签分必须是 39 或 38.x
  // 标签分 = q_ratio * 40，要 39 需 q_ratio = 0.975 → query 40 个中 39 个（但条目只有 39 个标签，e_ratio=1）
  const entry39b = Array.from({ length: 39 }, (_, i) => `t${i}`)
  const query40 = [...entry39b, 'extra'] // 40 个中 39 → q_ratio = 39/40 = 0.975 → 标签分 39
  const rec39 = [rec({ 编号: 'M-20261105-003', 形态: '规则', 自由标签: entry39b, 时距: 1 })]
  const res39 = run(rec39, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: query40 })

  // 注意：query 含 'extra' 未命中，但 e_ratio = 39/39 = 1 过否决，q_ratio = 0.975 > 0.15 过门槛
  assert.equal(res39.hits.length, 0, `总分 39 < 40 必须不返回，实际返回 ${res39.hits.length} 条`)
  const near39 = res39.near.find((n) => n['编号'] === 'M-20261105-003')
  assert.ok(near39, '39 分的条目应进 near')
  assert.equal(near39.score, 39, `该条总分应恰为 39，实际 ${near39.score}`)
  assert.equal(near39.reason, 'BELOW_PASS_LINE', `原因应为 BELOW_PASS_LINE，实际 ${near39.reason}`)

  // 41 分：形态不中(0) + q_ratio=1(40) + 时距 2(≈1)
  const rec41 = [rec({ 编号: 'M-20261105-004', 形态: '规则', 自由标签: ['a', 'b'], 时距: 2 })]
  const res41 = run(rec41, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })
  assert.deepEqual(idsOf(res41), ['M-20261105-004'], '41 分必须返回')
  assert.ok(res41.hits[0].score > 40)
})

/* ------------------------------------------------------------------ *
 * F8a 浏览模式跳过命中否决
 * ------------------------------------------------------------------ */
test('F8a 浏览模式（query 标签为空）→ 跳过命中否决，返回该形态下全部生效条目', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a'] }),
    rec({ 编号: 'M-20261105-002', 形态: '技能', 自由标签: ['b', 'c', 'd', 'e', 'f', 'g'] }),
    rec({ 编号: 'M-20261105-003', 形态: '技能', 自由标签: ['x', 'y', 'z'] }),
    rec({ 编号: 'M-20261105-004', 形态: '规则', 自由标签: ['a'] }), // 形态不符
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: [] })

  assert.equal(res.browseMode, true, 'query 标签为空应进入浏览模式')

  // 3 条技能条目全部返回（标签占比 0 也不受影响）
  assert.deepEqual(
    idsOf(res).sort(),
    ['M-20261105-001', 'M-20261105-002', 'M-20261105-003'],
    `浏览模式应返回该形态下全部生效条目，实际 ${idsOf(res).join(',')}`,
  )
  assert.equal(res.filtered, 4, '硬筛后 4 条（形态不是硬筛项）')
  assert.equal(res.vetoed, 0, `浏览模式不得有被否决的条目，实际 vetoed=${res.vetoed}`)

  // 每条都是形态命中 50 分
  for (const h of res.hits) assert.equal(h.explain.shapeHit, true)
})

/* ------------------------------------------------------------------ *
 * F8b 浏览模式不跳过及格线
 * ------------------------------------------------------------------ */
test('F8b 浏览模式【不】跳过及格线：仍受 >= 40 约束（正常条目必然过线）', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a'] }),
    rec({ 编号: 'M-20261105-002', 形态: '技能', 自由标签: ['b'] }),
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: [] })

  // 浏览时形态命中 = 50 >= 40 → 必然过线（这正是"不跳线也没问题"的原因）
  assert.equal(res.hits.length, 2, '浏览正常形态时全部过线')
  for (const h of res.hits) {
    assert.ok(h.score >= 40, `浏览模式下每条也必须 >= 40，实际 ${h.score}`)
  }

  // 结构性证明：浏览模式下形态命中给 50 分，>= 40 必然成立
  assert.equal(CONFIG.passLine, 40)
  assert.ok(CONFIG.weights.shapeHit >= CONFIG.passLine, '形态分(50) >= 及格线(40)，故浏览正常形态必然过线')
})

/* ------------------------------------------------------------------ *
 * F8c 形态为空的条目，浏览任何具体形态都返回不到（设计本意，不是缺陷）
 * ------------------------------------------------------------------ */
test('F8c 【设计本意】形态为空的条目 → 浏览任何具体形态都返回不到（不写成缺陷）', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '', 自由标签: ['a', 'b'] }), // 形态为空
  ]

  for (const shape of schema.shapes) {
    const res = run(records, { 项目: 'P', 智能体: 'A', 形态: shape, 自由标签: [] })
    assert.deepEqual(
      idsOf(res),
      [],
      `浏览「${shape}」时形态为空的条目必须返回不到（它本来就不是那个形态），实际返回了`,
    )
  }

  // 但硬筛是过的（说明不是被隔离挡掉，而是分数不够）
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: [] })
  assert.equal(res.filtered, 1, '硬筛应通过（不是被隔离挡掉）')
  assert.equal(res.empty, 'false_but_near', '应记为假查空（有擦边条目），不是真查空')
})

/* ------------------------------------------------------------------ *
 * F-veto0 空标签条目 + 非空 query → e_ratio=0 → 否决（设计本意）
 * ------------------------------------------------------------------ */
test('F-veto0 【设计本意】空标签条目 + 非空 query → e_ratio=0 → 被否决，不返回', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: [] }), // 标签空（理论上写入会被 TAGS_EMPTY 拦，这里是历史脏数据）
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.deepEqual(idsOf(res), [], '空标签条目在非空 query 下必须被否决')

  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '应进 near')
  assert.equal(near.e_ratio, 0, 'e_ratio 必须是 0（0/0 裁决）')
  assert.equal(near.reason, 'ENTRY_RATIO', '原因应为 ENTRY_RATIO')

  // 但浏览模式仍能看到它（标签空不影响浏览）——不过它形态命中，所以过线
  const browse = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: [] })
  assert.deepEqual(idsOf(browse), ['M-20261105-001'], '浏览模式下空标签条目仍可返回（形态命中 50）')
})

/* ------------------------------------------------------------------ *
 * F9 跨形态放行口（文档明写"有意保留"）→ 应返回
 * ------------------------------------------------------------------ */
test('F9 【设计本意·有意保留】形态不命中 + 标签满 + 时距满 = 50 → 应返回', () => {
  const records = [
    rec({
      编号: 'M-20261105-001',
      形态: '规则', // query 要找 技能 → 形态不命中 0 分
      自由标签: ['a', 'b'],
      时距: 32, // 时距分 10
    }),
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.deepEqual(
    idsOf(res),
    ['M-20261105-001'],
    '形态不命中但标签高度吻合（40+10=50）应返回——这是《流程_读取》§4.3 明写的"有意保留"，不是 bug',
  )
  assert.equal(res.hits[0].score, 50)
  assert.equal(res.hits[0].explain.shapeHit, false, '（前提）形态确实没命中')
  assert.equal(res.hits[0].explain.breakdown.tag, 40)
  assert.equal(res.hits[0].explain.breakdown.tick, 10)
})

/* ------------------------------------------------------------------ *
 * F-附加 同分排序：编号新的在前（顺序可复现）
 * ------------------------------------------------------------------ */
test('F-附加 同分时按编号降序排列（新的在前），保证顺序可复现', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a', 'b'], 时距: 1 }),
    rec({ 编号: 'M-20261105-003', 形态: '技能', 自由标签: ['a', 'b'], 时距: 1 }),
    rec({ 编号: 'M-20261105-002', 形态: '技能', 自由标签: ['a', 'b'], 时距: 1 }),
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.equal(res.hits.length, 3)
  const scores = res.hits.map((h) => h.score)
  assert.equal(new Set(scores).size, 1, '（前提）三条同分')

  assert.deepEqual(
    idsOf(res),
    ['M-20261105-003', 'M-20261105-002', 'M-20261105-001'],
    `同分应按编号降序（新在前），实际 ${idsOf(res).join(',')}`,
  )
})

/* ------------------------------------------------------------------ *
 * F-附加 Top-K 截断
 * ------------------------------------------------------------------ */
test('F-附加 Top-K：默认 5 条，超出截断，near 最多 3 条', () => {
  const records = Array.from({ length: 10 }, (_, i) =>
    rec({
      编号: `M-20261105-${String(i + 1).padStart(3, '0')}`,
      形态: '技能',
      自由标签: ['a', 'b'],
      时距: 1,
    }),
  )
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.equal(CONFIG.topK, 5)
  assert.equal(res.hits.length, 5, `Top-K 应截到 5 条，实际 ${res.hits.length}`)
  assert.equal(res.passed, 10, 'passed 应统计全部过线条目（不是截断后的）')

  assert.ok(res.near.length <= CONFIG.nearLimit, `near 最多 ${CONFIG.nearLimit} 条，实际 ${res.near.length}`)
})
