// 闸门① D 组：写入校验（18 条）
//
// 依据：《流程_写入》§二/§三/§五、《标签字典》「写入」、「功能说明」§十四「引擎层」、
//       《接口契约》§七 错误码族、Lead 规格变更（2026-11-05：TAGS_EMPTY 加严）。
// 断言按规格写，不按实现写。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateWriteInput, buildNewRecord, buildWriteLog, MODEL_FIELDS, PROGRAM_FIELDS } from '../../lib/engine/write.mjs'
import { appendRecordCsv, readLibraryCsv } from '../../lib/engine/core.mjs'
import schemaJson from '../../lib/engine/templates/schema.json' with { type: 'json' }

const schema = schemaJson
const SHAPES = schema.shapes

/** 合法的写入输入基线 */
function baseInput(over = {}) {
  return {
    主要内容: '部署时先跑 build 再跑 test',
    形态: '技能',
    项目: '用户设置',
    智能体: '通用',
    自由标签: ['发版检查', '需先build'],
    ...over,
  }
}

/** 取某错误码的条目 */
const errOf = (res, code) => res.errors.find((e) => e.code === code)

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-d-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** 构造一个真实的空库文件（只有表头） */
function seedLibrary(dir) {
  const file = join(dir, 'store', 'memory.csv')
  mkdirSync(join(dir, 'store'), { recursive: true })
  return file
}

/* ------------------------------------------------------------------ *
 * D1 主要内容为空/纯空白 → 拒写 CONTENT_EMPTY
 * ------------------------------------------------------------------ */
test('D1 主要内容为空或纯空白 → 拒写 CONTENT_EMPTY，文件零新增', async () => {
  await withTempDir(async (dir) => {
    for (const bad of ['', '   ', '\t\n']) {
      const res = validateWriteInput(baseInput({ 主要内容: bad }), schema)
      assert.equal(res.ok, false, `主要内容「${JSON.stringify(bad)}」应拒写`)
      assert.ok(errOf(res, 'CONTENT_EMPTY'), `必须报 CONTENT_EMPTY，实际 ${res.errors.map((e) => e.code).join(',')}`)
    }

    // 文件级：拒写后库文件不得新增行
    const file = seedLibrary(dir)
    const built = buildNewRecord({ input: baseInput({ 主要内容: '' }), existingIds: [], schema })
    assert.equal(built.ok, false)
    assert.equal(existsSync(file), false, '拒写时不得创建库文件')
  })
})

/* ------------------------------------------------------------------ *
 * D2 六个合法形态逐个通过
 * ------------------------------------------------------------------ */
test('D2 六个合法形态逐个通过（技能/流程/规则/偏好/事实/模板）', () => {
  assert.equal(SHAPES.length, 6, '形态必须是 6 个')
  for (const shape of SHAPES) {
    const res = validateWriteInput(baseInput({ 形态: shape }), schema)
    assert.equal(res.ok, true, `形态「${shape}」应通过，实际错误：${res.errors.map((e) => e.code).join(',')}`)
    assert.equal(res.normalized['形态'], shape)
  }
})

/* ------------------------------------------------------------------ *
 * D3 形态非法 → SHAPE_INVALID，且列出合法值
 * ------------------------------------------------------------------ */
test('D3 形态非法（技能类）→ 拒写 SHAPE_INVALID，报错必须列出 6 个合法值', () => {
  const res = validateWriteInput(baseInput({ 形态: '技能类' }), schema)
  assert.equal(res.ok, false)

  const err = errOf(res, 'SHAPE_INVALID')
  assert.ok(err, `必须报 SHAPE_INVALID，实际 ${res.errors.map((e) => e.code).join(',')}`)

  // 报错文案必须列全 6 个合法值（规格：把合法值列在报错里告诉模型）
  for (const shape of SHAPES) {
    assert.ok(err.message.includes(shape), `报错文案必须含合法值「${shape}」，实际：${err.message}`)
  }
  assert.deepEqual(err.detail.allowed, SHAPES, 'detail.allowed 必须是 6 个合法值')
})

