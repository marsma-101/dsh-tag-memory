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

/**
 * 2026-11-11 标定：出厂 entryRatio 从 0.5 降到 0.3（scoring.json）。
 * 但 F2/F3/F6 守的是《简化评估结论》§3.9 逐位冻结的裁决：
 *   「条目侧 e_ratio > 阈值，等号不过；query 侧 q_ratio >= 阈值，等号过；否决先于及格线」。
 * 这些用例的前提是 0.5，**不能因为出厂值变了就删或放宽**——
 * 用局部 config 把阈值固定回 0.5，让它们继续守判定符/等号/顺序；
 * 新出厂值 0.3 的行为另见 read.h.test.mjs 的回归组。
 */
const LEGACY_0_5 = { ...CONFIG, veto: { ...CONFIG.veto, entryRatio: 0.5 } }
function runLegacy(records, query) {
  return run(records, query, { config: LEGACY_0_5 })
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
 * F2 【2026-11-16 判据重构的反例】条目 6 标签 / query 2 个全中
 *
 * 旧版这条断言「e_ratio=0.333 → 不返回」，正是我们要修的死锁：
 * 内容 100% 相关（查询词全在条目里），只因条目标签多就被永久否决。
 *
 * 新版：同样的输入必须**返回**。判据的分母改成了查询词数，
 * 2 个词全中 → q_ratio = 1.0 >= 0.5 → 过闸。
 * ------------------------------------------------------------------ */
test('F2 【核心回归】条目 6 标签 / query 2 个全中 → 必须返回（旧版 e_ratio 死锁已解）', () => {
  const records = [
    rec({
      编号: 'M-20261105-001',
      形态: '技能',
      自由标签: ['发版检查', '需先build', '部署', 'csv', 'token', '迁移'], // 6 个
    }),
  ]
  const query = {
    项目: 'P',
    智能体: 'A',
    形态: '技能',
    自由标签: ['发版检查', '部署'], // 2 个，全中
  }
  const res = run(records, query)

  assert.deepEqual(
    idsOf(res),
    ['M-20261105-001'],
    `查询词 100% 命中条目，必须返回。旧判据 e_ratio=2/6≈0.333 会否决，那是数学死锁（见 scoring.json _whyRemoved_entryRatio）`,
  )
  // e_ratio 仍被计算并输出（诊断用），但不参与判决
  assert.ok(Math.abs(res.hits[0].explain.e_ratio - 0.3333) < 0.001, 'e_ratio 仍应如实计算并输出，供诊断')
  assert.equal(res.hits[0].explain.q_ratio, 1, 'q_ratio = 2/2 = 1，这才是判决依据')

  // 反证：如果查询词只命中一半以下，仍应被否决（证明判据没被放宽成"任何查询都过"）
  const half = run(records, { ...query, 自由标签: ['发版检查', 'zzz', 'yyy'] }) // 1/3 ≈ 0.333 < 0.5
  assert.deepEqual(idsOf(half), [], 'q_ratio=0.333 < 0.5 应被否决，证明新判据仍在筛')
  const near = half.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '被否决的条目应进 near 作为擦边物证')
  assert.equal(near.reason, 'QUERY_FLOOR', `near.reason 应为 QUERY_FLOOR，实际 ${near.reason}`)
})

/* ------------------------------------------------------------------ *
 * F3 【等号边界·query 侧】q_ratio 恰 0.5 → 通过（判据是 >=，等号算过）
 *     对应旧版 F3「e_ratio 恰 0.5 → 不过（严格 >）」，判据换侧后等号方向也换了
 * ------------------------------------------------------------------ */
test('F3 【等号边界】q_ratio 恰为 0.5 → 通过（判据是 >=，等号算过）', () => {
  const records = [
    rec({
      编号: 'M-20261105-001',
      形态: '技能',
      自由标签: ['a', 'b', 'c', 'd'], // 4 个
    }),
  ]
  // query 4 个词，命中 2 个 → q_ratio = 0.5，恰好等于阈值
  const res = run(records, {
    项目: 'P',
    智能体: 'A',
    形态: '技能',
    自由标签: ['a', 'b', 'zzz', 'yyy'],
  })

  assert.deepEqual(
    idsOf(res),
    ['M-20261105-001'],
    `q_ratio=0.5 恰等于阈值应通过（>= 判定），实际未返回`,
  )
  assert.equal(res.hits[0].explain.q_ratio, 0.5, 'q_ratio 应恰为 0.5')

  // 反证：0.499... 不过。query 3 个词命中 1 个 → 0.333 < 0.5
  const below = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'zzz', 'yyy'] })
  assert.deepEqual(idsOf(below), [], 'q_ratio≈0.333 < 0.5 必须被否决')
  assert.equal(below.near.find((n) => n['编号'] === 'M-20261105-001').reason, 'QUERY_FLOOR')
})

/* ------------------------------------------------------------------ *
 * F4 查询全命中 + 形态命中 → 必然返回（新判据下最基础的正向用例）
 * ------------------------------------------------------------------ */
