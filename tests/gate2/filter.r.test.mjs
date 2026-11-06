/**
 * filter.r.test — 筛选字段名跨模块一致
 *
 * ============ 这条测试防的是真实事故（用户报告，2026-11-06） ============
 *
 * 用户原话：「筛选现在我测试的结果是摆设，我选定了相应的标签之后没有任何反应」
 *
 * 根因：跨模块字段名漂移（教训 2 的又一例）
 *   前端 query = { shape, project, agent, status, tags }      ← 英文键
 *   宿主 listEntries 读 filter['形态'] / filter['项目'] ...     ← 中文键
 *
 * 宿主读到的全是 undefined -> str() 成 '' -> 所有条件都当"不限"
 * -> 返回全部记录 -> 用户看到「选了没反应」。
 *
 * 没有任何报错：接口成功、数据正常返回，只是条件被静默忽略。
 * 这是最坏的一类缺陷 —— 看起来在工作，实际什么都没做。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_SRC = readFileSync(join(process.cwd(), 'index.js'), 'utf8')
const CLIENT_SRC = readFileSync(join(process.cwd(), 'client.js'), 'utf8')

/** 宿主 listEntries 实际读取的键名 */
function hostFilterKeys() {
  const i = HOST_SRC.indexOf('async function listEntries')
  assert.ok(i >= 0, '找不到 listEntries')

  let depth = 0
  let end = -1
  const bodyStart = HOST_SRC.indexOf('{', HOST_SRC.indexOf(')', i))
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
  const body = HOST_SRC.slice(i, end)
  return [...new Set([...body.matchAll(/filter\['([^']+)'\]/g)].map((m) => m[1]))]
}

/** 客户端 query 构造对象里的键名 */
function clientQueryKeys() {
  const i = CLIENT_SRC.indexOf('const query = React.useMemo')
  assert.ok(i >= 0, '找不到 query useMemo')

  const retIdx = CLIENT_SRC.indexOf('return {', i)
  assert.ok(retIdx >= 0, 'query 里找不到 return {')

  let depth = 0
  let end = -1
  for (let k = CLIENT_SRC.indexOf('{', retIdx); k < CLIENT_SRC.length; k++) {
    if (CLIENT_SRC[k] === '{') depth++
    else if (CLIENT_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  const body = CLIENT_SRC.slice(CLIENT_SRC.indexOf('{', retIdx), end)
  // 只取对象字面量顶层的 key: value
  // ⚠️ 不能用 \w+ —— JavaScript 的 \w 不匹配中文（形态/项目/智能体…），
  // 那样会提取到空集合，测试变成"假失败"。这里匹配"冒号前的非空白片段"。
  return [
    ...new Set(
      [...body.matchAll(/^\s{10}([^\s:{}'"]+)\s*:/gm)].map((m) => m[1]),
    ),
  ]
}

// ── R1: 宿主读的键，客户端必须发 ─────────────────────────

test('R1 【关键】宿主 listEntries 读的每个筛选键，客户端 query 都必须发', () => {
  const hostKeys = hostFilterKeys()
  const clientKeys = clientQueryKeys()

  assert.ok(hostKeys.length > 0, '宿主没读到任何 filter[...] 键，提取逻辑可能失效')

  // 分页键是英文（offset/limit），不参与筛选条件比对
  const pagination = ['offset', 'limit', 'page', 'pageSize']
  const needed = hostKeys.filter((k) => !pagination.includes(k))

  const missing = needed.filter((k) => !clientKeys.includes(k))
  assert.deepEqual(
    missing,
    [],
    `宿主读 filter['${missing.join("'] / filter['")}']，但客户端 query 没发这些键。` +
      `宿主会读到 undefined -> 条件被当成"不限" -> 筛选静默失效。\n` +
      `客户端实际发的键：${clientKeys.join(', ')}`,
  )
})

// ── R2: 不许再用英文键做筛选条件 ─────────────────────────

test('R2 客户端 query 不得使用英文筛选键（shape/project/agent/status/tags）', () => {
  const clientKeys = clientQueryKeys()
  const forbidden = ['shape', 'project', 'agent', 'status', 'tags']
  const hit = forbidden.filter((k) => clientKeys.includes(k))

  assert.deepEqual(
    hit,
    [],
    `客户端还在发英文筛选键：${hit.join(', ')}。` +
      `宿主读的是中文键（形态/项目/智能体/状态/自由标签），英文键会被静默忽略。`,
  )
})

// ── R3: 中文键必须齐全 ───────────────────────────────────

test('R3 客户端 query 必须发全部 5 个中文筛选键', () => {
  const clientKeys = clientQueryKeys()
  const required = ['形态', '项目', '智能体', '状态', '自由标签']
  const missing = required.filter((k) => !clientKeys.includes(k))

  assert.deepEqual(missing, [], `客户端 query 缺这些筛选键：${missing.join(', ')}`)
})

// ── R4: FilterBar 的 state key 与 query 要有映射 ──────────

test('R4 FilterBar 的 value 键（shape/project/…）必须被 query 消费', () => {
  // FilterBar 用英文 state key（shape/project/agent/status/tagsText）是设计内的，
  // 但 query 必须把它们映射成中文键 —— 上面 R1/R3 已保证。
  // 这里额外确认 FilterBar 确实用这些键，防止有人改了 FilterBar 让映射断掉。
  const i = CLIENT_SRC.indexOf('function FilterBar')
  assert.ok(i >= 0, '找不到 FilterBar')

  const seg = CLIENT_SRC.slice(i, i + 6000)
  for (const k of ['shape', 'project', 'agent', 'status', 'tagsText']) {
    assert.ok(
      seg.includes(k),
      `FilterBar 里找不到 state 键 ${k}，筛选控件的绑定可能断了`,
    )
  }
})

// ── R5: 宿主筛选逻辑真的在用这些键 ───────────────────────

test('R5 宿主 listEntries 对每个筛选键都有实际比较逻辑', () => {
  const i = HOST_SRC.indexOf('async function listEntries')
  let depth = 0
  let end = -1
  const bodyStart = HOST_SRC.indexOf('{', HOST_SRC.indexOf(')', i))
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
  const body = HOST_SRC.slice(i, end)

  // 每个 key 都要在 filter 回调里被读出来参与比较。
  // 实际写法是 `if (shape !== '' && str(r['形态']) !== shape) return false`
  // —— 键名出现在 r['形态'] 里，比较对象是局部变量。
  for (const k of ['形态', '项目', '智能体', '状态']) {
    const read = new RegExp("r\\['" + k + "'\\]")
    assert.match(body, read, `listEntries 里没读 r['${k}']，该筛选条件不会生效`)
  }
  // 标签是数组，比较方式是 some/includes
  assert.match(body, /tags\.some|tags\.includes/, '标签筛选没有 some/includes 比较')
})
