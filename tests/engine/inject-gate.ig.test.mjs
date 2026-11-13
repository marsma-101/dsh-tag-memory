// 闸门① IG 组：注入节流闸门（2026-11-13 框架级修复）
//
// 背景：用户反馈「有一条记忆每一轮都会自动传递」，要求从规则上避免
// 任何内容在同一会话被反复推送——不是关掉某条提醒。
// 根因：旧去重只比对「当前这一步的 messages 数组」，跨轮/跨步完全不设防。
// 本组守住三道闸：① 同轮不重投 ② 会话配额 ③ 退避间隔。
// 负对照：每道闸都要有「被挡住」的用例，否则守卫可能根本没生效。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_INJECTION_POLICY,
  injectionKey,
  createInjectionLedger,
  claimInjection,
  injectionStats,
} from '../../lib/engine/inject-gate.mjs'

const T = '这一轮还没写记忆。若有该记的规矩/决定/坑，先调 dtm_write 再继续。'

/* ------------------------------------------------------------------ *
 * IG1 指纹归一：同一句话不因空白差异被当成两条
 * ------------------------------------------------------------------ */
test('IG1 injectionKey 归一空白，但不做语义归一', () => {
  assert.equal(injectionKey('  a  b \n c '), 'a b c')
  assert.equal(injectionKey('a b'), injectionKey('a\nb'), '换行与空格等价')
  assert.notEqual(injectionKey('a b'), injectionKey('a c'), '不同内容不得合并（程序不判语义）')
  assert.equal(injectionKey(null), '')
  assert.equal(injectionKey(undefined), '')
})

/* ------------------------------------------------------------------ *
 * IG2 首次投递放行，且真的记账
 * ------------------------------------------------------------------ */
test('IG2 首次 claim 放行并记账（判定+记账一步完成）', () => {
  const l = createInjectionLedger()
  const r = claimInjection(l, T, { turn: 1 })
  assert.equal(r.allowed, true)
  assert.equal(r.reason, 'OK')
  assert.equal(r.deliveries, 1)
  assert.deepEqual(injectionStats(l, T), { deliveries: 1, lastTurn: 1 })
})

/* ------------------------------------------------------------------ *
 * IG3 【闸①负对照】同一轮内重复投递必须被挡
 * ------------------------------------------------------------------ */
test('IG3 同一 turn 内第二次 claim 被挡（SAME_TURN）', () => {
  const l = createInjectionLedger()
  assert.equal(claimInjection(l, T, { turn: 5 }).allowed, true)
  const again = claimInjection(l, T, { turn: 5 })
  assert.equal(again.allowed, false, '同轮重投必须静默')
  assert.equal(again.reason, 'SAME_TURN')
  assert.equal(injectionStats(l, T).deliveries, 1, '被挡的不得计数')
})

test('IG3b 轮号缺失（undefined）按同一未知轮处理，只许一次', () => {
  const l = createInjectionLedger()
  assert.equal(claimInjection(l, T, {}).allowed, true)
  assert.equal(claimInjection(l, T, {}).allowed, false, '判不了轮号宁可静默，不刷屏')
})

/* ------------------------------------------------------------------ *
 * IG4 【闸③负对照】跨轮太近被挡；够间隔才放行
 * ------------------------------------------------------------------ */
test('IG4 默认 minTurnGap=1：相邻轮被挡，隔一轮放行', () => {
  const l = createInjectionLedger()
  assert.equal(claimInjection(l, T, { turn: 1 }).allowed, true)
  const tooSoon = claimInjection(l, T, { turn: 2 })
  // 默认 backoffFactor=2，第 1 次投递后要求 1*2^0=1 轮 → turn2 距 turn1 恰好 1，放行
  assert.equal(tooSoon.allowed, true, '间隔恰好达标应放行')
  assert.equal(tooSoon.deliveries, 2)
})

test('IG4b minTurnGap=3：隔 1~2 轮被挡，隔 3 轮放行', () => {
  const l = createInjectionLedger()
  const policy = { minTurnGap: 3, backoffFactor: 1, maxPerSession: 5 }
  assert.equal(claimInjection(l, T, { turn: 1, policy }).allowed, true)
  assert.equal(claimInjection(l, T, { turn: 2, policy }).reason, 'TOO_SOON')
  assert.equal(claimInjection(l, T, { turn: 3, policy }).reason, 'TOO_SOON')
  assert.equal(claimInjection(l, T, { turn: 4, policy }).allowed, true, '隔满 3 轮才放行')
})

