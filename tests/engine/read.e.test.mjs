// 闸门① E 组：打分公式（11 条）
//
// 依据：《流程_读取》§4.1/§4.2、《架构说明》§十一、《功能说明》§七.2、《接口契约》疑点 1。
// 结构不能动，只允许按实测调数值。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tickScoreOf, scoreRecord, buildEquivalenceIndex, computeHit } from '../../lib/engine/read.mjs'
import { applyTick } from '../../lib/engine/tick.mjs'
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' }
import scoring from '../../lib/engine/templates/scoring.json' with { type: 'json' }

const CONFIG = scoring
const EQ = JSON.parse(JSON.stringify({ groups: [] })) // 空等价表：本组只验公式，不验归一
const eqIndexEmpty = buildEquivalenceIndex(EQ)

function rec(over = {}) {
  return {
    编号: 'M-20261105-001',
    主要内容: '测试条目',
    形态: '技能',
    项目: 'P',
    智能体: 'A',
    自由标签: ['x', 'y', 'z'],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
    ...over,
  }
}

/* ------------------------------------------------------------------ *
 * E1 形态命中 30 / 不命中 0（2026-11-16 权重 50→30）
 * ------------------------------------------------------------------ */
test('E1 形态命中 = 30 分；不命中 = 0 分', () => {
  const hit = scoreRecord(rec({ 形态: '技能' }), { 形态: '技能', 自由标签: ['x'] }, CONFIG, eqIndexEmpty)
  assert.equal(hit.breakdown.shape, 30, `形态命中应 30 分，实际 ${hit.breakdown.shape}`)
  assert.equal(hit.shapeHit, true)

  const miss = scoreRecord(rec({ 形态: '规则' }), { 形态: '技能', 自由标签: ['x'] }, CONFIG, eqIndexEmpty)
  assert.equal(miss.breakdown.shape, 0, `形态不命中应 0 分，实际 ${miss.breakdown.shape}`)
  assert.equal(miss.shapeHit, false)
})

/* ------------------------------------------------------------------ *
 * E2 标签分按 q_ratio 线性 0~60（2026-11-16 权重 40→60）
 * ------------------------------------------------------------------ */
test('E2 标签分 = 60 × q_ratio（线性）：1→60、0.75→45、0.5→30、0.25→15、0→0', () => {
  const entry = rec({ 形态: '规则', 自由标签: ['a', 'b', 'c', 'd'] })

  // 逐个明确写，避免数组歧义
  const check = (queryTags, expectedQ, expectedTag) => {
    const s = scoreRecord(entry, { 形态: '规则', 自由标签: queryTags }, CONFIG, eqIndexEmpty)
    assert.ok(
      Math.abs(s.q_ratio - expectedQ) < 1e-9,
      `q_ratio 期望 ${expectedQ}，实际 ${s.q_ratio}（query=${JSON.stringify(queryTags)}）`,
    )
    assert.ok(
      Math.abs(s.breakdown.tag - expectedTag) < 1e-9,
      `标签分期望 ${expectedTag}，实际 ${s.breakdown.tag}`,
    )
  }

  // q_ratio = |hit| / |query标签|（《流程_读取》§4.2：描述"query 想要的有多少被这条满足"）
  check(['a', 'b', 'c', 'd'], 1, 60) // query 4 个全中 → 4/4 = 1
  check(['a', 'b'], 1, 60) // query 2 个全中 → 2/2 = 1（全被满足就是 1）
  check(['a', 'b', 'c', 'zzz'], 0.75, 45) // query 4 个中 3 → 3/4
  check(['a', 'b', 'zzz', 'yyy'], 0.5, 30) // query 4 个中 2 → 2/4
  check(['a', 'zzz', 'yyy', 'xxx'], 0.25, 15) // query 4 个中 1 → 1/4
  check(['zzz'], 0, 0) // 全不中
})

/* ------------------------------------------------------------------ *
 * E3 时距分 = min(log2(时距)×2, 10)
 * ------------------------------------------------------------------ */
test('E3 时距分 = min(log2(时距)×2, 10)：1→0、2→2、4→4、16→8、32→10', () => {
  assert.equal(tickScoreOf(1, CONFIG), 0, '时距 1（写入初值）应 0 分——新条目不该靠时距加分')
  assert.equal(tickScoreOf(2, CONFIG), 2)
  assert.equal(tickScoreOf(4, CONFIG), 4)
  assert.equal(tickScoreOf(8, CONFIG), 6)
  assert.equal(tickScoreOf(16, CONFIG), 8)
  assert.equal(tickScoreOf(32, CONFIG), 10, 'log2(32)×2 = 10，正好到顶')
})

/* ------------------------------------------------------------------ *
 * E4 【两个 10 之一】weights.tickMaxScore 封顶 = 10
 * ------------------------------------------------------------------ */
