/**
 * prompt-templates.pt.test — 整理/合并提示词模板（2026-11-17 新增）
 *
 * 用户定的三条规则必须**真的出现在提示词文本里**（不是只写在方案文档里）：
 *   1. 不论什么格式，都以记忆内容为主题，严格按写入规则
 *   2. 固定标签按写入规则（项目/智能体原样复制，不映射）
 *   3. 自由标签按写入规则，尽量详细、可区分
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTidyPrompt, renderMergePrompt } from '../../lib/engine/prompt-templates.mjs';
import { parseSource } from '../../lib/engine/parse-source.mjs';
import { pickTidyCandidates } from '../../lib/engine/pick-tidy-candidates.mjs';

function tidyFixture() {
  const records = [
    { 编号: 'M-1', 主要内容: 'npm 发布需要 OTP 验证码，很长的正文……', 形态: '', 项目: '通用', 智能体: '通用', 自由标签: [], 稳定性: '观察', 时距: 1, 状态: '生效' },
    { 编号: 'M-2', 主要内容: '代理 TLS 证书问题', 形态: '技能', 项目: '通用', 智能体: '通用', 自由标签: ['3190', '原话'], 稳定性: '观察', 时距: 1, 状态: '生效' },
    { 编号: 'M-3', 主要内容: 'npm 发布需要 OTP 验证码', 形态: '技能', 项目: '通用', 智能体: '通用', 自由标签: ['npm', '发布'], 稳定性: '观察', 时距: 1, 状态: '生效' },
    { 编号: 'M-4', 主要内容: 'npm 发布需要 OTP 验证码', 形态: '技能', 项目: '通用', 智能体: '通用', 自由标签: ['npm', '发布'], 稳定性: '观察', 时距: 1, 状态: '生效' },
  ];
  return pickTidyCandidates({ records });
}

/* ------------------------------------------------------------------ *
 * 整理提示词
 * ------------------------------------------------------------------ */

test('PT1 整理提示词要求「原样展示」且不列工具清单（新会话已有）', () => {
  const r = tidyFixture();
  const text = renderTidyPrompt(r);
  assert.ok(text.includes('请原样展示'), '必须声明原样展示，防止模型改写');
  assert.ok(text.includes('新会话'));
  assert.ok(!text.includes('| 工具 | 什么时候调 |'), '不该重复注入里的工具入口表');
});

test('PT2 整理提示词含候选清单（编号/问题/摘要）', () => {
  const r = tidyFixture();
  const text = renderTidyPrompt(r);
  assert.ok(text.includes('M-1'));
  assert.ok(text.includes('空标签'));
  assert.ok(text.includes('本次候选清单'));
  assert.ok(text.includes('摘要'));
});

test('PT3 【用户规则3】整理提示词明确要求标签详细且可区分', () => {
  const text = renderTidyPrompt(tidyFixture());
  assert.ok(text.includes('尽量详细'));
  assert.ok(text.includes('区分'));
  assert.ok(text.includes('避开泛词'));
  assert.ok(text.includes('给它独有词'));
});

test('PT4 整理提示词含泛词频次表', () => {
  const r = tidyFixture();
  r.stats.commonWords = [['npm', 3], ['发布', 2]];
  const text = renderTidyPrompt(r);
  assert.ok(text.includes('npm(3)'));
  assert.ok(text.includes('发布(2)'));
});

test('PT5 整理提示词写明 dtm_retag 必带 basis 且不能改归属', () => {
  const text = renderTidyPrompt(tidyFixture());
  assert.ok(text.includes('必须带 `basis`'));
  assert.ok(text.includes('不能改'));
  assert.ok(text.includes('项目'));
});

test('PT6 疑似重复要模型读完再判（程序不判语义）', () => {
  const text = renderTidyPrompt(tidyFixture());
  assert.ok(text.includes('它不判语义'));
  assert.ok(text.includes('真的读完两条'));
  assert.ok(text.includes('不算重复'));
});

test('PT7 空库 → 明确说「什么都不用做」', () => {
  const text = renderTidyPrompt({ candidates: [], stats: { total: 0, active: 0, byIssue: {}, duplicateGroups: 0, commonWords: [] } });
  assert.ok(text.includes('没有需要整理的条目'));
});

test('PT8 表格单元格里的 | 被转义（不破坏 Markdown 表格）', () => {
  const r = tidyFixture();
  r.candidates[0]['自由标签'] = ['a|b'];
  const text = renderTidyPrompt(r);
  assert.ok(text.includes('a\\|b'));
});