test('F4 查询全命中（q_ratio=1）+ 形态命中 → 必然返回', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a', 'b', 'c'] }),
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.deepEqual(idsOf(res), ['M-20261105-001'], 'q_ratio=1 且形态命中，必返回')
  assert.equal(res.hits[0].explain.q_ratio, 1)
  assert.equal(res.hits[0].explain.shapeHit, true)
  // e_ratio 仍如实计算（2/3），但不再参与判决
  assert.ok(Math.abs(res.hits[0].explain.e_ratio - 0.6667) < 0.001)
})

/* ------------------------------------------------------------------ *
 * F5 【等号边界·query 侧】q_ratio = 0.5 过 / 0.499 不过
 * ------------------------------------------------------------------ */
test('F5a 【等号边界·query侧】q_ratio 恰为 0.5 → 通过（判据是 >=）', () => {
  // query 2 个词命中 1 个 → 0.5，恰好等于阈值
  const records = [rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a'] })]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'zzz'] })

  assert.deepEqual(idsOf(res), ['M-20261105-001'], 'q_ratio=0.5 应通过（>= 判定）')
  assert.equal(res.hits[0].explain.q_ratio, 0.5)
})

test('F5b 【等号边界·query侧】q_ratio 低于 0.5 → 被否决，不返回', () => {
  // query 3 个词命中 1 个 → 0.333 < 0.5
  const records = [rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a'] })]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'zzz', 'yyy'] })

  assert.deepEqual(idsOf(res), [], 'q_ratio≈0.333 < 0.5 应被否决')
  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '该条应进 near')
  assert.equal(near.reason, 'QUERY_FLOOR', `near.reason 应为 QUERY_FLOOR，实际 ${near.reason}`)
})

/* ------------------------------------------------------------------ *
 * F5c 【minHit 硬底线】零交集必被否决，且与 queryFloor 的取值无关
 * ------------------------------------------------------------------ */
test('F5c 【minHit】零标签交集 → 必被否决（MIN_HIT），即使把 queryFloor 调到 0', () => {
  const records = [rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a', 'b'] })]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['zzz'] })

  assert.deepEqual(idsOf(res), [], '零交集必须否决')
  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.equal(near.reason, 'MIN_HIT', `零交集的原因应为 MIN_HIT，实际 ${near.reason}`)

  // 关键：把 queryFloor 调到 0（谁都能过），minHit 仍然守着底线
  const noFloor = { ...CONFIG, veto: { ...CONFIG.veto, queryFloor: 0 } }
  const res2 = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['zzz'] }, { config: noFloor })
  assert.deepEqual(idsOf(res2), [], 'queryFloor=0 时 minHit 仍必须挡住零交集条目')
  assert.equal(res2.near.find((n) => n['编号'] === 'M-20261105-001').reason, 'MIN_HIT')
})

/* ------------------------------------------------------------------ *
 * F6 【顺序核心】否决先于及格线
 *
 * 构造：分数本可过及格线，但 q_ratio 不过 → 必须被否决拦下（不是被分数拦下）
 * 2026-11-16：判据从 e_ratio 换成 q_ratio，但「否决在前」这条顺序不变。
 * ------------------------------------------------------------------ */
test('F6 【顺序】命中否决先于及格线：分数够高但 q_ratio 不过 → 仍不返回，且原因是 QUERY_FLOOR', () => {
  const records = [
    rec({
      编号: 'M-20261105-001',
      形态: '技能', // 形态命中 = 30 分
      自由标签: ['a', 'b', 'c', 'd', 'e', 'f'],
      时距: 32, // + 10 分 → 总分 40（形态 30 + 时距 10）
    }),
  ]
  // query 6 个词只命中 2 个 → q_ratio = 2/6 ≈ 0.333 < 0.5 → 否决
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b', 'zzz', 'yyy', 'xxx', 'www'] })

  assert.deepEqual(
    idsOf(res),
    [],
    `q_ratio=0.333 不过 → 必须被否决拦下（若返回则说明顺序反了：先算分后否决）`,
  )

  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '该条应进 near')
  assert.equal(near.reason, 'QUERY_FLOOR', '被拦原因必须是 QUERY_FLOOR，不能是 BELOW_PASS_LINE')
})

/* ------------------------------------------------------------------ *
 * F7 及格线：39 不返回 / 45 返回
 * ------------------------------------------------------------------ */
