// 坏库防护回归（2026-11-12，容器审查 P1-3/P1-4）
//
// 守两件事：
//   ① 表头坏了（HEADER_MISSING）≠ 空库：write 必须拒写、recall 必须报格式问题，
//      不能把「一行都没读进来」伪装成「库里没有」，否则坏库越写越大、编号撞车。
//   ② 有坏行时召回的时距落盘必须跳过：writeLibraryCsv 是整库重写，会把坏行
//      「尽力解析」成缺字段行再写回，原始字节永久丢失（用户手工修复的物证被抹掉）。
//
// 负对照（ci-test-reliability：新守卫要能变红）：把库换成坏表头/坏行，断言守卫生效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

const HEADER = '编号,主要内容,形态,项目,智能体,自由标签,稳定性,时距,状态'

function libPath(dataDir) {
  return join(dataDir, 'store', 'memory.csv')
}

/** 预置一份库内容（在 makeHostCtx 之后写，覆盖空库）。 */
function seedLib(dataDir, content) {
  mkdirSync(join(dataDir, 'store'), { recursive: true })
  writeFileSync(libPath(dataDir), content, 'utf8')
}

const INPUT = {
  主要内容: '坏库防护测试条目',
  形态: '技能',
  自由标签: ['坏库防护'],
}

test('P1-3 表头缺失 → write 拒写（LIBRARY_FORMAT_MISMATCH），不 append 新行', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dtm-badlib-'))
  const h = await makeHostCtx({ identity: BOUND, dataDir })
  try {
    // 坏表头：列名对不上 → readLibraryCsv 返回 HEADER_MISSING + 空 records
    seedLib(dataDir, 'wrong,header,cols\nM-20261112-001,x,技能,通用,通用,a,观察,1,生效\n')
    const before = readFileSync(libPath(dataDir), 'utf8')

    const w = await h.host.writeEntry(h.agent, INPUT)
    assert.equal(w.ok, false, '表头坏了必须拒写，不能当空库继续 append')
    assert.ok(
      JSON.stringify(w).includes('LIBRARY_FORMAT_MISMATCH') || JSON.stringify(w).includes('HEADER_MISSING'),
      `要报格式问题，实际：${JSON.stringify(w)}`,
    )
    assert.equal(readFileSync(libPath(dataDir), 'utf8'), before, '拒写后库内容必须逐字节不变')
  } finally {
    h.cleanup()
  }
})

test('P1-3 表头缺失 → recall 报格式问题，不伪装成查空', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dtm-badlib-'))
  const h = await makeHostCtx({ identity: BOUND, dataDir })
  try {
    seedLib(dataDir, 'wrong,header,cols\nM-20261112-001,x,技能,通用,通用,a,观察,1,生效\n')
    const r = await h.host.recall(h.agent, { 形态: '技能', 自由标签: ['a'] })
    assert.ok(
      r.blocked === 'LIBRARY_FORMAT_MISMATCH' || JSON.stringify(r).includes('HEADER_MISSING'),
      `recall 要报格式问题而非查空，实际：${JSON.stringify(r).slice(0, 200)}`,
    )
  } finally {
    h.cleanup()
  }
})

test('P1-4 有坏行 → 召回命中也不整库重写，坏行原始字节保留', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dtm-badlib-'))
  const h = await makeHostCtx({ identity: BOUND, dataDir })
  try {
    // 一行合法（可被命中）+ 一行列数撕裂（坏行）。合法行标签含「坏库防护」。
    const good = 'M-20261112-001,合法条目,技能,qa-project,qa-agent,坏库防护,观察,1,生效'
    const bad = 'M-20261112-002,撕裂行,技能,qa-project' // 列数不足 → ROW_CELL_COUNT
    seedLib(dataDir, `${HEADER}\r\n${good}\r\n${bad}\r\n`)
    const before = readFileSync(libPath(dataDir), 'utf8')

    const r = await h.host.recall(h.agent, { 形态: '技能', 自由标签: ['坏库防护'] })
    // 命中与否取决于隔离/打分，但无论命中与否，坏行存在时都不该整库重写
    assert.equal(
      readFileSync(libPath(dataDir), 'utf8'),
      before,
      '有坏行时召回不得整库重写（会洗掉坏行原始字节）',
    )
    assert.ok(r.ok !== false || r.blocked, 'recall 应正常返回或明确受阻，不抛错')
  } finally {
    h.cleanup()
  }
})

test('P1-4 对照：库干净 → 召回命中正常累加时距（留守卫不误伤正常路径）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dtm-badlib-'))
  const h = await makeHostCtx({ identity: BOUND, dataDir })
  try {
    const w = await h.host.writeEntry(h.agent, INPUT)
    assert.equal(w.ok, true)
    const r = await h.host.recall(h.agent, { 形态: '技能', 自由标签: ['坏库防护'] })
    assert.ok(Array.isArray(r.hits) && r.hits.length >= 1, `干净库应命中，实际：${JSON.stringify(r).slice(0, 200)}`)
    const after = readFileSync(libPath(dataDir), 'utf8')
    assert.ok(after.includes('坏库防护'), '命中后库内容仍在')
  } finally {
    h.cleanup()
  }
})
