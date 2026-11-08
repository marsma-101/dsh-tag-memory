// 闸门② L 组：每轮提示注入（固定 section + 动态 context）
//
// 依据：《标签字典》「注入边界（硬约束）」、《功能说明》§十四「插件层」、
//       《架构说明》§4.1、《探明结论》§2（interpolate:false）、
//       dsh-system-prompt 的 PromptSection / PromptContext 契约。
//
// Q1 裁定（Lead 定死，三条同时满足才算过）：
//   ① UTF-8 字节 ≤ 6000
//   ② 行数 ≤ 130
//   ③ 含全部 10 个 dtm_* + 6 个形态值
//
// 2026-11-08 架构调整（KV cache 硬约束）：
//   身份从 section 挪到 context。理由：section 进系统提示词前缀，内容一变
//   其后所有缓存全废（工具定义 + 历史）。身份每轮都会变，只能放 context——
//   官方定义为 "durable user-role snapshot"，按 order 进历史、以 user 角色追加。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFakeCtx } from '../_fake-ctx.mjs'
import { apply as applyPreset } from '../../preset/index.js'
import {
  renderInjection,
  renderIdentityContext,
  SECTION_NAME,
  SECTION_ORDER,
  IDENTITY_CONTEXT_NAME,
  IDENTITY_CONTEXT_ORDER,
  missingToolNames,
  TOOL_WHENS,
} from '../../preset/prompt.js'

const SPEC_TOOLS = [
  'dtm_bind', 'dtm_write', 'dtm_recall', 'dtm_supersede', 'dtm_archive',
  'dtm_retag', 'dtm_review', 'dtm_records', 'dtm_export', 'dtm_merge',
]
const SHAPES = ['技能', '流程', '规则', '偏好', '事实', '模板']

/** Q1 的三条阈值（Lead 拍板，改需经 Lead） */
const Q1 = { maxBytes: 6000, maxLines: 130, toolCount: 10, shapeCount: 6 }

/** 取出注册进 systemPrompt.section 的固定判据文本 */
function registeredSection(ctx) {
  assert.equal(ctx.__sections.length, 1, '必须注册恰好 1 段固定注入（section）')
  const section = ctx.__sections[0]
  const text = typeof section.text === 'function' ? section.text({ agent: null }) : section.text
  return { section, text }
}

/** 取出注册进 systemPrompt.context 的动态身份文本 */
function registeredContext(ctx, agent = null) {
  assert.equal(ctx.__contexts.length, 1, '必须注册恰好 1 段动态身份（context）')
  const c = ctx.__contexts[0]
  const text = typeof c.text === 'function' ? c.text({ agent }) : c.text
  return { context: c, text }
}

/* ------------------------------------------------------------------ *
 * L1 十入口一个不缺
 * ------------------------------------------------------------------ */
test('L1 注入文本含全部 10 个 dtm_* 工具名（一个不缺）', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  const { text } = registeredSection(ctx)

  const missing = SPEC_TOOLS.filter((t) => !text.includes(t))
  assert.deepEqual(missing, [], `注入文本缺少工具入口：${missing.join(', ')}`)

  // 反向：不得多出规格外的 dtm_ 工具名（避免入口表漂移）
  const found = [...text.matchAll(/\bdtm_[a-z0-9_]+/g)].map((m) => m[0])
  const extra = [...new Set(found)].filter((t) => !SPEC_TOOLS.includes(t))
  assert.deepEqual(extra, [], `注入里出现规格外工具名：${extra.join(', ')}`)

  // 与 prompt.js 自带的自检函数交叉验证
  assert.deepEqual(missingToolNames(text), [], 'missingToolNames 应报告无缺失')
})

/* ------------------------------------------------------------------ *
 * L2 六形态值齐全
 * ------------------------------------------------------------------ */
test('L2 注入文本含 6 个形态合法值', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  const { text } = registeredSection(ctx)

  for (const shape of SHAPES) {
    assert.ok(text.includes(shape), `注入文本缺少形态值「${shape}」`)
  }
})

/* ------------------------------------------------------------------ *
 * L3 身份状态段（现在在 context 里）
 * ------------------------------------------------------------------ */
