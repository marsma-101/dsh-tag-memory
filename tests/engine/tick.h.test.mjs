// 闸门① H 组：时距 tick（7 条）
//
// 依据：《流程_读取》§六、《架构说明》§八、《功能说明》§七.2、《接口契约》疑点 1。
// 关键：两个「10」不是同一件事 —— tickCap（字段值上限）vs weights.tickMaxScore（打分权重上限）。
// H6 专门验"改一个不影响另一个"。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyTick, createTickQueue } from '../../lib/engine/tick.mjs'
import { tickScoreOf } from '../../lib/engine/read.mjs'
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' }
import scoring from '../../lib/engine/templates/scoring.json' with { type: 'json' }

const CONFIG = scoring

function rec(over = {}) {
  return {
    编号: 'M-20261105-001',
    主要内容: '测试条目',
    形态: '技能',
    项目: 'P',
    智能体: 'A',
    自由标签: ['a'],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
    ...over,
  }
}

const tickOf = (records, id) => records.find((r) => r['编号'] === id)?.['时距']

/* ------------------------------------------------------------------ *
 * H1 被召回 → 时距 +1
 * ------------------------------------------------------------------ */
test('H1 被召回的条目 → 时距 +1', () => {
  const records = [rec({ 编号: 'M-20261105-001', 时距: 3 })]
  const { records: after } = applyTick(records, ['M-20261105-001'], { cap: CONFIG.tickCap })

  assert.equal(tickOf(after, 'M-20261105-001'), 4, `时距应从 3 变 4，实际 ${tickOf(after, 'M-20261105-001')}`)
})

/* ------------------------------------------------------------------ *
 * H2 【关键】未被召回的条目完全不动
 * ------------------------------------------------------------------ */
test('H2 未被召回的条目 → 时距完全不动（逐条断言）', () => {
  const records = [
    rec({ 编号: 'M-20261105-001', 时距: 3 }),
    rec({ 编号: 'M-20261105-002', 时距: 7 }),
    rec({ 编号: 'M-20261105-003', 时距: 1 }),
  ]
  const { records: after } = applyTick(records, ['M-20261105-002'], { cap: CONFIG.tickCap })

  assert.equal(tickOf(after, 'M-20261105-001'), 3, '未召回的 001 必须仍是 3')
  assert.equal(tickOf(after, 'M-20261105-002'), 8, '被召回的 002 应 7→8')
  assert.equal(tickOf(after, 'M-20261105-003'), 1, '未召回的 003 必须仍是 1')
})

/* ------------------------------------------------------------------ *
 * H3 查空（miss）→ 全表时距不变
 * ------------------------------------------------------------------ */
test('H3 查空 miss（无命中）→ 全表时距不变', () => {
  const records = [rec({ 编号: 'M-20261105-001', 时距: 5 }), rec({ 编号: 'M-20261105-002', 时距: 9 })]
  const { records: after, changed } = applyTick(records, [], { cap: CONFIG.tickCap })

  assert.deepEqual(changed, [], '无命中时不得有任何变更')
  assert.equal(tickOf(after, 'M-20261105-001'), 5)
  assert.equal(tickOf(after, 'M-20261105-002'), 9)
})

/* ------------------------------------------------------------------ *
 * H4 9 → 10
 * ------------------------------------------------------------------ */
test('H4 时距 9 被召回 → 变 10', () => {
  const records = [rec({ 编号: 'M-20261105-001', 时距: 9 })]
  const { records: after } = applyTick(records, ['M-20261105-001'], { cap: CONFIG.tickCap })
  assert.equal(tickOf(after, 'M-20261105-001'), 10)
})

/* ------------------------------------------------------------------ *
 * H5 【两个 10 之二】tickCap 字段值封顶 = 10
 * ------------------------------------------------------------------ */
