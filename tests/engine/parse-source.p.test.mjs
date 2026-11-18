/**
 * parse-source.p.test — 外来记忆文件格式解析（2026-11-17 新增）
 *
 * 依据《整理合并-复制提示词方案-2026-11-16.md》§3.2 / V4-V6。
 *
 * 守三件事：
 *   ① 四种格式都能拆成候选条目，且**以内容为主题**（raw 是原文，不被加工）
 *   ② 归属元信息原样保留（用户要求「项目/智能体直接复制」）
 *   ③ 纯文本兜底必须 exact=false + 警告（不假装解析得很准）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sniffFormat, parseSource, SOURCE_FORMATS, renderTags } from '../../lib/engine/parse-source.mjs';
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' };

const HEADER = schema.columns.join(',');

/* ------------------------------------------------------------------ *
 * 格式嗅探
 * ------------------------------------------------------------------ */

test('P1 九列表头 → csv（即使文件名是 .txt）', () => {
  const text = `${HEADER}\r\nM-1,内容,事实,通用,通用,a|b,观察,1,生效\r\n`;
  assert.equal(sniffFormat({ text, filename: 'x.txt' }), 'csv');
});

test('P2 .md → markdown；代码块里的 # 不产生额外条目', () => {
  assert.equal(sniffFormat({ text: '# 标题\n正文', filename: 'memory.md' }), 'markdown');
});

test('P3 合法 JSON 首字符 → json', () => {
  assert.equal(sniffFormat({ text: '[{"content":"a"}]' }), 'json');
  assert.equal(sniffFormat({ text: '{ broken json', filename: 'x.json' }), 'json', '扩展名优先，解析失败在 parse 阶段退化');
});

test('P4 纯文本 → text', () => {
  assert.equal(sniffFormat({ text: '一段没有格式的记忆\n\n另一段' }), 'text');
});

test('P5 SOURCE_FORMATS 恰好四种', () => {
  assert.deepEqual([...SOURCE_FORMATS], ['csv', 'markdown', 'json', 'text']);
});

/* ------------------------------------------------------------------ *
 * 本插件 CSV
 * ------------------------------------------------------------------ */

test('P6 自家 CSV：解析出正确条数，归属原值保留', () => {
  const text =
    `${HEADER}\r\n` +
    `M-20261101-001,第一条记忆,技能,privhub-1,ClaudeCode@dsh-SQL,npm|发布,观察,1,生效\r\n` +
    `M-20261101-002,第二条记忆,规则,AI_treaning,萧潇,兜底|测试,稳定,3,生效\r\n`;
  const r = parseSource({ text, filename: 'lib.csv', schema });

  assert.equal(r.format, 'csv');
  assert.equal(r.parsed, 2);
  assert.equal(r.candidates[0].raw, '第一条记忆');
  assert.equal(r.candidates[0].meta['项目'], 'privhub-1', '项目必须原样保留，不许映射');
  assert.equal(r.candidates[0].meta['智能体'], 'ClaudeCode@dsh-SQL');
  assert.deepEqual(r.candidates[0].meta['自由标签'], ['npm', '发布']);
  assert.equal(r.candidates[1].meta['稳定性'] === undefined, true, 'meta 只带归属/形态/标签，不带稳定性（写入规则重置）');
});

test('P7 CSV 正文含逗号不得串列（复用 core 解析器）', () => {
  const text = `${HEADER}\r\nM-1,"内容, 带逗号",事实,通用,通用,a|b,观察,1,生效\r\n`;
  const r = parseSource({ text, schema });
  assert.equal(r.parsed, 1);
  assert.equal(r.candidates[0].raw, '内容, 带逗号');
});

test('P8 CSV 空内容行被丢弃，不造空记忆', () => {
  const text = `${HEADER}\r\nM-1,,事实,通用,通用,a|b,观察,1,生效\r\n`;
  const r = parseSource({ text, schema });
  assert.equal(r.parsed, 0);
});

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

test('P9 Markdown 按标题切块，标题拼进内容', () => {
  const text = [
    '# 免 OTP 发布',
    'npm 发布可以用 granular token 绕过 2FA。',
    '',
    '## 代理问题',
    'HTTPS_PROXY 指向本地代理会报证书错误。',
    '',
    '### 第三条',
    '这是第三段内容。',
  ].join('\n');
  const r = parseSource({ text, filename: 'MEMORY.md' });

  assert.equal(r.format, 'markdown');
  assert.equal(r.parsed, 3, '三个标题 = 三条候选');
  assert.ok(r.candidates[0].raw.includes('【免 OTP 发布】'));
  assert.ok(r.candidates[0].raw.includes('granular token'));
  assert.ok(r.candidates[1].raw.includes('【代理问题】'));
  assert.equal(r.exact, true);
});

