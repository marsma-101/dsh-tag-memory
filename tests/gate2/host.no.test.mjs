// 闸门② N 组：未绑定铁律（4 条）+ O 组：整理类纪律（3 条）
//
// 依据：《功能说明》§4.3、§十四「隔离」、「架构说明」§十、《流程_读取》§一第 0 步、
//       《流程_写入》§五末、`团队_子智能体说明`「未绑定铁律」。
//
// 铁律原文：未绑定 → 写入拒、读取空，**即使传 通用/引入 也不放行**。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

const INPUT = {
  主要内容: '未绑定测试',
  形态: '技能',
  项目: 'qa-project',
  智能体: 'qa-agent',
  自由标签: ['未绑定', '测试'],
}

const libPath = (d) => join(d, 'store', 'memory.csv')
const recPath = (d, k) => join(d, 'records', `${k}.jsonl`)

function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

/* ================================================================== *
 * N 组：未绑定铁律
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * N1 未绑定 → dtm_write 拒写
 * ------------------------------------------------------------------ */
test('N1 未绑定 → writeEntry 拒写 UNBOUND_IDENTITY，CSV 零新增，台账记 ok:false', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    const w = await h.host.writeEntry(h.agent, INPUT)

    assert.equal(w.ok, false, '未绑定时写入必须被拒')
    assert.equal(w.blocked, 'UNBOUND_IDENTITY', `应标 UNBOUND_IDENTITY，实际 ${w.blocked}`)
    assert.match(String(w.message), /绑定|dtm_bind|身份/, `应提示先绑定身份，实际：${w.message}`)

    // CSV 零新增
    const file = libPath(h.dataDir)
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
      assert.ok(lines.length <= 1, `拒写后不应有数据行，实际 ${lines.length - 1} 行`)
    }

    // 台账：未绑定也要记（《流程_写入》§六「写入成功和失败都需要留下调取记录」）
    const logs = readJsonl(recPath(h.dataDir, 'write'))
    assert.equal(logs.length, 1, `未绑定拒写也应记台账，实际 ${logs.length} 条`)
    assert.equal(logs[0].ok, false)
    assert.equal(logs[0].code, 'UNBOUND_IDENTITY')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * N2 未绑定 → dtm_recall 返回空并标未绑定
 * ------------------------------------------------------------------ */
