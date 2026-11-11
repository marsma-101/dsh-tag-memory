/**
 * reminder.test.mjs — §4.7 轮级「漏记提醒」验收
 *
 * 依据：《改进与迭代方向-2026-11-11.md》§4.7 验收 5 条 + 旧版 _work_preset.js
 * L1055-1137 逐条对齐（去重 / 插入位置 / 异常放行 / 可关闭 / 只判写没写过）。
 *
 * 测试分两层：
 *   A. 纯函数层（shouldRemind / insertReminder / sameMessage）——脱离框架；
 *   B. 事件接线层——用假 ctx 造一轮 pre-step / tools/result，直接调收集到的
 *      回调，验「提醒出现且只一次 / 写过了不提醒 / 闲聊不提醒 / 异常放行」。
 *      注意：假 ctx 不模拟 waterfall/emit 的真实派发（那是 LIMITS.md 的框架盲区），
 *      这里验的是「回调收到了正确形状的输入会做正确的事」。
 *
 * 另有一组静态断言：**断言轮级触发存在**（不能只断言判据文本存在，§2.4 教训）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

import { createFakeCtx } from '../_fake-ctx.mjs';
import { apply as applyPreset } from '../../preset/index.js';
import {
  WRITE_TOOLS,
  REMINDER_TEXT,
  isReminderEnabled,
  createReminderMessage,
  sameMessage,
  shouldRemind,
  insertReminder,
  installWriteReminder,
} from '../../preset/reminder.js';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ================================================================== *
 * A. 纯函数层
 * ================================================================== */

test('R1 写工具集合是 1.x 命名，且不含读取/整理工具', () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), ['dtm_supersede', 'dtm_write'])
  assert.equal(WRITE_TOOLS.has('dtm_recall'), false, '读取不算「写过」')
  assert.equal(WRITE_TOOLS.has('dtm_retag'), false, '整理改标签不算「写过」')
})

test('R2 shouldRemind：step>=2 + 见过真实 user + 没写过 + 没提醒过 才提醒', () => {
  assert.equal(shouldRemind({ step: 2, sawUser: true, wrote: false, reminded: false }), true)
  assert.equal(shouldRemind({ step: 1, sawUser: true, wrote: false, reminded: false }), false, '第一步不判')
  assert.equal(shouldRemind({ step: 2, sawUser: false, wrote: false, reminded: false }), false, '没见过真实 user（纯工具续跑）不提醒')
  assert.equal(shouldRemind({ step: 2, sawUser: true, wrote: true, reminded: false }), false, '写过了不提醒（不误报）')
  assert.equal(shouldRemind({ step: 2, sawUser: true, wrote: false, reminded: true }), false, '每轮最多一次')
  assert.equal(shouldRemind({ step: undefined, sawUser: true, wrote: false, reminded: false }), false, 'step 异常一律不提醒（宁可少提醒）')
})

