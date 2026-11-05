/**
 * schedule.l.test — 定时任务判定（schedule.mjs）的引擎单测
 *
 * 覆盖《流程_整理》§5.4 / 《功能说明》§10.2：
 *   备份到期判定、整理提醒判定、间隔格式化
 *
 * ⚠️ 注意与 tick.mjs 的分工：本模块**不持有 timer**，只做纯判定。
 *    宿主用 setInterval 驱动，把判定结果当闸门。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isBackupDue, isTidyDue, formatInterval } from '../../lib/engine/schedule.mjs'

const DAY = 86_400_000

// ── formatInterval ────────────────────────────────────────

test('L1 formatInterval：0 或负数 = 关闭', () => {
  assert.equal(formatInterval(0), '关闭')
  assert.equal(formatInterval(-1), '关闭')
  assert.equal(formatInterval(NaN), '关闭')
})

test('L2 formatInterval：小时/天/分钟', () => {
  assert.equal(formatInterval(3_600_000), '1 小时')
  assert.equal(formatInterval(7_200_000), '2 小时')
  assert.equal(formatInterval(DAY), '1 天')
  assert.equal(formatInterval(DAY * 3), '3 天')
  assert.equal(formatInterval(60_000), '1 分钟')
})

// ── isBackupDue ───────────────────────────────────────────

test('L3 备份：间隔为 0 = 关闭，永不到期', () => {
  const r = isBackupDue({ intervalMs: 0, lastAt: null, now: Date.now() })
  assert.equal(r.due, false)
  assert.ok(r.reason.includes('关闭'))
})

test('L4 备份：从未备份过 → 到期', () => {
  const r = isBackupDue({ intervalMs: DAY, lastAt: null, now: 1_700_000_000_000 })
  assert.equal(r.due, true)
  assert.ok(r.reason.includes('从未备份'))
})

test('L5 备份：未到间隔 → 不到期', () => {
  const now = 1_700_000_000_000
  const r = isBackupDue({ intervalMs: DAY, lastAt: now - 1000, now })
  assert.equal(r.due, false)
})

test('L6 备份：刚好到间隔 → 到期', () => {
  const now = 1_700_000_000_000
  const r = isBackupDue({ intervalMs: DAY, lastAt: now - DAY, now })
  assert.equal(r.due, true)
})

test('L7 备份：超过间隔 → 到期', () => {
  const now = 1_700_000_000_000
  const r = isBackupDue({ intervalMs: DAY, lastAt: now - DAY * 2, now })
  assert.equal(r.due, true)
})

test('L8 备份：时间戳异常时保守执行', () => {
  const r = isBackupDue({ intervalMs: DAY, lastAt: NaN, now: Date.now() })
  assert.equal(r.due, true)
})

// ── isTidyDue ─────────────────────────────────────────────

test('L9 整理：记录积压触发（即使定时关着）', () => {
  const r = isTidyDue({ intervalMs: 0, lastAt: null, now: Date.now(), pendingReadLogs: 60 })
  assert.equal(r.due, true)
  assert.ok(r.reason.includes('积压'))
})

test('L10 整理：积压未达阈值且定时关闭 → 不到期', () => {
  const r = isTidyDue({ intervalMs: 0, lastAt: null, now: Date.now(), pendingReadLogs: 10 })
  assert.equal(r.due, false)
})

test('L11 整理：从未整理过 → 到期', () => {
  const r = isTidyDue({ intervalMs: DAY, lastAt: null, now: 1_700_000_000_000 })
  assert.equal(r.due, true)
  assert.ok(r.reason.includes('从未整理'))
})

test('L12 整理：未到间隔 → 不到期', () => {
  const now = 1_700_000_000_000
  const r = isTidyDue({ intervalMs: DAY, lastAt: now - 1000, now })
  assert.equal(r.due, false)
})

test('L13 整理：超过间隔 → 到期', () => {
  const now = 1_700_000_000_000
  const r = isTidyDue({ intervalMs: DAY, lastAt: now - DAY * 2, now })
  assert.equal(r.due, true)
})

test('L14 整理：积压优先级高于定时（两种都满足时给积压理由）', () => {
  const now = 1_700_000_000_000
  const r = isTidyDue({
    intervalMs: DAY,
    lastAt: now - DAY * 2,
    now,
    pendingReadLogs: 99,
    readLogThreshold: 50,
  })
  assert.equal(r.due, true)
  assert.ok(r.reason.includes('积压'), '积压应优先提示')
})
