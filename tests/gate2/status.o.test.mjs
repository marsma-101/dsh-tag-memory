/**
 * status.o.test — 条目状态互斥（被取代 vs 已归档）
 *
 * 依据《流程_整理》§三 L153-154：
 *   `被取代`：被新的一条顶掉了、多条合并、或其他条目扩大使用范围
 *   `已归档`：因储存错误、方案变更等不需要了，**但也没有新的顶替**
 *
 * 两者语义互斥：一条记忆不可能"既被顶替又没被顶替"。
 *
 * ============ 这条测试防的是真实事故（2026-11-06） ============
 *
 * 前端真实对话里，模型先 dtm_supersede 把 M-005 顶替（状态→被取代），
 * 再 dtm_archive 同一条，**归档成功了**，于是这条同时带了两个退场状态。
 *
 * 模型自己发现了这个矛盾并主动指出：
 *   "这条旧记忆此前已被顶替（状态「被取代」），现在又被标成「已归档」，
 *    等于两个状态叠在同一条上……如果以后要按状态筛库，
 *    这条会同时落在两个筛选项里。"
 *
 * 实现当时只拦了"已归档 → 再归档"的幂等，漏了"被取代 → 归档"。
 *
 * ⚠️ 这是**模型发现的缺陷**，不是测试发现的 ——
 *    说明"让模型真用一遍"能发现用例覆盖不到的语义矛盾。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_SRC = readFileSync(join(process.cwd(), 'index.js'), 'utf8')

/** 取 archiveEntry 的函数体 */
function archiveBody() {
  const i = HOST_SRC.indexOf('async function archiveEntry')
  assert.ok(i >= 0, '找不到 archiveEntry')

  // ⚠️ 不能从函数名往后找第一个 '{' —— 参数里有解构 `{ 编号, id, basis }`，
  // 那个 '{' 会先被找到，导致大括号配对提前收尾、取到的 body 是残缺的。
  // 正确做法：先跳过参数列表（到 ')' 为止），再从其后找函数体的 '{'。
  const parenClose = HOST_SRC.indexOf(')', i)
  assert.ok(parenClose > i, 'archiveEntry 参数列表异常')
  const bodyStart = HOST_SRC.indexOf('{', parenClose)
  assert.ok(bodyStart > parenClose, 'archiveEntry 函数体异常')

  let depth = 0
  let end = -1
  for (let k = bodyStart; k < HOST_SRC.length; k++) {
    if (HOST_SRC[k] === '{') depth++
    else if (HOST_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  assert.ok(end > bodyStart, 'archiveEntry 大括号不配对')
  return HOST_SRC.slice(i, end)
}

test('O1 archiveEntry 必须拦截「已被取代」的条目', () => {
  const body = archiveBody()
  assert.match(
    body,
    /===\s*'被取代'/,
    'archiveEntry 必须判断 状态 === 被取代，否则被顶替的条目还能再归档',
  )
})

test('O2 拦截时返回 ALREADY_SUPERSEDED，且不写库', () => {
  const body = archiveBody()
  assert.match(body, /ALREADY_SUPERSEDED/, '必须给出明确错误码，不能静默成功')

  // 拦截分支里应当是 return，而不是继续往下走到 replaceRecordCsv
  const idx = body.indexOf('ALREADY_SUPERSEDED')
  const after = body.slice(idx, idx + 800)
  assert.match(after, /return/, '拦截分支必须 return，不能继续改库')
})

test('O3 错误信息要点明互斥关系（让模型看懂，不只是报错）', () => {
  const body = archiveBody()
  const idx = body.indexOf('ALREADY_SUPERSEDED')
  const ctx = body.slice(idx, idx + 900)
  assert.match(ctx, /互斥|不需要再归档/, '错误文案应说明「被取代 vs 已归档」互斥')
})

test('O4 「已归档」的幂等拦截仍然保留（不能为了修 O1 拆掉旧逻辑）', () => {
  const body = archiveBody()
  assert.match(
    body,
    /===\s*'已归档'/,
    '原本的"已归档→已归档"幂等判断必须保留',
  )
})

test('O5 两个状态判据都存在，且「被取代」判断在写库之前', () => {
  const body = archiveBody()
  const iSuperseded = body.indexOf("=== '被取代'")
  const iArchived = body.indexOf("=== '已归档'")
  const iWrite = body.indexOf('replaceRecordCsv')

  assert.ok(iSuperseded >= 0, '缺 被取代 判断')
  assert.ok(iArchived >= 0, '缺 已归档 判断')
  assert.ok(iWrite >= 0, '缺写库调用')
  assert.ok(iSuperseded < iWrite, '被取代 的判断必须在写库之前')
  assert.ok(iArchived < iWrite, '已归档 的判断必须在写库之前')
})
