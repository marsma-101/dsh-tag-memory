// 闸门③ Q 组：语法检查（2 条）
//
// 依据：《架构说明》§十二.3、《功能说明》§十四「客户端」。
// 边界（官方 verification.md + Lead 裁定）：
//   - Qa1 用 `node --check`（子进程）；沙箱禁管道 → 用文件重定向捕获输出
//   - Qa2 客户端文件只用 `new Function(src)` 做**语法**解析，
//     **绝不执行、绝不模拟 React/DOM**（不是渲染验证）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { openSync, closeSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT, listRuntimeSources, readText } from '../_helpers.mjs'

/**
 * 用 `node --check` 检查单文件语法。
 * 沙箱禁止管道捕获 → 把 stdout/stderr 重定向到临时文件再读回。
 */
function nodeCheck(relPath) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-syntax-'))
  const log = join(dir, 'out.txt')
  try {
    const fd = openSync(log, 'w')
    let res
    try {
      res = spawnSync(process.execPath, ['--check', relPath], {
        cwd: ROOT,
        stdio: ['ignore', fd, fd],
      })
    } finally {
      closeSync(fd)
    }
    const output = readFileSync(log, 'utf8')
    return { status: res.status, error: res.error, output }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * Qa1 全部 .js / .mjs 通过 node --check
 * ------------------------------------------------------------------ */
test('Qa1 全部 .js/.mjs 通过 node --check（失败须报文件名 + 行号）', () => {
  const sources = listRuntimeSources(['.js', '.mjs'])
  assert.ok(sources.length > 0, '未找到任何 .js/.mjs 源文件')

  const failures = []
  for (const f of sources) {
    const { status, error, output } = nodeCheck(f)
    if (error) {
      failures.push(`${f}: 无法执行 node --check（${error.code || error.message}）`)
      continue
    }
    if (status !== 0) {
      failures.push(`${f}:\n${output.trim().split('\n').slice(0, 6).join('\n')}`)
    }
  }

  assert.deepEqual(
    failures,
    [],
    `以下文件语法检查未通过（共检查 ${sources.length} 个）：\n${failures.join('\n\n')}`,
  )
})

/* ------------------------------------------------------------------ *
 * Qa2 客户端文件：语法可解析（new Function），不执行、不模拟 DOM
 * ------------------------------------------------------------------ */
test('Qa2 客户端文件语法可解析（new Function，不执行、不模拟 DOM）', () => {
  const clientFiles = listRuntimeSources(['.js']).filter((f) => /(^|\/)client[\w.-]*\.js$/.test(f))
  assert.ok(clientFiles.length > 0, '未找到任何 client*.js')

  for (const f of clientFiles) {
    const src = readText(f)
    // new Function 只做**语法**解析：不运行函数体，不接触 window / document / React
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(src)
    }, `${f} 语法无法解析`)
  }
})
