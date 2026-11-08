// 闸门② K8 组：工具层到宿主层的**字段边界**。
//
// 为什么单独测这个：工具 schema 声明了某参数、宿主方法与 engine 也支持它，
// 但中间层 `preset/tools.js` 的透传清单，决定了模型给的值能不能到达 engine。
// 清单多一项 → 越权字段漏进去；少一项 → 合法字段被静默丢弃。
// 两种都是静默的：不报错、不抛异常，只有比对落库值才能发现。
//
// 2026-11-08 硬性裁定（两条）：
//   ① 归属（`项目`/`智能体`）是**程序值**：项目=会话工作目录名，智能体=绑定身份。
//      这是环境事实，不是模型的判断，所以工具层连参数都不暴露（见 K6/K7），
//      更不该透传。模型硬塞也进不去。
//   ② `稳定性` 是**程序字段**：首次落库恒为 `观察`，只由使用过程事后演进。

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
 * K8 dtm_write 只透传 3 个模型字段
 * ------------------------------------------------------------------ */
test('K8 dtm_write 只透传 3 个模型字段（内容/形态/标签）', async () => {
  const { calls, tool } = setup()
  const w = tool('dtm_write')
  assert.ok(w, 'dtm_write 必须注册')

  await w.execute(
    {
      主要内容: '测试内容',
      形态: '事实',
      自由标签: ['实测'],
    },
    EXEC,
  )

  const call = calls.find((c) => c.method === 'writeEntry')
  assert.ok(call, '必须调用宿主 writeEntry')
  const payload = call.args[1]
  assert.ok(payload, 'writeEntry 第二个实参是写入内容')

  for (const f of ['主要内容', '形态', '自由标签']) {
    assert.ok(f in payload, `dtm_write 必须透传「${f}」，否则合法字段被静默丢弃`)
  }
  assert.equal(Object.keys(payload).length, 3, `只该有 3 个模型字段，实际：${Object.keys(payload).join(', ')}`)
})

/* ------------------------------------------------------------------ *
 * K8b 归属 + 稳定性 绝不透传：模型硬塞也进不去 engine
 * ------------------------------------------------------------------ */
test('K8b 模型硬塞 项目/智能体/稳定性 时，工具层一个都不透传', async () => {
  const { calls, tool } = setup()
  await tool('dtm_write').execute(
    {
      主要内容: 'x',
      形态: '事实',
      自由标签: ['t'],
      // 以下都是越权字段：schema 里根本没这些参数，模型硬塞也不该到 engine
      项目: '模型猜的项目',
      智能体: '模型猜的身份',
      稳定性: '稳定',
    },
    EXEC,
  )
  const payload = calls.find((c) => c.method === 'writeEntry').args[1]
  assert.equal(payload['项目'], undefined, '项目 是程序值（工作目录名），工具层不得透传')
  assert.equal(payload['智能体'], undefined, '智能体 是程序值（绑定身份），工具层不得透传')
  assert.equal(payload['稳定性'], undefined, '稳定性 是程序字段，首次落库恒为「观察」，不得透传')
})

/* ------------------------------------------------------------------ *
 * K8c dtm_recall 只透传 2 个查询字段（形态/标签），归属不透传
 * ------------------------------------------------------------------ */
test('K8c dtm_recall 只透传 形态/自由标签，归属由程序填', async () => {
  const { calls, tool } = setup({ ok: true, hits: [], total: 0, filtered: 0, vetoed: 0, passed: 0 })
  await tool('dtm_recall').execute({ 形态: '事实', 自由标签: ['实测'] }, EXEC)
  const payload = calls.find((c) => c.method === 'recall').args[1]
  for (const f of ['形态', '自由标签']) {
    assert.ok(f in payload, `dtm_recall 必须透传「${f}」`)
  }
  assert.equal(payload['项目'], undefined, '项目 由程序填（工作目录名），工具层不得透传')
  assert.equal(payload['智能体'], undefined, '智能体 由程序填（绑定身份），工具层不得透传')
})

/* ------------------------------------------------------------------ *
 * K8d dtm_bind 只透传 智能体，项目由程序取
 * ------------------------------------------------------------------ */
test('K8d dtm_bind 只透传 智能体，项目不由模型决定', async () => {
  const { calls, tool } = setup({ ok: true, 智能体: '萧潇', 项目: '工作目录名' })
  await tool('dtm_bind').execute({ 智能体: '萧潇' }, EXEC)
  const payload = calls.find((c) => c.method === 'bindIdentity').args[1]
  assert.equal(payload['智能体'], '萧潇', '智能体 必须透传')
  assert.equal(payload['项目'], undefined, '项目 由程序按工作目录填，模型无权传')
})
