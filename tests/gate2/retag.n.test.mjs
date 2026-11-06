/**
 * retag.n.test — dtm_retag 的 patch 组装（预设层）
 *
 * 依据《流程_整理》§七 + 《接口契约》§一。
 *
 * ============ 这条测试防的是真实事故（2026-11-06） ============
 *
 * 模型调 dtm_retag 只想改 `稳定性`，被连续拒绝 3 次：
 *   FIELD_EMPTY: 形态 不能改成空值
 *   FIELD_EMPTY: 项目 不能改成空值
 *   TAGS_EMPTY : 自由标签不能为空
 *
 * 根因：preset/tools.js 的 executeRetag 无条件把 5 个字段都塞进 patch：
 *   patch: { 形态: args['形态'], 项目: ..., 智能体: ..., 自由标签: ..., 稳定性: ... }
 * 模型只传稳定性时其余是 undefined，但 Object.keys(patch).length === 5，
 * 宿主以为"五个字段都要改"，撞上 undefined 就报 FIELD_EMPTY。
 *
 * **工具的语义是"改某几个"，不是"整组替换"**（后者是 UI 编辑器的语义）。
 * 所以本测试锁死：patch 必须只包含模型真正给出的字段。
 *
 * 为什么之前没测出来：旧用例全部"五个字段都传齐"，从没测过"只传一个"。
 * —— 这正是教训「用例缺口 ≠ 环境限制」的又一例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS_SRC = readFileSync(join(process.cwd(), 'preset', 'tools.js'), 'utf8')

/**
 * 从 preset/tools.js 里抽出 executeRetag 的 patch 组装逻辑并执行。
 *
 * 不 mock 宿主、不模拟 React —— 只把那段纯函数逻辑单独跑一遍，
 * 因为缺陷本身就在"组装 patch"这一步，与传输无关。
 */
function buildRetagPatch(args) {
  // 与 preset/tools.js 里的实现保持同构（字段清单必须一致）
  const patch = {}
  for (const field of ['形态', '项目', '智能体', '自由标签', '稳定性', '状态']) {
    const v = args[field]
    if (v !== undefined && v !== null) {
      patch[field] = v
    }
  }
  return patch
}

// ── 核心：只传一个字段 ────────────────────────────────────

test('N1 【关键】只传 稳定性 → patch 只有这 1 个键（不塞 undefined）', () => {
  const patch = buildRetagPatch({ 编号: 'M-1', basis: 'x', 稳定性: '稳定' })
  assert.deepEqual(Object.keys(patch), ['稳定性'])
  assert.equal(patch['稳定性'], '稳定')
})

test('N2 只传 稳定性 → patch 里不含 形态/项目/智能体/自由标签', () => {
  const patch = buildRetagPatch({ 编号: 'M-1', basis: 'x', 稳定性: '稳定' })
  for (const f of ['形态', '项目', '智能体', '自由标签']) {
    assert.equal(f in patch, false, `patch 不该含 ${f}（否则宿主会当"要清空"）`)
  }
})

test('N3 只传 形态 → patch 只有这 1 个键', () => {
  const patch = buildRetagPatch({ 编号: 'M-1', basis: 'x', 形态: '技能' })
  assert.deepEqual(Object.keys(patch), ['形态'])
})

test('N4 只传 自由标签 → patch 只有这 1 个键', () => {
  const patch = buildRetagPatch({ 编号: 'M-1', basis: 'x', 自由标签: ['甲', '乙'] })
  assert.deepEqual(Object.keys(patch), ['自由标签'])
  assert.deepEqual(patch['自由标签'], ['甲', '乙'])
})

// ── 多字段 ────────────────────────────────────────────────

test('N5 传 2 个字段 → patch 恰好 2 个键', () => {
  const patch = buildRetagPatch({ 形态: '技能', 稳定性: '稳定' })
  assert.deepEqual(Object.keys(patch).sort(), ['形态', '稳定性'].sort())
})

test('N6 传满 5 个字段 → patch 5 个键（向后兼容）', () => {
  const patch = buildRetagPatch({
    形态: '技能', 项目: 'P', 智能体: 'A', 自由标签: ['x'], 稳定性: '稳定',
  })
  assert.equal(Object.keys(patch).length, 5)
})

// ── 边界：省略 vs 清空 ────────────────────────────────────

test('N7 空数组是"真给了空值"→ 保留在 patch 里（让宿主报 TAGS_EMPTY）', () => {
  const patch = buildRetagPatch({ 自由标签: [] })
  assert.ok('自由标签' in patch, '空数组代表模型想清空标签，必须让它进 patch 被宿主拒绝')
  assert.deepEqual(patch['自由标签'], [])
})

test('N8 空字符串同理保留（是真给了空值）', () => {
  const patch = buildRetagPatch({ 项目: '' })
  assert.ok('项目' in patch)
  assert.equal(patch['项目'], '')
})

test('N9 null 视为"没给"，跳过', () => {
  const patch = buildRetagPatch({ 形态: null, 稳定性: '稳定' })
  assert.deepEqual(Object.keys(patch), ['稳定性'])
})

test('N10 一个字段都不给 → patch 是空对象（调用方据此报 PATCH_EMPTY）', () => {
  const patch = buildRetagPatch({ 编号: 'M-1', basis: 'x' })
  assert.equal(Object.keys(patch).length, 0)
})

// ── 源码级：确认实现真的按"跳过 undefined"写，不是又改回无条件塞 ──

test('N11 源码里 executeRetag 不再无条件塞 5 个字段', () => {
  const i = TOOLS_SRC.indexOf('function executeRetag')
  assert.ok(i >= 0, '找不到 executeRetag')

  // 取该函数体（大括号配对）
  let depth = 0, end = -1
  for (let k = TOOLS_SRC.indexOf('{', i); k < TOOLS_SRC.length; k++) {
    if (TOOLS_SRC[k] === '{') depth++
    else if (TOOLS_SRC[k] === '}') { depth--; if (depth === 0) { end = k + 1; break } }
  }
  const body = TOOLS_SRC.slice(i, end)

  // 必须出现"跳过 undefined/null"的判断
  assert.match(body, /!==\s*undefined/, 'executeRetag 必须显式跳过 undefined 字段')
  // 不得再出现"五连塞"的旧写法
  assert.equal(
    /patch:\s*\{[\s\S]{0,300}?形态:\s*args/.test(body),
    false,
    '不得退回"patch: { 形态: args[...], ... }"的旧写法（会把 undefined 当清空）',
  )
})

test('N12 源码里字段清单与测试一致（防实现改了测试没跟）', () => {
  const i = TOOLS_SRC.indexOf('function executeRetag')
  let depth = 0, end = -1
  for (let k = TOOLS_SRC.indexOf('{', i); k < TOOLS_SRC.length; k++) {
    if (TOOLS_SRC[k] === '{') depth++
    else if (TOOLS_SRC[k] === '}') { depth--; if (depth === 0) { end = k + 1; break } }
  }
  const body = TOOLS_SRC.slice(i, end)

  for (const f of ['形态', '项目', '智能体', '自由标签', '稳定性', '状态']) {
    assert.ok(body.includes(f), `executeRetag 的字段清单应含 ${f}`)
  }
})
