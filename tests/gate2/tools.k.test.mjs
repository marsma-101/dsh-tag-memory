// 闸门② K 组：工具注册冒烟（8 条）
//
// 依据：《架构说明》§十二.2、《团队_子开发流程》③、《接口契约》§五、
//       《标签字典》「工具入口（全量，各一行）」。
// 方式：假 ctx 加载预设入口，检查 dtm_* 是否都注册（官方允许的冒烟，非模拟 DOM）。
//
// 不需要 shim：preset 已自带 define-tool.js，零外部依赖，可直接 node --test。
//
// ⚠️ 断言层次：`ctx.tools.register` 收到的是**编译后**的 raw JSON Schema
//    （`{type:'object', properties:{...}, required:[...]}`），不是作者侧 DSL。
//    作者侧的 `required: true` 会被编译成根节点的 `required: ['编号','basis']`，
//    属性节点上不再保留 `required`。K4~K7 按编译后形状断言（这才是宿主真正拿到的）；
//    作者侧 DSL 的意图另由 `tool-defs.js` 直接断言（见 K5a/K7a）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFakeCtx } from '../_fake-ctx.mjs'
import { apply as applyPreset } from '../../preset/index.js'
import { registerTools, TOOL_NAMES, HOST_SERVICE } from '../../preset/tools.js'

/** 规格钦定的 10 个工具（《功能说明》§十四「插件层」原文顺序） */
const SPEC_TOOLS = [
  'dtm_write',
  'dtm_bind',
  'dtm_recall',
  'dtm_supersede',
  'dtm_archive',
  'dtm_review',
  'dtm_retag',
  'dtm_export',
  'dtm_records',
  'dtm_merge',
]

/* ------------------------------------------------------------------ *
 * K1 恰好 10 个
 * ------------------------------------------------------------------ */
test('K1 假 ctx 加载后 ctx.tools.register 恰好被调用 10 次', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  assert.equal(ctx.__tools.length, 10, `必须恰好注册 10 个工具，实际 ${ctx.__tools.length} 个`)
})

/* ------------------------------------------------------------------ *
 * K2 逐个点名（缺哪个报哪个）
 * ------------------------------------------------------------------ */
test('K2 10 个 dtm_* 逐个点名，一个不缺', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  const names = ctx.__tools.map((t) => t.name)
  const missing = SPEC_TOOLS.filter((t) => !names.includes(t))

  assert.deepEqual(missing, [], `缺少工具：${missing.join(', ')}（实际注册：${names.join(', ')}）`)
  assert.equal(TOOL_NAMES.length, 10, `TOOL_NAMES 导出应 10 个，实际 ${TOOL_NAMES.length}`)
})

/* ------------------------------------------------------------------ *
 * K3 前缀统一 dtm_
 * ------------------------------------------------------------------ */
test('K3 全部工具名以 dtm_ 开头，无裸名（且不是 dtm-ui-）', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  for (const t of ctx.__tools) {
    assert.match(t.name, /^dtm_[a-z0-9_]+$/, `工具名必须 dtm_ 前缀（下划线），实际「${t.name}」`)
    assert.equal(t.name.startsWith('dtm-ui-'), false, `工具名不得用 UI 前缀，实际「${t.name}」`)
  }

  // 无重复
  const names = ctx.__tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, '工具名不得重复')
})

/* ------------------------------------------------------------------ *
 * K4 parameters 非空且合法（编译后 = 宿主实际拿到的 raw JSON Schema）
 * ------------------------------------------------------------------ */
test('K4 每个工具都有 parameters，且每项含 type 与 description（编译后 JSON Schema）', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  for (const t of ctx.__tools) {
    assert.ok(t.parameters && typeof t.parameters === 'object', `${t.name} 缺少 parameters`)
    assert.equal(t.parameters.type, 'object', `${t.name}.parameters.type 必须是 object`)
    assert.ok(
      t.parameters.properties && typeof t.parameters.properties === 'object',
      `${t.name}.parameters 缺少 properties`,
    )

    const entries = Object.entries(t.parameters.properties)
    assert.ok(entries.length > 0, `${t.name} 的 parameters 不能为空`)

    for (const [key, spec] of entries) {
      assert.ok(spec && typeof spec === 'object', `${t.name}.${key} 必须是对象`)
      assert.equal(typeof spec.type, 'string', `${t.name}.${key} 缺少 type`)
      assert.equal(typeof spec.description, 'string', `${t.name}.${key} 缺少 description（给模型看）`)
      assert.ok(spec.description.trim().length > 0, `${t.name}.${key} 的 description 不能为空`)
    }

    // 必填键必须都真实存在于 properties（编译没漏）
    for (const key of t.parameters.required ?? []) {
      assert.ok(
        Object.hasOwn(t.parameters.properties, key),
        `${t.name}.required 里的 "${key}" 不在 properties 里`,
      )
    }
  }
})

/* ------------------------------------------------------------------ *
 * K5 dtm_retag 的 basis 必填
 * ------------------------------------------------------------------ */
test('K5 dtm_retag 的 basis 必须必填（契约 §五.2、流程_整理 §七）', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  const retag = ctx.__tools.find((t) => t.name === 'dtm_retag')
  assert.ok(retag, '未找到 dtm_retag')

  const basis = retag.parameters.properties.basis
  assert.ok(basis, 'dtm_retag 必须有 basis 参数')

  // 作者侧 required:true 已编译成根节点 required 数组
  const required = retag.parameters.required ?? []
  assert.ok(
    required.includes('basis'),
    `basis 必须必填，实际 required 数组：${JSON.stringify(required)}`,
  )

  // 规格：没有依据不许改 → basis 缺了就拒绝
  assert.ok(
    String(basis.description).length > 0,
    'basis 必须有 description 说明"依据哪条记录"',
  )
})