/* ------------------------------------------------------------------ *
 * D4 形态为空 → SHAPE_EMPTY
 * ------------------------------------------------------------------ */
test('D4 形态为空 → 拒写 SHAPE_EMPTY', () => {
  for (const bad of ['', '   ', undefined, null]) {
    const res = validateWriteInput(baseInput({ 形态: bad }), schema)
    assert.equal(res.ok, false, `形态「${JSON.stringify(bad)}」应拒写`)
    assert.ok(errOf(res, 'SHAPE_EMPTY'), `必须报 SHAPE_EMPTY，实际 ${res.errors.map((e) => e.code).join(',')}`)
  }
})

/* ------------------------------------------------------------------ *
 * D5 项目为空 → PROJECT_EMPTY，且不得偷补默认值
 * ------------------------------------------------------------------ */
test('D5 项目为空 → 拒写 PROJECT_EMPTY，不得偷偷补默认「通用」', async () => {
  for (const bad of ['', '   ', undefined]) {
    const res = validateWriteInput(baseInput({ 项目: bad }), schema)
    assert.equal(res.ok, false, `项目「${JSON.stringify(bad)}」应拒写`)
    const err = errOf(res, 'PROJECT_EMPTY')
    assert.ok(err, `必须报 PROJECT_EMPTY，实际 ${res.errors.map((e) => e.code).join(',')}`)
  }

  // 造行也必须拒绝（不能在校验失败后仍然补默认值造出一条）
  const built = buildNewRecord({ input: baseInput({ 项目: '' }), existingIds: [], schema })
  assert.equal(built.ok, false, '项目为空时 buildNewRecord 必须失败')
  assert.equal(built.record, null, '不得产出任何记录（否则就是偷补了默认值）')
})

/* ------------------------------------------------------------------ *
 * D6 智能体为空 → AGENT_EMPTY，同理不补默认
 * ------------------------------------------------------------------ */
test('D6 智能体为空 → 拒写 AGENT_EMPTY，不得偷偷补默认', () => {
  for (const bad of ['', '  ', undefined]) {
    const res = validateWriteInput(baseInput({ 智能体: bad }), schema)
    assert.equal(res.ok, false, `智能体「${JSON.stringify(bad)}」应拒写`)
    assert.ok(errOf(res, 'AGENT_EMPTY'), `必须报 AGENT_EMPTY，实际 ${res.errors.map((e) => e.code).join(',')}`)
  }

  const built = buildNewRecord({ input: baseInput({ 智能体: '' }), existingIds: [], schema })
  assert.equal(built.ok, false)
  assert.equal(built.record, null)
})

/* ------------------------------------------------------------------ *
 * D7 项目/智能体 40 字 → 边界内通过
 * ------------------------------------------------------------------ */
test('D7 项目/智能体恰 40 字 → 通过（上限边界内）', () => {
  const exactly40 = '甲'.repeat(40)
  assert.equal(exactly40.length, 40)

  const res = validateWriteInput(baseInput({ 项目: exactly40, 智能体: exactly40 }), schema)
  assert.equal(res.ok, true, `40 字应通过，实际错误：${res.errors.map((e) => e.code).join(',')}`)
})

/* ------------------------------------------------------------------ *
 * D8 项目/智能体 41 字 → NAME_TOO_LONG
 * ------------------------------------------------------------------ */
test('D8 项目/智能体 41 字 → 拒写 NAME_TOO_LONG', () => {
  const over41 = '甲'.repeat(41)

  const resP = validateWriteInput(baseInput({ 项目: over41 }), schema)
  assert.equal(resP.ok, false)
  assert.ok(errOf(resP, 'NAME_TOO_LONG'), `项目超长必须报 NAME_TOO_LONG，实际 ${resP.errors.map((e) => e.code).join(',')}`)

  const resA = validateWriteInput(baseInput({ 智能体: over41 }), schema)
  assert.equal(resA.ok, false)
  assert.ok(errOf(resA, 'NAME_TOO_LONG'), `智能体超长必须报 NAME_TOO_LONG，实际 ${resA.errors.map((e) => e.code).join(',')}`)
})

