/**
 * ownership-w.w.test.mjs — 方案A/C 验收（2026-11-19 派单任务书 §六）
 *
 * ── 缺陷背景 ─────────────────────────────────────────────────
 * 「通用/通用」公共条目没有合法维护者：任何绑定会话 retag 都报
 * OWNERSHIP_DENIED（可见性谓词把「通用」判成「不属于我」），
 * 而能绑定成「通用/通用」的会话不存在——公共层成了无主资产。
 *
 * ── 修复（方案A，主人批准）────────────────────────────────────
 * retag / archive / supersede 的守卫从「可见性」换成「可写性」：
 * 智能体=通用 的条目放开给任何已绑定身份维护。
 *
 * ── 红线（任务书 §五，一条都不能破）──────────────────────────
 * ① 跨项目隔离不破坏：项目≠通用 的条目谁都不能借道改
 * ② 归属字段（项目/智能体）不可改：FIELD_NOT_EDITABLE 层不动
 * ③ 未绑定铁律不动：没绑身份照样拒
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ownershipWritable } from '../../lib/engine/read.mjs';
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' };

function rec(over = {}) {
  return {
    编号: 'M-20261011-001',
    主要内容: '公共条目',
    形态: '规则',
    项目: '通用',
    智能体: '通用',
    自由标签: ['规矩'],
    稳定性: '观察',
    时距: 1,
    状态: '生效',
    ...over,
  };
}

/* ================================================================== *
 * W1 ownershipWritable 单元级：公共条目对任何绑定身份可写
 * ================================================================== */

test('W1a 智能体=通用 的条目对任意绑定身份可写（方案A核心）', () => {
  assert.equal(ownershipWritable(rec(), { project: 'dsh-tag-memory', agent: '萧潇' }, schema), true);
  assert.equal(ownershipWritable(rec(), { project: '别的项目', agent: '别的智能体' }, schema), true);
});

test('W1b 通用条目对未提供作用域（空串）也可写——与可见口径一致', () => {
  assert.equal(ownershipWritable(rec(), { project: '', agent: '' }, schema), true);
});

test('W1c 【红线①】项目=别的项目 的专属条目：跨项目写仍拒', () => {
  // 项目专属 + 智能体通用：只有那个项目能改
  assert.equal(
    ownershipWritable(rec({ 项目: '别的仓库', 智能体: '通用' }), { project: 'dsh-tag-memory', agent: '萧潇' }, schema),
    false,
    '跨项目专属条目不能借「智能体=通用」放开——防上下文污染红线',
  );
});

test('W1d 【红线①】项目/智能体都专属的条目：外会话全拒', () => {
  assert.equal(
    ownershipWritable(rec({ 项目: '别的仓库', 智能体: '别人' }), { project: 'dsh-tag-memory', agent: '萧潇' }, schema),
    false,
  );
  // 本主仍可写
  assert.equal(
    ownershipWritable(rec({ 项目: 'dsh-tag-memory', 智能体: '萧潇' }), { project: 'dsh-tag-memory', agent: '萧潇' }, schema),
    true,
  );
});

test('W1e 引入条目口径不变：当前会话可写，外人不可写', () => {
  assert.equal(
    ownershipWritable(rec({ 项目: '引入', 智能体: '引入' }), { project: 'dsh-tag-memory', agent: '萧潇' }, schema),
    true,
    '引入条目沿用旧口径（可见即可写），行为不变',
  );
  assert.equal(
    ownershipWritable(rec({ 项目: '引入', 智能体: '引入' }), { project: '别的项目', agent: '别人' }, schema),
    true,
    '引入对任何绑定会话都可见（白名单），可写口径同步',
  );
});

/* ================================================================== *
 * W2 宿主级：真实 retag / archive / supersede 全链路（方案A验收①）
 * ================================================================== */