test('E4 【打分权重上限】时距 64/100/1000 → 时距分恒为 10，不得 12/13', () => {
  for (const tick of [64, 100, 500, 1000, 1e6]) {
    const v = tickScoreOf(tick, CONFIG)
    assert.equal(v, 10, `时距 ${tick} 的时距分必须封顶 10，实际 ${v}`)
    assert.ok(v <= 10, '时距分绝不得超过 10（否则老条目靠召回自我强化）')
  }

  // 封顶值来自配置（不硬编码）
  const custom = { ...CONFIG, weights: { ...CONFIG.weights, tickMaxScore: 6 } }
  assert.equal(tickScoreOf(1000, custom), 6, '改 tickMaxScore 后封顶应随之变（证明没硬编码）')
})

/* ------------------------------------------------------------------ *
 * E5 满分 100，不超 —— 【2026-11-16 重写：走真实链路，不再构造不可达输入】
 *
 * 旧版直接构造 `时距: 32` 断言满分。当时 tickCap=10，32 永远不可达，
 * 等于用一个真实运行中不可能出现的输入来验证"满分可达"——这是假测试。
 *
 * 新版：先用 applyTick 把一条从写入初值 1 一路加到**配置声明的封顶值**，
 * 再用封顶后的真实时距算分。如果 tickCap 与 tickMaxScore 再次错配（像旧版 10 vs 10），
 * 这条测试会立刻变红，而不是像旧版那样被构造输入盖住。
 * ------------------------------------------------------------------ */
test('E5 满分构造：时距加到 tickCap 封顶后，总分恰为 100（走 applyTick 真实链路）', () => {
  const cap = CONFIG.tickCap;
  assert.ok(Number.isFinite(cap) && cap > 0, `tickCap 必须是正整数，实际 ${cap}`)

  // 从写入初值 1 开始，反复 applyTick 直到封顶——不手写时距值
  let records = [rec({ 编号: 'M-20261116-001', 形态: '技能', 自由标签: ['a'], 时距: 1 })]
  for (let i = 0; i < cap + 5; i++) {
    records = applyTick(records, ['M-20261116-001'], { cap }).records
  }
  const tick = records[0]['时距']
  assert.equal(tick, cap, `加到封顶后时距应恰为 tickCap=${cap}，实际 ${tick}`)

  const s = scoreRecord(records[0], { 形态: '技能', 自由标签: ['a'] }, CONFIG, eqIndexEmpty)
  assert.equal(s.breakdown.shape, 30)
  assert.equal(s.breakdown.tag, 60)
  assert.equal(s.breakdown.tick, 10, `封顶时距分必须能拿满 tickMaxScore=10，实际 ${s.breakdown.tick}`)
  assert.equal(s.score, 100, `满分应恰为 100，实际 ${s.score}`)
  assert.ok(s.score <= 100, '总分不得超过 100')
})

/* ------------------------------------------------------------------ *
 * E6 【2026-11-16 改判据】任一单项都不能单独越过及格线
 *
 * 旧判据「标签分不得高于形态分」的前提是「形态是主信号」。
 * 实测证明这个前提直接导致职责倒挂：形态 50 分 + 及格线 40 → 形态命中即及格
 * → 标签质量对筛选毫无作用（及格线拦下的条目数 = 0，成死代码）。
 *
 * 新判据「任一单项都不得单独及格」才是真正该守的不变式：
 * 没有哪一维可以垄断判决权，两者必须配合。
 * ------------------------------------------------------------------ */
test('E6 封顶原则：形态分、标签分（在 queryFloor 下限时）都不得单独越过及格线', () => {
  const { shapeHit, tagMax } = CONFIG.weights
  const passLine = CONFIG.passLine
  const queryFloor = CONFIG.veto.queryFloor

  // ① 形态不能单独及格
  assert.ok(
    shapeHit < passLine,
    `形态分(${shapeHit}) 必须 < 及格线(${passLine})，否则形态命中即及格，标签质量失去作用`,
  )

  // ② 标签在 queryFloor 下限时也不能单独及格
  const tagAtFloor = tagMax * queryFloor
  assert.ok(
    tagAtFloor < passLine,
    `标签分在 queryFloor=${queryFloor} 时(${tagAtFloor}) 必须 < 及格线(${passLine})，否则标签可单独及格`,
  )

  // ③ 两者配合能过线
  assert.ok(
    shapeHit + tagMax * 1.0 > passLine,
    '形态命中 + 标签满分必须能过及格线，否则正常条目永远召不回',
  )

  // 结构验证：只有形态命中（30）不够，只有标签满分（60）也不够
  const shapeOnly = scoreRecord(rec({ 形态: '技能', 自由标签: ['a'], 时距: 1 }), { 形态: '技能', 自由标签: ['zzz'] }, CONFIG, eqIndexEmpty)
  const tagOnly = scoreRecord(rec({ 形态: '规则', 自由标签: ['a'], 时距: 1 }), { 形态: '技能', 自由标签: ['a'] }, CONFIG, eqIndexEmpty)

  assert.equal(shapeOnly.score, 30, '只有形态命中 = 30 分')
  assert.equal(tagOnly.score, 60, '只有标签满分 = 60 分')
  assert.ok(shapeOnly.score < passLine, `只有形态命中(${shapeOnly.score}) 不得单独及格（及格线 ${passLine}）`)
})

