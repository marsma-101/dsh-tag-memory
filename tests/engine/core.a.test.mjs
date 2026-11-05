// 闸门① A 组：CSV RFC4180 序列化/解析（13 条）
//
// 依据：《架构说明》§8.1、《流程_写入》§四、《功能说明》§十四「存储（CSV）」、
//       《待查证问题》问题 4 的实测结论。
// 断言按规格写，不按实现写。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  needsQuote,
  formatCsvField,
  formatCsvRow,
  serializeCsv,
  parseCsv,
  resolveColumnIndex,
  cellsToRecord,
  recordToCells,
  rowsToRecords,
  appendRecordCsv,
  readLibraryCsv,
  tagCellToArray,
} from '../../lib/engine/core.mjs'

import schema from '../../lib/engine/templates/schema.json' with { type: 'json' }

const COLUMNS = schema.columns // 9 列，顺序固定

/** 造一条完整 9 字段记录（record 形态，中文键） */
function makeRecord(over = {}) {
  return {
    编号: 'M-20261105-001',
    主要内容: '部署时先跑 build 再跑 test',
    形态: '技能',
    项目: '用户设置',
    智能体: '通用',
    自由标签: ['发版检查', '需先build'],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
    ...over,
  }
}

/** record → 单行 CSV 文本（不含表头） */
function toLine(record) {
  return formatCsvRow(recordToCells(record, schema))
}

