/**
 * on-demand-hints.test.mjs — 精简后的「按需细则」补偿机制验收
 *
 * 背景（2026-11-11 分层精简）：
 *   section 从 5998 → 3626 字节，工具定义从 7819 → 6964 字节。
 *   被砍掉的内容**不是消失，而是改在真需要时才出现**：
 *     · 写入原则 5 条 → dtm_write 被拒时返回
 *     · 自由标签怎么打 → dtm_write 被拒时返回
 *     · 字段完整含义 → 标签字典.md
 *
 * 本文件守的正是「**不能因为精简导致该给的没给**」——
 * 一旦按需通道失效，模型会瞎试、反复重试，浪费的 token 远超省下的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeCtx } from '../_fake-ctx.mjs';
import { apply } from '../../preset/index.js';
import { makeHostCtx } from '../_host-ctx.mjs';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 造一个「preset 已接线到真实宿主」的测试环境 */
async function setup() {
  const h = await makeHostCtx({ identity: { 智能体: 'hint-agent', 项目: 'hint-project' } });
  const ctx = createFakeCtx({ services: { dtmHost: h.host } });
  apply(ctx, {});
  const tool = (name) => ctx.__tools.find((t) => t.name === name);
  return { h, ctx, tool };
}

test('H1 写入被拒时，返回值必须带「写入原则」与「标签怎么打」', async () => {
  const { h, tool } = await setup();
  try {
    // 含竖线 → 必然被拒（TAG_CONTAINS_PIPE）
    const out = await tool('dtm_write').execute(
      { 主要内容: '验证用', 形态: '技能', 自由标签: ['a|b'] },
      { agent: h.agent },
    );
    assert.equal(out.ok, false);

    // ① 原始错误码与点名文案必须保留（重写会丢关键信息）
    assert.ok(out.text.includes('TAG_CONTAINS_PIPE'), '必须保留原错误码');
    assert.ok(out.text.includes('a|b'), '必须点名是哪个标签');

    // ② 被砍掉的「写入原则」必须在这里补回来
    assert.ok(out.text.includes('写入原则'), '被拒时要给写入原则（原先在 section 里）');
    assert.ok(out.text.includes('只记正向结论') || out.text.includes('适用条件'), '原则内容要真的渲染出来');

    // ③ 被砍掉的「自由标签怎么打」必须在这里补回来
    assert.ok(out.text.includes('三方向'), '被拒时要给标签打法的三方向');
    assert.ok(out.text.includes('纯数字'), '要点名不该打的类型');
    assert.ok(out.text.includes('6~8'), '要给出数量建议');
  } finally {
    h.cleanup();
  }
})

test('H2 写入成功时**不带**这些细则（真按需，不浪费成功路径的 token）', async () => {
  const { h, tool } = await setup();
  try {
    const out = await tool('dtm_write').execute(
      { 主要内容: '正常条目', 形态: '技能', 自由标签: ['正常', '条目'] },
      { agent: h.agent },
    );
    assert.equal(out.ok, true, `应写入成功，实际 ${JSON.stringify(out).slice(0, 120)}`);
    assert.equal(out.text.includes('写入原则'), false, '成功路径不该附带长篇细则');
    assert.equal(out.text.includes('三方向'), false, '成功路径不该附带标签细则');
  } finally {
    h.cleanup();
  }
})

test('H3 写入原则来自 schema.json（单一真源，不硬编码在 preset 里）', async () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_DIR, 'lib', 'engine', 'templates', 'schema.json'), 'utf8'),
  );
  const principles = schema.writeRoutes.principles;
  assert.ok(Array.isArray(principles) && principles.length > 0, 'schema 里要保留 principles 数据');

  const { h, tool } = await setup();
  try {
    const out = await tool('dtm_write').execute(
      { 主要内容: 'x', 形态: '技能', 自由标签: ['a|b'] },
      { agent: h.agent },
    );
    // 至少第一条原则的原句要能对上（证明是从 schema 读的，没另存一份）
    const first = String(principles[0]).slice(0, 12);
    assert.ok(out.text.includes(first), `返回值应含 schema 里的原则原文（片段「${first}」）`);
  } finally {
    h.cleanup();
  }
})

test('H4 精简后 section 里不得再出现这些细则（否则就是没砍干净）', () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const section = ctx.__sections[0].text({ agent: null });
  for (const gone of ['只记正向结论', '不查重、直接写', '写清适用条件', '纯数字', '三方向']) {
    assert.equal(section.includes(gone), false, `section 里不该再有「${gone}」（已下沉到按需通道）`);
  }
  // 但「判什么该写」必须在（这是每轮真正要判的）
  for (const keep of ['什么情况该写', '规矩', '决策', '踩坑', '不写']) {
    assert.ok(section.includes(keep), `section 必须保留「${keep}」`);
  }
})

test('H5 标签字典.md 仍是完整说明的落地处（模型主动读得到）', () => {
  const dict = fs.readFileSync(path.join(PACKAGE_DIR, '标签字典.md'), 'utf8');
  assert.ok(dict.includes('写入原则'), '文档里要有写入原则全文');
  // 2026-11-12 P1-10：不再要求「来源标记」禁词——原话/推断 作类别首词合法（与 classTag 一致）。
  assert.ok(dict.includes('纯数字') && dict.includes('转述'), '文档里要有标签禁忌（纯数字/转述句）');
  assert.ok(dict.includes('6~8'), '文档里要有数量建议');
})
