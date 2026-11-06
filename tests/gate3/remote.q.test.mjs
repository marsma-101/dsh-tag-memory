/**
 * remote.q.test — Remote 方法表的单一数据源 + 三方一致
 *
 * ============ 这条测试防的是真实事故（2026-11-06） ============
 *
 * 新增 exportLibrary / listExportTargets 后，端点一直 404。
 * 查出来 index.js 里有**两份** REMOTE_SIGNATURES：
 *   ① createHostService 内 —— 负责把方法镜像到 HostServiceProto
 *   ② registerRemote 内    —— 负责生成 marker 符号描述符
 *
 * 我只改了 ①，没改 ②。而 gateway 只从 ② 的 marker 发现端点，
 * 所以「镜像层有方法、marker 层没有」= 端点不存在 = 404。
 *
 * 更糟的是这类错误**没有任何报错**：插件正常激活、其他端点正常работа，
 * 只有新加的那个静默不可用。前端表现为「按钮点了没反应」。
 *
 * 现在提取成模块级唯一常量 REMOTE_SIGNATURES，本测试锁死：
 *   · 只能有一份定义
 *   · 三方（宿主常量 / 客户端 spec / 客户端 api）方法集合完全一致
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_SRC = readFileSync(join(process.cwd(), 'index.js'), 'utf8')
const CLIENT_SRC = readFileSync(join(process.cwd(), 'client.js'), 'utf8')

/** 提取模块级 REMOTE_SIGNATURES 的方法名 */
function hostMethodNames() {
  const m = HOST_SRC.match(/export const REMOTE_SIGNATURES = Object\.freeze\(\{([\s\S]*?)\}\);/)
  assert.ok(m, '找不到模块级 REMOTE_SIGNATURES 定义（必须 export const 且用 Object.freeze 包）')
  return [...m[1].matchAll(/(\w+):\s*\[/g)].map((x) => x[1])
}

/** 提取客户端 spec 里的 endpoint 方法名 */
function clientSpecNames() {
  return [...CLIENT_SRC.matchAll(/'tagMemory\/([A-Za-z0-9_]+)'\s*:\s*\{/g)].map((m) => m[1])
}

// ── Q1: 只能有一份定义 ────────────────────────────────────

test('Q1 【关键】REMOTE_SIGNATURES 全文件只能定义一次', () => {
  const defs = [...HOST_SRC.matchAll(/const REMOTE_SIGNATURES\s*=/g)]
  assert.equal(
    defs.length,
    1,
    `找到 ${defs.length} 份 REMOTE_SIGNATURES 定义。多份会让「改一份、另一份不生效」，` +
      `端点静默 404。必须只有一份模块级定义，两个消费者都引用它。`,
  )
})

test('Q2 定义必须是模块级 export const（不是函数内 const）', () => {
  assert.match(
    HOST_SRC,
    /export const REMOTE_SIGNATURES = Object\.freeze\(/,
    '必须是 export const + Object.freeze，防止被就地改写',
  )
})

test('Q3 两个消费者都引用同一个常量，不再各自写一份', () => {
  // createHostService 与 registerRemote 里都应有 Object.keys(REMOTE_SIGNATURES)
  const refs = [...HOST_SRC.matchAll(/Object\.keys\(REMOTE_SIGNATURES\)/g)]
  assert.ok(refs.length >= 2, `应至少 2 处引用（镜像层 + marker 层），实际 ${refs.length} 处`)
})

// ── Q4/Q5: 三方一致 ──────────────────────────────────────

test('Q4 宿主方法表与客户端 spec 完全一致（双向）', () => {
  const host = hostMethodNames().sort()
  const spec = clientSpecNames().sort()

  const onlyHost = host.filter((x) => !spec.includes(x))
  const onlySpec = spec.filter((x) => !host.includes(x))

  assert.deepEqual(
    onlyHost,
    [],
    `宿主有、客户端 spec 没有（UI 调不到）：${onlyHost.join(', ')}`,
  )
  assert.deepEqual(
    onlySpec,
    [],
    `客户端 spec 有、宿主没有（会 404）：${onlySpec.join(', ')}`,
  )
})

test('Q5 客户端 createApi 覆盖全部 spec 方法', () => {
  const i = CLIENT_SRC.match(/function\s+createApi\s*\(/)
  assert.ok(i, '找不到 createApi')
  const retIdx = CLIENT_SRC.indexOf('return {', i.index)
  assert.ok(retIdx >= 0, 'createApi 里找不到 return {')

  // 大括号配对取返回对象
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
  const body = CLIENT_SRC
    .slice(CLIENT_SRC.indexOf('{', retIdx), end)
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  const apiMethods = [...new Set([...body.matchAll(/(\w+)\s*:\s*function\s*\(/g)].map((m) => m[1]))]
  const spec = clientSpecNames()

  const missing = spec.filter((x) => !apiMethods.includes(x))
  assert.deepEqual(missing, [], `spec 里有、createApi 没实现（UI 会 is not a function）：${missing.join(', ')}`)
})

test('Q6 客户端 createLazyApi 的 methods 列表覆盖全部 spec 方法', () => {
  const m = CLIENT_SRC.match(/const methods = \[([\s\S]*?)\]/)
  assert.ok(m, '找不到 createLazyApi 的 methods 数组')
  const lazy = [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1])
  const spec = clientSpecNames()

  const missing = spec.filter((x) => !lazy.includes(x))
  assert.deepEqual(missing, [], `spec 里有、lazy 代理没转发：${missing.join(', ')}`)
})

// ── Q7: 导出的必须真的在服务对象上 ─────────────────────────

test('Q7 每个 Remote 方法在 serviceObj 里都有同名实现', () => {
  const names = hostMethodNames()
  const missing = []

  // 找 const serviceObj = { ... } 块
  const start = HOST_SRC.indexOf('const serviceObj = {')
  assert.ok(start >= 0, '找不到 serviceObj')

  let depth = 0
  let end = -1
  for (let k = HOST_SRC.indexOf('{', start); k < HOST_SRC.length; k++) {
    if (HOST_SRC[k] === '{') depth++
    else if (HOST_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  const body = HOST_SRC.slice(start, end)

  for (const n of names) {
    // serviceObj 里应有 `    name,` 这一行（简写属性）
    const re = new RegExp('^\\s{4}' + n + '\\s*,', 'm')
    if (!re.test(body)) missing.push(n)
  }

  assert.deepEqual(missing, [], `这些 Remote 方法在 serviceObj 里没有同名实现（注册时会跳过）：${missing.join(', ')}`)
})