/* ------------------------------------------------------------------ *
 * K6 dtm_write 只暴露模型 3 个字段（内容 / 形态 / 标签）
 * ------------------------------------------------------------------ */
test('K6 dtm_write 参数恰为模型 3 个，绝不暴露 归属/程序字段', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  const write = ctx.__tools.find((t) => t.name === 'dtm_write')
  assert.ok(write, '未找到 dtm_write')

  const keys = Object.keys(write.parameters.properties)

  // 2026-11-08 硬性裁定：模型只决定**内容、形态、自由标签**这三件。
  const MUST_HAVE = ['主要内容', '形态', '自由标签']
  for (const f of MUST_HAVE) {
    assert.ok(keys.includes(f), `dtm_write 必须含模型字段「${f}」，实际参数：${keys.join(', ')}`)
  }

  // 归属由程序填（项目=工作目录名，智能体=绑定身份）：
  // 这是环境事实，不是模型的判断。让模型填会拿「主题」当项目，召回永远对不上。
  // 程序字段（编号/时距/状态/稳定性）同理——暴露了模型就会填，填了还得丢弃，等于骗它。
  const FORBIDDEN = ['项目', '智能体', '编号', '时距', '状态', '稳定性']
  for (const f of FORBIDDEN) {
    assert.equal(
      keys.includes(f),
      false,
      `dtm_write 绝不能暴露「${f}」（归属归程序 / 程序字段），实际参数：${keys.join(', ')}`,
    )
  }

  assert.equal(keys.length, 3, `dtm_write 参数必须恰好 3 个，实际 ${keys.length}：${keys.join(', ')}`)
})

/* ------------------------------------------------------------------ *
 * K7 dtm_recall 参数：形态必填、标签可选；归属不暴露
 * ------------------------------------------------------------------ */
test('K7 dtm_recall：形态必填；自由标签可选；不暴露 项目/智能体', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  const recall = ctx.__tools.find((t) => t.name === 'dtm_recall')
  assert.ok(recall, '未找到 dtm_recall')

  const p = recall.parameters.properties
  const required = recall.parameters.required ?? []

  // 2026-11-08 裁决 v2：归属（项目/智能体）是程序值，不暴露给模型。
  // 模型只决定「找哪类东西（形态）」和「按什么标签找」。
  assert.ok(p['形态'], 'dtm_recall 必须有 形态 参数')
  assert.ok(required.includes('形态'), `形态 必须必填，实际 required：${JSON.stringify(required)}`)

  for (const f of ['项目', '智能体']) {
    assert.equal(p[f], undefined, `dtm_recall 不该暴露「${f}」（归属由程序填）`)
  }

  assert.ok(p['自由标签'], 'dtm_recall 必须有 自由标签 参数')
  assert.ok(!required.includes('自由标签'), '自由标签应可选（留空=浏览模式）')
})

/* ------------------------------------------------------------------ *
 * K8 output.schema + output.render 齐备
 * ------------------------------------------------------------------ */
test('K8 每个工具都有 output.schema 与 output.render（否则模型看不到结果）', () => {
  const ctx = createFakeCtx()
  registerTools(ctx, {})

  for (const t of ctx.__tools) {
    assert.ok(t.output, `${t.name} 缺少 output`)
    assert.ok(t.output.schema, `${t.name} 缺少 output.schema`)
    assert.equal(typeof t.output.render, 'function', `${t.name} 的 output.render 必须是函数`)

    // render 必须能产出 [{type:'text', text}] 形态
    const rendered = t.output.render({}, { ok: true, text: '示例' })
    assert.ok(Array.isArray(rendered), `${t.name}.output.render 必须返回数组`)
    assert.ok(rendered.length > 0, `${t.name}.output.render 不能返回空数组`)
    for (const part of rendered) {
      assert.equal(typeof part.type, 'string', `${t.name}: render 部件必须有 type`)
    }
  }
})

/* ------------------------------------------------------------------ *
 * K-附加 预设入口 apply 能跑通，且注册与注入都发生
 * ------------------------------------------------------------------ */
test('K-附加 preset/index.js 的 apply 能完整跑通：注册 10 工具 + 1 段注入 + 1 段身份上下文', () => {
  const ctx = createFakeCtx()
  applyPreset(ctx, {})

  assert.equal(ctx.__tools.length, 10, `apply 后应注册 10 个工具，实际 ${ctx.__tools.length}`)
  assert.equal(ctx.__sections.length, 1, `应注册 1 段固定注入（section），实际 ${ctx.__sections.length}`)
  // 身份必须走 context 而非 section —— 否则每轮毁掉系统提示词缓存前缀
  assert.equal(ctx.__contexts.length, 1, `应注册 1 段身份上下文（context），实际 ${ctx.__contexts.length}`)

  // HOST_SERVICE 必须是个非空字符串（preset 惰性取宿主服务的键）
  assert.equal(typeof HOST_SERVICE, 'string')
  assert.ok(HOST_SERVICE.length > 0, 'HOST_SERVICE 不能为空')

  // 宿主服务缺失时不得抛错（preset 必须能在 host 未就绪时加载）
  assert.doesNotThrow(() => {
    const ctx2 = createFakeCtx({ services: {} })
    applyPreset(ctx2, {})
  }, '宿主服务未挂载时 apply 不得抛错（否则整个插件挂不上）')
})