/* ------------------------------------------------------------------ *
 * D9 【重点】标签含 | → TAG_CONTAINS_PIPE，且 detail.tag 点名到具体标签
 * ------------------------------------------------------------------ */
test('D9 标签含 | → 拒写 TAG_CONTAINS_PIPE，detail.tag 必须点名到具体标签', async () => {
  await withTempDir(async (dir) => {
    const res = validateWriteInput(baseInput({ 自由标签: ['发版检查', 'a|b', '部署'] }), schema)
    assert.equal(res.ok, false, '含 | 的标签必须拒写')

    const err = errOf(res, 'TAG_CONTAINS_PIPE')
    assert.ok(err, `必须报 TAG_CONTAINS_PIPE，实际 ${res.errors.map((e) => e.code).join(',')}`)

    // 契约 §七：detail.tag = 违规标签原文
    assert.equal(err.detail.tag, 'a|b', `detail.tag 必须是违规标签原文「a|b」，实际「${err.detail.tag}」`)

    // 报错文案必须含该标签，并说明 | 是保留分隔符
    assert.ok(err.message.includes('a|b'), `报错文案必须点名标签，实际：${err.message}`)
    assert.ok(err.message.includes('|'), '报错文案必须提到 | 字符')
    assert.ok(
      err.message.includes('分隔') || err.message.includes('保留'),
      `报错文案必须说明 | 是保留分隔符，实际：${err.message}`,
    )

    // 文件级：零新增
    const file = seedLibrary(dir)
    const built = buildNewRecord({ input: baseInput({ 自由标签: ['a|b'] }), existingIds: [], schema })
    assert.equal(built.ok, false, '含 | 时不得造出记录')
    assert.equal(built.record, null)
    assert.equal(existsSync(file), false, '拒写时库文件不得出现')
  })
})

/* ------------------------------------------------------------------ *
 * D10 标签恰 20 个 → 通过
 * ------------------------------------------------------------------ */
test('D10 自由标签恰 20 个 → 通过（上限边界内）', () => {
  const tags = Array.from({ length: 20 }, (_, i) => `标签${i + 1}`)
  assert.equal(tags.length, 20)

  const res = validateWriteInput(baseInput({ 自由标签: tags }), schema)
  assert.equal(res.ok, true, `20 个标签应通过，实际错误：${res.errors.map((e) => e.code).join(',')}`)
  assert.equal(res.normalized['自由标签'].length, 20)
})

/* ------------------------------------------------------------------ *
 * D11 标签 21 个 → TOO_MANY_TAGS
 * ------------------------------------------------------------------ */
test('D11 自由标签 21 个 → 拒写 TOO_MANY_TAGS', () => {
  const tags = Array.from({ length: 21 }, (_, i) => `标签${i + 1}`)
  const res = validateWriteInput(baseInput({ 自由标签: tags }), schema)

  assert.equal(res.ok, false)
  const err = errOf(res, 'TOO_MANY_TAGS')
  assert.ok(err, `必须报 TOO_MANY_TAGS，实际 ${res.errors.map((e) => e.code).join(',')}`)
  assert.equal(err.detail.max, 20)
})

/* ------------------------------------------------------------------ *
 * D12 标签含空串/重复 → 去重滤空，不报错（语义不变）
 * ------------------------------------------------------------------ */
test('D12 标签 ["a","","a","b"] → 去重滤空得 ["a","b"]，不报错，落盘 a|b', () => {
  const res = validateWriteInput(baseInput({ 自由标签: ['a', '', 'a', 'b'] }), schema)

  assert.equal(res.ok, true, `去重滤空后非空应通过，实际错误：${res.errors.map((e) => e.code).join(',')}`)
  assert.deepEqual(res.normalized['自由标签'], ['a', 'b'], '必须去重 + 滤空且保序')

  const built = buildNewRecord({ input: baseInput({ 自由标签: ['a', '', 'a', 'b'] }), existingIds: [], schema })
  assert.equal(built.ok, true)
  assert.deepEqual(built.record['自由标签'], ['a', 'b'])
})