test('N2 未绑定 → recall 返回空 + 标未绑定身份 + 提示 dtm_bind', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    // 先造一条真实数据（用绑定态写入），再切回未绑定读
    h.setIdentity(BOUND)
    await h.host.writeEntry(h.agent, INPUT)
    h.setIdentity(null)

    const r = await h.host.recall(h.agent, {
      项目: 'qa-project', 智能体: 'qa-agent', 形态: '技能', 自由标签: ['未绑定'],
    })

    assert.equal(r.ok, false, '未绑定时读取必须不返回数据')
    assert.equal(r.blocked, 'UNBOUND_IDENTITY', `应标 UNBOUND_IDENTITY，实际 ${r.blocked}`)
    assert.deepEqual(r.hits, [], '未绑定时 hits 必须为空')
    assert.match(String(r.message), /绑定|dtm_bind/, '应提示先调 dtm_bind')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * N3 【核心】未绑定但显式传 通用/通用 → 仍不放行
 * ------------------------------------------------------------------ */
test('N3 【核心】未绑定但显式传 项目=通用 智能体=通用 → 仍然拒写/返空', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    // 写入：显式传通用
    const w = await h.host.writeEntry(h.agent, {
      ...INPUT,
      项目: '通用',
      智能体: '通用',
    })
    assert.equal(
      w.ok,
      false,
      '未绑定时即使显式传 通用/通用 也必须拒写（否则就是"传通用就放行"的短路 bug）',
    )
    assert.equal(w.blocked, 'UNBOUND_IDENTITY')

    // 读取：显式传通用
    const r = await h.host.recall(h.agent, {
      项目: '通用', 智能体: '通用', 形态: '技能', 自由标签: ['未绑定'],
    })
    assert.equal(r.ok, false, '未绑定时即使显式传 通用/通用 也必须返回空')
    assert.deepEqual(r.hits, [], '不得因传通用而读到跨身份可见的记忆')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * N4 未绑定但显式传 引入 → 仍不放行
 * ------------------------------------------------------------------ */
test('N4 未绑定但显式传 项目=引入 智能体=引入 → 仍然拒写/返空', async () => {
  const h = await makeHostCtx({ identity: null })
  try {
    const w = await h.host.writeEntry(h.agent, { ...INPUT, 项目: '引入', 智能体: '引入' })
    assert.equal(w.ok, false, '未绑定时传 引入 也必须拒写')
    assert.equal(w.blocked, 'UNBOUND_IDENTITY')

    const r = await h.host.recall(h.agent, {
      项目: '引入', 智能体: '引入', 形态: '技能', 自由标签: ['未绑定'],
    })
    assert.equal(r.ok, false, '未绑定时传 引入 也必须返回空')
    assert.deepEqual(r.hits, [])
  } finally {
    h.cleanup()
  }
})

/* ================================================================== *
 * O 组：整理类纪律
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * O1 dtm_retag 缺 basis → 拒绝
 * ------------------------------------------------------------------ */
test('O1 retagEntry 缺 basis → 拒绝 BASIS_REQUIRED（没有依据不许改）', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const w = await h.host.writeEntry(h.agent, INPUT)
    assert.equal(w.ok, true)

    const r = await h.host.retagEntry(h.agent, {
      编号: w.id,
      patch: { 项目: '另一个项目' },
      // basis 故意不给
    })

    assert.equal(r.ok, false, '缺 basis 必须拒绝（《流程_整理》§七：没有依据的改动不允许做）')
    assert.equal(r.code, 'BASIS_REQUIRED', `应报 BASIS_REQUIRED，实际 ${r.code}`)

    // 库里那条不得被改：用 listEntries 直接看落盘值（不经过命中否决，
    // 避免"查询被否决"与"改动生效"混为一谈）
    const listed = await h.host.listEntries({ limit: 100 })
    const item = listed.items.find((it) => it['编号'] === w.id)
    assert.ok(item, '该条目应仍在库里')
    assert.equal(item['项目'], 'qa-project', `被拒的改动不得生效：项目应仍为 qa-project，实际「${item['项目']}」`)

    // 六个可改字段逐一确认未被改动
    assert.equal(item['形态'], INPUT['形态'])
    assert.equal(item['智能体'], INPUT['智能体'])
    assert.deepEqual(item['自由标签'], INPUT['自由标签'])
    assert.equal(item['状态'], '生效')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * O2 dtm_retag 试图改 编号/主要内容/时距 → 拒且点名
 * ------------------------------------------------------------------ */
test('O2 retagEntry 试图改 主要内容/编号/时距 → FIELD_NOT_EDITABLE 且点名到具体字段', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const w = await h.host.writeEntry(h.agent, INPUT)
    assert.equal(w.ok, true)

    for (const readonlyField of ['主要内容', '编号', '时距']) {
      const r = await h.host.retagEntry(h.agent, {
        编号: w.id,
        patch: { [readonlyField]: 'xxx' },
        basis: 'read.jsonl#test',
      })

      assert.equal(r.ok, false, `改「${readonlyField}」必须被拒（这三项整理也不能改）`)
      assert.equal(r.code, 'FIELD_NOT_EDITABLE', `应报 FIELD_NOT_EDITABLE，实际 ${r.code}`)

      const text = JSON.stringify(r)
      assert.ok(
        text.includes(readonlyField),
        `报错必须点名到具体字段「${readonlyField}」，实际：${text.slice(0, 300)}`,
      )
    }
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * O3 一个操作两个调用者：UI 与工具走同一实现
 * ------------------------------------------------------------------ */
test('O3 一个操作两个调用者：传 agent 与传 null 走同一实现，结果格式一致', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const w1 = await h.host.writeEntry(h.agent, INPUT)
    const w2 = await h.host.writeEntry(h.agent, { ...INPUT, 主要内容: '第二条用于对比' })
    assert.equal(w1.ok, true)
    assert.equal(w2.ok, true)

    // 工具调用路径（带 agent）
    const viaTool = await h.host.retagEntry(h.agent, {
      编号: w1.id,
      patch: { 项目: '改过的项目A' },
      basis: 'read.jsonl#test-tool',
    })

    // UI 调用路径（无 agent，用户手动）
    const viaUi = await h.host.retagEntry(null, {
      编号: w2.id,
      patch: { 项目: '改过的项目B' },
      basis: 'read.jsonl#test-ui',
    })

    assert.equal(viaTool.ok, true, `工具路径改条目应成功，实际 ${JSON.stringify(viaTool)}`)
    assert.equal(viaUi.ok, true, `UI 路径改条目应成功，实际 ${JSON.stringify(viaUi)}`)

    // 返回结构必须一致（同一实现）
    const keysTool = Object.keys(viaTool).sort()
    const keysUi = Object.keys(viaUi).sort()
    assert.deepEqual(keysTool, keysUi, `两个调用者的返回结构必须一致：\n工具=${keysTool.join(',')}\nUI=${keysUi.join(',')}`)

    // 台账必须都记 tidy.jsonl
    const tidy = readJsonl(recPath(h.dataDir, 'tidy'))
    assert.ok(tidy.length >= 2, `两次改动都应记 tidy 台账，实际 ${tidy.length} 条`)

    // who 必须能区分两种调用者
    const whos = tidy.map((t) => t.who)
    assert.ok(
      whos.some((w) => w && w.includes(BOUND.智能体)) || whos.some((w) => w && w.includes('（用户手动）')) || whos.some((w) => w && w.includes('用户')),
      `台账 who 应能区分工具/手动调用，实际：${JSON.stringify(whos)}`,
    )
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * O-附加 时距只动命中项
 * ------------------------------------------------------------------ */
test('O-附加 召回后只有命中条目 时距+1，其余条目一个字段都不动', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    // 三条：两条同形态同标签（会命中），一条不同形态（不会命中）
    const a = await h.host.writeEntry(h.agent, { ...INPUT, 主要内容: '条目A', 自由标签: ['命中关键词'] })
    const b = await h.host.writeEntry(h.agent, { ...INPUT, 主要内容: '条目B', 自由标签: ['命中关键词'] })
    const c = await h.host.writeEntry(h.agent, { ...INPUT, 主要内容: '条目C', 形态: '模板', 自由标签: ['别的'] })
    assert.ok(a.ok && b.ok && c.ok)

    const before = readFileSync(libPath(h.dataDir), 'utf8')

    const r = await h.host.recall(h.agent, {
      项目: 'qa-project', 智能体: 'qa-agent', 形态: '技能', 自由标签: ['命中关键词'],
    })
    assert.equal(r.ok, true)
    assert.ok(r.hits.length >= 1, '应有命中')

    const after = readFileSync(libPath(h.dataDir), 'utf8')

    // 逐条比对：只有命中项 时距 变了
    const listed = await h.host.listEntries({ limit: 100 })
    const byId = new Map(listed.items.map((it) => [it['编号'], it]))

    for (const hit of r.hits) {
      const item = byId.get(hit['编号'])
      assert.ok(item, `命中条目 ${hit['编号']} 应仍在库里`)
      assert.equal(Number(item['时距']), Number(hit['时距']) + 1, `命中项时距应 +1（返回 ${hit['时距']} → 库里 ${item['时距']}）`)
    }

    // 未命中项（条目C）时距不该变
    const cItem = byId.get(c.id)
    assert.equal(Number(cItem['时距']), 1, `未命中的条目C时距必须保持 1，实际 ${cItem['时距']}`)

    assert.notEqual(before, after, '有命中时文件应发生变化（时距被更新）')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * O-附加 全新安装：空数据目录第一次写入不崩
 * ------------------------------------------------------------------ */
test('O-附加 全新安装（空数据目录）第一次 writeEntry 不崩（不得 ENOENT lock）', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    // 数据目录此刻是全新的 mkdtemp，没有任何子目录
    assert.equal(existsSync(join(h.dataDir, 'store')), false, '（前提）store 目录尚不存在')

    const w = await h.host.writeEntry(h.agent, INPUT)
    assert.equal(w.ok, true, `全新安装首次写入必须成功（他修过 ENOENT lock 的 bug），实际 ${JSON.stringify(w)}`)

    assert.ok(existsSync(libPath(h.dataDir)), '库文件应被创建')
    assert.ok(existsSync(recPath(h.dataDir, 'write')), '写入台账应被创建')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * O-附加 并发取号不撞号
 * ------------------------------------------------------------------ */
test('O-附加 并发两次写入 → 编号不撞号、两行都在', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const [r1, r2] = await Promise.all([
      h.host.writeEntry(h.agent, { ...INPUT, 主要内容: '并发第一条' }),
      h.host.writeEntry(h.agent, { ...INPUT, 主要内容: '并发第二条' }),
    ])

    assert.equal(r1.ok, true, `并发写入 1 应成功，实际 ${JSON.stringify(r1)}`)
    assert.equal(r2.ok, true, `并发写入 2 应成功，实际 ${JSON.stringify(r2)}`)
    assert.notEqual(r1.id, r2.id, `并发写入撞号了：两个都是 ${r1.id}`)

    const listed = await h.host.listEntries({ limit: 100 })
    assert.equal(listed.items.length, 2, `应有 2 条，实际 ${listed.items.length}`)
    assert.equal(new Set(listed.items.map((i) => i['编号'])).size, 2, '编号不得重复')
  } finally {
    h.cleanup()
  }
})
