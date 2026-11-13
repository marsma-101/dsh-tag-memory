/**
 * free-tag-rules.test.mjs — §4.2 自由标签说明表验收
 *
 * 守三件事（都是 §4.2 明令的硬约束）：
 *   ① 机器可读源存在、结构完整，且「一张表」供两处 description 使用（单一真源）；
 *   ② 要点确实进了 dtm_write / dtm_recall 的 自由标签 参数 description；
 *   ③ 说明**不进 section**（5998/6000 字节 + KV cache 硬约束），也不新增第 11 个工具。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeCtx } from '../_fake-ctx.mjs';
import { apply as applyPreset } from '../../preset/index.js';
import {
  buildToolDefs,
  renderTagRules,
  freeTagRulesFor,
  clearTagRulesCache,
} from '../../preset/tool-defs.js';
import { renderInjection } from '../../preset/prompt.js';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_FILE = path.join(PACKAGE_DIR, 'lib', 'engine', 'templates', 'free-tag-rules.json');

test('T1 机器可读源存在且结构完整（写侧/读侧各就位）', () => {
  const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  assert.equal(rules.version, 1);
  assert.ok(Array.isArray(rules.write.directions) && rules.write.directions.length === 3);
  assert.ok(Array.isArray(rules.write.do) && rules.write.do.length > 0);
  assert.ok(Array.isArray(rules.write.dont) && rules.write.dont.length > 0);
  assert.ok(rules.write.limit.includes('6~8'), '要写明「超过 6~8 个就该收」');
  assert.ok(rules.write.classTag.includes('规矩'), '要写明类名标签');
  assert.ok(rules.read.howMany.includes('1~3'), '读取侧要写明一次给几个词');
  assert.ok(rules.read.onEmpty.includes('不要'), '读取侧要写明查空别反复换说法');
  assert.ok(rules.write.dont.some((x) => x.includes('纯数字')), '别打纯数字');
  assert.ok(rules.write.dont.some((x) => x.includes('转述句')), '别打转述句');
  // 2026-11-12 P1-10：原话/推断 是合法类别首词，dont 不得再把它们当「来源标记」禁掉，
  // 否则与 classTag 自相矛盾（同一条 description 里既禁又荐）。
  assert.equal(
    rules.write.dont.some((x) => x.includes('来源标记')),
    false,
    'dont 不得禁「来源标记（原话/推断）」——与 classTag 矛盾',
  );
  assert.ok(rules.write.classTag.includes('原话') && rules.write.classTag.includes('推断'), 'classTag 要承认原话/推断 作类别首词');
})

test('T2 人读副本存在且与机器源口径一致', () => {
  const doc = fs.readFileSync(path.join(PACKAGE_DIR, '内部文档', '自由标签说明表.md'), 'utf8');
  const dict = fs.readFileSync(path.join(PACKAGE_DIR, '标签字典.md'), 'utf8');
  for (const [file, text] of [['自由标签说明表.md', doc], ['标签字典.md', dict]]) {
    assert.ok(text.includes('纯数字'), `${file} 要写明别打纯数字`)
    // 2026-11-12 P1-10：不再要求「来源标记」禁词——原话/推断 作类别首词合法，
    // 与 classTag 一致。改为断言「转述句」禁词 + 类别首词口径。
    assert.ok(text.includes('转述') || text.includes('原话'), `${file} 要写明转述句/来源词口径`)
    assert.ok(text.includes('6~8'), `${file} 要写明超过 6~8 个该收`)
    assert.ok(text.includes('不要反复换说法') || text.includes('不要「换个说法再试」'), `${file} 要写明查空别反复重试`)
  }
})

test('T3 renderTagRules 从表渲染，且读不到表时有兜底（绝不抛错）', () => {
  clearTagRulesCache();
  const w = renderTagRules('write');
  const r = renderTagRules('read');
  // 三方向的**概念名**必须原样出现（不能压成描述句）
  assert.ok(w.includes('作用') && w.includes('注意事项') && w.includes('内容关键词'), `写侧缺三方向概念名：${w}`);
  assert.ok(w.includes('纯数字') && w.includes('6~8'));
  assert.ok(r.includes('1~3') && r.includes('查空'));

  // 传一个空规则 → 走兜底，仍有规范要点
  const fbW = renderTagRules('write', {});
  const fbR = renderTagRules('read', {});
  assert.ok(fbW.includes('纯数字') && fbW.includes('|'));
  assert.ok(fbR.length > 0);
  assert.ok(freeTagRulesFor() !== null, '表应能被同步读到');
})

test('T3b 【防语义反转】压缩后「不写 |」不能被洗成「写 |」', () => {
  // 真实踩过的坑：曾用 /^不打?|^别打/ 统一去前缀，把
  // 「不写 |（库用它分隔标签，会被拒写）」改成「写 |」——规则语义直接反了。
  // 省几个字节换来一条错规则，模型照做就会被拒写并反复重试，代价远大于收益。
  clearTagRulesCache();
  const w = renderTagRules('write');
  assert.ok(
    w.includes('不写 |') || w.includes('不写|'),
    `写侧必须明确「不写 |」，实际：${w}`,
  );
  assert.equal(
    /(^|[^不])写 \|/.test(w.replace(/不写 \|/g, '')),
    false,
    `不得出现「写 |」这种反转表述，实际：${w}`,
  );
  // 「被打/别打」的动词要说清楚，不能只剩名词
  assert.ok(w.includes('不打'), `写侧要保留「不打」动词，实际：${w}`);
})

test('T4 要点确实进了两个工具的 自由标签 参数 description', () => {
  const defs = buildToolDefs({ shapes: ['技能'], stabilities: ['观察'], statuses: ['生效'] });
  const write = defs.find((d) => d.name === 'dtm_write');
  const recall = defs.find((d) => d.name === 'dtm_recall');
  const wDesc = write.parameters['自由标签'].description;
  const rDesc = recall.parameters['自由标签'].description;

  // 写侧：三方向 + 不该打的 + 数量区间 + | 拒写，一个都不能少
  // 2026-11-12 P1-10：不再断言「来源标记」——那与 classTag（原话/推断 合法首词）矛盾。
  for (const kw of ['作用', '注意事项', '内容关键词', '纯数字', '转述句', '6~8', '|']) {
    assert.ok(wDesc.includes(kw), `dtm_write.自由标签 缺「${kw}」：${wDesc}`);
  }
  // 防矛盾回归：同一条 description 里不得既「禁原话/推断」又「荐原话/推断作首词」
  assert.equal(
    /不打[^；]*原话|不打[^；]*推断|来源标记（原话/.test(wDesc),
    false,
    `dtm_write.自由标签 不得把原话/推断当禁词（与 classTag 矛盾）：${wDesc}`,
  );
  assert.ok(wDesc.includes('原话') && wDesc.includes('推断'), 'classTag 要点要进 description');
  // 读侧：给几个词 + 查空怎么办
  for (const kw of ['1~3', '查空', '留空']) {
    assert.ok(rDesc.includes(kw), `dtm_recall.自由标签 缺「${kw}」：${rDesc}`);
  }
})

test('T4b 精简后仍保留全部取值域与省略语义（防误用）', () => {
  const defs = buildToolDefs({ shapes: ['技能', '流程'], stabilities: ['观察', '稳定'], statuses: ['生效'] });
  const byName = (n) => defs.find((d) => d.name === n);

  // 形态 enum 必须真的在参数 schema 里（不是靠描述文字）
  assert.deepEqual(byName('dtm_write').parameters['形态'].enum, ['技能', '流程']);
  assert.deepEqual(byName('dtm_retag').parameters['形态'].enum, ['技能', '流程']);
  assert.deepEqual(byName('dtm_retag').parameters['稳定性'].enum, ['观察', '稳定']);

  // retag 的「省略=不改」必须仍可见（提到工具描述里统一说明）
  assert.ok(byName('dtm_retag').description.includes('省略'), 'retag 必须说明省略语义');
  // review 的「省略=不限」同理
  assert.ok(byName('dtm_review').description.includes('省略'), 'review 必须说明省略语义');
})

test('T5 【硬约束】说明不进 section、不新增工具、注入字节仍 ≤6000', () => {
  const ctx = createFakeCtx();
  applyPreset(ctx, {});
  assert.equal(ctx.__tools.length, 10, '工具数必须仍是 10');
  assert.equal(ctx.__sections.length, 1);
  assert.equal(ctx.__contexts.length, 1);

  const section = typeof ctx.__sections[0].text === 'function'
    ? ctx.__sections[0].text({ agent: null })
    : ctx.__sections[0].text;
  // 说明表要点（三方向/纯数字等细则）绝不能进 section —— 预算 + KV cache 双重理由
  assert.equal(section.includes('纯数字'), false, '标签细则绝不能进 section（KV cache + 预算）');
  assert.equal(section.includes('三方向拆短实词'), false, '标签细则绝不能进 section');
  assert.ok(Buffer.byteLength(section, 'utf8') <= 6000, '注入字节仍 ≤6000');

  // 直接调 renderInjection 也一致
  const direct = renderInjection({});
  assert.ok(Buffer.byteLength(direct, 'utf8') <= 6000);
  assert.equal(direct.includes('纯数字'), false);
})
