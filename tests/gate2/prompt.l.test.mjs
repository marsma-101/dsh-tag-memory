// 闸门② L 组：每轮提示注入（7 条）
//
// 依据：《标签字典》「注入边界（硬约束）」、《功能说明》§十四「插件层」、
//       《架构说明》§4.1、《探明结论》§2（interpolate:false）。
// Q1 裁定（Lead 定死，三条同时满足才算过）：
//   ① UTF-8 字节 ≤ 6000
//   ② 行数 ≤ 130
//   ③ 含全部 10 个 dtm_* + 6 个形态值

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFakeCtx } from '../_fake-ctx.mjs'
import { apply as applyPreset } from '../../preset/index.js'
import { renderInjection, SECTION_NAME, SECTION_ORDER, missingToolNames, TOOL_WHENS } from '../../preset/prompt.js'

const SPEC_TOOLS = [
  'dtm_bind', 'dtm_write', 'dtm_recall', 'dtm_supersede', 'dtm_archive',
  'dtm_retag', 'dtm_review', 'dtm_records', 'dtm_export', 'dtm_merge',
]
const SHAPES = ['技能', '流程', '规则', '偏好', '事实', '模板']

/** Q1 的三条阈值（Lead 拍板，改需经 Lead） */
const Q1 = { maxBytes: 6000, maxLines: 130, toolCount: 10, shapeCount: 6 }

/** 从假 ctx 里取出真正注册进 systemPrompt 的那段文本 */
function registeredText(ctx) {
  assert.equal(ctx.__sections.length, 1, '必须注册恰好 1 段注入')
  const section = ctx.__sections[0]
  const text = typeof section.text === 'function' ? section.text({ agent: null }) : section.text
  return { section, text }
}

/* ------------------------------------------------------------------ *
 * L1 十入口一个不缺
 * ------------------------------------------------------------------ */
test('L1 注入文本含全部 10 个 dtm_* 工具名（一个不缺）', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  const { text } = registeredText(ctx)

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
  const { text } = registeredText(ctx)

  for (const shape of SHAPES) {
    assert.ok(text.includes(shape), `注入文本缺少形态值「${shape}」`)
  }
})

/* ------------------------------------------------------------------ *
 * L3 身份状态段
 * ------------------------------------------------------------------ */
test('L3 未绑定 → 含"未绑定"+问用户提示；已绑定 → 含当前身份名', () => {
  const unbound = renderInjection({ identity: { bound: false } })
  assert.ok(unbound.includes('未绑定'), `未绑定时必须标出「未绑定」，实际未找到`)
  assert.ok(
    unbound.includes('问用户') || unbound.includes('先问') || unbound.includes('dtm_bind'),
    '未绑定时必须提示去问用户 / 调 dtm_bind',
  )

  const bound = renderInjection({ identity: { bound: true, who: '罗桥', project: 'P' } })
  assert.ok(bound.includes('罗桥'), `已绑定时应显示身份名「罗桥」`)
  assert.ok(bound.includes('已绑定'), '已绑定时身份段应标出「已绑定」')

  // 「身份状态段」必须二选一，不能同时出现两种状态。
  // 注意：不能断言"全文不含'未绑定'字样"——工具表里
  // `dtm_bind | 会话开始未绑定身份时…` 是对工具用途的描述，属正常文案。
  // 所以只校验「### 身份：X」这一段。
  const stateOf = (text) => {
    const m = text.match(/###\s*身份：\s*(\S+)/)
    return m ? m[1] : null
  }
  assert.equal(stateOf(bound), '已绑定', `已绑定版的身份段应为「已绑定」，实际「${stateOf(bound)}」`)
  assert.equal(stateOf(unbound), '未绑定', `未绑定版的身份段应为「未绑定」，实际「${stateOf(unbound)}」`)

  // 未绑定版必须明确"写入被拒、读取返空"（铁律的注入侧）
  assert.ok(unbound.includes('拒') && unbound.includes('空'), '未绑定段必须说明写入会被拒、召回返回空')

  // 拿不到会话 → 必须当成未绑定，不得抛错（官方：assembly 没有 agent 是常态）
  assert.doesNotThrow(() => renderInjection({ identity: { bound: false } }))
  assert.doesNotThrow(() => renderInjection({}))
  assert.doesNotThrow(() => renderInjection())
})

/* ------------------------------------------------------------------ *
 * L4 【Q1 裁定】精简度：三条同时满足
 * ------------------------------------------------------------------ */
test('L4 【Q1】精简度三条同时满足：≤6000 字节 + ≤130 行 + 含 10 入口与 6 形态', () => {
  const text = renderInjection({ identity: { bound: true, who: '罗桥', project: 'P' } })

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
 * L5 不得含实现细节（阈值推导 / 匹配原理 / 状态机细节）
 * ------------------------------------------------------------------ */
test('L5 注入不得含阈值推导/匹配原理/状态机细节', () => {
  const text = renderInjection({ identity: { bound: true, who: '罗桥' } })

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
test('L6 注入含 {{ 或 {} 时必须 interpolate:false，否则 assembly 会抛错', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})
  const { section, text } = registeredText(ctx)

  const hasBraces = text.includes('{{') || text.includes('}}') || /\{[^}]*\}/.test(text)

  if (hasBraces) {
    assert.equal(
      section.interpolate,
      false,
      '注入文本含花括号，必须设 interpolate:false（探明结论 §2：否则整个 assembly 抛错）',
    )
  } else {
    // 即使不含花括号，显式写 false 更稳（防日后文案改动踩坑）
    assert.equal(section.interpolate, false, '建议显式 interpolate:false（防御性）')
  }
})

/* ------------------------------------------------------------------ *
 * L7 同一 name 只注册一次 + name/order 合理
 * ------------------------------------------------------------------ */
test('L7 注入段 name 唯一、order 与其他插件不冲突（同 name 重复注册会覆盖）', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})

  const names = ctx.__sections.map((s) => s.name)
  assert.equal(new Set(names).size, names.length, `注入段 name 不得重复，实际：${names.join(', ')}`)

  const section = ctx.__sections[0]
  assert.equal(section.name, SECTION_NAME, 'name 必须与导出的 SECTION_NAME 一致')
  assert.equal(typeof SECTION_NAME, 'string')
  assert.ok(SECTION_NAME.length > 0)
  assert.ok(SECTION_NAME.includes('dsh-tag-memory'), `name 应带包名便于诊断，实际「${SECTION_NAME}」`)

  assert.equal(section.order, SECTION_ORDER)
  assert.equal(typeof SECTION_ORDER, 'number')
  assert.ok(Number.isFinite(SECTION_ORDER), 'order 必须是有限数字')

  // TOOL_WHENS 必须覆盖 10 个（字典里"各一行"的数据来源）
  assert.equal(TOOL_WHENS.length, 10, `TOOL_WHENS 应 10 条，实际 ${TOOL_WHENS.length}`)
  for (const t of SPEC_TOOLS) {
    const item = TOOL_WHENS.find((x) => x.name === t)
    assert.ok(item, `TOOL_WHENS 缺少「${t}」`)
    assert.ok(typeof item.when === 'string' && item.when.length > 0, `「${t}」缺少 when 说明`)
  }
})