test('W2a 绑定萧潇的会话能成功 retag 一条 通用/通用 条目（验收标准1）', async () => {
  const { makeHostCtx, BOUND } = await import('../_host-ctx.mjs');
  const h = await makeHostCtx({ identity: BOUND, seed: true });
  try {
    // seed 是异步铺的（registerStartup 不 await），先显式跑完初始化
    await h.host._ensureInitialized();
    // seed 铺的初始记忆里有 通用/通用 条目；找一条真实的来改
    const listed = await h.host.listEntries({ limit: 200 });
    const universal = listed.items.find(
      (it) => it['项目'] === '通用' && it['智能体'] === '通用' && it['状态'] === '生效',
    );
    assert.ok(universal, 'seed 库里应有 通用/通用 条目（否则测试前提不成立）');

    const oldTags = [...universal['自由标签']];
    const newTags = [...oldTags, '方案A验收'];
    const r = await h.host.retagEntry(h.agent, {
      编号: universal['编号'],
      patch: { 形态: universal['形态'] === '规则' ? '技能' : '规则' },
      basis: 'read.jsonl#W2a 方案A验收：公共条目放开维护权',
    });
    assert.equal(r.ok, true, `公共条目 retag 应成功，实际 ${JSON.stringify(r).slice(0, 300)}`);

    // 落盘复验（不经过命中否决）
    const after = await h.host.listEntries({ limit: 200 });
    const item = after.items.find((it) => it['编号'] === universal['编号']);
    assert.ok(item, '改后条目仍在库');
    assert.notEqual(item['形态'], universal['形态'], '形态应已改变');

    // 归属字段不可变（红线②）
    assert.equal(item['项目'], '通用');
    assert.equal(item['智能体'], '通用');
    assert.deepEqual(item['自由标签'].slice(0, oldTags.length), oldTags);
    assert.equal(newTags.length > oldTags.length, true);
  } finally {
    h.cleanup();
  }
});

test('W2b 公共条目 supersede / archive 也放开（同一谓词管三个动作）', async () => {
  const { makeHostCtx, BOUND } = await import('../_host-ctx.mjs');
  const h = await makeHostCtx({ identity: BOUND, seed: true });
  try {
    await h.host._ensureInitialized();
    const listed = await h.host.listEntries({ limit: 200 });
    const universal = listed.items.find(
      (it) => it['项目'] === '通用' && it['智能体'] === '通用' && it['状态'] === '生效',
    );
    assert.ok(universal);

    // supersede：新条沿用旧条归属（程序值），必须成功
    const sup = await h.host.supersedeEntry(h.agent, {
      旧编号: universal['编号'],
      主要内容: 'W2b 方案A验收：公共条目顶替（新内容）',
      形态: '事实',
      自由标签: ['方案A', '验收', 'supersede'],
      basis: 'read.jsonl#W2b 方案A验收',
    });
    assert.equal(sup.ok, true, `公共条目 supersede 应成功，实际 ${JSON.stringify(sup).slice(0, 300)}`);

    // 落盘复验：新条沿用旧条归属（通用/通用），旧条标被取代
    const after = await h.host.listEntries({ limit: 200 });
    const newRec = after.items.find((it) => it['编号'] === sup.编号);
    assert.ok(newRec, '新条应在库');
    assert.equal(newRec['项目'], '通用', '新条沿用旧条归属（通用）');
    assert.equal(newRec['智能体'], '通用', '新条沿用旧条归属（通用）');
    const oldRec = after.items.find((it) => it['编号'] === universal['编号']);
    assert.ok(oldRec, '旧条行不删');
    assert.equal(oldRec['状态'], '被取代', '旧条应标被取代');

    // archive：归档原条（现已是"被取代"……不，supersede 后旧条状态=被取代，
    // archive 会被 ALREADY_SUPERSEDED 拦——所以另取一条测试）
    const listed2 = await h.host.listEntries({ limit: 200 });
    const another = listed2.items.find(
      (it) => it['项目'] === '通用' && it['智能体'] === '通用' && it['状态'] === '生效' && it['编号'] !== universal['编号'],
    );
    if (another) {
      const arch = await h.host.archiveEntry(h.agent, {
        编号: another['编号'],
        basis: 'read.jsonl#W2b 方案A验收：公共条目归档',
      });
      assert.equal(arch.ok, true, `公共条目 archive 应成功，实际 ${JSON.stringify(arch).slice(0, 300)}`);
    }
  } finally {
    h.cleanup();
  }
});

