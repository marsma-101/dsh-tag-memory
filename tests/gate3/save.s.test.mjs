// 闸门③ S1 组：**UI 保存链路必须真的改到库**（2026-11-08 用户反馈）。
//
// 用户现象：编辑条目 → 点保存 → 刷新页面 → 什么都没变。
//
// 根因（已修）：
//   `retagEntry(agent, payload)` 声明了两个参数，但远程端点只有**一个**参数
//   （`REMOTE_SIGNATURES.retagEntry = ['request']`）。于是远程调用时
//   `request` 落进 `agent` 位、payload 位收到 `undefined`，
//   恒报 `ID_REQUIRED` —— 什么都没改。
//
// 这一组守住：
//   S1   远程形状（单参）能改成功，且真的落盘
//   S1b  工具形状（双参 agent + payload）仍然正常，没被改坏
//   S1c  单参形状下不得把 payload 误判成 agent（不能靠"有 session"反推）
//   S1d  改完 listEntries 读回是新值（不是"返回 ok 但库没动"）

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

/** 写一条并返回编号 */
async function seed(h, agent, extra = {}) {
  const w = await h.host.writeEntry(agent, {
    主要内容: 'S1 种子条目',
    形态: '事实',
    自由标签: ['s1'],
    ...extra,
  })
  assert.equal(w.ok, true, `种子写入应成功，实际 ${JSON.stringify(w).slice(0, 150)}`)
  return w['编号']
}

/* ------------------------------------------------------------------ *
 * S1 远程形状（单参）：这是 UI 实际走的路径
 * ------------------------------------------------------------------ */
test('S1 远程形状 retagEntry(request) 能改成功（UI 保存走这条）', async () => {
  const h = await makeHostCtx({ identity: BOUND, workingDir: '/work/S1项目' })
  try {
    const agent = { session: { id: 'qa-s1' } }
    h.host.bindIdentity(agent, { 智能体: 'S1身份' })
    const id = await seed(h, agent)

    // ⚠️ 关键：只传一个参数，模拟远程端点（REMOTE_SIGNATURES = ['request']）
    const r = await h.host.retagEntry({
      编号: id,
      patch: { 形态: '规则', 自由标签: ['已改'] },
      basis: 'user_edit',
      who: null,
    })

    assert.equal(
      r.ok,
      true,
      `单参调用必须成功（这是 UI 的真实路径）。实际：${JSON.stringify(r).slice(0, 300)}`,
    )
    assert.equal(r['编号'], id, '应回传编号')
    assert.equal(r.after['形态'], '规则', 'after.形态 应是新值')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * S1b 工具形状（双参）不能被改坏
 * ------------------------------------------------------------------ */
test('S1b 工具形状 retagEntry(agent, payload) 仍然正常', async () => {
  const h = await makeHostCtx({ identity: BOUND, workingDir: '/work/S1b项目' })
  try {
    const agent = { session: { id: 'qa-s1b' } }
    h.host.bindIdentity(agent, { 智能体: 'S1b身份' })
    const id = await seed(h, agent)

    const r = await h.host.retagEntry(agent, {
      编号: id,
      patch: { 形态: '技能' },
      basis: 'user_edit',
      who: null,
    })

    assert.equal(r.ok, true, `双参调用必须仍然成功，实际 ${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(r.after['形态'], '技能', 'after.形态 应是新值')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * S1c 形状判别要稳：payload 里的字段名不能撞上 agent 的形状
 * ------------------------------------------------------------------ */
test('S1c 单参形状：payload 带 编号/patch 时必须识别为 payload 而非 agent', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const agent = { session: { id: 'qa-s1c' } }
    h.host.bindIdentity(agent, { 智能体: 'S1c身份' })
    const id = await seed(h, agent)

    // 只有 `id`（英文键）也该被认出来
    const r = await h.host.retagEntry({ id, patch: { 稳定性: '稳定' }, basis: 'user_edit' })
    assert.equal(r.ok, true, `只带 id 的单参调用也该成功，实际 ${JSON.stringify(r).slice(0, 200)}`)
    assert.equal(r.after['稳定性'], '稳定')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * S1d 真的落盘：读回必须是新值
 * ------------------------------------------------------------------ */
test('S1d 单参改完 listEntries 读回是新值（不是"返回 ok 但库没动"）', async () => {
  const h = await makeHostCtx({ identity: BOUND, workingDir: '/work/S1d项目' })
  try {
    const agent = { session: { id: 'qa-s1d' } }
    h.host.bindIdentity(agent, { 智能体: 'S1d身份' })
    const id = await seed(h, agent)

    await h.host.retagEntry({
      编号: id,
      patch: { 形态: '偏好', 自由标签: ['落盘验证'], 稳定性: '易变' },
      basis: 'user_edit',
    })

    // 关键：重新读库（模拟刷新页面），不能只看返回值
    const list = await h.host.listEntries({ limit: 100 })
    const row = list.items.find((x) => x['编号'] === id)
    assert.ok(row, '读回应能找到该条')
    assert.equal(row['形态'], '偏好', `读回的形态应是「偏好」，实际「${row['形态']}」`)
    assert.equal(row['稳定性'], '易变', `读回的稳定性应是「易变」，实际「${row['稳定性']}」`)
    assert.deepEqual(row['自由标签'], ['落盘验证'], '读回的标签应是新值')
  } finally {
    h.cleanup()
  }
})
