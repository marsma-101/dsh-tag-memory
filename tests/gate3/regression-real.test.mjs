// 闸门③ 回归：真容器安装暴露的 4 个缺陷
//
// 背景：本地 177 条全绿，但装进真实容器（DSH 0.2.1-rc.2 / Node v22 / Linux）
// 暴露了 4 个缺陷。
//
// ⚠️ 归因必须分清两类（Lead 2026-11-05 纠正，别笼统说成"环境限制"）：
//
//   【甲类·框架契约】本地真的测不出（框架在 apply 之前/之后做的事，假 ctx 没有那一步）
//     · 缺陷① Config = {} → resolveConfig TypeError
//
//   【乙类·实现缺口 + 用例缺口】**本地完全能测出来**，只要用例覆盖足够
//     · 缺陷② bindIdentity 只返回不存储   —— 用例没覆盖"投影读不到"的形态
//     · 缺陷③ recall 漏兜 项目            —— 用例总传全参数，没测"模型省略"
//     · 缺陷④ read.jsonl cond 记原始 query —— 同理，没测"省略 + 台账一致性"
//
//   **把用例缺口说成环境限制，是最容易自我原谅的偷懒。**
//   下面 4 条里，只有 R9 属于甲类；R10–R12 都是乙类，本来就该被本地测试挡住。
//
// ⚠️ 这些断言仍跑在假 ctx 上，只能守住"代码形态不再写错"，
//    守不住"框架实际行为"。真实容器验证不可被替代（见 tests/LIMITS.md）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

const PRESET_SRC = readFileSync(join(process.cwd(), 'preset', 'index.js'), 'utf8')

/** 读 jsonl 全量（测试辅助） */
function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

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
 * R11【2026-11-08 裁决】缺 项目/智能体 → 必须拒绝，不得补默认值
 *
 * 历史（为什么这条断言是反的）：
 *   旧实现为了让容器里「模型省略传值」能写进去，在 writeEntry/recall 里加了
 *   `|| identity.项目` 兜底。后果是**掩盖了真问题**：
 *     · 模型整场不传 项目 也能写成功 → 归属错了永远看不出来
 *     · 实测发现不了「模型没按标准填」，这类缺陷进不了生产
 *   现在改为：缺字段 → 拒 → 报错点名缺什么、合法值域、去哪查标准。
 *   模型据此补全重试，而不是程序替它做决定。
 * ------------------------------------------------------------------ */