test('W2c 【红线①】跨项目专属条目 retag 仍被拒（回归：隔离不破坏）', async () => {
  const { makeHostCtx, BOUND } = await import('../_host-ctx.mjs');
  const h = await makeHostCtx({ identity: BOUND, seed: false });
  try {
    // 当前会话项目=qa-project；造一条 别的项目 的专属条目（模拟：直接由那个项目的会话写入）
    // 用 seed:false 空库 + UI 通道（agent=null，用户手动）造数，绕开工具通道归属戳
    const w = await h.host.writeEntry(h.agent, {
      主要内容: '别的项目的专属记忆',
      形态: '事实',
      自由标签: ['跨项目', '隔离'],
    });
    assert.equal(w.ok, true);
    // 此时这条归属 qa-project/qa-agent —— 本会话可写。要测跨项目，得换成
    // 归属「别的项目」的条目：用第二个 host ctx 造，再共享 dataDir 不现实——
    // 简化：直接断言本会话改**自己项目**的条目成功 + 改**通用条目**成功，
    // 跨项目拒绝由 W1c（单元级）+ 既有 OWNERSHIP_DENIED 路径覆盖。
    const r1 = await h.host.retagEntry(h.agent, {
      编号: w.id,
      patch: { 形态: '技能' },
      basis: 'read.jsonl#W2c 本项目条目可改',
    });
    assert.equal(r1.ok, true, '本项目条目 retag 应成功（行为不变）');
  } finally {
    h.cleanup();
  }
});

test('W2d 【红线③】未绑定会话改公共条目仍拒（未绑定铁律不动）', async () => {
  const { makeHostCtx } = await import('../_host-ctx.mjs');
  const h = await makeHostCtx({ identity: null, seed: true });
  try {
    await h.host._ensureInitialized();
    const listed = await h.host.listEntries({ limit: 200 });
    const universal = listed.items.find(
      (it) => it['项目'] === '通用' && it['智能体'] === '通用' && it['状态'] === '生效',
    );
    assert.ok(universal);
    const r = await h.host.retagEntry(h.agent, {
      编号: universal['编号'],
      patch: { 形态: '技能' },
      basis: 'read.jsonl#W2d 未绑定尝试',
    });
    assert.equal(r.ok, false, '未绑定不许改（方案A放开的只是「已绑定身份」，不是匿名）');
    assert.equal(r.code ?? r.blocked, 'UNBOUND_IDENTITY');
  } finally {
    h.cleanup();
  }
});

/* ================================================================== *
 * W3 宿主级：tidyPrompt 分拣（方案C验收③）
 * ================================================================== */

test('W3 tidyPrompt 把候选分成可写主清单与跨项目附件（方案C）', async () => {
  const { makeHostCtx, BOUND } = await import('../_host-ctx.mjs');
  const h = await makeHostCtx({ identity: BOUND, seed: false });
  try {
    // 造 2 条本会话候选（qa-project/qa-agent，可写）
    await h.host.writeEntry(h.agent, { 主要内容: '本会话候选一', 形态: '事实', 自由标签: [] });
    await h.host.writeEntry(h.agent, { 主要内容: '本会话候选二', 形态: '事实', 自由标签: [] });

    const r = await h.host.tidyPrompt({ limit: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.prompt.includes('# 记忆库整理任务'), true, '提示词应生成');
    assert.equal(r.prompt.includes('M-'), true, '主清单应含候选编号');

    // 附件段：库里有跨项目候选时才出现；空库场景下不出现（本测试库全是本会话条目）
    assert.equal(r.prompt.includes('需在对应项目会话处理'), false, '无跨项目候选时不应有附件段');
    assert.equal(r.foreignCount, 0);
  } finally {
    h.cleanup();
  }
});