/** 把单行数据 + 表头组成完整 CSV 文本再解析，返回 { header, rows, errors } */
function roundtrip(record) {
  const text = serializeCsv({ header: COLUMNS, rows: [recordToCells(record, schema)] })
  return parseCsv(text)
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ab-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

/* ------------------------------------------------------------------ *
 * A1 正文含 ASCII 逗号，必须 9 列不是 10 列
 * ------------------------------------------------------------------ */
test('A1 正文含逗号 → 解析列数必须是 9（不是 10）', () => {
  const content = '部署时先跑 build, 再跑 test'
  const rec = makeRecord({ 主要内容: content })
  const { header, rows, errors } = roundtrip(rec)

  assert.equal(header.length, 9, '表头必须 9 列')
  assert.equal(rows.length, 1, '必须只有 1 条数据行')
  assert.equal(rows[0].length, 9, `正文含逗号后仍须 9 格，实际 ${rows[0].length} 格`)

  const { records } = rowsToRecords({ header, rows, errors }, schema)
  assert.equal(records.length, 1)
  assert.equal(records[0]['主要内容'], content, '正文必须逐字节读回')
})

/* ------------------------------------------------------------------ *
 * A2 反面证据：朴素 split(',') 一定会把 9 列拆成 10 段
 *     这条证明实现没有走简单 split
 * ------------------------------------------------------------------ */
test('A2 反面证据：朴素 split(",") 会得到 10 段（证明实现不是简单 split）', () => {
  const rec = makeRecord({ 主要内容: '部署时先跑 build, 再跑 test' })
  const line = toLine(rec)

  const naive = line.split(',')
  assert.equal(naive.length, 10, '朴素 split 应把这一行拆成 10 段（这是不能用它的理由）')

  const correct = parseCsv(serializeCsv({ header: COLUMNS, rows: [recordToCells(rec, schema)] }))
  assert.equal(correct.rows[0].length, 9, '标准解析器必须得 9 格')
})

/* ------------------------------------------------------------------ *
 * A3 正文含双引号 → "" 转义往返
 * ------------------------------------------------------------------ */
test('A3 正文含双引号 → 落盘用 "" 转义，读回逐字节相等', () => {
  const content = '他说"别用UTC"'
  const rec = makeRecord({ 主要内容: content })
  const line = toLine(rec)

  assert.ok(line.includes('""'), '落盘必须出现 "" 转义')
  assert.equal(line.includes('他 说'), false)

  const { header, rows, errors } = roundtrip(rec)
  assert.equal(rows[0].length, 9)
  const { records } = rowsToRecords({ header, rows, errors }, schema)
  assert.equal(records[0]['主要内容'], content, '双引号必须原样还原')
})

/* ------------------------------------------------------------------ *
 * A4 正文含 \n → 引号包裹，读回仍是 1 条记录
 * ------------------------------------------------------------------ */
test('A4 正文含 \\n → 整字段被引号包裹，读回仍是 1 条记录', () => {
  const content = '第一行\n第二行'
  const rec = makeRecord({ 主要内容: content })

  assert.equal(needsQuote(content), true, '含换行必须加引号')

  const line = toLine(rec)
  assert.ok(line.startsWith('"') || line.includes('"第一行'), '含换行的字段必须以引号包裹')

  const { header, rows } = roundtrip(rec)
  assert.equal(rows.length, 1, `字段内换行不得拆成多条记录，实际 ${rows.length} 条`)
  const { records } = rowsToRecords({ header, rows, errors: [] }, schema)
  assert.equal(records[0]['主要内容'], content, '换行必须原样保留')
})

/* ------------------------------------------------------------------ *
 * A5 正文含 \r\n
 * ------------------------------------------------------------------ */
test('A5 正文含 \\r\\n → 引号包裹，\\r 不被吞、不被当记录分隔', () => {
  const content = '第一行\r\n第二行'
  const rec = makeRecord({ 主要内容: content })

  assert.equal(needsQuote(content), true, '含 CR/LF 必须加引号')

  const { header, rows } = roundtrip(rec)
  assert.equal(rows.length, 1, `字段内 \\r\\n 不得拆成多条记录，实际 ${rows.length} 条`)
  const { records } = rowsToRecords({ header, rows, errors: [] }, schema)
  assert.equal(records[0]['主要内容'], content, '\\r\\n 必须原样保留（\\r 不能被吞）')
})

/* ------------------------------------------------------------------ *
 * A6 逗号 + 引号 + 换行 组合（最易翻车）
 * ------------------------------------------------------------------ */
test('A6 正文同时含 , " \\n → 组合往返仍一致', () => {
  const content = '他问："跑 build, 还是 test?"\n我答：先 build 再 test'
  const rec = makeRecord({ 主要内容: content })

  const { header, rows } = roundtrip(rec)
  assert.equal(rows.length, 1, '组合字符不得拆行')
  assert.equal(rows[0].length, 9, `组合字符不得错列，实际 ${rows[0].length} 格`)

  const { records } = rowsToRecords({ header, rows, errors: [] }, schema)
  assert.equal(records[0]['主要内容'], content, '组合字符必须逐字节还原')
})

/* ------------------------------------------------------------------ *
 * A7 首尾空格原样保留（不 trim）
 * ------------------------------------------------------------------ */
test('A7 正文首尾空格 → 原样保留，不做 trim', () => {
  const content = '  内容  '
  const rec = makeRecord({ 主要内容: content })

  const { header, rows } = roundtrip(rec)
  const { records } = rowsToRecords({ header, rows, errors: [] }, schema)
  assert.equal(records[0]['主要内容'], content, '首尾空格必须保留')
})

/* ------------------------------------------------------------------ *
 * A8 列序打乱 → 按列名定位仍可读
 * ------------------------------------------------------------------ */
test('A8 列序打乱 → 按列名定位，仍能正确读到 9 个字段', () => {
  const shuffled = ['状态', '编号', '主要内容', '形态', '项目', '智能体', '自由标签', '稳定性', '时距']
  const rec = makeRecord({ 编号: 'M-20261105-042', 主要内容: '打乱列序, 测试', 时距: 7 })

  // 按 shuffled 顺序产出一行
  const cells = shuffled.map((col) => {
    if (col === '自由标签') return rec[col].join('|')
    return String(rec[col])
  })
  const text = serializeCsv({ header: shuffled, rows: [cells] })
  const parsed = parseCsv(text)

  const { index, missing } = resolveColumnIndex(parsed.header, schema)
  assert.deepEqual(missing, [], '打乱列序不得被判缺列')
  assert.equal(parsed.rows[0].length, 9)

  const { records, errors } = rowsToRecords(parsed, schema)
  assert.deepEqual(errors, [], '打乱列序不应产生错误')
  assert.equal(records.length, 1)
  assert.equal(records[0]['编号'], 'M-20261105-042')
  assert.equal(records[0]['主要内容'], '打乱列序, 测试')
  assert.equal(records[0]['形态'], '技能')
  assert.equal(records[0]['时距'], 7)
  assert.deepEqual(records[0]['自由标签'], ['发版检查', '需先build'])
})

/* ------------------------------------------------------------------ *
 * A9 表头缺失 → HEADER_MISSING（Q6 裁定：抛明确错误，不静默吞）
 * ------------------------------------------------------------------ */
test('A9 表头缺失 → 必须报 HEADER_MISSING，不当空库静默吞', () => {
  const onlyData = formatCsvRow(recordToCells(makeRecord(), schema))
  const text = onlyData + '\r\n'

  const parsed = parseCsv(text)
  assert.equal(parsed.header.length, 9, '（前提）第一行会被当表头读入')

  // 真正的缺表头：给一份数据行当表头，列名对不上
  const bogus = '甲,乙,丙,丁,戊,己,庚,辛,壬'
  const bogusParsed = parseCsv(bogus + '\r\n1,2,3,4,5,6,7,8,9\r\n')
  const { records, errors } = rowsToRecords(bogusParsed, schema)

  const hit = errors.find((e) => e.code === 'HEADER_MISSING')
  assert.ok(hit, `必须报 HEADER_MISSING，实际错误码：${errors.map((e) => e.code).join(',') || '（无）'}`)
  assert.deepEqual(records, [], '表头不合法时 records 必须为空')
})

/* ------------------------------------------------------------------ *
 * A10 行单元格数与表头不符 → ROW_CELL_COUNT
 * ------------------------------------------------------------------ */
test('A10 行格数与表头不符 → 报 ROW_CELL_COUNT', () => {
  // 手工造一行 10 格（模拟"正文含未转义逗号"被拆错）
  const bad = [
    'M-20261105-001',
    '部署时先跑 build',
    '再跑 test',
    '技能',
    '用户设置',
    '通用',
    '发版检查|需先build',
    '观察',
    '1',
    '生效',
  ].join(',')
  const text = COLUMNS.join(',') + '\r\n' + bad + '\r\n'
  const parsed = parseCsv(text)

  assert.equal(parsed.rows[0].length, 10, '（前提）该行确实是 10 格')
  const hit = parsed.errors.find((e) => e.code === 'ROW_CELL_COUNT')
  assert.ok(hit, `必须报 ROW_CELL_COUNT，实际：${parsed.errors.map((e) => e.code).join(',') || '（无）'}`)
  assert.equal(hit.detail.cells, 10)
  assert.equal(hit.detail.expected, 9)
})

/* ------------------------------------------------------------------ *
 * A11 引号未闭合 → CSV_UNTERMINATED_QUOTE，且不得死循环
 * ------------------------------------------------------------------ */
test('A11 引号未闭合 → 报 CSV_UNTERMINATED_QUOTE（不得静默吞或死循环）', () => {
  const text = COLUMNS.join(',') + '\r\n"没闭合的正文\r\n'
  const started = Date.now()
  const parsed = parseCsv(text)
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2000, `解析不得卡死，实际耗时 ${elapsed}ms`)
  const hit = parsed.errors.find((e) => e.code === 'CSV_UNTERMINATED_QUOTE')
  assert.ok(hit, `必须报 CSV_UNTERMINATED_QUOTE，实际：${parsed.errors.map((e) => e.code).join(',') || '（无）'}`)
})

