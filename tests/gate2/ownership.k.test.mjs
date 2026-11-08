// 闸门② K9 组：**归属由程序填**（2026-11-08 硬性裁定）。
//
// 背景（为什么需要这一组）：
//   1.2.4 之前，`项目`/`智能体` 是模型的必填参数。实测暴露出两个问题：
//     · 模型会拿「主题」当项目（"插件开发" 不是项目，`dsh-tag-memory` 才是）
//     · 同一次会话能填出几个不同的值（`萧潇` 和 `萧潇 `），归属一乱召回对不上
//   裁决：归属是**环境事实**，不是模型的判断——
//     项目 = 会话工作目录名（Host `workingDirectory` 服务）
//     智能体 = 本次会话绑定的身份（`dtm_bind`）
//   模型只决定**内容、形态、自由标签**这三件。
//
// 本组守住三件事：
//   K9   工作目录 → 项目 的取名规则（basename，POSIX 与 Windows 两种分隔符）
//   K9b  模型传的归属一律被丢弃，落库是程序值
//   K9c  程序取不到值 → 拒（不猜、不兜底）

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeHostCtx, BOUND } from '../_host-ctx.mjs'

/* ------------------------------------------------------------------ *
 * K9 工作目录 → 项目：取最后一段，两种分隔符都要认
 * ------------------------------------------------------------------ */
test('K9 项目 = 工作目录名的最后一段（POSIX 与 Windows 路径都认）', async () => {
  const cases = [
    ['/opt/dsh', 'dsh'],
    ['/opt/dsh/plugins/dsh-tag-memory', 'dsh-tag-memory'],
    ['/work/项目甲', '项目甲'],
    ['G:\\AI_treaning\\dsh插件\\dsh-tag-memory', 'dsh-tag-memory'],
    ['C:\\work\\proj', 'proj'],
    ['/opt/dsh/', 'dsh'], // 尾随分隔符不能产生空段
  ]

  for (const [workingDir, expected] of cases) {
    const h = await makeHostCtx({ identity: BOUND, workingDir })
    try {
      const agent = { session: { id: `qa-k9-${expected}` } }
      h.host.bindIdentity(agent, { 智能体: 'tester' })
      const w = await h.host.writeEntry(agent, {
        主要内容: `K9: ${workingDir}`,
        形态: '事实',
        自由标签: ['k9'],
      })
      assert.equal(w.ok, true, `写入应成功（${workingDir}），实际 ${JSON.stringify(w).slice(0, 150)}`)
      assert.equal(w['项目'], expected, `工作目录 ${workingDir} 的项目应为「${expected}」，实际「${w['项目']}」`)
    } finally {
      h.cleanup()
    }
  }
})

/* ------------------------------------------------------------------ *
 * K9b 模型传的归属被丢弃，落库是程序值
 * ------------------------------------------------------------------ */
test('K9b 模型硬塞 项目/智能体 也改不了落库值（程序值优先）', async () => {
  const h = await makeHostCtx({ identity: null, workingDir: '/work/真实项目' })
  try {
    const agent = { session: { id: 'qa-k9b' } }
    h.host.bindIdentity(agent, { 智能体: '真实身份' })

    const w = await h.host.writeEntry(agent, {
      主要内容: 'K9b：模型传的归属必须被丢弃',
      形态: '事实',
      项目: '模型猜的项目',
      智能体: '模型猜的身份',
      自由标签: ['k9b'],
    })
    assert.equal(w.ok, true, `写入应成功，实际 ${JSON.stringify(w).slice(0, 150)}`)
    assert.equal(w['项目'], '真实项目', `项目 必须是工作目录名，不是模型传的值`)
    assert.equal(w['智能体'], '真实身份', `智能体 必须是绑定身份，不是模型传的值`)

    // 落库的行也必须带程序值（不只是返回值好看）
    const r = await h.host.recall(agent, { 形态: '事实', 自由标签: ['k9b'] })
    assert.equal(r.hits.length, 1, '应召回 1 条')
    assert.equal(r.hits[0]['项目'], '真实项目', '库里存的项目必须是程序值')
    assert.equal(r.hits[0]['智能体'], '真实身份', '库里存的身份必须是程序值')
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * K9c 程序取不到值 → 拒（不猜、不兜底）
 * ------------------------------------------------------------------ */
test('K9c 取不到工作目录时拒写并报 PROJECT_EMPTY（不猜一个项目名）', async () => {
  const h = await makeHostCtx({ identity: BOUND, workingDir: '' })
  try {
    const agent = { session: { id: 'qa-k9c' } }
    h.host.bindIdentity(agent, { 智能体: 'tester' })

    const w = await h.host.writeEntry(agent, {
      主要内容: 'K9c：取不到工作目录必须拒',
      形态: '事实',
      项目: '模型想兜底填的项目',
      自由标签: ['k9c'],
    })
    assert.equal(w.ok, false, `取不到工作目录必须拒写，实际 ${JSON.stringify(w).slice(0, 150)}`)
    const codes = (w.errors ?? []).map((e) => e.code)
    assert.ok(codes.includes('PROJECT_EMPTY'), `必须报 PROJECT_EMPTY，实际 ${codes.join(', ')}`)

    // 报错必须指向标准（模型据此才知道该补什么环境）
    const err = (w.errors ?? []).find((e) => e.code === 'PROJECT_EMPTY')
    assert.ok(err.message.includes('标签字典'), 'PROJECT_EMPTY 报错必须指向《标签字典》')
  } finally {
    h.cleanup()
  }
})
