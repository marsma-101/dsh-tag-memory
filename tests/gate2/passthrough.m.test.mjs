// 闸门② K8 组：工具层到宿主层的**字段透传**。
//
// 为什么单独测这个：工具 schema 声明了某参数、宿主方法与 engine 也支持它，
// 但中间层 `preset/tools.js` 漏传，是**静默降级**——不报错、不抛异常，
// 模型给的判断被悄悄丢掉，落库值变成默认。
//
// 真实事故（2026-11-08 容器实测）：`dtm_write` 声明了 `稳定性`，
// 模型明确传 `稳定性="稳定"`，落库却是 `观察`——因为 executeWrite
// 只透传了 5 个字段。这条测试守住它。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFakeCtx } from '../_fake-ctx.mjs'
import { registerTools, HOST_SERVICE } from '../../preset/tools.js'

/** 记录宿主方法收到的实参，并按给定结果返回 */
function fakeHost(result) {
  const calls = []
  const host = new Proxy(
    {},
    {
      get: (_t, method) => async (...args) => {
        calls.push({ method, args })
        return { ok: true, result }
      },
    },
  )
  return { host, calls }
}

function setup(result = { ok: true }) {
  const { host, calls } = fakeHost(result)
  const ctx = createFakeCtx({ services: { [HOST_SERVICE]: host } })
  registerTools(ctx, {})
  const tool = (name) => ctx.__tools.find((t) => t.name === name)
  return { ctx, calls, tool }
}

const EXEC = { agent: { id: 'a1' } }

/* ------------------------------------------------------------------ *
 * K8 dtm_write 必须把 6 个模型字段全部透传给宿主
 * ------------------------------------------------------------------ */
test('K8 dtm_write 把 6 个模型字段全部透传（含 稳定性）', async () => {
  const { calls, tool } = setup()
  const w = tool('dtm_write')
  assert.ok(w, 'dtm_write 必须注册')

  await w.execute(
    {
      主要内容: '测试内容',
      形态: '事实',
      项目: '测试文件夹',
      智能体: '萧潇',
      自由标签: ['实测'],
      稳定性: '稳定',
    },
    EXEC,
  )

  const call = calls.find((c) => c.method === 'writeEntry')
  assert.ok(call, '必须调用宿主 writeEntry')
  const payload = call.args[1]
  assert.ok(payload, 'writeEntry 第二个实参是写入内容')

  for (const f of ['主要内容', '形态', '项目', '智能体', '自由标签', '稳定性']) {
    assert.ok(f in payload, `dtm_write 必须透传「${f}」，否则模型给的判断被静默丢掉`)
  }
  assert.equal(payload['稳定性'], '稳定', '稳定性 必须原样透传，不得在工具层改写或丢弃')
})

/* ------------------------------------------------------------------ *
 * K8b 不给 稳定性 时不伪造值（undefined 透传，由 engine 决定起点）
 * ------------------------------------------------------------------ */
test('K8b dtm_write 不伪造 稳定性：没给就是 undefined', async () => {
  const { calls, tool } = setup()
  await tool('dtm_write').execute(
    { 主要内容: 'x', 形态: '事实', 项目: 'p', 智能体: 'a', 自由标签: ['t'] },
    EXEC,
  )
  const payload = calls.find((c) => c.method === 'writeEntry').args[1]
  assert.equal(payload['稳定性'], undefined, '模型没给时工具层不得自行填值（起点由 engine 定）')
})

/* ------------------------------------------------------------------ *
 * K8c dtm_recall 必须把 4 个查询字段全部透传
 * ------------------------------------------------------------------ */
test('K8c dtm_recall 把 4 个查询字段全部透传', async () => {
  const { calls, tool } = setup({ ok: true, hits: [], total: 0, filtered: 0, vetoed: 0, passed: 0 })
  await tool('dtm_recall').execute(
    { 项目: '测试文件夹', 智能体: '萧潇', 形态: '事实', 自由标签: ['实测'] },
    EXEC,
  )
  const payload = calls.find((c) => c.method === 'recall').args[1]
  for (const f of ['项目', '智能体', '形态', '自由标签']) {
    assert.ok(f in payload, `dtm_recall 必须透传「${f}」`)
  }
})

/* ------------------------------------------------------------------ *
 * K8d dtm_bind 必须透传 智能体 + 项目
 * ------------------------------------------------------------------ */
test('K8d dtm_bind 把 智能体 与 项目 都透传', async () => {
  const { calls, tool } = setup({ ok: true, 智能体: '萧潇', 项目: '测试文件夹' })
  await tool('dtm_bind').execute({ 智能体: '萧潇', 项目: '测试文件夹' }, EXEC)
  const payload = calls.find((c) => c.method === 'bindIdentity').args[1]
  assert.equal(payload['智能体'], '萧潇')
  assert.equal(payload['项目'], '测试文件夹')
})