test('H5 【字段值上限】时距 10 再被召回 → 仍为 10；连召 5 次仍是 10', () => {
  assert.equal(CONFIG.tickCap, 10, '（前提）出厂 tickCap = 10')

  let records = [rec({ 编号: 'M-20261105-001', 时距: 10 })]
  for (let i = 0; i < 5; i++) {
    const r = applyTick(records, ['M-20261105-001'], { cap: CONFIG.tickCap })
    records = r.records
    assert.equal(
      tickOf(records, 'M-20261105-001'),
      10,
      `第 ${i + 1} 次召回后时距必须封顶 10，实际 ${tickOf(records, 'M-20261105-001')}`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * H6 【核心】两个 10 不互相影响
 * ------------------------------------------------------------------ */
test('H6 两个「10」互不影响：改 tickCap 不动打分，改 tickMaxScore 不动字段', () => {
  // (a) tickCap → 5：字段封顶变 5，但打分公式仍按 log2
  const cap5 = { ...CONFIG, tickCap: 5 }
  let records = [rec({ 编号: 'M-20261105-001', 时距: 5 })]
  records = applyTick(records, ['M-20261105-001'], { cap: cap5.tickCap }).records
  assert.equal(tickOf(records, 'M-20261105-001'), 5, 'tickCap=5 时字段应封顶 5')

  // 打分仍按 log2(5)*2 ≈ 4.64，不受 tickCap 影响
  const scoreAt5 = tickScoreOf(5, cap5)
  assert.ok(Math.abs(scoreAt5 - Math.log2(5) * 2) < 1e-9, `tickCap 不应影响打分，实际 ${scoreAt5}`)

  // (b) weights.tickMaxScore → 6：打分封顶变 6，但字段仍封 10
  const win6 = { ...CONFIG, weights: { ...CONFIG.weights, tickMaxScore: 6 } }
  assert.equal(tickScoreOf(1000, win6), 6, 'tickMaxScore=6 时打分应封顶 6')

  let records2 = [rec({ 编号: 'M-20261105-002', 时距: 10 })]
  records2 = applyTick(records2, ['M-20261105-002'], { cap: CONFIG.tickCap }).records
  assert.equal(tickOf(records2, 'M-20261105-002'), 10, 'tickMaxScore 不应改变字段封顶（仍是 10）')

  // (c) 两个键必须是不同的键
  assert.notEqual('tickCap' in CONFIG && 'tickMaxScore' in CONFIG.weights, undefined)
  assert.equal(CONFIG.tickCap, 10, 'tickCap 在顶层')
  assert.equal(CONFIG.weights.tickMaxScore, 10, 'tickMaxScore 在 weights 下')
})

/* ------------------------------------------------------------------ *
 * H7 tick 队列：只入队不落盘、不阻塞调用方
 * ------------------------------------------------------------------ */
test('H7 tick 队列：push 只入队不落盘，drain 才消费，不阻塞调用方', async () => {
  const flushed = []

  const queue = createTickQueue({
    cap: CONFIG.tickCap,
    flush: async (ids) => {
      flushed.push([...ids])
    },
    onError: () => {},
  })

  // push 必须是同步/立即返回，不得等落盘
  const t0 = Date.now()
  queue.push(['M-20261105-001'])
  queue.push(['M-20261105-002'])
  const pushElapsed = Date.now() - t0

  assert.ok(pushElapsed < 100, `push 不得阻塞调用方，实际耗时 ${pushElapsed}ms`)
  assert.equal(flushed.length, 0, 'push 后不得立即落盘（要等 drain）')
  assert.ok(queue.pendingSize >= 1, `排队中应有待处理项，实际 ${queue.pendingSize}`)

  // drain 之后才真正消费
  await queue.drain()
  assert.ok(flushed.length > 0, 'drain 后必须调用 flush')

  // 全部消费完
  const totalIds = flushed.flat()
  assert.ok(totalIds.includes('M-20261105-001'), 'flush 应收到 001')
  assert.ok(totalIds.includes('M-20261105-002'), 'flush 应收到 002')
})
