/**
 * dump-injection.mjs — 把「本插件每轮注入给模型的全部内容」原样导出
 *
 * 只读，不改任何文件（除输出快照文件本身）。用途：给维护者看清
 * 每一轮到底塞了什么，作为精简决策的依据。
 *
 * 本插件每轮注入分三块（**不含宿主自带的系统提示**）：
 *   A. systemPrompt.section  「固定判据段」—— 与身份无关、字节恒定
 *   B. systemPrompt.context  「动态身份段」—— user 角色快照，按 order 进历史
 *   C. 10 个工具定义        —— name / description / parameters，由宿主编译后注入
 *
 * 用法：node scripts/dump-injection.mjs
 * 输出：内部文档/注入内容快照.md（人读）+ stdout 摘要
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderInjection, renderIdentityContext } from '../preset/prompt.js';
import { buildToolDefs } from '../preset/tool-defs.js';
import schema from '../lib/engine/templates/schema.json' with { type: 'json' };

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(PACKAGE_DIR, '内部文档', '注入内容快照.md');

const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const lines = (s) => String(s ?? '').split('\n').length;

const section = renderInjection({ writeRoutes: schema.writeRoutes, dimensions: schema.dimensions });
const bound = renderIdentityContext({ bound: true, who: '〈身份名〉', project: '〈项目名〉' });
const unbound = renderIdentityContext({ bound: false });

const domain = { shapes: schema.shapes, stabilities: schema.stabilities, statuses: schema.statuses };
const defs = buildToolDefs(domain);

/* ---- 按 `###` 小节切分 section，统计每节字节（供精简决策）---- */
const sectionParts = [];
{
  const all = section.split('\n');
  let title = '（开头）';
  let buf = [];
  for (const l of all) {
    if (l.startsWith('### ')) {
      if (buf.length) sectionParts.push({ title, text: buf.join('\n') });
      title = l;
      buf = [l];
    } else {
      buf.push(l);
    }
  }
  if (buf.length) sectionParts.push({ title, text: buf.join('\n') });
}

/* ---- 工具定义逐个体积 ---- */
const toolRows = defs.map((d) => ({
  name: d.name,
  description: d.description,
  descriptionBytes: bytes(d.description),
  parametersBytes: bytes(JSON.stringify(d.parameters)),
  totalBytes: bytes(d.description) + bytes(JSON.stringify(d.parameters)) + bytes(d.name),
}));

const totalSection = bytes(section);
const totalContext = Math.max(bytes(bound), bytes(unbound));
const totalTools = toolRows.reduce((s, r) => s + r.totalBytes, 0);

/* ---- 组装快照 ---- */
const md = [];
md.push('# 每轮注入内容快照（只读导出）');
md.push('');
md.push('> 由 `node scripts/dump-injection.mjs` 生成。本文件只反映**本插件**注入的内容，');
md.push('> 不含 DSH 宿主自带的系统提示、工具、身份上下文。');
md.push('> 生成时间：' + new Date().toISOString());
md.push('');
md.push('## 体积总览');
md.push('');
md.push('| 块 | 位置 | 字节 | 行数 | 备注 |');
md.push('|---|---|---:|---:|---|');
md.push(`| A. 固定判据段 | systemPrompt.section | ${totalSection} | ${lines(section)} | 与身份无关，字节恒定 |`);
md.push(`| B. 动态身份段（已绑定） | systemPrompt.context | ${bytes(bound)} | ${lines(bound)} | user 角色快照 |`);
md.push(`| B. 动态身份段（未绑定） | systemPrompt.context | ${bytes(unbound)} | ${lines(unbound)} | user 角色快照 |`);
md.push(`| C. 10 个工具定义 | ctx.tools.register | ${totalTools} | — | name + description + parameters（JSON 近似） |`);
md.push(`| **A+C 合计（每轮固定）** | — | **${totalSection + totalTools}** | — | 不含 B |`);
md.push(`| **A+B+C 合计** | — | **${totalSection + totalContext + totalTools}** | — | 含已绑定身份段 |`);
md.push('');
md.push('> ⚠️ L4 断言（`tests/gate2/prompt.l.test.mjs`）测的**只有 A**：≤6000 字节、≤130 行。');
md.push('> B 与 C 都不计入该断言。');
md.push('');
md.push('## A 按小节拆分（哪节占了多少字节）');
md.push('');
md.push('| 小节 | 字节 | 占 A |');
md.push('|---|---:|---:|');
for (const p of sectionParts) {
  md.push(`| ${p.title.replace(/\|/g, '\\|')} | ${bytes(p.text)} | ${((bytes(p.text) / totalSection) * 100).toFixed(1)}% |`);
}
md.push('');
md.push('## C 工具定义体积明细');
md.push('');
md.push('| 工具 | description 字节 | parameters 字节 | 小计 |');
md.push('|---|---:|---:|---:|');
for (const r of toolRows) {
  md.push(`| \`${r.name}\` | ${r.descriptionBytes} | ${r.parametersBytes} | ${r.totalBytes} |`);
}
md.push('');

md.push('---');
md.push('');
md.push('## A. 固定判据段 · 全文（systemPrompt.section）');
md.push('');
md.push('````text');
md.push(section);
md.push('````');
md.push('');
md.push('## B. 动态身份段 · 已绑定（systemPrompt.context）');
md.push('');
md.push('````text');
md.push(bound);
md.push('````');
md.push('');
md.push('## B. 动态身份段 · 未绑定（systemPrompt.context）');
md.push('');
md.push('````text');
md.push(unbound);
md.push('````');
md.push('');
md.push('## C. 10 个工具定义 · 全文');
md.push('');
for (const d of defs) {
  md.push(`### \`${d.name}\``);
  md.push('');
  md.push('**description**：');
  md.push('');
  md.push('````text');
  md.push(d.description);
  md.push('````');
  md.push('');
  md.push('**parameters**：');
  md.push('');
  md.push('````json');
  md.push(JSON.stringify(d.parameters, null, 2));
  md.push('````');
  md.push('');
}

fs.writeFileSync(OUT, md.join('\n'), 'utf8');

console.log(`已写出：${OUT}`);
console.log(`A(section) = ${totalSection} 字节 / ${lines(section)} 行`);
console.log(`B(context, 已绑定) = ${bytes(bound)} 字节；未绑定 = ${bytes(unbound)} 字节`);
console.log(`C(10 工具定义) = ${totalTools} 字节`);
console.log(`A+C = ${totalSection + totalTools} 字节；A+B+C = ${totalSection + totalContext + totalTools} 字节`);
console.log('\nA 分节：');
for (const p of sectionParts) console.log(`  ${String(bytes(p.text)).padStart(5)} B  ${p.title}`);
