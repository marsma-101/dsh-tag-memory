// 闸门① C 组：编号 M-YYYYMMDD-NNN（7 条）
//
// 依据：《流程_写入》§三「编号」、《架构说明》§八、Lead 裁定 Q8（注入 now）。
// 关键反例 C6：toISOString 跨零点会错天，必须用本地时间。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nextId, parseId, isValidId, formatLocalDate, withFileLock } from '../../lib/engine/core.mjs'

/** 以本地时间构造 Date（避免测试机时区影响预期） */
function localDate(y, m, d, hh = 12, mm = 0, ss = 0) {
  return new Date(y, m - 1, d, hh, mm, ss)
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-c-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

/* ------------------------------------------------------------------ *
 * C1 格式严格 M-YYYYMMDD-NNN
 * ------------------------------------------------------------------ */
test('C1 编号格式严格匹配 /^M-\\d{8}-\\d{3}$/', () => {
  const id = nextId([], localDate(2026, 11, 5))
  assert.match(id, /^M-\d{8}-\d{3}$/, `编号格式不符，实际「${id}」`)

  const parsed = parseId(id)
  assert.ok(parsed, 'parseId 必须能解析自己产出的编号')
  assert.equal(parsed.date, '20261105')
  assert.equal(parsed.seq, 1)
})

/* ------------------------------------------------------------------ *
 * C2 当天首条 = 001
 * ------------------------------------------------------------------ */
test('C2 空库当天首条 → 001', () => {
  const id = nextId([], localDate(2026, 11, 5))
  assert.equal(id, 'M-20261105-001')
})

/* ------------------------------------------------------------------ *
 * C3 同日连续取号递增不重复
 * ------------------------------------------------------------------ */
test('C3 同日连取 3 次 → 001/002/003 递增不重复', () => {
  const now = localDate(2026, 11, 5)
  const ids = []
  for (let i = 0; i < 3; i++) {
    const next = nextId(ids, now)
    ids.push(next)
  }
  assert.deepEqual(ids, ['M-20261105-001', 'M-20261105-002', 'M-20261105-003'])
  assert.equal(new Set(ids).size, 3, '编号必须互不重复')
})

/* ------------------------------------------------------------------ *
 * C4 已有 007 → 取 008（扫全表当天最大 +1，不是按行数）
 * ------------------------------------------------------------------ */
test('C4 已有 M-20261105-007 → 下一个是 008（扫最大序号，不是数行数）', () => {
  const now = localDate(2026, 11, 5)
  const existing = ['M-20261105-001', 'M-20261105-007']
  assert.equal(nextId(existing, now), 'M-20261105-008')

  // 反证：若按"行数+1"实现会得到 003，这种实现是错的
  assert.notEqual(nextId(existing, now), 'M-20261105-003', '不得按行数取号')
})

/* ------------------------------------------------------------------ *
 * C5 混多天数据 → 只统计当天
 * ------------------------------------------------------------------ */
test('C5 库里混有多天数据 → 只按当天序号递增，不被别的日期影响', () => {
  const now = localDate(2026, 11, 5)
  const existing = [
    'M-20261103-009',
    'M-20261104-012',
    'M-20261105-002',
    'M-20261001-050',
  ]
  assert.equal(
    nextId(existing, now),
    'M-20261105-003',
    '只应看 20261105 这一天（最大 002）→ 003，不能被 04 天的 012 干扰',
  )
})

/* ------------------------------------------------------------------ *
 * C6 【核心反例】本地时间 vs UTC 跨零点错天
 *     2026-11-05T17:00:00Z 在 +08 已是 11-06 凌晨
 *     toISOString 会给出 20261105（错天），本地时间才是 20261106
 * ------------------------------------------------------------------ */
test('C6 本地时间不踩 UTC：17:00Z 在东八区已跨日 → 日期段必须是 20261106', () => {
  const now = new Date('2026-11-05T17:00:00Z')

  // 先确认测试机时区确实是 +08，否则这条断言的前提不成立
  const offsetMin = -now.getTimezoneOffset()
  assert.equal(
    offsetMin,
    480,
    `本用例依赖测试机时区为 +08:00（当前 ${offsetMin / 60}h）。这是环境前提，不是实现问题——` +
      '若换了机器/时区，此用例需要改为显式构造本地时间',
  )

  assert.equal(
    formatLocalDate(now),
    '20261106',
    '本地时间应是 11-06（UTC 17:00 = 次日 01:00）',
  )

  // 反证：toISOString 的错误结果
  const utcDate = now.toISOString().slice(0, 10).replace(/-/g, '')
  assert.equal(utcDate, '20261105', '（反证）toISOString 给出 20261105，这正是要避免的错天')

  const id = nextId([], now)
  assert.equal(id, 'M-20261106-001', `编号日期段必须用本地时间，实际「${id}」`)
  assert.notEqual(id.slice(2, 10), utcDate, '绝不能等于 UTC 日期')
})

/* ------------------------------------------------------------------ *
 * C7 锁内取号：并发写不撞号
 * ------------------------------------------------------------------ */
test('C7 withFileLock 内取号 → 并发两次写入不撞号、不丢行', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, '.lock')
    const idFile = join(dir, 'ids.txt')

    // 模拟"读表 → 取号 → 追加"的临界区
    const allocate = (existing, now) =>
      withFileLock(lockPath, async () => {
        // 临界区内：读当前已分配 → 取号 → 写回
        const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
        const raw = existsSync(idFile) ? readFileSync(idFile, 'utf8') : ''
        const ids = raw.split('\n').filter((s) => s !== '')
        const next = nextId(ids, now)
        writeFileSync(idFile, [...ids, next].join('\n'), 'utf8')
        // 故意留一点处理时间，放大并发窗口
        await new Promise((r) => setTimeout(r, 5))
        return next
      })

    const now = localDate(2026, 11, 5)
    const [a, b] = await Promise.all([allocate([], now), allocate([], now)])

    assert.notEqual(a, b, `并发取号撞号了：两个都是 ${a}`)
    assert.deepEqual([a, b].sort(), ['M-20261105-001', 'M-20261105-002'])

    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(idFile, 'utf8').split('\n').filter((s) => s !== '')
    assert.equal(lines.length, 2, `不得丢行，实际写入 ${lines.length} 条`)
    assert.equal(new Set(lines).size, 2, '不得有重复编号')
  })
})
