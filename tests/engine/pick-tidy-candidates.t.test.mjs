/**
 * pick-tidy-candidates.t.test — 整理候选挑选（2026-11-17 新增）
 *
 * 守的核心：程序**只按规则挑，不判语义**。
 * 「这两条是不是同一件事」必须由模型读完再定，程序只报「疑似」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickTidyCandidates,
  findDuplicateGroups,
  issueLabel,
  ISSUE_TYPES,
} from '../../lib/engine/pick-tidy-candidates.mjs';

const ACTIVE = '生效';

function rec(id, over = {}) {
  return {
    编号: id,
    主要内容: '一条正常记忆',
    形态: '事实',
    项目: '通用',
    智能体: '通用',
    自由标签: ['npm', '发布'],
    稳定性: '观察',
    时距: 1,
    状态: ACTIVE,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * 四类问题
 * ------------------------------------------------------------------ */

test('T1 空标签 → empty-tags（最优先）', () => {
  const r = pickTidyCandidates({ records: [rec('M-1', { 自由标签: [] })] });
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0]['问题'], ['empty-tags']);
  assert.equal(r.stats.byIssue['empty-tags'], 1);
});

test('T2 标签全是噪声 → noise-tags（纯数字/单字/来源标记）', () => {
  const r = pickTidyCandidates({
    records: [rec('M-1', { 自由标签: ['3190', '坑', '原话'] })],
  });
  assert.deepEqual(r.candidates[0]['问题'], ['noise-tags']);
});

test('T3 部分标签有效 → 不报噪声（不能误伤）', () => {
  const r = pickTidyCandidates({
    records: [rec('M-1', { 自由标签: ['3190', 'npm发布'] })],
  });
  assert.equal(r.candidates.length, 0, '有一个有效标签就不算全噪声');
});

test('T4 形态为空 → empty-shape', () => {
  const r = pickTidyCandidates({ records: [rec('M-1', { 形态: '' })] });
  assert.deepEqual(r.candidates[0]['问题'], ['empty-shape']);
});

test('T5 一条同时有多种问题 → 都要列出来', () => {
  const r = pickTidyCandidates({
    records: [rec('M-1', { 自由标签: [], 形态: '' })],
  });
  assert.deepEqual(r.candidates[0]['问题'], ['empty-tags', 'empty-shape']);
});

test('T6 被取代/已归档的条目不进入候选', () => {
  const r = pickTidyCandidates({
    records: [
      rec('M-1', { 自由标签: [], 状态: '已归档' }),
      rec('M-2', { 自由标签: [], 状态: '被取代' }),
      rec('M-3', { 自由标签: [] }),
    ],
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0]['编号'], 'M-3');
  assert.equal(r.stats.active, 1);
});

/* ------------------------------------------------------------------ *
 * 疑似重复
 * ------------------------------------------------------------------ */

test('T7 内容几乎相同 → 报疑似重复组，但不判合并', () => {
  const r = pickTidyCandidates({
    records: [
      rec('M-1', { 主要内容: 'npm 发布需要带 OTP 验证码' }),
      rec('M-2', { 主要内容: 'npm 发布需要带 OTP 验证码！' }),
    ],
  });
  assert.equal(r.stats.duplicateGroups, 1);
  assert.ok(r.candidates.every((c) => c['问题'].includes('duplicate')));
  // 关键：只报「疑似」，不产出任何动作
  assert.equal(r.candidates[0]['动作'], undefined);
});

test('T8 主题相近但内容不同 → 不算重复（模型才判语义）', () => {
  const groups = findDuplicateGroups([
    rec('M-1', { 主要内容: 'npm 发布需要 2FA 验证码' }),
    rec('M-2', { 主要内容: 'git push 走代理会报证书错误' }),
  ]);
  assert.equal(groups.length, 0);
});

test('T9 findDuplicateGroups：三条相似归一组（并查集，不是链式贪心）', () => {
  const groups = findDuplicateGroups([
    rec('M-1', { 主要内容: '同一件事的记述' }),
    rec('M-2', { 主要内容: '同一件事的记述' }),
    rec('M-3', { 主要内容: '同一件事的记述' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ids.length, 3);
});

test('T9b 阈值边界：末尾多一个标点导致相似度不足 → 不归组（程序宁可少报）', () => {
  // 0.9 是刻意严格的阈值：误报会让模型把两件不同的事合并，代价远高于漏报。
  const groups = findDuplicateGroups([
    rec('M-1', { 主要内容: '同一件事的记述' }),
    rec('M-2', { 主要内容: '同一件事的记述。' }),
  ], 0.99);
  assert.equal(groups.length, 0, '阈值调高后，差一个标点就不该归组');
});

/* ------------------------------------------------------------------ *
 * 排序 / 截断 / 统计
 * ------------------------------------------------------------------ */

test('T10 问题多的排前面', () => {
  const r = pickTidyCandidates({
    records: [
      rec('M-1', { 形态: '' }),                       // 1 个问题
      rec('M-2', { 自由标签: [], 形态: '' }),         // 2 个问题
    ],
  });
  assert.equal(r.candidates[0]['编号'], 'M-2');
});

test('T11 limit 截断并标记 truncated', () => {
  const records = Array.from({ length: 5 }, (_, i) =>
    rec(`M-${i + 1}`, { 自由标签: [] }),
  );
  const r = pickTidyCandidates({ records, limit: 2 });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.truncated, true);
});

test('T12 limit=0 → 不截断，全给', () => {
  const records = Array.from({ length: 3 }, (_, i) => rec(`M-${i + 1}`, { 自由标签: [] }));
  const r = pickTidyCandidates({ records, limit: 0 });
  assert.equal(r.candidates.length, 3);
  assert.equal(r.truncated, false);
});

test('T13 commonWords 给出高频泛词（供提示词让模型避开）', () => {
  const records = [
    rec('M-1', { 自由标签: ['npm', '发布'] }),
    rec('M-2', { 自由标签: ['npm', '代理'] }),
    rec('M-3', { 自由标签: ['npm', '证书'] }),
  ];
  const r = pickTidyCandidates({ records, commonTopN: 5 });
  assert.equal(r.stats.commonWords[0][0], 'npm');
  assert.equal(r.stats.commonWords[0][1], 3);
});

test('T14 摘要不超过 80 字且无换行', () => {
  const long = '很长的内容'.repeat(50);
  const r = pickTidyCandidates({ records: [rec('M-1', { 自由标签: [], 主要内容: long })] });
  assert.ok(r.candidates[0]['摘要'].length <= 81);
  assert.ok(!r.candidates[0]['摘要'].includes('\n'));
});

/* ------------------------------------------------------------------ *
 * 通用契约
 * ------------------------------------------------------------------ */

test('T15 入参非数组 → 抛错（不静默当空库）', () => {
  assert.throws(() => pickTidyCandidates({ records: null }), /必须是数组/);
});

test('T16 空库 → 0 候选，不抛错', () => {
  const r = pickTidyCandidates({ records: [] });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.stats.total, 0);
});

test('T17 ISSUE_TYPES 恰好四类且顺序固定', () => {
  assert.deepEqual([...ISSUE_TYPES], ['empty-tags', 'noise-tags', 'empty-shape', 'duplicate']);
  assert.equal(issueLabel('empty-tags'), '空标签');
});