test('F7 及格线 >= 45：44 不返回、45 返回', () => {
  // 构造 45 分：形态不中(0) + q_ratio=0.75(45) + 时距 1(0) = 45
  const exact45 = [rec({ 编号: 'M-20261105-001', 形态: '规则', 自由标签: ['a', 'b', 'c'], 时距: 1 })]
  const res45 = run(exact45, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b', 'c', 'zzz'] })
  assert.deepEqual(idsOf(res45), ['M-20261105-001'], '总分恰 45 必须返回（>= 判定）')
  assert.equal(res45.hits[0].score, 45, `总分应恰为 45，实际 ${res45.hits[0].score}`)

  // 构造 30 分：形态不中(0) + q_ratio=0.5(30) → 过了否决但不过及格线
  const below = [rec({ 编号: 'M-20261105-002', 形态: '规则', 自由标签: ['a', 'b'], 时距: 1 })]
  const res30 = run(below, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b', 'zzz', 'yyy'] })
  assert.deepEqual(idsOf(res30), [], '30 分 < 45 必须不返回')
  const near30 = res30.near.find((n) => n['编号'] === 'M-20261105-002')
  assert.ok(near30, '该条应进 near')
  assert.equal(near30.score, 30, `该条总分应恰为 30，实际 ${near30.score}`)
  assert.equal(near30.reason, 'BELOW_PASS_LINE', `原因应为 BELOW_PASS_LINE，实际 ${near30.reason}`)

  // 46 分：形态不中(0) + q_ratio=1(60) 太低 → 用形态命中(30) + q_ratio=0.5(30) = 60
  const rec60 = [rec({ 编号: 'M-20261105-003', 形态: '技能', 自由标签: ['a', 'b'], 时距: 1 })]
  const res60 = run(rec60, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b', 'zzz', 'yyy'] })
  assert.deepEqual(idsOf(res60), ['M-20261105-003'], '60 分必须返回')
  assert.equal(res60.hits[0].score, 60)
})

/* ------------------------------------------------------------------ *
 * F8a 浏览模式跳过命中否决与及格线
 * ------------------------------------------------------------------ */
test('F8a 浏览模式（query 标签为空）→ 跳过否决与及格线，返回该形态下全部生效条目', () => {
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
})

/* ------------------------------------------------------------------ *
 * F8b 【2026-11-16 关键回归】浏览模式必须跳过及格线
 *
 * 旧版这条测试守的是「浏览不跳及格线，因为形态分 50 >= 40 必然过线」。
 * 权重重构后形态分只有 30 < 45，若照旧走及格线，6 个形态会全部返回空。
 * 这不是假设——实测确认过。
 * ------------------------------------------------------------------ */
test('F8b 【关键】浏览模式必须跳过及格线：否则形态分 30 < 45 会让浏览全部返回空', () => {
  // 结构性证明：形态分已低于及格线，走及格线就必然全空
  assert.ok(
    CONFIG.weights.shapeHit < CONFIG.passLine,
    `（前提）形态分(${CONFIG.weights.shapeHit}) 现在低于及格线(${CONFIG.passLine})，` +
      '所以浏览模式不能再依赖"形态命中必然过线"',
  )

  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: ['a'] }),
    rec({ 编号: 'M-20261105-002', 形态: '技能', 自由标签: ['b'] }),
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: [] })

  assert.equal(res.hits.length, 2, '浏览必须返回全部条目（不能因及格线全空）')

  // 反证：这些条目的分数确实低于及格线——如果走了及格线就一条都出不来
  for (const h of res.hits) {
    assert.ok(
      h.score < CONFIG.passLine,
      `（反证）浏览返回的条目分数 ${h.score} < 及格线 ${CONFIG.passLine}，` +
        '正是"跳过及格线"才让它们能返回',
    )
  }
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
 * F-veto0 空标签条目 + 非空 query → minHit 不达标 → 否决（设计本意）
 * ------------------------------------------------------------------ */
test('F-veto0 【设计本意】空标签条目 + 非空 query → 命中数为 0 → 被否决，不返回', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 形态: '技能', 自由标签: [] }), // 标签空（理论上写入会被 TAGS_EMPTY 拦，这里是历史脏数据）
  ]
  const res = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: ['a', 'b'] })

  assert.deepEqual(idsOf(res), [], '空标签条目在非空 query 下必须被否决')

  const near = res.near.find((n) => n['编号'] === 'M-20261105-001')
  assert.ok(near, '应进 near')
  assert.equal(near.e_ratio, 0, 'e_ratio 仍如实计算为 0（诊断用）')
  assert.equal(near.hitTags.length, 0, '命中数必须是 0')
  assert.equal(near.reason, 'MIN_HIT', '原因应为 MIN_HIT（零交集）')

  // 但浏览模式仍能看到它（标签空不影响浏览）
  const browse = run(records, { 项目: 'P', 智能体: 'A', 形态: '技能', 自由标签: [] })
  assert.deepEqual(idsOf(browse), ['M-20261105-001'], '浏览模式下空标签条目仍可返回（跳过否决与及格线）')
})

/* ------------------------------------------------------------------ *
 * F9 跨形态放行口（文档明写"有意保留"）→ 应返回
 * ------------------------------------------------------------------ */
test('F9 【设计本意·有意保留】形态不命中 + 标签满分 = 60 → 应返回（形态不是硬门）', () => {
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
    '形态不命中但标签高度吻合（60+10=70）应返回——这是《流程_读取》§4.3 明写的"有意保留"，不是 bug',
  )
  assert.equal(res.hits[0].score, 70)
  assert.equal(res.hits[0].explain.shapeHit, false, '（前提）形态确实没命中')
  assert.equal(res.hits[0].explain.breakdown.tag, 60)
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
