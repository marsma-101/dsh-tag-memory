// 闸门③ 跨模块契约：宿主 Remote 端点 ↔ 客户端 spec（3 条）
//
// 来源：host-dev 与 client-dev 共同提供的检查逻辑，由 qa 落盘与归属
//       （测试写作用域 tests/** 属 qa，他们只提供逻辑）。
//
// 为什么必须有这层（client-dev 抓到的真实缺陷）：
//   宿主 `oneParamMethod('retagEntry', ..., 'request')` 的参数名是 `request`，
//   而客户端 spec 曾写 `payload` → 装上后 UI 一调就报
//   `gateway/arguments-invalid: missing "request"`，整个编辑功能不能用。
// **双方各自的自测都发现不了**：
//   · client-dev 的假宿主是照自己的 spec 造的 → 自洽
//   · host-dev 的自测直接调服务方法 → 绕过 wire 层字段名匹配
//
// 断言必须**双向**（只查"客户端缺"会漏掉"宿主多了一个没人调的端点"）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_SRC = readFileSync(join(process.cwd(), 'index.js'), 'utf8')
const CLIENT_SRC = readFileSync(join(process.cwd(), 'client.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * 1. 宿主侧：endpoint → 参数名（无参为 null）
 * ------------------------------------------------------------------ */
function hostEndpoints() {
  const map = new Map()

  // ⚠️ 提取源已改为 REMOTE_SIGNATURES（registerRemote 里的唯一数据源）。
  //
  // 历史：早期宿主用 noParamMethod(...) / oneParamMethod(..., 'paramName') 两个
  // helper 声明端点，测试也照着解析。后来端点注册重写为
  //   REMOTE_SIGNATURES = { getOverview: [], listEntries: ['query'], ... }
  // 单一数据源（marker 与纯标识符包装器都从它派生），旧 helper 已删除。
  // 解析目标随之变化 —— 否则契约测试会"提取到 0 个端点"而假性失败。
  // 适配两种形态（实现从函数内提取成模块级常量后，
  // 结尾从 "  };" 变成 "});"）—— 两种都要能解析，避免实现微调后测试假失败。
  const block =
    HOST_SRC.match(/const REMOTE_SIGNATURES = Object\.freeze\(\{([\s\S]*?)\}\)/) ||
    HOST_SRC.match(/const REMOTE_SIGNATURES = \{([\s\S]*?)\n  \};/)
  if (!block) return map

  for (const m of block[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*\[([^\]]*)\]/g)) {
    const name = m[1]
    const params = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
    map.set(name, params.length === 0 ? null : params[0])
  }

  return map
}

/* ------------------------------------------------------------------ *
 * 2. 客户端侧：'tagMemory/xxx' → 该 method 块内的 parameters[].name
 *
 * 注意：不能简单搜窗口里的 `name:` —— descriptor 本身没有 name 字段，
 * 只有参数对象里有。无参方法 parameters: [] → 参数名 null。
 * 正确做法：定位该 method 块的 parameters 数组，取其中 name。
 * ------------------------------------------------------------------ */
function clientEndpoints() {
  const map = new Map()

  for (const m of CLIENT_SRC.matchAll(/'tagMemory\/([A-Za-z0-9_]+)'\s*:\s*\{/g)) {
    const name = m[1]
    // 从该方法块的 { 起，按大括号配对截出完整块
    const from = m.index
    let i = CLIENT_SRC.indexOf('{', from)
    const begin = i
    let depth = 0
    for (; i < CLIENT_SRC.length; i++) {
      if (CLIENT_SRC[i] === '{') depth++
      else if (CLIENT_SRC[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const block = CLIENT_SRC.slice(begin, i + 1)

    // parameters: [ ... ] —— 取数组里的 name
    const pm = /parameters\s*:\s*\[([\s\S]*?)\]/.exec(block)
    let paramName = null
    if (pm && pm[1].trim() !== '') {
      const nm = /name\s*:\s*'([A-Za-z0-9_]+)'/.exec(pm[1])
      paramName = nm ? nm[1] : null
    }
    map.set(name, paramName)
  }

  return map
}

/* ------------------------------------------------------------------ *
 * 契约1 双向比对：宿主 ↔ 客户端
 * ------------------------------------------------------------------ */
test('契约1 宿主 Remote 端点与客户端 spec 双向一致（缺一个/多一个/参数名不同 都报）', () => {
  const host = hostEndpoints()
  const client = clientEndpoints()

  // ⚠️ 必须先打印计数 —— client-dev 踩过坑：提取失败时一边是空数组，
  // 比对"看起来通过"，实际只提取到 4 个方法。
  console.log(`\n[契约1 计数] host=${host.size} client=${client.size}\n`)

  assert.ok(host.size > 0, '未能从 index.js 提取到任何 Remote 端点（提取逻辑失效，不算通过）')
  assert.ok(client.size > 0, '未能从 client.js 提取到任何 endpoint（提取逻辑失效，不算通过）')

  // a) 宿主有、客户端没有
  const onlyHost = [...host.keys()].filter((k) => !client.has(k)).sort()
  assert.deepEqual(onlyHost, [], `宿主有但客户端 spec 缺（UI 永远调不到）：${onlyHost.join(', ')}`)

  // b) 客户端有、宿主没有（host-dev 特别强调：这条同样要查）
  const onlyClient = [...client.keys()].filter((k) => !host.has(k)).sort()
  assert.deepEqual(onlyClient, [], `客户端 spec 有但宿主没有（运行期必然失败）：${onlyClient.join(', ')}`)

  // c) 参数名必须一致
  const mismatched = []
  for (const [name, hostParam] of host) {
    const clientParam = client.get(name)
    if (hostParam !== clientParam) {
      mismatched.push(`${name}: 宿主=${hostParam ?? '(none)'} 客户端=${clientParam ?? '(none)'}`)
    }
  }
  assert.deepEqual(
    mismatched,
    [],
    `参数名两侧不一致 → 会报 gateway/arguments-invalid: missing "xxx"：\n  ${mismatched.join('\n  ')}`,
  )

  // 记录基线（将来加方法时这条会立刻提醒"另一侧没跟上"）
  const lines = [...host.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${k.padEnd(18)} 宿主=${String(v ?? '(none)').padEnd(8)} 客户端=${String(client.get(k) ?? '(none)').padEnd(8)} PASS`)
  console.log(`[契约1 逐项]\n${lines.join('\n')}\n`)
})

/* ------------------------------------------------------------------ *
 * 契约2 Remote descriptor 显式字段校验
 * ------------------------------------------------------------------ */
test('契约2 每条 Remote descriptor 的显式字段齐备（$mount 会拒绝漏字段的）', async () => {
  // 从 client.js 抽 buildRemoteSpec 纯函数真实执行（不碰 React/DOM）
  const start = CLIENT_SRC.indexOf('function buildRemoteSpec(')
  assert.ok(start >= 0, 'client.js 里找不到 buildRemoteSpec')

  function grabBrace(from) {
    let i = CLIENT_SRC.indexOf('{', from)
    let depth = 0
    for (; i < CLIENT_SRC.length; i++) {
      if (CLIENT_SRC[i] === '{') depth++
      else if (CLIENT_SRC[i] === '}') {
        depth--
        if (depth === 0) return CLIENT_SRC.slice(from, i + 1)
      }
    }
    throw new Error('大括号不配对')
  }

  const code = [
    `const REMOTE_NS = 'tagMemory';`,
    `const PACKAGE_NAME = 'dsh-tag-memory';`,
    grabBrace(CLIENT_SRC.indexOf('function passthroughCodec(')),
    grabBrace(CLIENT_SRC.indexOf('function toContribution(')),
    grabBrace(start),
    'return { buildRemoteSpec, toContribution };',
  ].join('\n')

  // eslint-disable-next-line no-new-func
  const M = new Function(code)()
  const spec = M.buildRemoteSpec()

  // ⚠️ 关键：`id` / `namespace` / `method` 不是 buildRemoteSpec 直接产的，
  // 而是 `toContribution(spec)` 生成的 —— 官方 $mount 收的也是后者。
  // 验的时候必须验真实产物，不能验中间层（否则会误判"缺 id"）。
  const contribution = M.toContribution(spec)

  assert.ok(contribution && typeof contribution === 'object', 'toContribution 必须返回对象')
  assert.ok(Array.isArray(contribution.descriptors), 'toContribution 必须返回 descriptors 数组')

  const descriptors = contribution.descriptors
  assert.ok(descriptors.length > 0, `descriptors 不能为空，实际 ${descriptors.length} 条`)

  const problems = []

  for (const d of descriptors) {
    const tag = `${d.namespace}/${d.method}`

    // id 必须是 包名#命名空间/方法
    const expectId = `dsh-tag-memory#${d.namespace}/${d.method}`
    if (d.id !== expectId) problems.push(`${tag}: id 应为 "${expectId}"，实际 "${d.id}"`)

    if (d.invocation?.kind !== 'direct') problems.push(`${tag}: invocation.kind 应为 'direct'，实际 ${d.invocation?.kind}`)
    if (d.result?.mode !== 'src-json') problems.push(`${tag}: result.mode 应为 'src-json'，实际 ${d.result?.mode}`)
    if (typeof d.service !== 'string' || d.service.length === 0) problems.push(`${tag}: service 必须是非空字符串`)

    const params = Array.isArray(d.parameters) ? d.parameters : []
    for (const p of params) {
      const ptag = `${tag}.${p.name}`

      if (!('wire' in p) || p.wire == null) problems.push(`${ptag}: 缺 wire（必须显式存在）`)
      if (p.source !== 'json') problems.push(`${ptag}: source 应为 'json'（不写会掉进 lookup 分支），实际 ${p.source}`)
      if (p.codec?.mode !== 'strict') problems.push(`${ptag}: codec.mode 应为 'strict'（硬门，缺了 $mount 直接抛），实际 ${p.codec?.mode}`)
      if (typeof p.codec?.create !== 'function') problems.push(`${ptag}: codec.create 必须是函数`)
      if (typeof p.codec?.typeSymbol !== 'string' || p.codec.typeSymbol.length === 0) {
        problems.push(`${ptag}: codec.typeSymbol 必须是非空字符串`)
      }
    }
  }

  console.log(`\n[契约2] descriptors=${descriptors.length} 条，问题=${problems.length} 条\n`)
  assert.deepEqual(problems, [], `descriptor 字段不合法（$mount 会拒绝）：\n  ${problems.join('\n  ')}`)
})

/* ------------------------------------------------------------------ *
 * 契约3 三方方法名一致：spec / createApi / createLazyApi
 * ------------------------------------------------------------------ */
test('契约3 三方方法名完全一致（spec / createApi / createLazyApi），拼错即 is not a function', () => {
  // ① spec endpoint
  const spec = [...new Set([...CLIENT_SRC.matchAll(/'tagMemory\/([A-Za-z0-9_]+)'\s*:\s*\{/g)].map((m) => m[1]))].sort()

  // ② createApi 返回对象里name: function
  // 不绑参数名（createApi(ctx) / createApi(nsRef) 都应能解析）
  const apiMatch = CLIENT_SRC.match(/function\s+createApi\s*\(/)
  const apiStart = apiMatch ? apiMatch.index : -1
  assert.ok(apiStart >= 0, '找不到 createApi')
  const retIdx = CLIENT_SRC.indexOf('return {', apiStart)
  assert.ok(retIdx >= 0, 'createApi 里找不到 return {')

  let i = CLIENT_SRC.indexOf('{', retIdx)
  const begin = i
  let depth = 0
  for (; i < CLIENT_SRC.length; i++) {
    if (CLIENT_SRC[i] === '{') depth++
    else if (CLIENT_SRC[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  const apiBody = CLIENT_SRC.slice(begin, i + 1)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const api = [...new Set([...apiBody.matchAll(/([A-Za-z0-9_]+)\s*:\s*function\s*\(/g)].map((m) => m[1]))].sort()

  // ③ createLazyApi 的 methods 数组
  const lm = CLIENT_SRC.match(/const methods = \[([\s\S]*?)\]/)
  assert.ok(lm, '找不到 createLazyApi 的 methods 数组')
  const lazy = [...new Set([...lm[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].sort()

  // ⚠️ 必须打印计数（防"空数组看起来通过"）
  console.log(`\n[契约3 计数] spec=${spec.length} api=${api.length} lazy=${lazy.length}\n`)

  assert.ok(spec.length > 0 && api.length > 0 && lazy.length > 0, '三方都必须提取到非空方法名列表')

  assert.deepEqual(api, spec, `createApi 与 spec 不一致：\n  仅 spec: ${spec.filter((x) => !api.includes(x)).join(',') || '无'}\n  仅 api: ${api.filter((x) => !spec.includes(x)).join(',') || '无'}`)
  assert.deepEqual(lazy, spec, `createLazyApi 与 spec 不一致：\n  仅 spec: ${spec.filter((x) => !lazy.includes(x)).join(',') || '无'}\n  仅 lazy: ${lazy.filter((x) => !spec.includes(x)).join(',') || '无'}`)
})
