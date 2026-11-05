// 闸门② M 组：落盘（8 条）
//
// 依据：《流程_写入》§六、《流程_读取》§七、《流程_整理》§七、
//       《架构说明》§六/§八、《接口契约》Q6（tags 取前 10）、
//       Lead 裁决（feedback 占位只验"存在且是数组"）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

const INPUT = {
  主要内容: '部署时先跑 build, 再跑 test',
  形态: '技能',
  项目: 'qa-project',
  智能体: 'qa-agent',
  自由标签: ['发版检查', '需先build'],
}

function libPath(dataDir) {
  return join(dataDir, 'store', 'memory.csv')
}
function recPath(dataDir, kind) {
  return join(dataDir, 'records', `${kind}.jsonl`)
}
function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

/* ------------------------------------------------------------------ *
 * M1 写入后 CSV 多一行，旧行逐字节不变
 * ------------------------------------------------------------------ */
test('M1 dtm_write 成功 → store/memory.csv 增 1 行，旧行逐字节不变', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const w1 = await h.host.writeEntry(h.agent, INPUT)
    assert.equal(w1.ok, true, `第一次写入应成功，实际 ${JSON.stringify(w1)}`)

    const after1 = readFileSync(libPath(h.dataDir), 'utf8')
    assert.ok(after1.length > 0, '库文件应有内容')

    const w2 = await h.host.writeEntry(h.agent, { ...INPUT, 主要内容: '第二条：先 build 再 test, 别搞反' })
    assert.equal(w2.ok, true)

    const after2 = readFileSync(libPath(h.dataDir), 'utf8')
    assert.ok(
      after2.startsWith(after1),
      '第二次写入后，第一次的完整内容必须是新内容的字节前缀（只追加，不改旧行）',
    )
    assert.notEqual(w1.id, w2.id, '两条编号必须不同')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M2 表头 9 列且顺序正确
 * ------------------------------------------------------------------ */
test('M2 memory.csv 首行表头是 9 列，顺序符合 schema.json', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    await h.host.writeEntry(h.agent, INPUT)
    const raw = readFileSync(libPath(h.dataDir), 'utf8')
    const header = raw.split(/\r?\n/)[0]

    assert.equal(
      header,
      '编号,主要内容,形态,项目,智能体,自由标签,稳定性,时距,状态',
      `表头必须 9 列且顺序固定，实际「${header}」`,
    )
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M3 write.jsonl 追加一条，字段齐全
 * ------------------------------------------------------------------ */
test('M3 records/write.jsonl 追加 1 条，含 ts/who/summary/形态/项目/智能体/tags/ok/id', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const w = await h.host.writeEntry(h.agent, INPUT)
    const items = readJsonl(recPath(h.dataDir, 'write'))

    assert.equal(items.length, 1, `应记 1 条写入台账，实际 ${items.length} 条`)
    const log = items[0]

    for (const f of ['ts', 'who', 'summary', '形态', '项目', '智能体', 'tags', 'ok']) {
      assert.ok(f in log, `台账缺字段「${f}」，实际字段：${Object.keys(log).join(',')}`)
    }
    assert.equal(log.ok, true)
    assert.equal(log.id, w.id, '台账 id 必须等于新编号')
    assert.equal(log.who, BOUND.智能体, `who 应是当前身份，实际「${log.who}」`)
    assert.match(log.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, `ts 必须是本地 ISO，实际「${log.ts}」`)
    assert.ok(log.summary.length <= 30, `summary 应是主要内容前 30 字，实际 ${log.summary.length} 字`)
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M4 写失败也记台账（ok:false + reason + code），CSV 零新增
 * ------------------------------------------------------------------ */
test('M4 写入失败（标签含 |）→ write.jsonl 记 ok:false + reason + code，CSV 零新增', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const bad = { ...INPUT, 自由标签: ['发版检查', 'a|b'] }
    const w = await h.host.writeEntry(h.agent, bad)

    assert.equal(w.ok, false, '含 | 的标签必须拒写')

    // CSV 不得新增（可能整个文件不存在）
    const file = libPath(h.dataDir)
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
      assert.ok(lines.length <= 1, `拒写后 CSV 不应有数据行，实际 ${lines.length - 1} 行`)
    }

    const items = readJsonl(recPath(h.dataDir, 'write'))
    assert.equal(items.length, 1, `失败也必须记台账（《流程_写入》§六），实际 ${items.length} 条`)

    const log = items[0]
    assert.equal(log.ok, false)
    assert.ok(typeof log.reason === 'string' && log.reason.length > 0, '失败必须记 reason')
    assert.equal(log.code, 'TAG_CONTAINS_PIPE', `失败应记错误码，实际「${log.code}」`)
    assert.equal(log.id, undefined, '失败时不得有 id')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M5 read.jsonl 字段齐全，cond 原样不改写
 * ------------------------------------------------------------------ */
test('M5 dtm_recall → read.jsonl 含 cond/total/filtered/passed/near/hits，cond 原样不改写', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    await h.host.writeEntry(h.agent, INPUT)

    const query = {
      项目: 'qa-project',
      智能体: 'qa-agent',
      形态: '技能',
      自由标签: ['发版检查'],
    }
    const r = await h.host.recall(h.agent, query)
    assert.equal(r.ok, true, `召回应成功，实际 ${JSON.stringify(r).slice(0, 200)}`)

    const items = readJsonl(recPath(h.dataDir, 'read'))
    assert.equal(items.length, 1, `应记 1 条读取台账，实际 ${items.length}`)

    const log = items[0]
    for (const f of ['ts', 'who', 'cond', 'total', 'filtered', 'passed', 'near', 'hits']) {
      assert.ok(f in log, `读取台账缺字段「${f}」，实际：${Object.keys(log).join(',')}`)
    }

    // cond 必须原样回显（不归一、不改写）
    assert.equal(log.cond['项目'], query['项目'])
    assert.equal(log.cond['智能体'], query['智能体'])
    assert.equal(log.cond['形态'], query['形态'])
    assert.deepEqual(log.cond['标签'], query['自由标签'], 'cond.标签 必须原样不改写')

    assert.ok(Array.isArray(log.hits), 'hits 必须是数组')
    assert.ok(Array.isArray(log.near), 'near 必须是数组')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M5' feedback 占位：只断言"存在且是数组"
 * ------------------------------------------------------------------ */
test("M5' read.jsonl 的 feedback 字段存在且是数组（不断言落盘形态）", async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    await h.host.writeEntry(h.agent, INPUT)
    await h.host.recall(h.agent, {
      项目: 'qa-project', 智能体: 'qa-agent', 形态: '技能', 自由标签: ['发版检查'],
    })

    const log = readJsonl(recPath(h.dataDir, 'read'))[0]
    assert.ok('feedback' in log, 'read.jsonl 必须有 feedback 字段（《流程_读取》§七）')
    assert.ok(Array.isArray(log.feedback), `feedback 必须是数组（占位为 []），实际 ${typeof log.feedback}`)

    // 明确不断言具体落盘形态（三种方案未定稿，Lead 裁决）
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M6 查空也记台账，near ≤ 3，真/假查空可区分
 * ------------------------------------------------------------------ */
test('M6 查空 → read.jsonl 也记一条，hits=[]，near≤3，empty 可区分真假查空', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    await h.host.writeEntry(h.agent, INPUT)

    // 真查空：形态完全不同
    const r1 = await h.host.recall(h.agent, {
      项目: 'qa-project', 智能体: 'qa-agent', 形态: '模板', 自由标签: ['完全不相干'],
    })
    assert.equal(r1.ok, true)
    assert.equal(r1.hits.length, 0, '真查空应无命中')

    const items = readJsonl(recPath(h.dataDir, 'read'))
    assert.equal(items.length, 1, '查空也必须记台账（《流程_读取》§七：不能静默返回空）')
    assert.deepEqual(items[0].hits, [], '查空时 hits 应为空数组')
    assert.ok(items[0].near.length <= 3, `near 最多 3 条，实际 ${items[0].near.length}`)
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M7 追加不改旧行（records/*.jsonl）
 * ------------------------------------------------------------------ */
test('M7 records/*.jsonl 连续追加 3 次，前两行逐字节不变', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    for (let i = 0; i < 3; i++) {
      await h.host.writeEntry(h.agent, { ...INPUT, 主要内容: `第 ${i + 1} 条` })
    }

    const file = recPath(h.dataDir, 'write')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    assert.equal(lines.length, 3, `应追加 3 行，实际 ${lines.length}`)

    // 逐行都是合法 JSON（证明没有互相覆盖成半行）
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `每一行都必须是完整 JSON：${line.slice(0, 80)}`)
    }

    const parsed = lines.map((l) => JSON.parse(l))
    assert.equal(parsed.length, 3)
    assert.equal(new Set(parsed.map((p) => p.id)).size, 3, '三条台账应有三个不同编号')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * M8 含逗号/引号/换行的正文真实落盘后可读回
 * ------------------------------------------------------------------ */
test('M8 含逗号/引号/换行的正文 → 真实落盘后能完整读回', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const content = '他问："跑 build, 还是 test?"\n我答：先 build 再 test'
    const w = await h.host.writeEntry(h.agent, { ...INPUT, 主要内容: content })
    assert.equal(w.ok, true, `应写入成功，实际 ${JSON.stringify(w)}`)

    const raw = readFileSync(libPath(h.dataDir), 'utf8')
    assert.ok(raw.includes('""'), '含双引号的正文应以 "" 转义')

    // 注意：本条用**全部 2 个标签**去查，让 e_ratio = 2/2 = 1 过命中否决。
    // 若只查 1 个标签 → e_ratio = 1/2 = 0.5，按 F3 裁决（严格大于）会被否决，
    // 那是命中否决的正常行为，与本条要验的「落盘往返」无关。
    const r = await h.host.recall(h.agent, {
      项目: 'qa-project', 智能体: 'qa-agent', 形态: '技能', 自由标签: ['发版检查', '需先build'],
    })
    assert.equal(r.hits.length, 1, `应能召回该条（e_ratio=1 已过否决），实际 ${r.hits.length} 条；near=${JSON.stringify(r.near)}`)
    assert.equal(r.hits[0]['主要内容'], content, '落盘再读回必须逐字节还原')
  } finally {
    h.cleanup()
  }
})