/* ------------------------------------------------------------------ *
 * D13 程序填的 4 个字段；模型硬塞 → 忽略并覆盖，不报错
 * ------------------------------------------------------------------ */
test('D13 程序填 4 字段；模型硬塞 稳定性 也丢弃，恒落「观察」', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0) // 本地 2026-11-05 12:00
  const existingIds = ['M-20261105-007']

  const input = baseInput({
    稳定性: '稳定', // 硬塞：程序字段，一律丢弃（首次落库 = 未经系统性验证）
    时距: 99, // 硬塞：程序值应是 1
    状态: '已归档', // 硬塞：程序值应是 生效
    编号: 'M-19990101-999', // 硬塞：程序应自己取号
  })

  const built = buildNewRecord({ input, existingIds, schema, now })

  assert.equal(built.ok, true, `硬塞程序字段不得导致失败，实际错误：${built.errors.map((e) => e.code).join(',')}`)

  // 编号/时距/状态 是程序字段，必须被覆盖
  assert.equal(built.record['编号'], 'M-20261105-008', `编号必须是程序取的号，实际「${built.record['编号']}」`)
  assert.equal(built.record['时距'], 1, `时距必须是 1，实际 ${built.record['时距']}`)
  assert.equal(built.record['状态'], '生效', `状态必须是「生效」，实际「${built.record['状态']}」`)

  // 稳定性是程序字段：模型给什么都不采纳，首次落库恒为「观察」
  assert.equal(
    built.record['稳定性'],
    '观察',
    `首次落库必须是「观察」（未经系统性验证），模型给的「稳定」必须丢弃，实际「${built.record['稳定性']}」`,
  )

  // ignored 必须记下 稳定性——它是程序字段，模型传了就是越权
  assert.ok(Array.isArray(built.ignored), 'ignored 应是数组')
  for (const f of ['时距', '状态', '编号', '稳定性']) {
    assert.ok(built.ignored.includes(f), `ignored 应含「${f}」，实际：${built.ignored.join(',')}`)
  }
})

/* ------------------------------------------------------------------ *
 * D13b 稳定性恒为「观察」：给什么都不改，也不报错
 * ------------------------------------------------------------------ */
