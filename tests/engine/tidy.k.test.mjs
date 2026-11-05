/**
 * tidy.k.test — 整理链路（tidy.mjs）的引擎单测
 *
 * 覆盖《流程_整理》：
 *   §5.4 稳定性三态演进（feedback 驱动）
 *   §2.4 升通用强判定（≥4 不同身份/项目，且只升一个维度）
 *   §四   归纳（≥3 独立场合）
 *   §三   只许改 6 个字段，编号/主要内容/时距 不可改
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  foldFeedback,
  nextStability,
  planPromote,
  planInduction,
  validateTidyPatch,
  planTidy,
  planSplit,
  TIDY_EDITABLE,
  TIDY_IMMUTABLE,
} from '../../lib/engine/tidy.mjs'

const readOk = (id, ts, verdict = 'ok') => ({
  ts,
  who: 'tester',
  cond: {},
  total: 1,
  filtered: 1,
  passed: 1,
  near: [],
  hits: [{ 编号: id, 分: 90 }],
  feedback: [{ id, verdict }],
})

// ── foldFeedback ──────────────────────────────────────────

test('K1 foldFeedback：累计 ok', () => {
  const fb = foldFeedback([
    readOk('M-1', '2026-11-01T10:00:00+08:00'),
    readOk('M-1', '2026-11-02T10:00:00+08:00'),
  ])
  assert.equal(fb.get('M-1').ok, 2)
  assert.equal(fb.get('M-1').wrong, 0)
})

test('K2 foldFeedback：累计 wrong', () => {
  const fb = foldFeedback([readOk('M-1', '2026-11-01T10:00:00+08:00', 'wrong')])
  assert.equal(fb.get('M-1').wrong, 1)
})

test('K3 foldFeedback：显式 verdict 优先于默认 ok', () => {
  const fb = foldFeedback([readOk('M-1', '2026-11-01T10:00:00+08:00', 'unused')])
  assert.equal(fb.get('M-1').unused, 1)
  assert.equal(fb.get('M-1').ok, 0)
})

test('K4 foldFeedback：near 反复出现未被采纳 → 记 wrong', () => {
  const log = {
    ts: '2026-11-01T10:00:00+08:00',
    hits: [],
    near: [{ 编号: 'M-9', 分: 35 }],
    feedback: [],
  }
  const fb = foldFeedback([log])
  assert.equal(fb.get('M-9').wrong, 1)
})

test('K5 foldFeedback：命中过的条目不因 near 再记 wrong', () => {
  const log = {
    ts: '2026-11-01T10:00:00+08:00',
    hits: [{ 编号: 'M-1' }],
    near: [{ 编号: 'M-1' }],
    feedback: [{ id: 'M-1', verdict: 'ok' }],
  }
  const fb = foldFeedback([log])
  assert.equal(fb.get('M-1').ok, 1)
  assert.equal(fb.get('M-1').wrong, 0)
})

test('K6 foldFeedback：空输入不抛', () => {
  assert.equal(foldFeedback([]).size, 0)
  assert.equal(foldFeedback(null).size, 0)
})

// ── nextStability（状态机）─────────────────────────────────

test('K7 状态机：观察 + ok 达阈值 → 稳定', () => {
  const r = nextStability({ 稳定性: '观察' }, { ok: 3, wrong: 0 }, { stableOkThreshold: 3 })
  assert.equal(r.next, '稳定')
})

test('K8 状态机：ok 未达阈值不动', () => {
  assert.equal(nextStability({ 稳定性: '观察' }, { ok: 2, wrong: 0 }, { stableOkThreshold: 3 }), null)
})

test('K9 状态机：有 wrong → 降易变', () => {
  const r = nextStability({ 稳定性: '稳定' }, { ok: 9, wrong: 1 })
  assert.equal(r.next, '易变')
})

test('K10 状态机：已稳定不重复升', () => {
  assert.equal(nextStability({ 稳定性: '稳定' }, { ok: 99, wrong: 0 }, { stableOkThreshold: 3 }), null)
})

test('K11 状态机：已易变且有 wrong 不重复降', () => {
  assert.equal(nextStability({ 稳定性: '易变' }, { ok: 0, wrong: 5 }), null)
})

test('K12 状态机：易变安静 → 回观察（自愈）', () => {
  const r = nextStability({ 稳定性: '易变' }, { ok: 0, wrong: 0 })
  assert.equal(r.next, '观察')
})

test('K13 状态机：无 feedback 不动', () => {
  assert.equal(nextStability({ 稳定性: '观察' }, null), null)
})

// ── planPromote（升通用）──────────────────────────────────

const cand = (id, agent, proj = 'P', same = true) => ({
  编号: id,
  sameCluster: same,
  智能体: agent,
  项目: proj,
  主要内容: '同一件事',
})

test('K14 升通用：3 个不同身份不够（阈值 4）', () => {
  const r = planPromote([cand('M-1', 'a'), cand('M-2', 'b'), cand('M-3', 'c')], {
    minDistinct: 4,
    dimension: '智能体',
  })
  assert.equal(r.length, 0)
})

test('K15 升通用：4 个不同身份触发', () => {
  const r = planPromote([cand('M-1', 'a'), cand('M-2', 'b'), cand('M-3', 'c'), cand('M-4', 'd')], {
    minDistinct: 4,
    dimension: '智能体',
  })
  assert.equal(r.length, 1)
  assert.equal(r[0].field, '智能体')
  assert.equal(r[0].to, '通用')
})

test('K16 升通用：同一身份重复出现不算不同', () => {
  const r = planPromote(
    [cand('M-1', 'a'), cand('M-2', 'a'), cand('M-3', 'a'), cand('M-4', 'a')],
    { minDistinct: 4, dimension: '智能体' },
  )
  assert.equal(r.length, 0, '4 条但只有 1 个身份，不该升')
})

test('K17 升通用：未标记 sameCluster 的不计入', () => {
  const r = planPromote(
    [cand('M-1', 'a'), cand('M-2', 'b'), cand('M-3', 'c'), cand('M-4', 'd', 'P', false)],
    { minDistinct: 4, dimension: '智能体' },
  )
  assert.equal(r.length, 0, '第 4 条 sameCluster=false，只有 3 个有效')
})

test('K18 升通用：每次只升一个维度', () => {
  const r = planPromote([cand('M-1', 'a'), cand('M-2', 'b'), cand('M-3', 'c'), cand('M-4', 'd')], {
    minDistinct: 4,
    dimension: '智能体',
  })
  assert.equal(r.length, 1, '只应产生 1 条改动，不能同时升智能体和项目')
})

// ── planInduction（归纳）─────────────────────────────────

test('K19 归纳：≥3 个独立场合够格', () => {
  const logs = [
    { ts: '2026-11-01T10:00:00+08:00', ok: true },
    { ts: '2026-11-02T10:00:00+08:00', ok: true },
    { ts: '2026-11-03T10:00:00+08:00', ok: true },
  ]
  const r = planInduction(logs, { minOccasions: 3 })
  assert.equal(r[0].eligible, true)
  assert.equal(r[0].occasions, 3)
})

test('K20 归纳：同一天多次只算 1 个场合', () => {
  const logs = [
    { ts: '2026-11-01T10:00:00+08:00', ok: true },
    { ts: '2026-11-01T15:00:00+08:00', ok: true },
    { ts: '2026-11-01T20:00:00+08:00', ok: true },
  ]
  const r = planInduction(logs, { minOccasions: 3 })
  assert.equal(r[0].eligible, false)
  assert.equal(r[0].occasions, 1)
})

test('K21 归纳：只统计成功的写入', () => {
  const logs = [
    { ts: '2026-11-01T10:00:00+08:00', ok: false },
    { ts: '2026-11-02T10:00:00+08:00', ok: true },
    { ts: '2026-11-03T10:00:00+08:00', ok: true },
  ]
  const r = planInduction(logs, { minOccasions: 3 })
  assert.equal(r[0].occasions, 2)
  assert.equal(r[0].eligible, false)
})

// ── validateTidyPatch（越界校验）───────────────────────────

test('K22 越界：编号/主要内容/时距 一律拒绝', () => {
  for (const f of TIDY_IMMUTABLE) {
    const r = validateTidyPatch({ [f]: 'x' })
    assert.equal(r.ok, false, `${f} 应该被拒`)
    assert.ok(r.violations.length > 0)
  }
})

test('K23 越界：6 个可改字段全部允许', () => {
  for (const f of TIDY_EDITABLE) {
    const r = validateTidyPatch({ [f]: 'v' })
    assert.equal(r.ok, true, `${f} 应该允许`)
  }
})

test('K24 越界：不在白名单的字段也拒绝', () => {
  const r = validateTidyPatch({ 随便一个字段: 1 })
  assert.equal(r.ok, false)
})

// ── planTidy（汇总）──────────────────────────────────────

test('K25 planTidy：完整流程产出稳定性变更', () => {
  const r = planTidy({
    records: [
      { 编号: 'M-1', 稳定性: '观察', 形态: '技能', 项目: 'P', 智能体: 'A', 主要内容: 'x', 时距: 1, 状态: '生效' },
    ],
    readLogs: [
      readOk('M-1', '2026-11-01T10:00:00+08:00'),
      readOk('M-1', '2026-11-02T10:00:00+08:00'),
      readOk('M-1', '2026-11-03T10:00:00+08:00'),
    ],
    writeLogs: [],
    config: { stableOkThreshold: 3 },
  })
  assert.equal(r.changes.length, 1)
  assert.equal(r.changes[0].field, '稳定性')
  assert.equal(r.changes[0].after, '稳定')
  assert.ok(r.changes[0].basis.includes('feedback'))
})

test('K26 planTidy：无反馈时零改动', () => {
  const r = planTidy({
    records: [{ 编号: 'M-1', 稳定性: '观察' }],
    readLogs: [],
    writeLogs: [],
    config: {},
  })
  assert.equal(r.changes.length, 0)
  assert.equal(r.report.changes, 0)
})

test('K27 planTidy：report 字段齐全', () => {
  const r = planTidy({ records: [], readLogs: [], writeLogs: [], config: {} })
  for (const k of ['条目总数', 'read记录数', 'write记录数', 'feedback覆盖条目数', 'changes', 'proposals']) {
    assert.ok(k in r.report, `report 缺 ${k}`)
  }
})
// ── planSplit（拆库拆表）─────────────────────────────────

test('K28 拆库：空库不拆', () => {
  assert.equal(planSplit([]).shouldSplit, false)
})

test('K29 拆库：条目数超阈值 → 建议拆', () => {
  const many = Array.from({ length: 2100 }, (_, i) => ({ 项目: `P${i % 10}`, 自由标签: [`t${i}`] }))
  const r = planSplit(many, { maxEntries: 2000 })
  assert.equal(r.shouldSplit, true)
  assert.ok(r.reason.includes('条目数'))
})

test('K30 拆库：单项目占比过高 → 建议拆并点名该维度', () => {
  const list = Array.from({ length: 100 }, (_, i) => ({
    项目: i < 80 ? 'BIG' : 'small',
    自由标签: [`t${i}`],
  }))
  const r = planSplit(list, { projectDominance: 0.6 })
  assert.equal(r.shouldSplit, true)
  assert.ok(r.reason.includes('BIG'))
  assert.ok(r.suggestion.includes('BIG'))
})

test('K31 拆库：标签重复度过高 → 建议拆', () => {
  const list = Array.from({ length: 100 }, (_, i) => ({ 项目: `P${i % 5}`, 自由标签: ['same', 'tag'] }))
  const r = planSplit(list, { tagDuplication: 0.85 })
  assert.equal(r.shouldSplit, true)
  assert.ok(r.reason.includes('标签重复度'))
})

test('K32 拆库：正常库不拆', () => {
  const list = Array.from({ length: 100 }, (_, i) => ({ 项目: `P${i % 10}`, 自由标签: [`t${i}`, `u${i}`] }))
  const r = planSplit(list)
  assert.equal(r.shouldSplit, false)
})

test('K33 拆库：指标都回报（供 UI 显示）', () => {
  const r = planSplit([{ 项目: 'P', 自由标签: ['a'] }])
  for (const k of ['条目数', '条目数阈值', '最大项目占比', '标签重复度']) {
    assert.ok(k in r.metrics, `metrics 缺 ${k}`)
  }
})

test('K34 拆库：只提议不自动执行（planTidy 里归入 proposals）', () => {
  const many = Array.from({ length: 2100 }, (_, i) => ({
    编号: `M-${i}`,
    形态: '事实',
    项目: `P${i % 10}`,
    智能体: 'A',
    主要内容: 'x',
    自由标签: [`t${i}`],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
  }))
  const r = planTidy({ records: many, readLogs: [], writeLogs: [], config: {} })
  assert.equal(r.changes.length, 0, '拆库不得进入可执行 changes')
  assert.ok(r.proposals.some((p) => p.kind === 'split'), '拆库应作为 proposal')
  assert.equal(r.report.需要拆库, true)
})