test('R3 提醒文本只问「写没写过」，不分类用户输入内容', () => {
  // 旧版原则 1：绝不判内容。文案里不得出现任何「规矩/闲聊/关键词」的分类触发词，
  // 程序侧也没有按用户消息做正则/关键词分类（见 installWriteReminder 源码）。
  assert.ok(REMINDER_TEXT.includes('还没写记忆'))
  assert.ok(REMINDER_TEXT.includes('dtm_write') && REMINDER_TEXT.includes('dtm_supersede'))
  // 「只是闲聊就忽略」是给模型的退出口，不是程序分类条件 —— 程序不看用户消息内容。
  const src = fs.readFileSync(path.join(PACKAGE_DIR, 'preset', 'reminder.js'), 'utf8')
  assert.equal(/\.match\(|test\(|includes\(['"]规矩|includes\(['"]闲聊/.test(src), false,
    '程序里不得出现按用户消息内容做分类的代码')
})

test('R4 createReminderMessage 形状是 UserMessage（source.kind 为插件自有名）', () => {
  const m = createReminderMessage()
  assert.equal(m.role, 'user')
  assert.ok(typeof m.id === 'string' && m.id.length > 0)
  assert.deepEqual(m.content[0].type, 'text')
  assert.equal(m.source.kind, 'tag-memory', '不能用 runtime-context（会被 loop 快照顶掉）')
  assert.ok(m.content[0].text.includes('dtm_write'))
})

test('R5 sameMessage 按 content+source 深度比较（官方 sameContextPayload 口径）', () => {
  const a = createReminderMessage('固定文案')
  const b = createReminderMessage('固定文案')
  assert.equal(sameMessage(a, b), true, 'id 不同但 content+source 相同 → 视为同一条提醒')
  assert.equal(sameMessage(a, createReminderMessage('别的文案')), false)
  assert.equal(sameMessage(a, null), false, '脏输入不抛错')
})

test('R6 insertReminder 插在已认领消息之后，且去重', () => {
  const claimed = [{ id: 'u1' }, { id: 'u2' }]
  const ctxMsg = { id: 'ctx' } // 官方 context 快照，排在 claimed 之后
  const decision = [...claimed, ctxMsg]
  const desired = createReminderMessage('固定文案')

  const entered = insertReminder(decision, claimed, desired)
  assert.equal(entered.length, 4)
  assert.equal(entered[2], desired, '应插在最后一条 claimed（u2）之后、context 之前')
  assert.equal(entered[3], ctxMsg)

  // 同一条提醒已在 decision 里 → 不重复插入
  assert.equal(insertReminder([...decision, desired], claimed, desired).length, 4)

  // claimed 为空（step>=2 常见）→ 插到最前
  assert.equal(insertReminder([ctxMsg], [], desired)[0], desired)
  assert.equal(decision.length, 3, '不得原地改入参数组（waterfall 用返回值）')
})

test('R7 可关闭：reminderEnabled === false 时不启用', () => {
  assert.equal(isReminderEnabled({}), true)
  assert.equal(isReminderEnabled({ reminderEnabled: true }), true)
  assert.equal(isReminderEnabled({ reminderEnabled: false }), false)
})

/* ================================================================== *
 * B. 静态：断言「轮级触发存在」（§2.4 回归教训）
 * ================================================================== */

test('R8 【关键】apply 必须挂 agent/pre-step 与 tools/result 两个轮级钩子', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  const events = ctx.__listeners.map((l) => l.event)
  assert.ok(events.includes('agent/pre-step'), `缺 agent/pre-step 钩子，实际只有 ${JSON.stringify(events)}`)
  assert.ok(events.includes('tools/result'), `缺 tools/result 钩子，实际只有 ${JSON.stringify(events)}`)

  // 不能只挂一个：少一个就不是完整的「观察写没写过 + 轮级检查」链路
  const src = fs.readFileSync(path.join(PACKAGE_DIR, 'preset', 'index.js'), 'utf8')
  assert.ok(src.includes('installWriteReminder'), 'preset/index.js 必须真的调用注册器')
  const rsrc = fs.readFileSync(path.join(PACKAGE_DIR, 'preset', 'reminder.js'), 'utf8')
  assert.ok(rsrc.includes("ctx.on('agent/pre-step'") || rsrc.includes('on(\'agent/pre-step\''), 'reminder.js 必须订阅 pre-step')
  assert.ok(rsrc.includes("ctx.on('tools/result'") || rsrc.includes('on(\'tools/result\''), 'reminder.js 必须订阅 tools/result')
})

test('R9 关闭时两个钩子都不注册', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, { reminderEnabled: false })
  const events = ctx.__listeners.map((l) => l.event)
  assert.equal(events.includes('agent/pre-step'), false)
  assert.equal(events.includes('tools/result'), false)
})

test('R10 新增钩子不破坏既有结构：仍是 10 工具 / 1 section / 1 context', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  assert.equal(ctx.__tools.length, 10)
  assert.equal(ctx.__sections.length, 1)
  assert.equal(ctx.__contexts.length, 1)
})

/* ================================================================== *
 * C. 事件接线层：直接调收集到的回调，模拟一轮
 * ================================================================== */