test('L3 身份段走 context：未绑定提示问用户，已绑定显示身份名', () => {
  const unbound = renderIdentityContext({ bound: false })
  assert.ok(unbound.includes('未绑定'), '未绑定时必须标出「未绑定」')
  assert.ok(
    unbound.includes('问用户') || unbound.includes('先问') || unbound.includes('dtm_bind'),
    '未绑定时必须提示去问用户 / 调 dtm_bind',
  )
  // 未绑定必须明确"写入被拒、读取返空"
  assert.ok(unbound.includes('拒') && unbound.includes('空'), '未绑定段必须说明写入会被拒、召回返回空')

  const bound = renderIdentityContext({ bound: true, who: '罗桥', project: 'P' })
  assert.ok(bound.includes('罗桥'), '已绑定时应显示身份名「罗桥」')
  assert.ok(bound.includes('P'), '已绑定时应显示项目名')

  // 拿不到会话 → 必须当成未绑定，不得抛错（官方：assembly 没有 agent 是常态）
  assert.doesNotThrow(() => renderIdentityContext({ bound: false }))
  assert.doesNotThrow(() => renderIdentityContext({}))
  assert.doesNotThrow(() => renderIdentityContext())
})

/* ------------------------------------------------------------------ *
 * L3b 【KV cache】固定段必须与身份无关
 * ------------------------------------------------------------------ */
test('L3b 【KV cache】section 文本必须与身份无关（绑没绑都要字节相同）', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})

  const a = registeredSection(ctx).text
  const b = registeredSection(ctx).text

  // 同一个 provider 反复求值必须字节相同 —— 否则每轮都在重建缓存前缀
  assert.equal(a, b, 'section 文本两次求值必须完全一致（缓存前缀不能每轮变）')

  // 且不得包含任何**身份状态**文案：身份属于 context，不属于 section。
  // 注意：不能查「未绑定」这个词——工具表里
  // `dtm_bind | 会话开始未绑定身份时…` 是对工具用途的描述，属正常文案。
  // 所以只查真正的状态标题与状态字段。
  for (const word of ['### 身份：', '当前身份：', '当前项目：', '记忆身份']) {
    assert.ok(!a.includes(word), `section 里不得出现身份状态文案「${word}」——它属于 context`)
  }
})

/* ------------------------------------------------------------------ *
 * L3c 【KV cache】context 的 order 必须晚于 section
 * ------------------------------------------------------------------ */
test('L3c context 与 section 的 name/order 各自唯一且互不冲突', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})

  const { section } = registeredSection(ctx)
  const { context } = registeredContext(ctx)

  assert.equal(section.name, SECTION_NAME)
  assert.equal(section.order, SECTION_ORDER)
  assert.equal(context.name, IDENTITY_CONTEXT_NAME)
  assert.equal(context.order, IDENTITY_CONTEXT_ORDER)

  // name 不得撞车
  assert.notEqual(SECTION_NAME, IDENTITY_CONTEXT_NAME, 'section 与 context 的 name 不能相同')

  // 两者都是有限数字
  assert.ok(Number.isFinite(SECTION_ORDER), 'section order 必须是有限数字')
  assert.ok(Number.isFinite(IDENTITY_CONTEXT_ORDER), 'context order 必须是有限数字')

  // 身份必须晚于第一方 TEAM_IDENTITY(125)、早于 HARNESS_SOURCE(200)
  assert.ok(IDENTITY_CONTEXT_ORDER > 125, '身份 context 应排在 TEAM_IDENTITY(125) 之后')
  assert.ok(IDENTITY_CONTEXT_ORDER < 200, '身份 context 应排在 HARNESS_SOURCE(200) 之前')
})

/* ------------------------------------------------------------------ *
 * L4 【Q1 裁定】精简度：三条同时满足
 * ------------------------------------------------------------------ */
test('L4 【Q1】精简度三条同时满足：≤6000 字节 + ≤130 行 + 含 10 入口与 6 形态', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  const text = registeredSection(ctx).text

  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = text.split('\n').length

  // ① 字节数
  assert.ok(
    bytes <= Q1.maxBytes,
    `【Q1-①】UTF-8 字节数 ${bytes} 超过上限 ${Q1.maxBytes} → 疑似不精简，不通过`,
  )

  // ② 行数
  assert.ok(
    lines <= Q1.maxLines,
    `【Q1-②】行数 ${lines} 超过上限 ${Q1.maxLines} → 疑似不精简，不通过`,
  )

  // ③ 入口与形态齐全
  const missingTools = SPEC_TOOLS.filter((t) => !text.includes(t))
  assert.deepEqual(missingTools, [], `【Q1-③】缺少工具入口：${missingTools.join(', ')}`)
  const missingShapes = SHAPES.filter((s) => !text.includes(s))
  assert.deepEqual(missingShapes, [], `【Q1-③】缺少形态值：${missingShapes.join(', ')}`)

  // 实测数值一并报出，便于日后调阈值时有据可依
  console.log(`\n[L4 实测] bytes=${bytes}/${Q1.maxBytes}  lines=${lines}/${Q1.maxLines}  tools=${Q1.toolCount}  shapes=${Q1.shapeCount}\n`)
})

