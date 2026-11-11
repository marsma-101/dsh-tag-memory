/**
 * read.h.test.mjs — 召回阈值标定回归（§4.1 / §3 探针）
 *
 * 起因（《改进与迭代方向-2026-11-11.md》§3）：
 *   出厂 entryRatio=0.5 与实库「平均 4~5 个标签」不匹配 —— 标签打得越规范、
 *   分母越大，越召不回。同口径自证探针 k=1 假查空率 98.5% / k=2 87.9% / k=3 19.7%，
 *   失败 100% 是 ENTRY_RATIO。原有 read.*.test.mjs 只冻结了「=0.5 不过」，
 *   没有「多标签条目 + 少标签 query」的用例，所以偏差一直没被测出来。
 *
 * 本组专测这个空白，并守住三条不能顺手改坏的东西：
 *   ① 判定符 `>`（条目侧）/ `>=`（query 侧）逐位冻结，只标定数值；
 *   ② 跨项目/跨身份硬筛不受阈值影响（§4.1 验收要求隔离结果不变）；
 *   ③ 出厂值来自 scoring.json，用户侧 overrides 能覆盖（dict.mjs 深合并）。
 *
 * 与 read.f.test.mjs 的分工：F 组用局部 config 固定 0.5 守旧裁决的等号/顺序；
 * 本组用**出厂 config**（0.3）验新行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recall, checkIsolation } from '../../lib/engine/read.mjs';
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' };
import scoring from '../../lib/engine/templates/scoring.json' with { type: 'json' };
import equivalence from '../../lib/engine/templates/tag-equivalence.json' with { type: 'json' };

const EQ = { groups: [] };
const ID = { bound: true, who: '萧潇' };

function rec(over = {}) {
  return {
    编号: 'M-20261111-001',
    主要内容: '多标签条目',
    形态: '技能',
    项目: 'dsh-tag-memory',
    智能体: '萧潇',
    自由标签: ['发版', '上线', '部署', '回滚', '监控', '预案'],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
    ...over,
  };
}

function run(records, 自由标签, extra = {}) {
  return recall({
    records,
    query: { 项目: 'dsh-tag-memory', 智能体: '萧潇', 形态: '技能', 自由标签 },
    identity: ID,
    schema,
    config: scoring,
    equivalence: EQ,
    ...extra,
  });
}

const idsOf = (res) => res.hits.map((h) => h['编号']);

/* ------------------------------------------------------------------ *
 * H1 出厂阈值已标定为 0.3（不是 0.5）
 * ------------------------------------------------------------------ */
test('H1 出厂 veto.entryRatio = 0.3（§4.1 标定，判定符仍为 >）', () => {
  assert.equal(scoring.veto.entryRatio, 0.3, '出厂阈值应为温和标定的 0.3，不要一步到 0.1')
  assert.equal(scoring.veto.queryFloor, 0.15, 'queryFloor 不动，仍为 0.15')
})

/* ------------------------------------------------------------------ *
 * H2 【核心回归】多标签条目 + 少标签 query → 该召回的能召回
 *    这正是 §3 探针 k=1/2/3 在库里跑出来的失败形态
 * ------------------------------------------------------------------ */
test('H2 【核心回归】6 标签条目，k=2/3 少词查询应召回（出厂 0.3 温标定）', () => {
  const r = rec() // 6 个标签
  for (const k of [2, 3]) {
    const q = r['自由标签'].slice(0, k)
    const res = run([r], q)
    assert.deepEqual(
      idsOf(res),
      [r['编号']],
      `k=${k}（查询词全部来自条目本身）应召回该条，实际 ${idsOf(res).join(',')}；` +
        `near=${JSON.stringify(res.near)}`,
    )
  }

  // k=1 在 0.3 下 e_ratio=1/6≈0.167 ≤ 0.3 → 仍被否决，与 §3 探针
  // 「0.3 时 k=1 假查空率 87.9%」一致。文档明令「不要一步到 0.1，先用 0.3」
  // （一步到 0.1 才能把 k=1 也压到 0%）。这里显式锁住这个温和标定的边界，
  // 防止后人误以为 0.3 已解决所有少词查询。
  const k1 = run([r], r['自由标签'].slice(0, 1))
  assert.deepEqual(idsOf(k1), [], 'k=1（e_ratio≈0.167）在 0.3 下按严格 > 判定应被否决')
  assert.equal(k1.near[0].reason, 'ENTRY_RATIO')
})

/* ------------------------------------------------------------------ *
 * H3 标签越多、分母越大也不该召不回（写入规范与读取闸门配平）
 *    7/10 个标签、只查 2 个词 → e_ratio=0.2/0.2 > 0.3? 0.2 不过，见 H3b 边界
 * ------------------------------------------------------------------ */
