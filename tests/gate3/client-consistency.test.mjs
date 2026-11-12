// 闸门③ 补充：客户端三方一致性（3 条）
//
// client-dev 主动请求复核：buildRemoteSpec 的 endpoint、createApi 返回的方法、
// createLazyApi 的 methods 列表 —— 三者必须完全一致。
// 任何拼错都会导致运行期 "is not a function"，而语法检查和静态审查都查不出来。
//
// 方式：纯文本/正则解析 client.js（不执行、不模拟 DOM —— 官方验证铁律）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT = readFileSync(join(process.cwd(), 'client.js'), 'utf8')

/** ① buildRemoteSpec 里注册的 endpoint 名（'tagMemory/xxx':） */
function specEndpoints() {
  return [...new Set([...CLIENT.matchAll(/'tagMemory\/(\w+)':/g)].map((m) => m[1]))].sort()
}

/** ③ createLazyApi 的 methods 数组 */
function lazyMethods() {
  const m = CLIENT.match(/const methods = \[([\s\S]*?)\]/)
  if (!m) return null
  return [...new Set([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]))].sort()
}

/**
 * ② createApi 返回对象的方法名。
 * 只在 `return { ... }` 到 `}` 之间取 `name: function`。
 */
function createApiMethods() {
  // 不绑参数名（createApi(ctx) / createApi(nsRef) 都应能解析）
  const m = CLIENT.match(/function\s+createApi\s*\(/)
  const start = m ? m.index : -1
  if (start === -1) return null
  const retIdx = CLIENT.indexOf('return {', start)
  if (retIdx === -1) return null

  // 从 return { 开始，按大括号配对找到对象结束
  let depth = 0
  let i = CLIENT.indexOf('{', retIdx)
  const begin = i
  for (; i < CLIENT.length; i++) {
    if (CLIENT[i] === '{') depth++
    else if (CLIENT[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  const body = CLIENT.slice(begin, i + 1)

  // 去掉注释行，避免注释里的 `xxx: function` 干扰
  const cleaned = body
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  return [...new Set([...cleaned.matchAll(/(\w+)\s*:\s*function\s*\(/g)].map((m) => m[1]))].sort()
}

/* ------------------------------------------------------------------ *
 * C1 三方数量一致（不硬编码具体数字 —— 接口会演进）
 *
 * 原断言写死 9，client.js 后来新增 listBackups 变成 10 就误报了。
 * 那不是缺陷，是接口正常演进。改为：三方数量必须相同，
 * 且每个 endpoint 都必须能在宿主服务里找到同名方法（更强的跨模块契约检查）。
 * ------------------------------------------------------------------ */
test('C1 三方数量一致，且每个 endpoint 都在宿主服务里有同名方法', async () => {
  const a = specEndpoints()
  const b = createApiMethods()
  const c = lazyMethods()

  assert.ok(b, '未解析出 createApi 返回对象（解析失败即报，不跳过）')
  assert.ok(c, '未解析出 createLazyApi 的 methods 列表')
  assert.ok(a.length > 0, 'buildRemoteSpec 至少要有一个 endpoint')

  assert.equal(b.length, a.length, `createApi 数量(${b.length}) 应等于 spec endpoint 数量(${a.length})：${a.join(',')}`)
  assert.equal(c.length, a.length, `lazyMethods 数量(${c.length}) 应等于 spec endpoint 数量(${a.length})：${a.join(',')}`)

  // 每个 endpoint 必须在宿主服务里有同名方法（跨模块契约）
  const { makeHostCtx, BOUND } = await import('../_host-ctx.mjs')
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const missing = a.filter((name) => typeof h.host[name] !== 'function')
    assert.deepEqual(
      missing,
      [],
      `以下 Remote endpoint 在宿主服务里找不到同名方法（会导致运行期 is not a function）：${missing.join(', ')}`,
    )
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * C2 三方逐名对齐
 * ------------------------------------------------------------------ */
test('C2 三方名称完全一致（spec endpoint == createApi == lazyMethods）', () => {
  const a = specEndpoints()
  const b = createApiMethods()
  const c = lazyMethods()

  assert.deepEqual(b, a, `createApi 与 spec endpoint 不一致：\n  仅 spec 有: ${a.filter((x) => !b.includes(x)).join(',') || '无'}\n  仅 createApi 有: ${b.filter((x) => !a.includes(x)).join(',') || '无'}`)
  assert.deepEqual(c, a, `lazyMethods 与 spec endpoint 不一致：\n  仅 spec 有: ${a.filter((x) => !c.includes(x)).join(',') || '无'}\n  仅 lazy 有: ${c.filter((x) => !a.includes(x)).join(',') || '无'}`)
})

/* ------------------------------------------------------------------ *
 * C3 lazy 代理里每个方法都真的转发到同名 api 方法
 * ------------------------------------------------------------------ */
test('C3 lazy 代理每个方法都转发到同名 api 方法（不得转错名）', () => {
  const m = CLIENT.match(/const methods = \[([\s\S]*?)\]/)
  assert.ok(m, '未找到 methods 数组')

  const start = CLIENT.indexOf('const methods = [')
  const tail = CLIENT.slice(start, start + 2000)

  // 不绑定具体写法（箭头函数 / function 表达式都合法），只断言语义：
  //   lazy[name] = <任意函数> { ... return api[name].apply(...) }
  // 关键点：必须用 `api[name]` 按**同名**转发；写死具体方法名极易漏改。
  assert.match(
    tail,
    /lazy\[name\]\s*=/,
    '必须通过 lazy[name] 循环赋值（逐个硬写 9 个方法容易漏改）',
  )
  assert.match(
    tail,
    /return\s+api\[name\]\.apply\(/,
    '必须用 api[name] 按同名转发，不得写成 api.某个具体方法名',
  )

  // 反向：转发体里不得出现写死的方法名字面量（防"循环里却写死一个名字"）
  const forEachBlock = tail.slice(tail.indexOf('lazy[name]'), tail.indexOf('return lazy'))
  const hardcoded = ['getOverview', 'listEntries', 'getFacets', 'getSettings', 'retagEntry',
    'migrateDataDir', 'backupNow', 'restore', 'mergeLibrary'].filter((n) => forEachBlock.includes(n))
  assert.deepEqual(hardcoded, [], `转发体里不得写死方法名，发现：${hardcoded.join(', ')}`)

  // ready() 必须存在（页面据此判断是否真连上）
  assert.match(CLIENT, /ready:\s*function\s*\(\s*\)\s*\{\s*return\s+hasApi\(\w+\)/, 'lazy 代理必须提供 ready()')

  // inject 面不得再是"一次性求值"写法（原缺陷）
  assert.equal(
    /inject:\s*function\s*\(\s*\)\s*\{\s*return\s*\{[\s\S]{0,200}?api:\s*hasApi/.test(CLIENT),
    false,
    'inject 不得沿用「注册时一次性求值 hasApi」的旧写法（会导致页面永远卡在未接线）',
  )
})

/* ------------------------------------------------------------------ *
 * C4 只读三字段保障（《功能说明》§10.3 硬要求）
 * ------------------------------------------------------------------ */
test('C4 只读三字段保障：EntryTable / ReadOnlyCell / ReadOnlyBlock 内零表单控件', () => {
  const lines = CLIENT.split(/\r?\n/)
  const byFunc = new Map()
  let cur = '(top)'

  for (let i = 0; i < lines.length; i++) {
    const fm = lines[i].match(/^\s{4}function ([A-Za-z]+)\(/)
    if (fm) cur = fm[1]
    if (/'(input|select|textarea)'/.test(lines[i])) {
      if (!byFunc.has(cur)) byFunc.set(cur, [])
      byFunc.get(cur).push(i + 1)
    }
  }

  // 只读相关组件里绝不允许出现表单控件
  for (const readonlyFn of ['EntryTable', 'ReadOnlyCell', 'ReadOnlyBlock']) {
    assert.equal(
      byFunc.has(readonlyFn),
      false,
      `${readonlyFn} 内不得出现表单控件，实际在 L${(byFunc.get(readonlyFn) || []).join(', L')}`,
    )
  }

  // 可写控件只允许出现在这些函数里（超出即报，防止漏到只读路径）
  const ALLOWED = new Set(['BackupDialogs', 'EntryEditor', 'FilterBar', 'Pager', 'SettingsPage', 'TagsEditor'])
  const unexpected = [...byFunc.keys()].filter((k) => !ALLOWED.has(k))
  assert.deepEqual(
    unexpected,
    [],
    `表单控件出现在非预期函数里：${unexpected.map((k) => `${k}(L${byFunc.get(k).join(',L')})`).join(', ')}`,
  )
})

/* ------------------------------------------------------------------ *
 * C5 只读三字段在 EntryEditor 里只以 ReadOnlyBlock 呈现
 * ------------------------------------------------------------------ */
test('C5 EntryEditor 里 编号/主要内容/时距 只经 ReadOnlyBlock 呈现，无编辑控件', () => {
  const lines = CLIENT.split(/\r?\n/)
  const s = lines.findIndex((l) => /function EntryEditor\(/.test(l))
  const e = lines.findIndex((l) => /function EntriesPage\(/.test(l))
  assert.ok(s !== -1 && e !== -1 && e > s, '未能定位 EntryEditor 段落')

  const seg = lines.slice(s, e)
  const readonlyFields = ['编号', '主要内容', '时距']

  for (const f of readonlyFields) {
    // 作为"可编辑字段键"出现（形如 字段: { ... } 绑到表单）不允许
    const asEditKey = seg.filter((l) => new RegExp(`${f}\\s*:\\s*\\{`).test(l))
    assert.deepEqual(asEditKey, [], `${f} 不得作为可编辑字段对象出现：${asEditKey.join(' | ')}`)
  }

  // 三个字段都必须经 ReadOnlyBlock 渲染
  const roLines = seg.filter((l) => l.includes('ReadOnlyBlock'))
  assert.ok(roLines.length >= 3, `EntryEditor 应至少 3 处 ReadOnlyBlock（编号/主要内容/时距），实际 ${roLines.length}`)

  // 设计意图：只读靠"不存在可写控件"，不靠 disabled/readonly 属性
  const disabledInSeg = seg.filter((l) => /\bdisabled\b|\breadOnly\b/.test(l) && /ReadOnly/.test(l))
  assert.deepEqual(
    disabledInSeg,
    [],
    '只读不应依赖 disabled/readonly 属性（属性可被绕过或误改），应靠不存在可写控件',
  )
})

/* ------------------------------------------------------------------ *
 * C6 页面组件里不得出现「未声明的自由变量」
 *
 * 事故背景（v1.4.2）：设置页「版本与更新」卡片直接写了 `update && update.hasUpdate`，
 * 但该作用域里只有 `const s = settings || {}`，`update` 从未声明。
 * 结果一进设置页就抛 `ReferenceError: update is not defined`，被错误边界接住，
 * 整块显示成「这个页面渲染出错」。`node --check`、`new Function` 全都查不出来
 * ——它们是**语法**检查，未声明标识符是**运行时**错误。
 *
 * 这里用纯文本静态分析（不执行、不模拟 React/DOM）做一层兜底：
 * 把函数体里的标识符引用与「声明集合」比一遍，多出来的就是可疑的自由变量。
 *
 * 已知局限（如实说明，不假装完备）：
 *   · 只能看函数体内声明的变量，模块级/外层作用域的靠 KNOWN_OUTER 白名单补齐
 *   · 正则做不到了解作用域嵌套，嵌套函数声明的名字会被放宽（宁可漏报，不可误报）
 * ------------------------------------------------------------------ */

/** 模块外层就能拿到的名字：外层的 const/function，React/h，以及 JS 全局。 */
const KNOWN_OUTER = new Set([
  // 外层作用域（factory 内定义的通用件）
  'React', 'h', 'NS', 'CSS', 'api',
  'DtmWarn', 'DtmErrorBoundary', 'DtmTabs', 'DtmModal', 'BackupDialogs', 'TagsEditor',
  'EntryEditor', 'EntryTable', 'FilterBar', 'OverviewBar', 'Pager', 'ReadOnlyCell',
  'ReadOnlyBlock', 'SettingsPage', 'EntriesPage', 'PageShell', 'BundleConfigPage',
  'translateOf', 'focusableIn',
  // JS 内建
  'Promise', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'JSON', 'Math',
  'Set', 'Map', 'Error', 'RegExp', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'isFinite',
  // 宿主 / 浏览器
  'window', 'document', 'console', 'setTimeout', 'clearTimeout', 'localStorage',
])

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'function', 'return', 'new', 'typeof', 'catch', 'else',
  'try', 'do', 'break', 'continue', 'case', 'default', 'in', 'of', 'instanceof', 'void',
  'delete', 'throw', 'yield', 'await', 'async', 'class', 'extends', 'super', 'const', 'let',
  'var', 'true', 'false', 'null', 'undefined', 'this', 'arguments', 'NaN', 'Infinity',
])

/** 把注释和字符串内容替换成空格（保持偏移不变，避免误判位置关系）。 */
function stripCommentsAndStrings(code) {
  let out = ''
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') { out += ' '; i++ }
      out += '\n'
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += ' '
      i++
      while (i < code.length) {
        if (code[i] === '\\') { out += '  '; i += 2; continue }
        if (code[i] === q) { out += ' '; break }
        out += code[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    // 正则字面量：`/.../flags`。不单独处理的话，`/[:.]/g` 里的 g、
    // `/\/$/` 里的 $ 会被当成自由变量误报（C6 首版就踩了）。
    // 判据：`/` 前面是分隔符（运算符、括号、逗号、等号、return 等），
    // 说明这是正则起点而不是除号。
    if (c === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1)
      const prevWord = out.replace(/\s+$/, '').match(/[A-Za-z_$][\w$]*$/)
      const isRegexStart =
        prev === '' || /[=(,:[!&|?{};+\-*%~^<>]/.test(prev)
        || (prevWord && /^(return|typeof|case|in|of|delete|void)$/.test(prevWord[0]))
      if (isRegexStart) {
        out += ' '
        i++
        let closed = false
        let inClass = false
        while (i < code.length) {
          const d = code[i]
          if (d === '\\') { out += '  '; i += 2; continue }
          if (d === '\n') break
          if (d === '[') inClass = true
          else if (d === ']') inClass = false
          else if (d === '/' && !inClass) { out += ' '; closed = true; i++; break }
          out += ' '
          i++
        }
        // flags（g / i / m / u / y / s / d）
        if (closed) {
          while (i < code.length && /[dgimsuvy]/.test(code[i])) { out += ' '; i++ }
        }
        i--
        continue
      }
    }
    out += c
  }
  return out
}

/** 取 `function NAME(` 的形参名列表 + 函数体文本。
 *
 * 形参必须在扫描里算作「已声明」——否则 `props` / `api` / `t` 全成误报。
 * 返回 { params: string[], body: string }。
 */
function functionParts(code, name) {
  const i = code.indexOf(`function ${name}(`)
  if (i < 0) return null
  const lp = code.indexOf('(', i)
  let depthP = 0
  let rp = -1
  for (let j = lp; j < code.length; j++) {
    if (code[j] === '(') depthP++
    else if (code[j] === ')') {
      depthP--
      if (depthP === 0) { rp = j; break }
    }
  }
  if (rp < 0) return null
  const params = code
    .slice(lp + 1, rp)
    .split(',')
    .map((x) => x.trim().replace(/^[\{\[]|[\}\]]$/g, '').split('=')[0].split(':')[0].trim())
    .filter(Boolean)

  const b = code.indexOf('{', rp)
  if (b < 0) return null
  let depth = 0
  for (let j = b; j < code.length; j++) {
    if (code[j] === '{') depth++
    else if (code[j] === '}') {
      depth--
      if (depth === 0) return { params, body: code.slice(b + 1, j) }
    }
  }
  return null
}

/** 收集一段代码里所有「声明」出来的名字。 */
function declaredNames(code) {
  const declared = new Set()
  const add = (raw) => {
    const n = String(raw || '')
      .trim()
      .replace(/^[\{\[]|[\}\]]$/g, '')
      .split('=')[0]
      .split(':')
      .pop()
      .trim()
    if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n)
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([\{\[][^\}\]]*[\}\]])\s*=/g)) {
    m[1].split(',').forEach(add)
  }
  for (const m of code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) add(m[1].split(',')[0])
  for (const m of code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) m[1].split(',').forEach(add)
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) m[1].split(',').forEach(add)
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1])
  for (const m of code.matchAll(/\bcatch\s*\(\s*([\w$]+)/g)) add(m[1])
  return declared
}

test('C6 页面组件内没有未声明的自由变量（防 ReferenceError 红框）', () => {
  const raw = CLIENT
  for (const fnName of ['SettingsPage', 'EntriesPage']) {
    const parts = functionParts(raw, fnName)
    assert.ok(parts, `未能定位 ${fnName} 函数体`)

    const code = stripCommentsAndStrings(parts.body)
    const declared = declaredNames(code)
    // 形参也算已声明（props / api / t 都是从这里来的）
    parts.params.forEach((p) => declared.add(p))
    const free = new Set()

    for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0]
      const before = code.slice(0, m.index).replace(/\s+$/, '')
      // 属性访问 a.b / ?.b 跳过
      if (before.endsWith('.')) continue
      // 前一个字符是标识符字符 → 这是长名字的一部分，正则不会这样切，保险起见跳过
      if (/[A-Za-z0-9_$]$/.test(before)) continue
      // 对象字面量的 key：`foo: value`
      const after = code.slice(m.index + name.length).replace(/^\s+/, '')
      if (after.startsWith(':')) continue
      if (KEYWORDS.has(name)) continue
      if (declared.has(name) || KNOWN_OUTER.has(name)) continue
      free.add(name)
    }

    assert.deepEqual(
      [...free],
      [],
      `${fnName} 里出现未声明的变量：${[...free].join(', ')}\n`
        + '未声明变量在运行时抛 ReferenceError，语法检查（node --check / new Function）查不出来。\n'
        + '要么在函数体里声明它，要么从 props / 宿主返回值里显式取一次。',
    )
  }
})