/** 用收集到的 listeners 造一个最小「事件驱动器」。 */
function driver(ctx) {
  const byEvent = (e) => ctx.__listeners.filter((l) => l.event === e).map((l) => l.fn)
  const emitToolsResult = (exec, result) => {
    for (const fn of byEvent('tools/result')) fn(exec, result)
  }
  const preStep = async (payload) => {
    // 模拟 waterfall：从后往前串，最后一个 next 给默认 enter 决策。
    const fns = byEvent('agent/pre-step')
    let i = fns.length - 1
    const next = async () => ({ kind: 'enter', messages: Array.isArray(payload.messages) ? [...payload.messages] : [] })
    const chain = async (idx) => {
      if (idx < 0) return next()
      return fns[idx](payload, () => chain(idx - 1))
    }
    return chain(i)
  }
  return { emitToolsResult, preStep }
}

const userMsg = () => ({ id: 'u1', role: 'user', content: [{ type: 'text', text: '以后仓库一律不许改生产端' }], source: { kind: 'user' } })
const toolMsg = () => ({ id: 't1', role: 'user', content: [{ type: 'text', text: '工具结果' }], source: { kind: 'tool' } })

test('R11 验收①：用户下达明确规矩但未写 → 提醒出现，且只出现一次', async () => {
  const ctx = createFakeCtx()
  const agent = { id: 'a1' }
  installWriteReminder(ctx)
  const d = driver(ctx)

  // step 1：用户发起（只重置状态，不提醒）
  const r1 = await d.preStep({ agent, messages: [userMsg()], turn: 7, step: 1, signal: undefined })
  assert.equal(r1.messages.some((m) => m?.source?.kind === 'tag-memory'), false, '第一步不提醒')

  // step 2：没写过 → 提醒一次
  const r2 = await d.preStep({ agent, messages: [], turn: 7, step: 2, signal: undefined })
  const reminders2 = r2.messages.filter((m) => m?.source?.kind === 'tag-memory')
  assert.equal(reminders2.length, 1, 'step>=2 未写 → 必须提醒一次')
  assert.ok(reminders2[0].content[0].text.includes('dtm_write'))

  // step 3：同一轮再检查 → 不重复（reminded 一次性）
  const r3 = await d.preStep({ agent, messages: [], turn: 7, step: 3, signal: undefined })
  assert.equal(r3.messages.filter((m) => m?.source?.kind === 'tag-memory').length, 0, '每轮最多一次')

  // 换了新 turn → 重新有资格
  const r4 = await d.preStep({ agent, messages: [userMsg()], turn: 8, step: 1, signal: undefined })
  assert.equal(r4.messages.some((m) => m?.source?.kind === 'tag-memory'), false)
  const r5 = await d.preStep({ agent, messages: [], turn: 8, step: 2, signal: undefined })
  assert.equal(r5.messages.filter((m) => m?.source?.kind === 'tag-memory').length, 1, '新一轮重新可提醒')
})

test('R12 验收②：已调 dtm_write → 不提醒（不误报）', async () => {
  const ctx = createFakeCtx()
  const agent = { id: 'a2' }
  installWriteReminder(ctx)
  const d = driver(ctx)

  await d.preStep({ agent, messages: [userMsg()], turn: 1, step: 1 })
  d.emitToolsResult({ name: 'dtm_write', agent }, { isError: false })
  const r = await d.preStep({ agent, messages: [], turn: 1, step: 2 })
  assert.equal(r.messages.filter((m) => m?.source?.kind === 'tag-memory').length, 0, '写过了不该再提醒')
})

test('R12b dtm_supersede 也算写过；dtm_recall / dtm_retag 不算', async () => {
  for (const [name, expectWrote] of [
    ['dtm_supersede', true], ['dtm_write', true], ['dtm_recall', false], ['dtm_retag', false],
  ]) {
    const ctx = createFakeCtx()
    const agent = { id: `a-${name}` }
    installWriteReminder(ctx)
    const d = driver(ctx)
    await d.preStep({ agent, messages: [userMsg()], turn: 1, step: 1 })
    d.emitToolsResult({ name, agent }, { isError: false })
    const r = await d.preStep({ agent, messages: [], turn: 1, step: 2 })
    const n = r.messages.filter((m) => m?.source?.kind === 'tag-memory').length
    assert.equal(n, expectWrote ? 0 : 1, `${name}: ${expectWrote ? '算写过不该提醒' : '不算写过应提醒'}`)
  }
})

