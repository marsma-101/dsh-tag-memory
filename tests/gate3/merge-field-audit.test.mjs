/**
 * merge-field-audit.test.mjs — §4.3 合并字段口径体检验收
 *
 * 三层：
 *   A. 纯函数 inspectMergeFields（只读、可脱离框架单测）；
 *   B. mergeLibrary({dryRun:true}) 真的返回 fieldAudit，且不改库；
 *   C. 工具 format / client.js 文案 / 契约注释 都接上了同一份数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { inspectMergeFields } from '../../lib/engine/diagnose.mjs';
import { formatMergeResult } from '../../preset/format.js';
import { makeHostCtx } from '../_host-ctx.mjs';
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' };

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function rec(over = {}) {
  return {
    编号: 'M-20261111-001',
    主要内容: '一条记忆',
    形态: '技能',
    项目: 'dsh-tag-memory',
    智能体: '萧潇',
    自由标签: ['发版', '上线', '部署'],
    稳定性: '观察',
    时距: 0,
    状态: '生效',
    ...over,
  };
}

/* ================================================================== *
 * A. 纯函数
 * ================================================================== */

test('A1 整洁库：各维度归零、建议为「无需特别处置」', () => {
  const a = inspectMergeFields([rec(), rec({ 编号: 'M-20261111-002', 主要内容: '另一条' })], schema);
  assert.equal(a.scanned, 2);
  assert.equal(a.distinctProjects, 1);
  assert.equal(a.distinctAgents, 1);
  assert.equal(a.blanks['自由标签'], 0);
  assert.equal(a.noiseTags.numeric, 0);
  assert.equal(a.suspiciousDuplicateGroups, 0);
  assert.equal(a.tick.zeros, 2);
  assert.ok(a.suggestions.length >= 1);
})

test('A2 多项目/多身份/空标签/噪声标签/重复 都能被点名', () => {
  const a = inspectMergeFields([
    rec({ 项目: '项目A', 智能体: '身份1', 自由标签: [] }),
    rec({ 编号: 'M-20261111-002', 项目: '项目B', 智能体: '身份2', 自由标签: ['3190', '原话', '0'] }),
    rec({ 编号: 'M-20261111-003', 项目: '', 智能体: '', 主要内容: '重复内容', 自由标签: ['推断'] }),
    rec({ 编号: 'M-20261111-004', 主要内容: '重复内容', 自由标签: ['x'] }), // 编号不同、内容同
    rec({ 编号: 'M-20261111-005', 稳定性: '稳定', 主要内容: '老稳定条目' }),
  ], schema);

  assert.equal(a.distinctProjects, 3);  // 项目A / 项目B / （空）
  assert.equal(a.distinctAgents, 3);    // 身份1 / 身份2 / （空）
  assert.equal(a.blanks['项目'], 1);
  assert.equal(a.blanks['智能体'], 1);
  assert.equal(a.blanks['自由标签'], 1);
  assert.equal(a.noiseTags.numeric, 2);      // 3190 / 0
  assert.equal(a.noiseTags.sourceMark, 2);   // 原话 / 推断
  // 2 组：「一条记忆」出现在 001/002（都未覆写主要内容）、「重复内容」出现在 003/004
  assert.equal(a.suspiciousDuplicateGroups, 2);
  assert.equal(a.stability['稳定'], 1);
  assert.equal(a.emptyTagIds.length, 1);

  const all = a.suggestions.join('\n');
  assert.ok(all.includes('引入'), '多归属要提示标 引入 而不是 通用');
  assert.ok(all.includes('自由标签为空'));
  assert.ok(all.includes('噪声标签') || all.includes('纯数字'));
  assert.ok(all.includes('疑似重复'));
  assert.ok(all.includes('不要') && all.includes('稳定'), '老稳定条目要提示别重置');
})

test('A3 纯只读：不修改传入 records，不写文件', () => {
  const records = [rec({ 自由标签: ['a', ''] })];
  const snapshot = JSON.stringify(records);
  inspectMergeFields(records, schema);
  assert.equal(JSON.stringify(records), snapshot, '体检绝不能改入参');
})

/* ================================================================== *
 * B. dryRun 接线（真实宿主方法）
 * ================================================================== */

