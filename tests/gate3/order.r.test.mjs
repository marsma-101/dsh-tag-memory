// 闸门② R13 组：界面列表顺序 —— **新的排前面**。
//
// 背景（2026-11-08 用户反馈）：
//   界面里越早存的越靠前，最新的沉在最后一页，想找刚记的那条得翻到底。
//   根因：CSV 是追加写的，`records` 天然顺序 = 从旧到新，界面直接拿它显示。
//   修法：listEntries 按 `编号` 倒序（编号 `M-YYYYMMDD-NNN` 自带时间序）。
//
// 这一组守住三件事：
//   R13   默认列表新的排前面
//   R13b  分页也按倒序切（第一页就是最新的 N 条，不是最旧的）
//   R13c  筛选后仍然是倒序（不能因为过滤把顺序丢掉）

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

/** 连写 3 条，返回编号（按写入先后） */
async function writeThree(h, agent) {
  const ids = []
  for (const n of [1, 2, 3]) {
    const w = await h.host.writeEntry(agent, {
      主要内容: `R13 第 ${n} 条`,
      形态: '事实',
      自由标签: ['r13'],
    })
    assert.equal(w.ok, true, `第 ${n} 条写入应成功，实际 ${JSON.stringify(w).slice(0, 150)}`)
    ids.push(w['编号'])
  }
  return ids
}

/* ------------------------------------------------------------------ *
 * R13 默认列表：新的排前面
 * ------------------------------------------------------------------ */
test('R13 listEntries 默认新的排前面（不是 CSV 文件顺序）', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const agent = { session: { id: 'qa-r13' } }
    h.host.bindIdentity(agent, { 智能体: 'tester' })

    const written = await writeThree(h, agent)
    // 写入顺序即时间顺序：第 1 条最早，第 3 条最新
    const list = await h.host.listEntries({ limit: 100 })
    assert.equal(list.ok, true, 'listEntries 应成功')

    const ids = list.items.map((r) => r['编号'])
    assert.deepEqual(
      ids,
      [...written].reverse(),
      `列表应按编号倒序（最新在前），实际：${ids.join(', ')}（写入顺序：${written.join(', ')}）`,
    )
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * R13b 分页也倒序切
 * ------------------------------------------------------------------ */
test('R13b 分页按倒序切：第一页是最新的 N 条', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const agent = { session: { id: 'qa-r13b' } }
    h.host.bindIdentity(agent, { 智能体: 'tester' })

    const written = await writeThree(h, agent)
    const newest = written[written.length - 1]

    const page1 = await h.host.listEntries({ limit: 1, offset: 0 })
    assert.equal(page1.items.length, 1, '第一页应有 1 条')
    assert.equal(
      page1.items[0]['编号'],
      newest,
      `第一页第一条应是最新那条「${newest}」，实际「${page1.items[0]['编号']}」`,
    )

    const page2 = await h.host.listEntries({ limit: 1, offset: 1 })
    assert.equal(page2.items[0]['编号'], written[1], '第二页应是中间那条')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * R13c 筛选后仍倒序
 * ------------------------------------------------------------------ */
test('R13c 带筛选条件时顺序不丢（仍新的在前）', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const agent = { session: { id: 'qa-r13c' } }
    h.host.bindIdentity(agent, { 智能体: 'tester' })

    // 写两条「事实」+ 一条「规则」，确认筛选不会打乱顺序
    const facts = []
    for (const n of [1, 2]) {
      const w = await h.host.writeEntry(agent, {
        主要内容: `R13c 事实 ${n}`,
        形态: '事实',
        自由标签: ['r13c'],
      })
      facts.push(w['编号'])
    }
    await h.host.writeEntry(agent, {
      主要内容: 'R13c 规则',
      形态: '规则',
      自由标签: ['r13c'],
    })

    const list = await h.host.listEntries({ 形态: '事实', limit: 100 })
    const ids = list.items.map((r) => r['编号'])
    assert.deepEqual(
      ids,
      [...facts].reverse(),
      `筛选后仍应倒序，实际：${ids.join(', ')}（写入顺序：${facts.join(', ')}）`,
    )
    assert.equal(list.items.length, 2, '只该有 2 条「事实」')
  } finally {
    h.cleanup()
  }
})
