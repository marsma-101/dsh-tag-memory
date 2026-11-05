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

/* ------------------------------------------------------------------ *
 * R12【缺陷④】read.jsonl 的 cond 必须记**实际硬筛值**，且与 echo 一致
 *
 * 原实现：`buildReadLog({ query: 原始query })` —— 模型省略 项目/智能体 时，
 * cond 记成空串，而实际硬筛用的是绑定值。
 *
 * 为什么是真问题（不只是"字段不好看"）：
 *   cond 的用途是整理阶段追根因。
 *   记空串会让整理得出**错误结论**："模型没传项目所以查不到"，
 *   而真相是"用 P1 查了但库里没有"。
 *   → 整理会去改**本来正确**的行为，而不是去补缺失的条目。**归因被台账带偏。**
 * ------------------------------------------------------------------ */
test('R12【真容器缺陷④】省略 项目/智能体 召回 → read.jsonl 的 cond 记绑定值，且与 echo 一致', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    const agent = { session: { id: 'qa-r12' } }
    h.host.bindIdentity(agent, { 智能体: 'tester', 项目: 'P1' })

    // 先写一条，确保库非空（否则可能走不同分支）
    const w = await h.host.writeEntry(agent, {
      主要内容: 'R12 回归：cond 必须记实际硬筛值',
      形态: '事实',
      自由标签: ['cond回归'],
    })
    assert.equal(w.ok, true)

    // 故意省略 项目/智能体 召回
    const query = { 形态: '事实', 自由标签: ['cond回归'] }
    const r = await h.host.recall(agent, query)
    assert.equal(r.ok, true, `召回应成功，实际 ${JSON.stringify(r).slice(0, 200)}`)

    // 读台账
    const logs = readJsonl(join(h.dataDir, 'records', 'read.jsonl'))
    assert.equal(logs.length, 1, `应记 1 条读取台账，实际 ${logs.length}`)
    const cond = logs[0].cond

    assert.ok(cond, '台账必须有 cond 字段')

    // 核心断言：cond 必须记**实际使用的绑定值**，不是空串
    assert.equal(
      cond['项目'],
      'P1',
      `cond.项目 必须记实际硬筛用的绑定值 P1，实际「${cond['项目']}」—— ` +
        '原缺陷：记原始 query 的空串，会让整理误判"模型没传项目"',
    )
    assert.equal(
      cond['智能体'],
      'tester',
      `cond.智能体 必须记实际硬筛用的绑定值 tester，实际「${cond['智能体']}」`,
    )

    // cond 与 echo 必须一致（两者都是"实际用了什么条件"的回显）
    assert.equal(cond['项目'], r.echo['项目'], 'cond.项目 必须与 echo.项目 一致')
    assert.equal(cond['智能体'], r.echo['智能体'], 'cond.智能体 必须与 echo.智能体 一致')
    assert.equal(cond['形态'], r.echo['形态'], 'cond.形态 必须与 echo.形态 一致')

    // 反向：cond 不得是空串（这是原缺陷的直接形态）
    assert.notEqual(cond['项目'], '', 'cond.项目 不得为空串')
    assert.notEqual(cond['智能体'], '', 'cond.智能体 不得为空串')

    // 显式传值时，cond 应记显式值（不是绑定值）—— 证明记的是"实际用的"
    await h.host.recall(agent, { 项目: 'P-other', 智能体: 'tester', 形态: '事实', 自由标签: ['cond回归'] })
    const logs2 = readJsonl(join(h.dataDir, 'records', 'read.jsonl'))
    assert.equal(logs2.length, 2, '第二次召回也应记台账')
    assert.equal(
      logs2[1].cond['项目'],
      'P-other',
      `显式传值时 cond 必须记显式值 P-other，实际「${logs2[1].cond['项目']}」（证明记的是实际用的，不是绑定值）`,
    )
  } finally {
    h.cleanup()
  }
})
