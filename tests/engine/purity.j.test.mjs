// 闸门① J 组：纯度边界（3 条）
//
// 依据：《团队_子智能体说明》E 边界、《接口契约》§一、《架构说明》§4.1、
//       《功能说明》§十四「引擎层」。
// 核心：lib/engine/* 不知道 Cordis 存在，能脱离框架单测。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listRuntimeSources, readText } from '../_helpers.mjs'

const ENGINE_SOURCES = listRuntimeSources(['.js', '.mjs']).filter((f) => f.startsWith('lib/engine/'))

/* ------------------------------------------------------------------ *
 * J1 零 Cordis / 零 DSH 依赖
 * ------------------------------------------------------------------ */
test('J1 lib/engine/** 零 cordis / @deepseek-ai 依赖，且能直接 import', () => {
  assert.ok(ENGINE_SOURCES.length > 0, '未找到任何 lib/engine 源文件')

  const violations = []
  const importRe = /(?:^\s*import\s+[^;]*?from\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm

  for (const f of ENGINE_SOURCES) {
    const text = readText(f)
    for (const m of text.matchAll(importRe)) {
      const spec = m[1]
      // 只允许 node: 内置 与相对路径
      const isNodeBuiltin = spec.startsWith('node:')
      const isRelative = spec.startsWith('./') || spec.startsWith('../')
      if (!isNodeBuiltin && !isRelative) {
        violations.push(`${f}: import "${spec}"`)
      }
      if (/cordis|@deepseek-ai/i.test(spec)) {
        violations.push(`${f}: 引了框架依赖 "${spec}"`)
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `lib/engine 必须零框架依赖（只能 node: 内置 + 相对路径），发现：\n${violations.join('\n')}`,
  )

  // 源码里不得出现 cordis / ctx. 这类框架符号
  const symbolHits = []
  for (const f of ENGINE_SOURCES) {
    const lines = readText(f).split(/\r?\n/)
    lines.forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return // 注释里提到不算
      if (/\bcordis\b/i.test(line)) symbolHits.push(`${f}:${i + 1}: ${t}`)
    })
  }
  assert.deepEqual(symbolHits, [], `引擎代码不得引用 cordis：\n${symbolHits.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * J2 引擎不直接写 records/*.jsonl —— 只返回"该写什么"
 * ------------------------------------------------------------------ */
test("J2 引擎不直接写 records/*.jsonl，只返回『该写什么』（build* 形态）", () => {
  // 引擎里允许有 appendJsonl（通用落盘薄封装，由 host 调用），
  // 但**不得**在 read/write 流程内部自己拼路径并落盘。
  // 判据：read.jsonl / write.jsonl / tidy.jsonl 的电话号码不得出现在引擎里。
  const hits = []
  for (const f of ENGINE_SOURCES) {
    const text = readText(f)
    for (const name of ['read.jsonl', 'write.jsonl', 'tidy.jsonl']) {
      const lines = text.split(/\r?\n/)
      lines.forEach((line, i) => {
        if (!line.includes(name)) return
        const t = line.trim()
        // 注释里说明不算
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
        // 文档字符串/普通文案里提到也不算（如 message 文案）
        if (/['"`]/.test(t) && !/path\.join|appendJsonl|writeFile|createWriteStream/.test(t)) return
        hits.push(`${f}:${i + 1}: ${t}`)
      })
    }
  }

  assert.deepEqual(
    hits,
    [],
    `引擎不得自己落盘 records/*.jsonl（路径应由 host 传入），发现疑似：\n${hits.join('\n')}`,
  )

  // 正向验证：read.mjs / write.mjs 提供 build* 函数（"该写什么"）
  const readSrc = readText('lib/engine/read.mjs')
  const writeSrc = readText('lib/engine/write.mjs')
  assert.match(readSrc, /export\s+function\s+buildReadLog/, 'read.mjs 必须导出 buildReadLog')
  assert.match(writeSrc, /export\s+function\s+buildWriteLog/, 'write.mjs 必须导出 buildWriteLog')
})

/* ------------------------------------------------------------------ *
 * J3 import 无副作用：不产生文件、不起 timer、不读 HOME
 * ------------------------------------------------------------------ */
test('J3 import 引擎无副作用：不产生文件、不起 timer、不读 HOME', () => {
  const hits = []

  for (const f of ENGINE_SOURCES) {
    const lines = readText(f).split(/\r?\n/)
    lines.forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return

      // 顶层 setInterval / setTimeout 会阻止进程退出
      if (/^setInterval\s*\(/.test(t) || /^setTimeout\s*\(/.test(t)) {
        hits.push(`${f}:${i + 1}: 顶层 timer（应放 host 并 .unref()）: ${t}`)
      }
      // 读 HOME / USERPROFILE
      if (/process\.env\.(HOME|USERPROFILE)/.test(line)) {
        hits.push(`${f}:${i + 1}: 读 HOME: ${t}`)
      }
      // 直接读 process.env（配置应通过入参/Config 传，便于测试）
      if (/process\.env\./.test(line) && !/NODE_ENV/.test(line)) {
        hits.push(`${f}:${i + 1}: 引擎不应直接读 process.env（应由入参传入）: ${t}`)
      }
    })
  }

  assert.deepEqual(hits, [], `引擎 import 必须无副作用：\n${hits.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * J-附加 引擎模块可被独立 import（每个都有导出）
 * ------------------------------------------------------------------ */
test('J-附加 每个引擎模块都有导出（可被独立 import 单测）', async () => {
  const modules = ENGINE_SOURCES.filter((f) => f.endsWith('.mjs'))
  assert.ok(modules.length >= 6, `引擎模块应至少 6 个，实际 ${modules.length}`)

  for (const f of modules) {
    const abs = join(process.cwd(), f.split('/').join('\\'))
    const mod = await import(`file:///${abs.replace(/\\/g, '/')}`)
    const names = Object.keys(mod)
    assert.ok(names.length > 0, `${f} 必须至少导出一个符号（否则无法单测）`)
  }
})