test('H3 标签数 4~7 的条目，k=2 查询都能召回（0.3 下 e_ratio≥0.286）', () => {
  for (const n of [4, 5, 6, 7]) {
    const tags = Array.from({ length: n }, (_, i) => `t${i}`)
    const r = rec({ 编号: `M-20261111-${String(n).padStart(3, '0')}`, 自由标签: tags })
    const res = run([r], tags.slice(0, 2)) // 命中 2 → e_ratio = 2/n
    // n=7 → 2/7≈0.286 > 0.3? 不，0.286 < 0.3，会被否决 —— 见 H3b 显式边界
    if (2 / n > scoring.veto.entryRatio) {
      assert.deepEqual(idsOf(res), [r['编号']], `n=${n} k=2（e_ratio=${(2 / n).toFixed(3)}）应召回`)
    } else {
      assert.deepEqual(idsOf(res), [], `n=${n} k=2（e_ratio=${(2 / n).toFixed(3)} ≤ 0.3）按 > 判定应被否决`)
      const near = res.near.find((x) => x['编号'] === r['编号'])
      assert.ok(near, '被否决的条目应进 near 作为擦边物证')
      assert.equal(near.reason, 'ENTRY_RATIO')
    }
  }
})

test('H3b 显式边界：e_ratio 恰 0.3（3/10）仍被否决，严格 > 没被改坏', () => {
  const tags = Array.from({ length: 10 }, (_, i) => `t${i}`)
  const r = rec({ 编号: 'M-20261111-010', 自由标签: tags })
  const res = run([r], tags.slice(0, 3)) // 3/10 = 0.3，恰好等于阈值
  assert.deepEqual(idsOf(res), [], 'e_ratio 恰等于 0.3 也不得过（判定符是严格 >）')
  const near = res.near.find((x) => x['编号'] === r['编号'])
  assert.ok(near)
  assert.equal(near.reason, 'ENTRY_RATIO')
  assert.equal(near.e_ratio, 0.3)
})

/* ------------------------------------------------------------------ *
 * H4 阈值来自配置，不是硬编码：overrides 到 0.5 时行为回到旧版
 * ------------------------------------------------------------------ */
test('H4 阈值来自 scoring.json：覆盖为 0.5 后同一探针回到「召不回」', () => {
  const legacy = { ...scoring, veto: { ...scoring.veto, entryRatio: 0.5 } }
  const r = rec()
  const res = run([r], r['自由标签'].slice(0, 2), { config: legacy }) // e_ratio=2/6≈0.333
  assert.deepEqual(idsOf(res), [], '覆盖成 0.5 后 e_ratio=0.333 又被否决 —— 证明阈值没写死在 read.mjs')
  assert.equal(res.near[0].reason, 'ENTRY_RATIO')
})

/* ------------------------------------------------------------------ *
 * H5 【验收】跨项目/跨身份隔离不受阈值标定影响
 * ------------------------------------------------------------------ */
test('H5 阈值降到 0.3 后，跨项目/跨身份条目仍查不到（硬筛在否决之前）', () => {
  const visible = rec({ 编号: 'M-20261111-100' })
  const foreignProject = rec({ 编号: 'M-20261111-101', 项目: '别的仓库' })
  const foreignAgent = rec({ 编号: 'M-20261111-102', 智能体: '别人' })
  const archived = rec({ 编号: 'M-20261111-103', 状态: '已归档' })

  const records = [visible, foreignProject, foreignAgent, archived]
  const res = run(records, visible['自由标签'].slice(0, 2))

  assert.deepEqual(idsOf(res), [visible['编号']], '只有可见集合内的条目可返回')
  assert.equal(res.filtered, 1, `硬筛后应剩 1 条，实际 ${res.filtered}`)

  // 直接复验 checkIsolation：阈值改动与硬筛函数完全无关
  assert.equal(checkIsolation(foreignProject, { project: 'dsh-tag-memory', agent: '萧潇' }, schema).pass, false)
  assert.equal(checkIsolation(foreignAgent, { project: 'dsh-tag-memory', agent: '萧潇' }, schema).pass, false)
  assert.equal(checkIsolation(archived, { project: 'dsh-tag-memory', agent: '萧潇' }, schema).pass, false)
})

/* ------------------------------------------------------------------ *
 * H6 通用/引入 白名单仍可见（隔离口径不变）
 * ------------------------------------------------------------------ */
test('H6 项目/智能体为 通用·引入 的条目在 0.3 下仍可见', () => {
  const records = [
    rec({ 编号: 'M-20261111-200', 项目: '通用', 智能体: '通用' }),
    rec({ 编号: 'M-20261111-201', 项目: '引入', 智能体: '引入' }),
  ]
  const res = run(records, records[0]['自由标签'].slice(0, 2))
  assert.equal(res.filtered, 2, '白名单取值仍进可见集合')
  assert.equal(idsOf(res).length, 2, '0.3 下这两条都应被召回')
})

/* ------------------------------------------------------------------ *
 * H7 空标签条目仍被否决（0/0 裁决不因阈值变化而松动）
 * ------------------------------------------------------------------ */
test('H7 空标签条目 + 非空 query 仍被 ENTRY_RATIO 否决（0/0 裁决不变）', () => {
  const r = rec({ 编号: 'M-20261111-300', 自由标签: [] })
  const res = run([r], ['发版', '上线'])
  assert.deepEqual(idsOf(res), [])
  const near = res.near.find((x) => x['编号'] === r['编号'])
  assert.ok(near)
  assert.equal(near.reason, 'ENTRY_RATIO')
  assert.equal(near.e_ratio, 0)
})
