// 闸门③ 补：定时任务 unref（1 条，用「已过对照组」的判据）
//
// 背景（方法论，必须写清）：
//   host-dev 最初用 `process._getActiveHandles()` 过滤 `hasRef()` 来验 unref。
//   该判据经对照实验证明**无效**：Node v24.21.0 上 `_getActiveHandles()`
//   **根本不返回 Timeout 对象**（连明确 ref 的对照组也不返回），
//   所以"过滤后为空"恒成立 → **无论有没有 unref 都会通过**（恒绿假阳性）。
//
//   本项目做过对照实验确认有效判据：
//     ref()   → hasRef() === true
//     unref() → hasRef() === false
//     unref→ref / ref→unref 双向可逆均正确
//
//   因此本用例用两层证据：
//     ① 源码层：`.unref()` 是否作用于 `setInterval` 赋值的**同一个变量**
//     ② 运行时：抓住真实 timer 对象，直接问 `hasRef()`
//
// 纪律：验"某机制是否生效"前，先确认判据能区分"有"和"无"。
//       判据对反例也返回通过 → 该判据作废。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = readFileSync(join(process.cwd(), 'index.js'), 'utf8')

/** 造最小 ctx（与 _host-ctx.mjs 同构，但不预置 identity） */
function makeCtx() {
  const services = {}
  return {
    _services: services,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    effect(fn) {
      const r = typeof fn === 'function' ? fn() : undefined
      return typeof r === 'function' ? r : () => {}
    },
    on() {
      return () => {}
    },
    provide(n, v) {
      services[n] = v
      return () => {}
    },
    get(n) {
      return services[n]
    },
    __init() {
      services.sessionProjections = { stateOf: () => null, register: () => () => {} }
      return this
    },
  }
}

/* ------------------------------------------------------------------ *
 * 前置自检：确认 hasRef 判据本身有效（对照组）
 *   如果这条挂了，后面那条 unref 就不可信 —— 先证明尺子是准的
 * ------------------------------------------------------------------ */
test('前置：hasRef() 判据有效（ref→true / unref→false / 双向可逆）', () => {
  const cases = [
    { name: 'ref()', setup: (t) => t.ref(), expect: true },
    { name: 'unref()', setup: (t) => t.unref(), expect: false },
    { name: 'unref→ref', setup: (t) => { t.unref(); t.ref() }, expect: true },
    { name: 'ref→unref', setup: (t) => { t.ref(); t.unref() }, expect: false },
  ]

  for (const c of cases) {
    const t = setInterval(() => {}, 100000)
    try {
      c.setup(t)
      assert.equal(t.hasRef(), c.expect, `hasRef() 对「${c.name}」应为 ${c.expect}，实际 ${t.hasRef()}`)
    } finally {
      clearInterval(t)
    }
  }

  // 顺带固化 host-dev 的发现：该 API 不返回 Timeout，不可用作判据
  const t2 = setInterval(() => {}, 100000)
  try {
    t2.ref()
    const inHandles = process._getActiveHandles().includes(t2)
    assert.equal(
      inHandles,
      false,
      '_getActiveHandles() 在 Node v24 上不返回 Timeout —— 若此断言失败，说明该 API 行为变了，' +
        '那么"用它判空来证明 unref"仍然无效（ref 的 timer 也不在里面）',
    )
  } finally {
    clearInterval(t2)
  }
})

/* ------------------------------------------------------------------ *
 * 定时任务 unref：源码层 + 运行时 hasRef 双证据
 * ------------------------------------------------------------------ */
test('定时任务 setInterval 已 unref（源码层 + hasRef 直接探针）', async () => {
  // ① 源码层：.unref() 必须作用于 setInterval 赋值的同一个变量
  const lines = SRC.split('\n')
  let sourceOk = false
  let detail = ''

  for (let i = 0; i < lines.length; i++) {
    if (!/setInterval\s*\(/.test(lines[i])) continue
    const assign = /(\w+)\s*=\s*setInterval/.exec(lines[i])
    const varName = assign ? assign[1] : null
    const window = lines.slice(i, i + 8).join('\n')
    const unrefMatch = /(\w+)\s*\.unref\s*\(\s*\)/.exec(window)
    const unrefVar = unrefMatch ? unrefMatch[1] : null

    detail = `L${i + 1}: 赋值给 ${varName ?? '（未赋值）'}，unref 作用于 ${unrefVar ?? '（未找到）'}`
    if (varName && varName === unrefVar) sourceOk = true
  }

  assert.ok(sourceOk, `源码层未找到「setInterval 赋值变量 与 .unref() 是同一个」的证据。${detail}`)

  // ② 运行时：抓住真实 timer，直接问 hasRef()
  const real = globalThis.setInterval
  let captured = null
  globalThis.setInterval = function (...args) {
    const t = real.apply(this, args)
    captured = t
    return t
  }

  const dir = mkdtempSync(join(tmpdir(), 'qa-timer-'))
  let dispose = null
  try {
    const { apply } = await import('../../index.js')
    const ctx = makeCtx().__init()
    dispose = apply(ctx, { dataDir: dir, autoBackupIntervalHours: 1 })
  } finally {
    globalThis.setInterval = real // 立刻还原，避免污染其他用例
  }

  try {
    assert.ok(captured, '未能捕获到 setInterval 创建的 timer（定时任务可能未启用，需检查配置）')
    assert.equal(
      captured.hasRef(),
      false,
      `timer.hasRef() 应为 false（已 unref），实际 ${captured.hasRef()} —— refed timer 会阻止进程退出`,
    )
  } finally {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      /* 卸载期忽略 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * dispose 幂等
 * ------------------------------------------------------------------ */
test('dispose() 幂等：连续调用两次不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-timer3-'))
  try {
    const { apply } = await import('../../index.js')
    const ctx = makeCtx().__init()
    const dispose = apply(ctx, { dataDir: dir, autoBackupIntervalHours: 1 })

    assert.equal(typeof dispose, 'function', 'apply 必须返回 dispose 函数')
    assert.doesNotThrow(() => dispose(), '第一次 dispose() 不应抛错')
    assert.doesNotThrow(() => dispose(), '第二次 dispose() 不应抛错（卸载可能被调多次）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