/* ------------------------------------------------------------------ *
 * A12 时距按整数读写
 * ------------------------------------------------------------------ */
test('A12 时距 按整数读写：读回是 number 整数，落盘不带小数', () => {
  const rec = makeRecord({ 时距: 3 })
  const cells = recordToCells(rec, schema)
  const tickCell = cells[schema.columns.indexOf('时距')]

  assert.equal(tickCell, '3', `落盘必须是 "3"，实际 "${tickCell}"`)
  assert.equal(tickCell.includes('.'), false, '落盘不得出现小数点')

  const { header, rows } = roundtrip(rec)
  const { records } = rowsToRecords({ header, rows, errors: [] }, schema)
  assert.equal(typeof records[0]['时距'], 'number', '读回必须是 number，不是字符串')
  assert.equal(records[0]['时距'], 3)
  assert.equal(Number.isInteger(records[0]['时距']), true)
})

/* ------------------------------------------------------------------ *
 * A13 末尾无换行 / 末尾多空行 → 不产生幽灵空记录
 * ------------------------------------------------------------------ */
test('A13 末尾无换行、末尾多空行 → 都不产生幽灵空记录', () => {
  const header = COLUMNS.join(',')
  const row = toLine(makeRecord())

  const cases = {
    '标准 \\r\\n 结尾': header + '\r\n' + row + '\r\n',
    '末尾无换行': header + '\r\n' + row,
    '末尾多一个空行': header + '\r\n' + row + '\r\n\r\n',
    '末尾多三个空行': header + '\r\n' + row + '\r\n\r\n\r\n\r\n',
    'LF 换行': header + '\n' + row + '\n',
  }

  for (const [label, text] of Object.entries(cases)) {
    const parsed = parseCsv(text)
    assert.equal(parsed.rows.length, 1, `${label}：应只有 1 条数据行，实际 ${parsed.rows.length} 条`)
    assert.equal(parsed.rows[0].length, 9, `${label}：数据行必须 9 格`)
  }
})

/* ------------------------------------------------------------------ *
 * A-文件级：真实落盘后再读回（不只测内存序列化）
 * ------------------------------------------------------------------ */
test('A-文件级 appendRecordCsv 落盘后 readLibraryCsv 能逐字节读回含逗号/引号/换行的正文', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'store', 'memory.csv')
    mkdirSync(join(dir, 'store'), { recursive: true })

    const content = '他问："跑 build, 还是 test?"\n我答：先 build 再 test'
    const rec = makeRecord({ 主要内容: content, 编号: 'M-20261105-001' })

    await appendRecordCsv(file, rec, schema)

    const raw = readFileSync(file, 'utf8')
    assert.ok(raw.startsWith(COLUMNS.join(',')), '首行必须是表头')

    const { records, errors } = await readLibraryCsv(file, schema)
    assert.deepEqual(errors, [], `读回不得有错误：${JSON.stringify(errors)}`)
    assert.equal(records.length, 1, `应读回 1 条，实际 ${records.length} 条`)
    assert.equal(records[0]['主要内容'], content, '真实落盘后正文必须逐字节还原')
    assert.equal(records[0]['编号'], 'M-20261105-001')
    assert.deepEqual(records[0]['自由标签'], ['发版检查', '需先build'])
    assert.equal(records[0]['时距'], 1)
  })
})