test('IG4c 退避翻倍：第 2 次投递后要求的间隔加倍', () => {
  const l = createInjectionLedger()
  const policy = { minTurnGap: 1, backoffFactor: 2, maxPerSession: 5 }
  assert.equal(claimInjection(l, T, { turn: 1, policy }).allowed, true)   // 第1次
  assert.equal(claimInjection(l, T, { turn: 2, policy }).allowed, true)   // 第2次（需1轮）
  assert.equal(claimInjection(l, T, { turn: 3, policy }).reason, 'TOO_SOON') // 需2轮
  assert.equal(claimInjection(l, T, { turn: 4, policy }).allowed, true)   // 第3次（需2轮）
})

/* ------------------------------------------------------------------ *
 * IG5 【闸②负对照】会话配额用尽 → 永久静默（本次事故的正解）
 * ------------------------------------------------------------------ */
test('IG5 默认 maxPerSession=2：第 3 次起永久静默，哪怕隔很多轮', () => {
  const l = createInjectionLedger()
  assert.equal(claimInjection(l, T, { turn: 1 }).allowed, true)
  assert.equal(claimInjection(l, T, { turn: 3 }).allowed, true)
  for (const turn of [5, 10, 50, 1000]) {
    const r = claimInjection(l, T, { turn })
    assert.equal(r.allowed, false, `turn=${turn} 配额已用尽必须静默`)
    assert.equal(r.reason, 'SESSION_QUOTA')
  }
  assert.equal(injectionStats(l, T).deliveries, 2, '静默的不得计数')
})

test('IG5b maxPerSession=1：一个会话只送一次（最严）', () => {
  const l = createInjectionLedger()
  const policy = { maxPerSession: 1 }
  assert.equal(claimInjection(l, T, { turn: 1, policy }).allowed, true)
  assert.equal(claimInjection(l, T, { turn: 99, policy }).reason, 'SESSION_QUOTA')
})

/* ------------------------------------------------------------------ *
 * IG6 不同内容各自计数（闸门不是「全局只许一条」）
 * ------------------------------------------------------------------ */
test('IG6 不同内容互不影响，各自独立配额', () => {
  const l = createInjectionLedger()
  assert.equal(claimInjection(l, '内容A', { turn: 1 }).allowed, true)
  assert.equal(claimInjection(l, '内容B', { turn: 1 }).allowed, true, '另一条内容同轮也可送')
  assert.equal(claimInjection(l, '内容A', { turn: 1 }).allowed, false, 'A 同轮不得重投')
  assert.equal(injectionStats(l, '内容A').deliveries, 1)
  assert.equal(injectionStats(l, '内容B').deliveries, 1)
})

/* ------------------------------------------------------------------ *
 * IG7 台账隔离：两个会话各持一个台账，互不影响
 * ------------------------------------------------------------------ */
test('IG7 不同台账（不同会话）互不影响', () => {
  const a = createInjectionLedger()
  const b = createInjectionLedger()
  const policy = { maxPerSession: 1 }
  assert.equal(claimInjection(a, T, { turn: 1, policy }).allowed, true)
  assert.equal(claimInjection(b, T, { turn: 1, policy }).allowed, true, '另一会话不受影响')
})

/* ------------------------------------------------------------------ *
 * IG8 边界：空内容/坏台账/非法策略一律安全（宁可少送不失控）
 * ------------------------------------------------------------------ */
test('IG8 空内容与坏台账不投递、不抛错', () => {
  const l = createInjectionLedger()
  assert.equal(claimInjection(l, '', { turn: 1 }).reason, 'EMPTY_KEY')
  assert.equal(claimInjection(l, '   ', { turn: 1 }).reason, 'EMPTY_KEY')
  assert.equal(claimInjection(null, T, { turn: 1 }).allowed, false)
  assert.equal(claimInjection({}, T, { turn: 1 }).allowed, false)
  assert.doesNotThrow(() => claimInjection(l, T, { turn: NaN }))
})

test('IG8b 非法策略回落默认（配置写错不该让注入失控）', () => {
  const l = createInjectionLedger()
  const bad = { maxPerSession: -5, minTurnGap: 'abc', backoffFactor: 0 }
  assert.equal(claimInjection(l, T, { turn: 1, policy: bad }).allowed, true)
  assert.equal(claimInjection(l, T, { turn: 3, policy: bad }).allowed, true)
  // 回落到默认 maxPerSession=2 → 第 3 次必须挡
  assert.equal(claimInjection(l, T, { turn: 9, policy: bad }).reason, 'SESSION_QUOTA')
})

test('IG9 默认策略是冻结常量，且配额>=1（不可被改成永不投递的死值）', () => {
  assert.ok(Object.isFrozen(DEFAULT_INJECTION_POLICY))
  assert.ok(DEFAULT_INJECTION_POLICY.maxPerSession >= 1)
  assert.ok(DEFAULT_INJECTION_POLICY.minTurnGap >= 0)
  assert.ok(DEFAULT_INJECTION_POLICY.backoffFactor >= 1)
})
