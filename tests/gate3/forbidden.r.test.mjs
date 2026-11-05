// 闸门③ R 组：禁止项检查（8 条）
//
// 依据：《架构说明》§五/§十三、《功能说明》§十四「客户端」「安全与接口」、
//       官方 references/practices.md、user-actions.md、verification.md。
// Lead 裁定：R4 字面色白名单只放 artwork（icon.svg）；R8 命令前缀 dtm-ui- 与工具 dtm_ 区分。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { listRuntimeSources, readText } from '../_helpers.mjs'

/** 只扫源码（.js / .mjs），不扫 md/json/svg */
const SOURCES = listRuntimeSources(['.js', '.mjs'])

/** 客户端源码（浏览器侧） */
const CLIENT_SOURCES = SOURCES.filter((f) => /(^|\/)client[\w.-]*\.js$/.test(f))

/** 读所有源码拼成 { 文件: 内容 } */
function allSourceTexts() {
  const map = {}
  for (const f of SOURCES) map[f] = readText(f)
  return map
}

/** 在一批文件里找匹配行，返回 "文件:行号: 内容" 列表 */
function findIn(fileList, regex) {
  const hits = []
  for (const f of fileList) {
    const lines = readText(f).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) hits.push(`${f}:${i + 1}: ${lines[i].trim()}`)
    }
  }
  return hits
}

/* ------------------------------------------------------------------ *
 * R1 不 import 任何 Harness Client 包
 * ------------------------------------------------------------------ */