test('R11【裁决】缺 项目/智能体 → write 必须拒绝并点名字段，不得补默认值', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    const agent = { session: { id: 'qa-r11' } }
    h.host.bindIdentity(agent, { 智能体: 'tester', 项目: 'P1' })

    // 即使已绑定身份，写入时缺 项目/智能体 也必须被拒 —— 身份不是默认值来源
    const w = await h.host.writeEntry(agent, {
      主要内容: 'R11 回归：缺字段必须被拒',
      形态: '事实',
      自由标签: ['回归', '拒写'],
    })
    assert.equal(w.ok, false, `缺 项目/智能体 必须拒写，实际 ${JSON.stringify(w).slice(0, 200)}`)

    const codes = (w.errors ?? []).map((e) => e.code)
    assert.ok(codes.includes('PROJECT_EMPTY'), `必须报 PROJECT_EMPTY，实际 ${codes.join(', ')}`)
    assert.ok(codes.includes('AGENT_EMPTY'), `必须报 AGENT_EMPTY，实际 ${codes.join(', ')}`)

    // 报错必须说清标准与去处（模型据此才能纠正）
    const projErr = (w.errors ?? []).find((e) => e.code === 'PROJECT_EMPTY')
    assert.ok(projErr.message.includes('标签字典'), 'PROJECT_EMPTY 报错必须指向《标签字典》')
    assert.ok(projErr.message.includes('问用户'), 'PROJECT_EMPTY 报错必须说明「不知道就问用户」')

    // 库必须没被写入
    const r0 = await h.host.recall(agent, { 项目: 'P1', 智能体: 'tester', 形态: '事实', 自由标签: [] })
    assert.equal(r0.hits.length, 0, '拒写后库里不应有这条')

    // 补齐字段后必须成功（证明被拒只是「缺参数」，不是「用不了」）
    // 注意标签只给 1 个：召回用 1 个标签查 2 个标签的条目时 e_ratio=0.5，
    // 不满足 veto 的 `> entryRatio(0.5)`，会被正确否决——那是引擎行为，不是缺陷。
    const w2 = await h.host.writeEntry(agent, {
      主要内容: 'R11 回归：补齐字段后写入成功',
      形态: '事实',
      项目: 'P1',
      智能体: 'tester',
      自由标签: ['补全'],
    })
    assert.equal(w2.ok, true, `补齐字段后必须写入成功，实际 ${JSON.stringify(w2).slice(0, 200)}`)
    assert.equal(w2['项目'], 'P1')
    assert.equal(w2['智能体'], 'tester')

    // 召回同理：缺字段必须拒
    const r = await h.host.recall(agent, { 形态: '事实', 自由标签: ['回归'] })
    assert.equal(r.ok, false, '缺 项目/智能体 的召回必须被拒')
    assert.ok(
      ['PROJECT_EMPTY', 'AGENT_EMPTY'].includes(r.blocked),
      `召回必须被前置闸门挡下，实际 blocked=${r.blocked}`,
    )

    // 补齐后能查到
    const r2 = await h.host.recall(agent, { 项目: 'P1', 智能体: 'tester', 形态: '事实', 自由标签: ['补全'] })
    assert.equal(r2.hits.length, 1, `补齐字段后应召回 1 条，实际 ${r2.hits.length}`)
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * R12【裁决】被拒也必须落台账，且台账要记清拒绝原因
 *
 * 为什么：模型要靠「被拒记录」纠正下一次调用。
 * 台账里没有拒绝原因，整理阶段也分不清「库真没有」和「参数不合规被挡」——
 * 这两者对下一步该做什么是完全相反的动作。
 * ------------------------------------------------------------------ */
test('R12【裁决】被拒的 recall 必须落 read.jsonl，并记 blocked + errors', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    const agent = { session: { id: 'qa-r12' } }
    h.host.bindIdentity(agent, { 智能体: 'tester', 项目: 'P1' })

    // 缺字段的召回（会被前置闸门挡下）
    const r = await h.host.recall(agent, { 形态: '事实', 自由标签: ['cond回归'] })
    assert.equal(r.ok, false, '缺字段召回应被拒')

    const logs = readJsonl(join(h.dataDir, 'records', 'read.jsonl'))
    assert.equal(logs.length, 1, `被拒的召回也必须记台账，实际 ${logs.length} 条`)

    const log = logs[0]
    assert.equal(log.ok, false, '台账必须标 ok:false')
    assert.ok(log.blocked, '台账必须记 blocked 原因码')
    assert.ok(
      ['PROJECT_EMPTY', 'AGENT_EMPTY'].includes(log.blocked),
      `blocked 应是字段缺失码，实际「${log.blocked}」`,
    )
    assert.ok(Array.isArray(log.errors) && log.errors.length > 0, '台账必须记 errors 明细')

    // cond 记的是模型实际传的值（这里 项目/智能体 都空）——台账如实反映输入
    assert.equal(log.cond['项目'], '', 'cond.项目 应如实记模型传入的空值')
    assert.equal(log.cond['智能体'], '', 'cond.智能体 应如实记模型传入的空值')
    assert.equal(log.cond['形态'], '事实', 'cond.形态 应记实际传入值')

    // 成功召回也要落台账，且 ok 不为 false
    await h.host.writeEntry(agent, {
      主要内容: 'R12 回归：成功召回也要落台账',
      形态: '事实',
      项目: 'P1',
      智能体: 'tester',
      自由标签: ['cond回归'],
    })
    const ok = await h.host.recall(agent, { 项目: 'P1', 智能体: 'tester', 形态: '事实', 自由标签: ['cond回归'] })
    assert.equal(ok.ok, true, '补齐字段后召回应成功')

    const logs2 = readJsonl(join(h.dataDir, 'records', 'read.jsonl'))
    assert.equal(logs2.length, 2, '成功召回也应记台账')
    assert.ok(logs2[1].ok !== false, '成功召回不应标 ok:false')
    assert.equal(logs2[1].cond['项目'], 'P1', '成功召回的 cond 应记实际传入值')
  } finally {
    h.cleanup()
  }
})
