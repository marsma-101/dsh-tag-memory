/**
 * paths.noversion.test — 仓库内路径字符串不得出现版本号
 *
 * 主子明确要求（2026-11-06）：
 *   「这个是 v1，而且是内部记录版本，不显示在插件上，插件名不变，文件夹也需要用插件名。」
 *
 * 为什么单独立一条测试：
 *   版本化路径（`dsh-tag-memory-v2/`、`tag-memory-2.0.0/`）有三个实际危害：
 *     ① 数据目录一旦带版本号，升级就换目录 → 用户数据"消失"（其实在旧目录里）
 *     ② 部署脚本/文档里的路径会随版本漂移，每次发版都要手工改
 *     ③ 补丁 id 与路径不一致时排查困难（P0-1 就是这么烧掉的半天）
 *
 * 判定口径（重要，避免误报）：
 *   ✅ 只查**代码/配置**里的路径字符串字面量（'...' / "..." / `...`）
 *   ❌ 不查文档、注释、测试自身的说明文字
 *   ❌ 不查语义上合理的版本号：package.json 的 version 字段、依赖版本、SemVer 比较
 *
 * 这条测试只盯「看起来像路径、却带版本号」的字符串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listRuntimeSources, readText } from '../_helpers.mjs'

/** 只检查运行时源码（.js/.mjs），不含 documents/tests。 */
const SOURCES = listRuntimeSources(['.js', '.mjs'])

/**
 * 从一行代码里剥掉注释，只留代码部分。
 * 与 purity.j.test 同样的口径：注释里提到版本号不算违规。
 */
function stripComment(line) {
  const t = line
  // 整行注释
  const trimmed = t.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  // 行尾注释（粗暴但够用：先找 `//` 且前面不是 `:`）
  const idx = t.indexOf('//')
  if (idx >= 0 && t[idx - 1] !== ':') return t.slice(0, idx)
  return t
}

/** 提取代码里的字符串字面量（单引号 / 双引号 / 反引号）。 */
function stringLiterals(code) {
  const out = []
  const re = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g
  for (const m of code.matchAll(re)) out.push(m[0].slice(1, -1))
  return out
}

/**
 * 违规模式：路径分隔符后面紧跟一个带版本号的目录段。
 *
 * 命中示例（应为违规）：
 *   /opt/dsh/tag-memory-v2        ← -v2
 *   plugins/dsh-tag-memory-2.0.0  ← -2.0.0
 *   C:\...\tag-memory-1.2.3
 *
 * 不命中（应为合法）：
 *   'version'                     ← 不是路径
 *   node:v22                     ← 不是路径分隔符上下文
 *   'M-20261106-001'             ← 不是版本号形态
 */
const VERSIONED_PATH = /[\\/][A-Za-z0-9_.@-]*?-v?\d+(?:\.\d+){0,2}(?=[\\/'"`]|$)/

test('N1 运行时源码的路径字符串字面量里不得出现版本号目录', () => {
  const violations = []

  for (const f of SOURCES) {
    const lines = readText(f).split(/\r?\n/)
    lines.forEach((line, i) => {
      const code = stripComment(line)
      if (code === '') return
      for (const lit of stringLiterals(code)) {
        if (!VERSIONED_PATH.test(lit)) continue
        // 白名单：明确的版本号语义（不是路径）
        if (/^(version|engines|dependencies)$/i.test(lit)) continue
        violations.push(`${f}:${i + 1}: ${JSON.stringify(lit)}`)
      }
    })
  }

  assert.deepEqual(
    violations,
    [],
    '路径字符串里不得出现版本号（主子明确要求"文件夹也需要用插件名"）：\n' + violations.join('\n'),
  )
})

test('N2 package.json 的 version 仍是内部记录用的版本号（不参与路径）', () => {
  // 这条是**正向**断言：版本号本身该保留，只是不许进路径。
  // 同时防止有人为了过 N1 把 version 删了（那会破坏 npm 语义）。
  const pkg = JSON.parse(readText('package.json'))
  assert.equal(typeof pkg.version, 'string', 'package.json 必须保留 version（内部版本号）')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, `version 应是 SemVer，实际 ${pkg.version}`)
  assert.equal(pkg.name, 'dsh-tag-memory', '包名必须等于插件名（不含版本号）')
})

test('N3 数据目录常量不含版本号', async () => {
  const { DATA_DIR_NAME } = await import('../../lib/engine/core.mjs')
  assert.equal(DATA_DIR_NAME, 'tag-memory', '数据目录名必须用插件名，不带版本号')
  assert.ok(!VERSIONED_PATH.test('/x/' + DATA_DIR_NAME), `DATA_DIR_NAME 命中了版本号模式：${DATA_DIR_NAME}`)
})