test('D13b 稳定性恒落「观察」：不给、给合法值、给非法值，结果都一样', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const existingIds = []

  const cases = [
    ['不给', {}],
    ['给合法值 稳定', { 稳定性: '稳定' }],
    ['给合法值 易变', { 稳定性: '易变' }],
    ['给非法值 很稳', { 稳定性: '很稳' }],
  ]

  for (const [label, extra] of cases) {
    const r = buildNewRecord({ input: baseInput(extra), existingIds, schema, now })
    assert.equal(r.ok, true, `${label}：不得拒写（模型无从给对，报错只会让它以为该重试）`)
    assert.equal(
      r.record['稳定性'],
      '观察',
      `${label}：首次落库恒为「观察」，实际「${r.record['稳定性']}」`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * D14 只追加、不查重：连写两条同内容
 * ------------------------------------------------------------------ */
test('D14 只追加不查重：连写两条同内容 → 库多 2 行，旧行逐字节不变', async () => {
  await withTempDir(async (dir) => {
    const file = seedLibrary(dir)

    const b1 = buildNewRecord({ input: baseInput(), existingIds: [], schema })
    await appendRecordCsv(file, b1.record, schema)
    const afterFirst = readFileSync(file, 'utf8')

    const b2 = buildNewRecord({ input: baseInput(), existingIds: [b1.record['编号']], schema })
    await appendRecordCsv(file, b2.record, schema)
    const afterSecond = readFileSync(file, 'utf8')

    // 旧内容必须是新内容的字节前缀（只追加不改旧行）
    assert.ok(
      afterSecond.startsWith(afterFirst),
      '第二次写入后，第一次的完整内容必须原样保留（只追加，不改旧行）',
    )

    const { records, errors } = await readLibraryCsv(file, schema)
    assert.deepEqual(errors, [])
    assert.equal(records.length, 2, `同内容应写 2 条（不查重），实际 ${records.length} 条`)
    assert.equal(records[0]['主要内容'], records[1]['主要内容'], '两条内容相同（证明不查重）')
    assert.notEqual(records[0]['编号'], records[1]['编号'], '编号必须不同')
    assert.equal(records[0]['状态'], '生效')
    assert.equal(records[1]['状态'], '生效', '写入不得产生「被取代」/「已归档」')
  })
})

/* ------------------------------------------------------------------ *
 * D15 取值域来自 schema.json（证明没硬编码）
 * ------------------------------------------------------------------ */
test('D15 形态取值域来自 schema.json → 改 schema 后校验行为随之变', () => {
  const customSchema = {
    ...schema,
    shapes: [...schema.shapes, '自定义形态'],
  }

  // 原 schema 下非法
  assert.equal(validateWriteInput(baseInput({ 形态: '自定义形态' }), schema).ok, false)

  // 换 schema 后合法 → 证明不是硬编码
  const res = validateWriteInput(baseInput({ 形态: '自定义形态' }), customSchema)
  assert.equal(res.ok, true, `schema 加了「自定义形态」后应通过，实际错误：${res.errors.map((e) => e.code).join(',')}`)
})

/* ------------------------------------------------------------------ *
 * D16 错误对象结构：code + message（契约 §七）
 * ------------------------------------------------------------------ */
test('D16 错误对象必须有 code 与 message（不是裸字符串）', () => {
  const res = validateWriteInput({ 主要内容: '', 形态: '', 项目: '', 智能体: '', 自由标签: [] }, schema)
  assert.equal(res.ok, false)
  assert.ok(res.errors.length > 0)

  for (const err of res.errors) {
    assert.equal(typeof err, 'object', '错误必须是对象，不是字符串')
    assert.equal(typeof err.code, 'string', '错误必须有 code')
    assert.ok(err.code.length > 0)
    assert.equal(typeof err.message, 'string', '错误必须有 message')
    assert.ok(err.message.length > 0, `code=${err.code} 的 message 不能为空`)
  }

  // 契约 §七 的码族抽查
  const codes = res.errors.map((e) => e.code)
  for (const expected of ['CONTENT_EMPTY', 'SHAPE_EMPTY', 'PROJECT_EMPTY', 'AGENT_EMPTY', 'TAGS_EMPTY']) {
    assert.ok(codes.includes(expected), `空输入应报 ${expected}，实际：${codes.join(',')}`)
  }
})

/* ------------------------------------------------------------------ *
 * D17 【规格变更】自由标签 = [] → 拒写 TAGS_EMPTY
 * ------------------------------------------------------------------ */
test('D17 自由标签 = [] → 拒写 TAGS_EMPTY（Lead 2026-11-05 加严）', async () => {
  await withTempDir(async (dir) => {
    const res = validateWriteInput(baseInput({ 自由标签: [] }), schema)
    assert.equal(res.ok, false, '空标签数组必须拒写')
    const err = errOf(res, 'TAGS_EMPTY')
    assert.ok(err, `必须报 TAGS_EMPTY，实际 ${res.errors.map((e) => e.code).join(',')}`)
    assert.ok(err.message.includes('1'), `报错应提示"至少给 1 个标签"，实际：${err.message}`)

    // 未传该字段也等同空
    const resUndef = validateWriteInput(baseInput({ 自由标签: undefined }), schema)
    assert.equal(resUndef.ok, false, '不传自由标签也必须拒写（等同空）')

    // 文件级零新增
    const file = seedLibrary(dir)
    const built = buildNewRecord({ input: baseInput({ 自由标签: [] }), existingIds: [], schema })
    assert.equal(built.ok, false)
    assert.equal(built.record, null)
    assert.equal(existsSync(file), false, '拒写时库文件不得出现')
  })
})

/* ------------------------------------------------------------------ *
 * D18 【规格变更】标签全为空串 ['',''] → 滤空后为空 → 同样拒写
 * ------------------------------------------------------------------ */
test("D18 自由标签 = ['',''] → 滤空后为空 → 拒写 TAGS_EMPTY", () => {
  const res = validateWriteInput(baseInput({ 自由标签: ['', ''] }), schema)
  assert.equal(res.ok, false, '全空串标签滤空后为空，必须拒写')
  assert.ok(errOf(res, 'TAGS_EMPTY'), `必须报 TAGS_EMPTY，实际 ${res.errors.map((e) => e.code).join(',')}`)

  // 只有空白的也算
  const resBlank = validateWriteInput(baseInput({ 自由标签: ['   ', '\t'] }), schema)
  assert.equal(resBlank.ok, false, '纯空白标签滤空后为空，也必须拒写')
})

/* ------------------------------------------------------------------ *
 * D-附加 MODEL_FIELDS / PROGRAM_FIELDS 契约
 * ------------------------------------------------------------------ */
test('D-附加 MODEL_FIELDS 5 个、PROGRAM_FIELDS 4 个，且与 9 列互补', () => {
  assert.equal(MODEL_FIELDS.length, 5, `模型字段必须是 5 个，实际 ${MODEL_FIELDS.length}`)
  assert.equal(PROGRAM_FIELDS.length, 4, `程序字段必须是 4 个，实际 ${PROGRAM_FIELDS.length}`)

  const union = [...MODEL_FIELDS, ...PROGRAM_FIELDS].sort()
  const columns = [...schema.columns].sort()
  assert.deepEqual(union, columns, '模型 5 + 程序 4 必须恰好覆盖 9 列，不多不少')

  // 交集必须为空（不能有字段既是模型填又是程序填）
  const overlap = MODEL_FIELDS.filter((f) => PROGRAM_FIELDS.includes(f))
  assert.deepEqual(overlap, [], `不得有字段既属模型又属程序：${overlap.join(',')}`)

  // 稳定性 必须属程序：首次落库恒为观察，模型自评不算数（2026-11-08 硬性裁定）
  assert.ok(PROGRAM_FIELDS.includes('稳定性'), '稳定性 必须是程序字段')
  assert.ok(!MODEL_FIELDS.includes('稳定性'), '稳定性 不得出现在模型字段里')
})

/* ------------------------------------------------------------------ *
 * D-附加 buildWriteLog：成功记 id、失败记 reason/code，tags 取前 N
 * ------------------------------------------------------------------ */
test('D-附加 buildWriteLog：成功记 id；失败记 reason+code；tags 默认取前 10', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)

  const okRes = buildNewRecord({ input: baseInput(), existingIds: [], schema, now })
  const okLog = buildWriteLog({ input: baseInput(), identity: { who: 'agent-A' }, result: okRes, schema, now })

  assert.equal(okLog.ok, true)
  assert.equal(okLog.id, okRes.record['编号'], '成功时必须记新编号')
  assert.equal(okLog.who, 'agent-A')
  assert.equal(okLog.reason, undefined, '成功时不得有 reason')
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(okLog.ts), `ts 必须是 ISO 时间，实际「${okLog.ts}」`)

  const badInput = baseInput({ 自由标签: ['a|b'] })
  const badRes = validateWriteInput(badInput, schema)
  const badLog = buildWriteLog({ input: badInput, identity: { who: 'agent-A' }, result: badRes, schema, now })

  assert.equal(badLog.ok, false)
  assert.equal(badLog.id, undefined, '失败时不得有 id')
  assert.ok(typeof badLog.reason === 'string' && badLog.reason.length > 0, '失败必须记 reason')
  assert.equal(badLog.code, 'TAG_CONTAINS_PIPE', '失败应记首个错误码')

  // tags 取前 10（契约 Q6）
  const manyTags = Array.from({ length: 15 }, (_, i) => `t${i + 1}`)
  const manyLog = buildWriteLog({
    input: baseInput({ 自由标签: manyTags }),
    identity: { who: 'agent-A' },
    result: buildNewRecord({ input: baseInput({ 自由标签: manyTags }), existingIds: [], schema, now }),
    schema,
    now,
  })
  assert.equal(manyLog.tags.split(',').length, 10, `tags 应截到前 10 个，实际 ${manyLog.tags.split(',').length} 个`)
})