/* ------------------------------------------------------------------ *
 * 合并提示词
 * ------------------------------------------------------------------ */

test('PT9 【用户规则1】合并提示词写明「不论什么格式，以内容为主题」', () => {
  const parsed = parseSource({ text: '# 标题\n一段记忆', filename: 'm.md' });
  const text = renderMergePrompt({ parsed, filename: 'm.md' });
  assert.ok(text.includes('不论来源是什么格式'));
  assert.ok(text.includes('以记忆内容为主题'));
  assert.ok(text.includes('写入规则重新表达'));
  assert.ok(text.includes('一条只记一件事'));
});

test('PT10 【用户规则2】合并提示词写明项目/智能体「原样复制、不映射」', () => {
  const parsed = parseSource({ text: '# 标题\n一段记忆', filename: 'm.md' });
  const text = renderMergePrompt({ parsed, filename: 'm.md' });
  assert.ok(text.includes('原样复制来源里的值'));
  assert.ok(text.includes('不重新推断、不映射'));
  assert.ok(text.includes('归属是环境事实'));
  assert.ok(text.includes('来源为空 → `引入`'));
  assert.ok(text.includes('稳定性'), '固定标签按写入规则');
});

test('PT11 【用户规则3】合并提示词写明自由标签详细且可区分', () => {
  const parsed = parseSource({ text: '# 标题\n一段记忆', filename: 'm.md' });
  const text = renderMergePrompt({ parsed, filename: 'm.md', commonWords: [['npm', 5]] });
  assert.ok(text.includes('尽量详细'));
  assert.ok(text.includes('区分开'));
  assert.ok(text.includes('npm(5)'));
});

test('PT12 合并提示词含方式 A/B 选择与判断标准（dtm_write 会覆盖归属）', () => {
  const parsed = parseSource({ text: '# 标题\n一段记忆', filename: 'm.md' });
  const text = renderMergePrompt({ parsed, filename: 'm.md', currentView: { project: 'dsh-tag-memory', agent: '萧潇' } });
  assert.ok(text.includes('方式 A'));
  assert.ok(text.includes('方式 B'));
  assert.ok(text.includes('`dtm_write`'));
  assert.ok(text.includes('`dtm_merge`'));
  assert.ok(text.includes('判断标准'));
  assert.ok(text.includes('萧潇'));
});

test('PT13 合并提示词含来源信息与逐条候选', () => {
  const md = '# 免 OTP 发布\nnpm 发布可以用 granular token 绕过 2FA。\n\n## 代理问题\nHTTPS_PROXY 会报证书错误。';
  const parsed = parseSource({ text: md, filename: 'MEMORY.md' });
  const text = renderMergePrompt({ parsed, filename: 'MEMORY.md' });
  assert.ok(text.includes('MEMORY.md'));
  assert.ok(text.includes('Markdown'));
  assert.ok(text.includes('第 1 条'));
  assert.ok(text.includes('第 2 条'));
  assert.ok(text.includes('granular token'));
});

test('PT14 纯文本兜底 → 提示词里如实给出「可能不准」警告', () => {
  const parsed = parseSource({ text: '一段记忆。\n\n另一段记忆。', filename: 'notes.txt' });
  const text = renderMergePrompt({ parsed, filename: 'notes.txt' });
  assert.equal(parsed.exact, false);
  assert.ok(text.includes('可能不准'));
  assert.ok(text.includes('切分是否精确：**否**'));
});

test('PT15 候选里的代码块 ``` 被转义，不提前闭合', () => {
  const parsed = { format: 'json', candidates: [{ seq: 1, raw: '示例 ```python\nprint(1)\n```', meta: {} }], parsed: 1, warnings: [], exact: true };
  const text = renderMergePrompt({ parsed, filename: 'm.json' });
  assert.ok(!text.includes('```python'), '原文里的 fence 不该原样出现');
});

test('PT16 空候选 → 明确提示核对文件', () => {
  const parsed = { format: 'text', candidates: [], parsed: 0, warnings: [], exact: false };
  const text = renderMergePrompt({ parsed, filename: 'empty.txt' });
  assert.ok(text.includes('没解析出任何候选'));
});

test('PT17 两个提示词都以「固定标签/自由标签按写入规则」收尾', () => {
  const parsed = parseSource({ text: '# T\n内容', filename: 'm.md' });
  const merge = renderMergePrompt({ parsed, filename: 'm.md' });
  assert.ok(merge.includes('固定标签按写入规则执行'));
  assert.ok(merge.includes('自由标签按写入规则写入'));
});