test('P10 Markdown 代码块内的 # 不当标题（真实会踩的坑）', () => {
  const text = [
    '# 第一条',
    '正文 A',
    '```python',
    '# 这是注释不是标题',
    '## 这也是注释',
    'print(1)',
    '```',
    '',
    '# 第二条',
    '正文 B',
  ].join('\n');
  const r = parseSource({ text, filename: 'm.md' });

  assert.equal(r.parsed, 2, '代码块里的 # / ## 不得产生额外条目');
  assert.ok(r.candidates[0].raw.includes('# 这是注释不是标题'), '代码内容要保留在块里');
  assert.ok(r.candidates[1].raw.includes('正文 B'));
});

test('P11 Markdown 无标题 → 整篇当一条 + exact=false 警告', () => {
  const text = '一段没有标题的记忆，直接写在文件里。';
  const r = parseSource({ text, filename: 'plain.md' });
  assert.equal(r.parsed, 1);
  assert.equal(r.exact, false);
  assert.ok(r.warnings.some((w) => w.includes('整篇')));
});

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

test('P12 JSON 数组：取常见内容键', () => {
  const data = [
    { content: '第一条记忆', tags: ['npm', '发布'], project: 'privhub-1', agent: 'ClaudeCode@dsh-SQL' },
    { text: '第二条记忆', memory: '（这个键不该被优先）' },
  ];
  const r = parseSource({ text: JSON.stringify(data), filename: 'mem.json' });
  assert.equal(r.format, 'json');
  assert.equal(r.parsed, 2);
  assert.equal(r.candidates[0].raw, '第一条记忆');
  assert.equal(r.candidates[0].meta['项目'], 'privhub-1');
  assert.deepEqual(r.candidates[0].meta['自由标签'], ['npm', '发布']);
  assert.equal(r.candidates[1].raw, '第二条记忆', 'text 优先级高于 memory');
});

test('P13 JSON 包装对象 { memories: [...] } 能找到数组', () => {
  const data = { version: 1, memories: [{ content: 'A' }, { content: 'B' }] };
  const r = parseSource({ text: JSON.stringify(data), filename: 'm.json' });
  assert.equal(r.parsed, 2);
});

test('P14 JSON 无内容键 → 整对象序列化，不丢信息', () => {
  const data = [{ foo: 'bar', n: 1 }];
  const r = parseSource({ text: JSON.stringify(data), filename: 'm.json' });
  assert.equal(r.parsed, 1);
  assert.ok(r.candidates[0].raw.includes('"foo": "bar"'));
});

test('P15 JSON 字符串数组 → 每条字符串是一条', () => {
  const r = parseSource({ text: JSON.stringify(['记忆A', '记忆B']), filename: 'm.json' });
  assert.equal(r.parsed, 2);
  assert.equal(r.candidates[1].raw, '记忆B');
});

/* ------------------------------------------------------------------ *
 * 纯文本兜底
 * ------------------------------------------------------------------ */

test('P16 纯文本按空行切块，exact=false 且带明确警告', () => {
  const text = '第一段记忆。\n\n第二段记忆。\n\n第三段记忆。';
  const r = parseSource({ text, filename: 'notes.txt' });
  assert.equal(r.format, 'text');
  assert.equal(r.parsed, 3);
  assert.equal(r.exact, false, '兜底切分必须标记为不精确');
  assert.ok(r.warnings.some((w) => w.includes('可能不准')), '警告里必须说「可能不准」');
  assert.ok(r.warnings.some((w) => w.includes('CSV/JSON')), '警告里要给出建议');
});

test('P17 空白内容块被丢弃，seq 连续', () => {
  const text = '第一段。\n\n   \n\n第二段。';
  const r = parseSource({ text });
  assert.equal(r.parsed, 2);
  assert.deepEqual(r.candidates.map((c) => c.seq), [1, 2], 'seq 必须连续 1-based');
});

/* ------------------------------------------------------------------ *
 * 通用契约
 * ------------------------------------------------------------------ */

test('P18 空文本 → 0 条，不抛错', () => {
  const r = parseSource({ text: '' });
  assert.equal(r.parsed, 0);
  assert.ok(Array.isArray(r.warnings));
});

test('P19 入参非字符串 → 抛错（不静默当空库）', () => {
  assert.throws(() => parseSource({ text: null }), /必须是字符串/);
});

test('P20 显式指定 format 优先于嗅探', () => {
  const text = '# 标题\n正文';
  const r = parseSource({ text, format: 'text' });
  assert.equal(r.format, 'text');
  assert.equal(r.exact, false);
});

test('P21 renderTags：空标签显示「（无）」', () => {
  assert.equal(renderTags([]), '（无）');
  assert.equal(renderTags(['npm', '发布']), 'npm、发布');
});