/* ------------------------------------------------------------------ *
 * L4b 写入判据必须存在（v0.3.7 的 writeRoutes 补回）
 * ------------------------------------------------------------------ */
test('L4b 注入含「什么情况该写」判据，且覆盖规矩/决策/踩坑/不写', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  const text = registeredSection(ctx).text

  assert.ok(text.includes('什么情况该写'), '注入必须含写入判据段（v0.3.7 的 writeRoutes）')

  // 四类关键判据一个不能少
  for (const kw of ['规矩', '决策', '踩坑', '不写']) {
    assert.ok(text.includes(kw), `写入判据缺少「${kw}」这一类`)
  }

  // 字段标准与被拒处理也必须在（模型被拒后要知道回哪儿查）
  assert.ok(text.includes('字段标准'), '注入必须含字段标准表')
  assert.ok(text.includes('被拒了怎么办'), '注入必须含「被拒了怎么办」的纠正闭环')
})

/* ------------------------------------------------------------------ *
 * L5 不得含实现细节（阈值推导 / 匹配原理 / 状态机细节）
 * ------------------------------------------------------------------ */
test('L5 注入不得含阈值推导/匹配原理/状态机细节', () => {
  const text = renderInjection({})

  const FORBIDDEN = [
    'log2', 'e_ratio', 'q_ratio', 'ENTRY_RATIO', 'QUERY_FLOOR',
    'tickCap', 'tickMaxScore', 'passLine', '及格线', '权重', '状态机',
    '0.15', '0.5', '50 分', '40 分', '百分制',
  ]

  const hits = FORBIDDEN.filter((w) => text.includes(w))
  assert.deepEqual(
    hits,
    [],
    `注入文本不得含实现细节（应留在 templates/ 与流程文档），命中：${hits.join(', ')}`,
  )
})

/* ------------------------------------------------------------------ *
 * L6 interpolate:false（含 {{ }} 时必须）
 * ------------------------------------------------------------------ */
test('L6 section 与 context 都必须 interpolate:false', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})

  const { section, text } = registeredSection(ctx)
  const { context, text: ctxText } = registeredContext(ctx)

  // 含花括号时是硬性要求；不含时显式写 false 更稳（防日后文案改动踩坑）
  const hasBraces = text.includes('{{') || text.includes('}}') || /\{[^}]*\}/.test(text)
  assert.equal(
    section.interpolate,
    false,
    hasBraces
      ? '注入文本含花括号，必须设 interpolate:false（否则整个 assembly 抛错）'
      : '建议显式 interpolate:false（防御性）',
  )

  const ctxHasBraces = ctxText.includes('{{') || ctxText.includes('}}') || /\{[^}]*\}/.test(ctxText)
  assert.equal(
    context.interpolate,
    false,
    ctxHasBraces ? '身份文本含花括号，必须 interpolate:false' : '建议显式 interpolate:false（防御性）',
  )
})

/* ------------------------------------------------------------------ *
 * L7 同一 name 只注册一次 + name/order 合理
 * ------------------------------------------------------------------ */
test('L7 注入段 name 唯一、order 与其他插件不冲突（同 name 重复注册会覆盖）', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})

  const names = [...ctx.__sections.map((s) => s.name), ...ctx.__contexts.map((c) => c.name)]
  assert.equal(new Set(names).size, names.length, `注入段 name 不得重复，实际：${names.join(', ')}`)

  assert.ok(SECTION_NAME.includes('dsh-tag-memory'), `name 应带包名便于诊断，实际「${SECTION_NAME}」`)

  // TOOL_WHENS 必须覆盖 10 个（字典里"各一行"的数据来源）
  assert.equal(TOOL_WHENS.length, 10, `TOOL_WHENS 应 10 条，实际 ${TOOL_WHENS.length}`)
  for (const t of SPEC_TOOLS) {
    const item = TOOL_WHENS.find((x) => x.name === t)
    assert.ok(item, `TOOL_WHENS 缺少「${t}」`)
    assert.ok(typeof item.when === 'string' && item.when.length > 0, `「${t}」缺少 when 说明`)
  }
})
