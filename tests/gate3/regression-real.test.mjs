// 闸门③ 回归：真容器安装暴露的 3 个缺陷（3 条）
//
// 背景：本地 177 条全绿，但装进真实容器（DSH 0.2.1-rc.2 / Node v22 / Linux）
// 暴露了 3 个缺陷。这三个都属于**假 ctx 测试覆盖不到的那一层**——
// 框架契约、事件链路、真实调用形态。
//
// 本文件把它们固化成回归断言，防止再退化。
// ⚠️ 注意：这些断言仍然跑在假 ctx 上，**只能守住"代码形态不再写错"**，
//          守不住"框架实际行为"。真实容器验证不可被替代（见 tests/LIMITS.md）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

const PRESET_SRC = readFileSync(join(process.cwd(), 'preset', 'index.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * R9【真容器缺陷①】preset 不得导出没有 `~standard` 的 Config
 *
 * Cordis 的 resolveConfig（cordis/lib/index.js:958）：
 *   if (!runtime.Config) return config;                            // 没有 → 放行
 *   const result = runtime.Config['~standard'].validate(config);   // 有 → 必须是标准 schema
 *
 * `export const Config = {}` 是**空对象不是 undefined** —— 过了第一道判断，
 * 然后 Config['~standard'] 是 undefined →
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 * → 整个插件行激活失败。
 *
 * 这是纯框架契约问题，**假 ctx 没有 resolveConfig 这一步，任何本地单测都测不出**。
 * ------------------------------------------------------------------ */
test('R9【真容器缺陷①】preset 不得导出空 Config（会触发 resolveConfig TypeError）', () => {
  // 找所有 `export const Config` / `export { Config }` 形态
  const exportConfig = /export\s+(?:const|let|var)\s+Config\s*=|export\s*\{[^}]*\bConfig\b/
  const hasExport = exportConfig.test(PRESET_SRC)

  if (!hasExport) {
    // 当前选择：不导出 —— 这是安全的（resolveConfig 第一道判断直接放行）
    assert.ok(true, '未导出 Config → resolveConfig 放行 → 安全')
    return
  }

  // 若将来确实要导出，必须是带 `~standard` 的真 schema
  assert.match(
    PRESET_SRC,
    /~standard/,
    '导出了 Config 但没有 `~standard` 字段 —— resolveConfig 会执行 ' +
      "`Config['~standard'].validate(config)` 并抛 TypeError，导致整个插件行激活失败。\n" +
      '修法二选一：① 不导出 Config（当前做法，可调值走 templates/*.json）；' +
      '② 导出真正的 schemastery/zod schema（含 ~standard）',
  )
})

/* ------------------------------------------------------------------ *
 * R10【真容器缺陷②】bindIdentity 后 identityOf 必须非 null
 *
 * 原实现只 return 不存储：
 *   return { ok: true, 智能体: who, 项目: project };   // 存哪了？没存
 * 投影依赖 tool/call / command/run 事件，但宿主方法被**直接调用**时投影恒为空。
 * 实测现象：bind 返回 ok，紧接着 write 报 UNBOUND_IDENTITY。
 * ------------------------------------------------------------------ */
test('R10【真容器缺陷②】bindIdentity 之后 identityOf 必须立刻非 null', async () => {
  // 关键：拿一个**投影读不到**的 agent（模拟"宿主方法被直接调用"的真实形态）
  const h = await makeHostCtx({ identity: null })
  try {
    const agent = { session: { id: 'qa-r10' } }

    // 绑定前：应为 null
    assert.equal(h.host.identityOfSync(agent), null, '（前提）绑定前 identityOfSync 应为 null')

    // 绑定
    const bound = h.host.bindIdentity(agent, { 智能体: 'tester', 项目: 'P1' })
    assert.equal(bound.ok, true, `bindIdentity 应成功，实际 ${JSON.stringify(bound)}`)

    // 绑定后：必须立刻能读到（这正是原缺陷：只返回不存储）
    const after = h.host.identityOfSync(agent)
    assert.ok(
      after !== null,
      'bindIdentity 之后 identityOfSync 仍为 null —— 原缺陷：只 return 不存储。' +
        '会导致 bind 返回 ok 但紧接着 write 报 UNBOUND_IDENTITY',
    )
    assert.equal(after['智能体'], 'tester', `应读到绑定值，实际 ${JSON.stringify(after)}`)
    assert.equal(after['项目'], 'P1')

    // identityOf 与 identityOfSync 必须一致
    assert.deepEqual(h.host.identityOf(agent), after, 'identityOf 与 identityOfSync 必须返回相同结果')

    // 端到端：绑定后写入必须成功（原缺陷的直接后果）
    const w = await h.host.writeEntry(agent, {
      主要内容: 'R10 回归：绑定后应能写入',
      形态: '事实',
      项目: 'P1',
      智能体: 'tester',
      自由标签: ['回归'],
    })
    assert.equal(w.ok, true, `绑定后写入必须成功，实际 ${JSON.stringify(w)}`)

    // 不同 agent 之间不得串（兜底缓存的 key 是 agent 对象本身）
    const other = { session: { id: 'qa-r10-other' } }
    assert.equal(h.host.identityOfSync(other), null, '另一个 agent 不应读到本 agent 的身份')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * R11【真容器缺陷③】writeEntry / recall 省略 项目/智能体 时必须用绑定值兜底
 *
 * 原实现：
 *   · writeEntry 不兜底 → engine 判 PROJECT_EMPTY / AGENT_EMPTY 拒写
 *   · recall 只兜底 智能体 不兜底 项目 → 空串参与硬筛 → filtered 归零，查不到自己刚写的
 * ------------------------------------------------------------------ */
test('R11【真容器缺陷③】省略 项目/智能体 → write 与 recall 都必须用绑定值兜底', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    const agent = { session: { id: 'qa-r11' } }
    h.host.bindIdentity(agent, { 智能体: 'tester', 项目: 'P1' })

    // 写入时**故意省略** 项目/智能体（模型常见行为）
    const w = await h.host.writeEntry(agent, {
      主要内容: 'R11 回归：省略项目与智能体也应写入成功',
      形态: '事实',
      自由标签: ['回归', '兜底'],
    })
    assert.equal(
      w.ok,
      true,
      `省略 项目/智能体 时必须用绑定值兜底后写入成功，实际 ${JSON.stringify(w)} —— ` +
        '原缺陷：engine 会判 PROJECT_EMPTY/AGENT_EMPTY',
    )
    assert.equal(w['项目'], 'P1', `落库的项目应是绑定值 P1，实际「${w['项目']}」`)
    assert.equal(w['智能体'], 'tester', `落库的智能体应是绑定值 tester，实际「${w['智能体']}」`)

    // 召回时**故意省略** 项目/智能体 —— 两个都必须兜底，否则硬筛用空串 → filtered 归零
    const r = await h.host.recall(agent, { 形态: '事实', 自由标签: ['兜底', '回归'] })
    assert.equal(
      r.filtered,
      1,
      `省略 项目/智能体 的召回，硬筛后应剩 1 条，实际 ${r.filtered} —— ` +
        '原缺陷：只兜底智能体不兜底项目，空串参与硬筛导致 filtered 归零',
    )
    assert.equal(r.hits.length, 1, `应召回刚写的那条，实际 ${r.hits.length} 条`)
    assert.equal(r.hits[0]['主要内容'], 'R11 回归：省略项目与智能体也应写入成功')

    // 显式给值时，必须优先于绑定值（不能被兜底覆盖）
    const w2 = await h.host.writeEntry(agent, {
      主要内容: 'R11 回归：显式值优先',
      形态: '事实',
      项目: 'P2',
      智能体: 'tester',
      自由标签: ['显式优先'],
    })
    assert.equal(w2.ok, true)
    assert.equal(w2['项目'], 'P2', '模型显式给的 项目 必须优先于绑定值')
  } finally {
    h.cleanup()
  }
})