test('R13 验收③：纯闲聊/一次性提问（没见过真实 user 源）→ 不刷屏', async () => {
  const ctx = createFakeCtx()
  const agent = { id: 'a3' }
  installWriteReminder(ctx)
  const d = driver(ctx)

  // 第一步只有工具消息，没有 source.kind==='user'
  await d.preStep({ agent, messages: [toolMsg()], turn: 1, step: 1 })
  const r = await d.preStep({ agent, messages: [], turn: 1, step: 2 })
  assert.equal(r.messages.filter((m) => m?.source?.kind === 'tag-memory').length, 0,
    '本轮没见过真实 user 消息（如定时/工具续跑）不提醒')
})

test('R14 验收⑤：异常一律放行，不卡住对话；next() 的异常不被吞', async () => {
  // a) 我们自己逻辑抛错（例如 decision.messages 是坏值）→ 原样返回 decision
  const ctx = createFakeCtx()
  const agent = { id: 'a4' }
  installWriteReminder(ctx)
  const fns = ctx.__listeners.filter((l) => l.event === 'agent/pre-step').map((l) => l.fn)
  assert.ok(fns.length > 0)
  const decision = { kind: 'enter', messages: null } // 坏值，会触发 catch
  const got = await fns[0]({ agent, messages: [userMsg()], turn: 1, step: 1 }, async () => decision)
  assert.equal(got, decision, '任何异常都必须原样放行')

  // b) next() 抛错 → 必须冒泡（不能被我们的 try 吞掉）
  const boom = new Error('上游决策失败')
  await assert.rejects(
    () => fns[0]({ agent, messages: [], turn: 1, step: 2 }, async () => { throw boom }),
    (e) => e === boom,
  )
})

test('R15 官方契约对齐：返回值 spread 保住 startsRequestSeries，且插入用 toSpliced 语义', async () => {
  const ctx = createFakeCtx()
  const agent = { id: 'a5' }
  installWriteReminder(ctx)
  const d = driver(ctx)
  await d.preStep({ agent, messages: [userMsg()], turn: 1, step: 1 })

  // 模拟官方 decision 带 startsRequestSeries + 尾部 context 快照
  const claimed = [userMsg()]
  const snap = { id: 'snap', source: { kind: 'runtime-context' } }
  const fns = ctx.__listeners.filter((l) => l.event === 'agent/pre-step').map((l) => l.fn)
  const decision = { kind: 'enter', messages: [...claimed, snap], startsRequestSeries: true }
  const out = await fns[0]({ agent, messages: claimed, turn: 1, step: 2 }, async () => decision)
  assert.equal(out.startsRequestSeries, true, '必须 spread，不能丢官方字段')
  assert.equal(out.messages.length, 3)
  assert.equal(out.messages[1].source.kind, 'tag-memory', '提醒插在已认领消息之后')
  assert.equal(out.messages[2], snap, 'context 快照仍留在最后')
  assert.equal(decision.messages.length, 2, '不得原地改入参')
})

test('R16 §4.7 配套：答复前自问在 identity context 里，不进 section（KV cache）', async () => {
  const { renderInjection, renderIdentityContext } = await import(
    pathToFileURL(path.join(PACKAGE_DIR, 'preset', 'prompt.js')).href
  )
  const section = renderInjection({})
  const identity = renderIdentityContext({ bound: true, who: '萧潇', project: 'dsh-tag-memory' })
  assert.ok(identity.includes('答复前自问'), '自检句要在身份 context 里')
  assert.ok(identity.includes('dtm_write') && identity.includes('dtm_recall'))
  assert.equal(section.includes('答复前自问'), false, '绝不能进 section（会毁 KV cache 前缀、撑破 6000 字节）')
})