test('B1 mergeLibrary dryRun 返回 fieldAudit，且一个字节都不落盘', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtm-audit-'));
  const src = path.join(tmp, 'incoming.csv');
  const CSV_HEADER = schema.columns.join(',') + '\r\n';
  const line = (r) => schema.columns.map((c) =>
    c === '自由标签' ? (r['自由标签'] ?? []).join('|') : String(r[c] ?? '')).join(',') + '\r\n';

  fs.writeFileSync(
    src,
    CSV_HEADER
      + line(rec({ 编号: 'M-20261111-001', 项目: '外来项目', 自由标签: ['原话', '3190'] }))
      + line(rec({ 编号: 'M-20261111-002', 项目: '外来项目', 自由标签: [] })),
    'utf8',
  );

  const h = await makeHostCtx({ identity: { 智能体: 'qa-agent', 项目: 'qa-project' }, dataDir: tmp });
  try {
    const before = fs.existsSync(path.join(tmp, 'store', 'memory.csv'))
      ? fs.readFileSync(path.join(tmp, 'store', 'memory.csv'), 'utf8')
      : null;
    const r = await h.host.mergeLibrary({ path: src, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.ok(r.fieldAudit, 'dryRun 必须带 fieldAudit');
    assert.equal(r.fieldAudit.scanned, 2);
    assert.equal(r.fieldAudit.blanks['自由标签'], 1);
    assert.equal(r.fieldAudit.noiseTags.numeric, 1);
    assert.equal(r.fieldAudit.distinctProjects, 1, '两条都用 外来项目，只有 1 种');
    assert.ok(Array.isArray(r.fieldAudit.suggestions));

    const after = fs.existsSync(path.join(tmp, 'store', 'memory.csv'))
      ? fs.readFileSync(path.join(tmp, 'store', 'memory.csv'), 'utf8')
      : null;
    assert.equal(after, before, 'dryRun 一个字节都不能改库');
  } finally {
    h.cleanup();
  }
})

/* ================================================================== *
 * C. 展示层接线
 * ================================================================== */

test('C1 工具 formatMergeResult 渲染体检项与冲突数', () => {
  const r = {
    ok: true, changed: 0, added: 2, conflicts: 1,
    fieldAudit: inspectMergeFields([rec({ 自由标签: [] }), rec({ 编号: 'M-2', 自由标签: ['原话'] })], schema),
  };
  const dry = formatMergeResult(r, true).text;
  const real = formatMergeResult(r, false).text;
  for (const text of [dry, real]) {
    assert.ok(text.includes('字段口径体检'));
    assert.ok(text.includes('空标签 1 条'));
    assert.ok(text.includes('冲突 1 条'));
    assert.ok(text.includes('不自动改'));
  }
  assert.ok(dry.includes('没有落盘'));
})

test('C2 client.js 与 index.js 契约都接上了 fieldAudit', () => {
  const client = fs.readFileSync(path.join(PACKAGE_DIR, 'client.js'), 'utf8');
  const host = fs.readFileSync(path.join(PACKAGE_DIR, 'index.js'), 'utf8');
  assert.ok(client.includes('mergeAuditTitle'), '客户端要有体检小节文案');
  assert.ok(client.includes("result.fieldAudit"), '合并成功后要读 fieldAudit');
  assert.ok(client.includes('mergeAuditSummary'), '要有体检摘要');
  assert.ok(host.includes('inspectMergeFields') && host.includes('fieldAudit'), '宿主 dryRun 要带体检');
  assert.ok(host.includes('fieldAudit?'), '宿主方法契约注释要写明该字段');
  // 两套 I18N 都要有键（zh/en 一致性）
  assert.equal((client.match(/mergeAuditTitle:/g) || []).length, 2);
  assert.equal((client.match(/mergeAuditDone:/g) || []).length, 2);
})

test('C3 《记忆合并规则》成文且六维口径齐全', () => {
  const doc = fs.readFileSync(path.join(PACKAGE_DIR, '内部文档', '记忆合并规则.md'), 'utf8');
  for (const kw of ['引入', '稳定性', '时距', '自由标签', '疑似重复', 'conflicts', 'dryRun', '不自动改']) {
    assert.ok(doc.includes(kw), `合并规则缺「${kw}」`);
  }
})