test('R1 不 import 任何 @deepseek-ai/dsh-client-* 包（含 -ui-primitives）', () => {
  const re = /(?:from|require\(|import\()\s*['"]@deepseek-ai\/dsh-client[^'"]*['"]/
  const hits = findIn(SOURCES, re)
  assert.deepEqual(hits, [], `禁止 import Harness Client 包，发现：\n${hits.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * R2 不用 iframe 载入宿主 HTML
 * ------------------------------------------------------------------ */
test('R2 客户端不用 iframe（含 createElement("iframe")）', () => {
  const hits = findIn(CLIENT_SOURCES, /<iframe|createElement\(\s*['"]iframe['"]\s*\)/i)
  assert.deepEqual(hits, [], `禁止 iframe 载入宿主 HTML，发现：\n${hits.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * R3 无自建 HTTP 前缀 / 无自做鉴权
 * ------------------------------------------------------------------ */
test('R3 无自建 HTTP 前缀、无 requestRejection 自鉴权', () => {
  const patterns = [
    { name: '自建前缀 /tag-memory-api', re: /\/tag-memory-api/ },
    { name: 'requestRejection 自鉴权', re: /requestRejection/ },
    { name: '自起 HTTP 服务 createServer', re: /createServer\s*\(/ },
    { name: '自起 HTTP 服务 .listen(', re: /\.listen\s*\(/ },
    { name: 'express 框架', re: /\bfrom\s+['"]express['"]|require\(\s*['"]express['"]\s*\)/ },
  ]

  const hits = []
  for (const { name, re } of patterns) {
    for (const h of findIn(SOURCES, re)) hits.push(`[${name}] ${h}`)
  }

  assert.deepEqual(hits, [], `禁止自建通道（应走官方 Remote/命令入口），发现：\n${hits.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * R4 客户端样式无字面色（artwork 例外：icon.svg 不是 CSS）
 * ------------------------------------------------------------------ */
test('R4 客户端 CSS 无字面色（#rrggbb / rgb() / hsl()）—— artwork 例外', () => {
  // 只查 CSS 语境：客户端源码里的样式字符串。
  // icon.svg 是 artwork，不在此列（R4 裁定）。
  const hexRe = /#[0-9a-fA-F]{3,8}\b/
  const fnRe = /\b(?:rgb|rgba|hsl|hsla)\s*\(/

  const hits = []
  for (const f of CLIENT_SOURCES) {
    const lines = readText(f).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 跳过纯注释行（说明性文字里出现色值不算样式）
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      if (hexRe.test(line) || fnRe.test(line)) {
        hits.push(`${f}:${i + 1}: ${trimmed}`)
      }
    }
  }

  assert.deepEqual(
    hits,
    [],
    `客户端样式必须只用 --dsw-alias-* 主题 token，禁止字面色（artwork 例外）：\n${hits.join('\n')}`,
  )
})

/* ------------------------------------------------------------------ *
 * R5 客户端使用的 CSS 变量必须是真实存在的主题 token
 *
 * 规格原文（《架构说明》§十三）：「客户端样式只用 Theme 列出的 --dsw-alias-* token」。
 * 这条拆成两级，因为两者严重性不同，不能混为一谈：
 *   R5a【硬失败】变量在本机主题包里**根本不存在** → 明暗主题下必然渲染异常，属真 bug
 *   R5b【规格偏差】变量真实存在，但**不是 --dsw-alias-* 前缀** → 能用，但偏离规格原文
 * R5b 不由我判"通过"或"不通过"，报给 Lead 定（纪律：不放宽、不擅判）。
 * ------------------------------------------------------------------ */
const THEME_FILE =
  'C:/Users/Administrator/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'

test('R5a 客户端 CSS 变量全部在本机主题包中真实存在（不存在 = 硬失败）', () => {
  const used = new Set()
  for (const f of CLIENT_SOURCES) {
    for (const m of readText(f).matchAll(/var\(\s*(--[\w-]+)/g)) used.add(m[1])
  }

  if (used.size === 0) return // 客户端还没写样式，不算失败

  let themeText = null
  try {
    // 直接读绝对路径（node:fs 可直接吃 Windows 绝对路径）
    themeText = readFileSync(THEME_FILE, 'utf8')
  } catch {
    assert.fail(`无法读取主题包以复核 token 真实性：${THEME_FILE}（复核不了就如实报，不能跳过）`)
  }

  const missing = [...used].filter((v) => !themeText.includes(`${v}:`))
  assert.deepEqual(
    missing,
    [],
    `以下 CSS 变量在主题包里不存在，明暗主题下会渲染异常：${missing.join(', ')}`,
  )
})

/* ------------------------------------------------------------------ *
 * R5b 客户端样式 token 前缀（依据《架构说明》§13.2，Lead 2026-11-05 裁定）
 *
 * 裁定原文（《架构说明》§13.2）：
 *   「只用主题包中真实存在的 token；能对上 --dsw-alias-* 的必须用 alias，
 *     对不上的允许用系统级 token。」
 *   「唯一豁免：--ds-font-family-code」——它是一条两层回退链
 *    var(--dsh-font-family-code, var(--dsh-font-family-code-default))，
 *    内联会拍平用户的字体自定义能力（功能退化，不是审美问题）。
 *
 * 为什么放宽（三条实测事实，qa 与 client-dev 各自独立复核）：
 *   1. --dsw-alias-* 共 107 个，其中 font / radius / transition / elevation 类为 0 个
 *      —— 这些类别在设计系统里没有 alias 对应物
 *   2. 若强制改成 alias，只能写死 8px / .1s 这类具体值 → 反而变成硬编码，比现状更差
 *   3. 官方参考页 dsh-client-ui-plugin-manager（practices.md 明说"management lists 照它抄"）
 *      自己也在用 var(--ds-font-family-code)；该 token 被 15 个官方包使用
 *
 * 这是对官方 practices.md:35「keep only --dsw-alias-*」的**有据放宽**，不是随手放水。
 * 留痕理由：若日后要收紧，需先推翻上面三条事实。
 *
 * 执行口径：
 *   · 纯常量（radius / transition / ease）→ 已内联，不再作为 token 出现
 *   · 可覆盖变量链（font-family）→ 保留 --ds-font-family-code（唯一豁免）
 *   · **字面色依旧绝对禁止**（artwork 除外）—— 由 R4 独立把守，不放宽
 * ------------------------------------------------------------------ */

/** §13.2 裁定的唯一豁免项。要改动这里必须先改《架构说明》§13.2。 */
const ALLOWED_NON_ALIAS = ['--ds-font-family-code']

test('R5b 客户端 CSS 变量：alias 优先，唯一豁免 --ds-font-family-code（《架构说明》§13.2）', () => {
  const used = new Set()
  for (const f of CLIENT_SOURCES) {
    for (const m of readText(f).matchAll(/var\(\s*(--[\w-]+)/g)) used.add(m[1])
  }

  const nonAlias = [...used].filter((v) => !v.startsWith('--dsw-alias-')).sort()
  const unexpected = nonAlias.filter((v) => !ALLOWED_NON_ALIAS.includes(v))

  assert.deepEqual(
    unexpected,
    [],
    `《架构说明》§13.2 规定：能对上 --dsw-alias-* 的必须用 alias，唯一豁免是 ${ALLOWED_NON_ALIAS.join(', ')}。\n` +
      `发现 ${unexpected.length} 个超出豁免范围的非 alias 变量：\n  ${unexpected.join('\n  ')}\n` +
      '（若确实需要新增豁免，须先改《架构说明》§13.2 并重新论证三条事实）',
  )

  // 豁免项也不能凭空多出来：若豁免项已不再使用，说明可收窄规则（提示，不判失败）
  const exemptionUnused = ALLOWED_NON_ALIAS.filter((v) => !used.has(v))
  if (exemptionUnused.length > 0) {
    console.log(
      `\n[R5b 提示] 豁免项已不再使用：${exemptionUnused.join(', ')}` +
        ' —— 可考虑收窄 §13.2 的豁免范围\n',
    )
  }

  // 把实际用到的 token 分类打印出来，便于人工复核
  const alias = [...used].filter((v) => v.startsWith('--dsw-alias-')).sort()
  console.log(`\n[R5b 实测] 共 ${used.size} 个 token：alias ${alias.length} 个 + 豁免 ${nonAlias.length} 个\n`)
})

/* ------------------------------------------------------------------ *
 * R6 对宿主的所有调用收口在 client.api.js，且不是 HTTP
 * ------------------------------------------------------------------ */
test('R6 客户端对宿主的调用不是 fetch/axios/XHR（走官方 Remote/命令入口）', () => {
  const patterns = [
    { name: 'fetch(', re: /(^|[^.\w])fetch\s*\(/ },
    { name: 'axios', re: /\baxios\b/ },
    { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
    { name: 'WebSocket', re: /\bnew\s+WebSocket\b/ },
  ]

  const hits = []
  for (const { name, re } of patterns) {
    for (const h of findIn(CLIENT_SOURCES, re)) hits.push(`[${name}] ${h}`)
  }

  assert.deepEqual(hits, [], `客户端不得用 HTTP 客户端/裸连接调宿主，发现：\n${hits.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * R7 隐私：无硬编码 token/密钥、不篡改 HOME
 * ------------------------------------------------------------------ */
test('R7 无硬编码 token/密钥；不篡改 HOME 或浏览器配置', () => {
  const patterns = [
    { name: '疑似硬编码密钥', re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i },
    { name: '篡改 HOME', re: /\bprocess\.env\.HOME\s*=|process\.env\.USERPROFILE\s*=/ },
    { name: '翻浏览器配置', re: /(?:Chrome|Chromium|Firefox|Edge)\/(?:User Data|Profiles|Cookies)/i },
  ]

  const hits = []
  for (const { name, re } of patterns) {
    for (const h of findIn(SOURCES, re)) hits.push(`[${name}] ${h}`)
  }

  assert.deepEqual(hits, [], `隐私/验证纪律问题，发现：\n${hits.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * R8 命名前缀：工具 dtm_* / UI 命令 dtm-ui-*，两者不混
 * ------------------------------------------------------------------ */
test('R8 工具名用 dtm_ 前缀，UI 命令用 dtm-ui- 前缀，不混用', () => {
  const map = allSourceTexts()

  // 收集所有字面量形式的命令/工具名
  const uiCommands = new Set()
  const toolNames = new Set()

  for (const [f, text] of Object.entries(map)) {
    // ctx.commands.register({ name: 'xxx' })
    for (const m of text.matchAll(/ctx\.commands\.register\(\s*\{[\s\S]{0,200}?name\s*:\s*['"]([^'"]+)['"]/g)) {
      uiCommands.add(`${f}::${m[1]}`)
    }
    // defineTool({ name: 'xxx' })
    for (const m of text.matchAll(/defineTool\(\s*\{[\s\S]{0,200}?name\s*:\s*['"]([^'"]+)['"]/g)) {
      toolNames.add(`${f}::${m[1]}`)
    }
  }

  // 断言：工具名必须是 dtm_ 前缀（不能带 -）
  const badTools = [...toolNames].filter((entry) => {
    const name = entry.split('::')[1]
    return !/^dtm_[a-z0-9_]+$/.test(name)
  })
  assert.deepEqual(badTools, [], `工具名必须是 dtm_ 前缀（下划线），发现：${badTools.join(', ')}`)

  // 断言：UI 命令名若是本插件自己的，必须用 dtm-ui- 前缀
  const badUi = [...uiCommands].filter((entry) => {
    const name = entry.split('::')[1]
    // 只审我们自己命名空间的命令（dtm 开头）；别人的命令不管
    if (!/^dtm/i.test(name)) return false
    return !/^dtm-ui-[a-z0-9-]+$/.test(name)
  })
  assert.deepEqual(badUi, [], `UI 命令名必须用 dtm-ui- 前缀（连字符），发现：${badUi.join(', ')}`)
})