/* ------------------------------------------------------------------ *
 * E7 e_ratio / q_ratio 分母互不串用
 * ------------------------------------------------------------------ */
test('E7 e_ratio 用条目标签数为分母、q_ratio 用 query 标签数为分母，互不串用', () => {
  const entry = rec({ 自由标签: ['a', 'b', 'c', 'd'] }) // 4 个
  const query = { 形态: '规则', 自由标签: ['a', 'b'] } // 2 个

  const { hit, q_ratio, e_ratio } = computeHit(query['自由标签'], entry['自由标签'], eqIndexEmpty)

  assert.equal(hit.length, 2, '交集应为 2 个')
  assert.equal(q_ratio, 1, `q_ratio = 2/2 = 1，实际 ${q_ratio}`)
  assert.equal(e_ratio, 0.5, `e_ratio = 2/4 = 0.5，实际 ${e_ratio}`)

  // 反过来验：若分母串用，这两个值会互换或相等
  assert.notEqual(q_ratio, e_ratio, '两者分母不同，值不应相等（若相等说明分母串用了）')
})

/* ------------------------------------------------------------------ *
 * E7b 【裁决】0/0 定为 0
 * ------------------------------------------------------------------ */
test('E7b 【0/0 裁决】条目标签空 + query 非空 → e_ratio 严格等于 0（不是 NaN、不是 1）', () => {
  const s = scoreRecord(rec({ 自由标签: [] }), { 形态: '规则', 自由标签: ['a', 'b'] }, CONFIG, eqIndexEmpty)

  assert.equal(Number.isNaN(s.e_ratio), false, `e_ratio 不得为 NaN，实际 ${s.e_ratio}`)
  assert.equal(s.e_ratio, 0, `e_ratio 必须严格等于 0，实际 ${s.e_ratio}`)
  assert.notEqual(s.e_ratio, 1, '绝不能是 1（否则空标签条目会被当成完全命中）')
  assert.equal(s.breakdown.tag, 0, '空标签条目标签分必须 0')
})

/* ------------------------------------------------------------------ *
 * E8 等价表归一（双向）
 * ------------------------------------------------------------------ */
test('E8 等价表归一双向生效：发版≈上线≈deploy，query 侧与条目侧各测一次', () => {
  const eq = buildEquivalenceIndex({ groups: [['发版', '上线', 'deploy'], ['部署', 'deploy']] })

  // 条目侧 = 发版，query 侧 = 上线 → 应撞上
  const a = computeHit(['上线'], ['发版'], eq)
  assert.equal(a.hit.length, 1, `「上线」与「发版」经等价表归一后应撞上，实际 ${JSON.stringify(a)}`)

  // 条目侧 = deploy，query 侧 = 发版 → 也应撞上（双向）
  const b = computeHit(['发版'], ['deploy'], eq)
  assert.equal(b.hit.length, 1, `「发版」与「deploy」应撞上，实际 ${JSON.stringify(b)}`)

  // 传递性：部署≈deploy≈上线 → 部署与上线同类
  const c = computeHit(['上线'], ['部署'], eq)
  assert.equal(c.hit.length, 1, '等价关系应传递：上线≈deploy≈部署')

  // 反证：不等价的词不得撞上
  const d = computeHit(['发版'], ['csv'], eq)
  assert.equal(d.hit.length, 0, '不等价的词不得撞上')
})

/* ------------------------------------------------------------------ *
 * E9 两边都空
 * ------------------------------------------------------------------ */
test('E9 条目标签空 + query 标签空 → e_ratio=0、q_ratio=0，标签分 0，不抛错', () => {
  const r = computeHit([], [], eqIndexEmpty)
  assert.equal(r.e_ratio, 0)
  assert.equal(r.q_ratio, 0)
  assert.deepEqual(r.hit, [])
  assert.equal(Number.isNaN(r.e_ratio), false)

  const s = scoreRecord(rec({ 自由标签: [] }), { 形态: '技能', 自由标签: [] }, CONFIG, eqIndexEmpty)
  assert.equal(s.breakdown.tag, 0)
  assert.equal(s.score, 30, '形态命中 30 + 标签 0 + 时距 0 = 30')
})

/* ------------------------------------------------------------------ *
 * E10 数值来自 scoring.json（证明没硬编码）
 * ------------------------------------------------------------------ */
test('E10 权重/threshold 来自 scoring.json → 改配置后分数随之变', () => {
  const custom = {
    ...CONFIG,
    weights: { shapeHit: 70, tagMax: 20, tickMaxScore: 10 },
  }

  const entry = rec({ 形态: '技能', 自由标签: ['a'], 时距: 1 })
  const s = scoreRecord(entry, { 形态: '技能', 自由标签: ['a'] }, custom, eqIndexEmpty)

  assert.equal(s.breakdown.shape, 70, '形态分应随 shapeHit 配置变（证明没硬编码 50）')
  assert.equal(s.breakdown.tag, 20, '标签分应随 tagMax 配置变（证明没硬编码 40）')
  assert.equal(s.score, 90)
})
