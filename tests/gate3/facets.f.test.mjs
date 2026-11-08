// 闸门③ F1 组：**取值域一律来自宿主，前端不写死**（2026-11-08 用户裁定）。
//
// 背景：
//   用户反馈编辑条目时点「项目」下拉只有一个值（就是原有的），改不了。
//   根因是 `<input list>` + `<datalist>`：浏览器按输入框当前内容**过滤**候选，
//   编辑时输入框预填原值，于是只剩匹配的那一项。
//
//   修的过程中发现更严重的问题：client.js 里写死了
//     SHAPES / STABILITIES / STATUSES / UNIVERSAL
//   四个常量，并在宿主取不到时"退回"它们。那是有害的兜底：
//     · 字典改了前端不跟 → 用户选到宿主不认的值 → 提交被拒还以为自己操作错
//     · 库是空的前端照样显示"标准答案" → 掩盖"这里确实还没有值"
//
// 这一组守住：
//   F1   client.js 里不得再出现写死的业务取值域
//   F1b  宿主 getFacets 的项目/智能体必须是从库里扫出来的（不是常量）
//   F1c  空库时 facets 返回空数组（不编造候选）
//   F1d  getOverview 带 byStatus（自描述），前端不必维护状态名映射

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * F1 前端不得写死业务取值域
 * ------------------------------------------------------------------ */
test('F1 client.js 不写死 形态/稳定性/状态 的取值域', () => {
  // 只看代码，不看注释：注释里提到这些名字是允许的（解释历史）
  const code = CLIENT_SRC
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  const banned = [
    ['形态', /const\s+SHAPES\s*=\s*\[/],
    ['稳定性', /const\s+STABILITIES\s*=\s*\[/],
    ['状态', /const\s+STATUSES\s*=\s*\[/],
    ['通用/引入', /const\s+UNIVERSAL\s*=\s*\[/],
  ]
  for (const [label, re] of banned) {
    assert.ok(
      !re.test(code),
      `client.js 仍写死了「${label}」的取值域（${re}）。取值域必须来自宿主 facets——` +
        `写死的话字典改了前端不跟，用户会选到宿主不认的值。`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * F1b facets 从库里扫，不是常量
 * ------------------------------------------------------------------ */
test('F1b getFacets 的项目/智能体来自库内容（写什么就出现什么）', async () => {
  const h = await makeHostCtx({ identity: BOUND, workingDir: '/work/F1项目甲' })
  try {
    const agent = { session: { id: 'qa-f1b' } }
    h.host.bindIdentity(agent, { 智能体: 'F1身份甲' })

    const w = await h.host.writeEntry(agent, {
      主要内容: 'F1b：项目候选应来自库',
      形态: '事实',
      自由标签: ['f1b'],
    })
    assert.equal(w.ok, true, `写入应成功，实际 ${JSON.stringify(w).slice(0, 150)}`)

    const f = await h.host.getFacets()
    assert.equal(f.ok, true, 'getFacets 应成功')
    assert.ok(
      f['项目'].includes('F1项目甲'),
      `项目候选应包含刚写入的「F1项目甲」，实际：${f['项目'].join(' / ')}`,
    )
    assert.ok(
      f['智能体'].includes('F1身份甲'),
      `智能体候选应包含刚写入的「F1身份甲」，实际：${f['智能体'].join(' / ')}`,
    )
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * F1c 空库不编造候选
 * ------------------------------------------------------------------ */
test('F1c 空库时 facets 的项目/智能体为空数组（不编造候选）', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const f = await h.host.getFacets()
    assert.equal(f.ok, true, 'getFacets 应成功')
    assert.deepEqual(f['项目'], [], '空库时项目候选必须为空，不能编造')
    assert.deepEqual(f['智能体'], [], '空库时智能体候选必须为空，不能编造')

    // 但字典里的合法值必须给全 —— 编辑时要能选，即便库里还没有
    assert.ok(Array.isArray(f.allowedShapes) && f.allowedShapes.length > 0, 'allowedShapes 不能空')
    assert.ok(Array.isArray(f.allowedStabilities) && f.allowedStabilities.length > 0, 'allowedStabilities 不能空')
    assert.ok(Array.isArray(f.allowedStatuses) && f.allowedStatuses.length > 0, 'allowedStatuses 不能空')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * F1d overview 自带 byStatus
 * ------------------------------------------------------------------ */
test('F1d getOverview 带 byStatus（状态名+条数自描述，前端不用维护映射表）', async () => {
  const h = await makeHostCtx({ identity: BOUND })
  try {
    const agent = { session: { id: 'qa-f1d' } }
    h.host.bindIdentity(agent, { 智能体: 'tester' })
    await h.host.writeEntry(agent, {
      主要内容: 'F1d：byStatus 自描述',
      形态: '事实',
      自由标签: ['f1d'],
    })

    const o = await h.host.getOverview()
    assert.equal(o.ok, true, 'getOverview 应成功')
    assert.ok(Array.isArray(o.byStatus), 'byStatus 必须是数组')
    assert.ok(o.byStatus.length > 0, 'byStatus 不能为空')

    for (const item of o.byStatus) {
      assert.ok(typeof item['状态'] === 'string' && item['状态'] !== '', 'byStatus 每项要有 状态')
      assert.ok(typeof item['数量'] === 'number', 'byStatus 每项要有 数量')
    }

    // 总条数必须等于各状态之和（自洽性）
    const sum = o.byStatus.reduce((acc, x) => acc + x['数量'], 0)
    assert.equal(sum, o.total, `byStatus 之和 ${sum} 应等于 total ${o.total}`)

    // 新写入的那条是「生效」
    const active = o.byStatus.find((x) => x['状态'] === '生效')
    assert.ok(active && active['数量'] >= 1, '应有「生效」状态且至少 1 条')
  } finally {
    h.cleanup()
  }
})
