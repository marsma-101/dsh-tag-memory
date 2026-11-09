/**
 * tests/gate3/seed.test.mjs —— 种子记忆的约束测试
 *
 * 这些不是"随便写几条字"的测试，每条都在守一个**已验证的硬约束**：
 *   · 标签必须恰好 3 个（召回闸门 e_ratio > 0.5 决定的）
 *   · 标签不能跨条目重叠（否则互相抢 Top-K）
 *   · 项目/智能体必须是 通用（否则新装会话看不到）
 *   · 内容不能与注入重复（否则污染召回）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..', '..');
const SEED = path.join(PACKAGE_DIR, 'scripts', 'seed.mjs');

const { SEED_ENTRIES } = await import(`file://${SEED.replaceAll('\\', '/')}`);

test('S1 种子条目存在且字段齐全', () => {
  assert.ok(SEED_ENTRIES.length > 0, '至少要有一条种子');
  for (const s of SEED_ENTRIES) {
    assert.ok(typeof s.key === 'string' && s.key.length > 0, 'key 必填');
    assert.ok(typeof s['主要内容'] === 'string' && s['主要内容'].length > 20, `${s.key}: 主要内容 太短`);
    assert.ok(['技能', '流程', '规则', '偏好', '事实', '模板'].includes(s['形态']), `${s.key}: 形态 不合法`);
    assert.ok(Array.isArray(s['自由标签']), `${s.key}: 自由标签 必须是数组`);
  }
});

test('S2 每条种子恰好 3 个标签（召回闸门要求）', () => {
  // read.mjs L388：e_ratio = 命中数/条目标签数 必须 **严格大于 0.5**。
  // 3 个标签 → 查 2 个得 0.67 过；4 个标签 → 查 2 个得 0.5 不过（要严格大于）。
  // 所以 3 是能"用两个词召回"的最大标签数。
  for (const s of SEED_ENTRIES) {
    assert.equal(
      s['自由标签'].length,
      3,
      `${s.key}: 必须恰好 3 个标签（实际 ${s['自由标签'].length}）——` +
        '多了会因 e_ratio<=0.5 被闸门否决，查不回来',
    );
  }
});

test('S3 标签不跨条目重叠（避免抢 Top-K）', () => {
  const seen = new Map();
  for (const s of SEED_ENTRIES) {
    for (const t of s['自由标签']) {
      assert.ok(!seen.has(t), `标签「${t}」同时出现在 ${seen.get(t)} 和 ${s.key}——` + '会让一次查询同时命中两条');
      seen.set(t, s.key);
    }
  }
});

test('S4 标签不含竖线、不含空格（写入会被拒/归一失败）', () => {
  for (const s of SEED_ENTRIES) {
    for (const t of s['自由标签']) {
      assert.ok(!t.includes('|'), `${s.key}: 标签「${t}」含 |，写入会被拒`);
      assert.equal(t.trim(), t, `${s.key}: 标签「${t}」有首尾空格`);
      assert.ok(t.length > 0, `${s.key}: 空标签`);
    }
  }
});

test('S5 内容不得与注入文本重复（防污染）', async () => {
  // 注入里已经写了：插件存在、10 个工具、问身份、字段标准、什么情况该写。
  // 种子若把这些再讲一遍，dtm_recall 会被自我介绍挤占。
  const { renderInjection } = await import(`file://${path.join(PACKAGE_DIR, 'preset', 'prompt.js').replaceAll('\\', '/')}`);
  const { loadSchema } = await import(`file://${path.join(PACKAGE_DIR, 'lib', 'engine', 'dict.mjs').replaceAll('\\', '/')}`);
  const schema = await loadSchema({ baseDir: path.join(PACKAGE_DIR, 'lib', 'engine', 'templates') });
  const t = renderInjection({ writeRoutes: schema.writeRoutes, dimensions: schema.dimensions });
  const injection = String(t.text ?? t);

  // 禁止的"自我介绍"句式：与注入职责重叠
  const forbidden = ['dtm_write', 'dtm_recall 的用法', '这 10 个工具', '每次会话第一次读写'];
  for (const s of SEED_ENTRIES) {
    for (const f of forbidden) {
      assert.ok(
        !s['主要内容'].includes(f),
        `${s.key}: 内容含「${f}」，与注入重复——应交给注入，不要进库`,
      );
    }
  }
  assert.ok(injection.length > 0, '注入文本不该为空');
});

test('S6 种子必须写 项目=通用 且 智能体=通用', () => {
  // 这是脚本行为约定：脚本用工作目录末段「通用」让程序取到 项目=通用。
  // 这里校验脚本确实这么做了（防止有人改回固定字符串）。
  const src = fs.readFileSync(SEED, 'utf8');
  assert.match(
    src,
    /workingDirectory[^\n]*通用/,
    '脚本必须让工作目录末段为「通用」，否则 projectOfSync 会取到别的项目名',
  );
  assert.ok(
    !/项目:\s*'通用'/.test(src) || /bindIdentity\([^)]*项目:\s*'通用'/.test(src),
    '项目 由程序取，不该指望 writeEntry 采纳参数',
  );
});

test('S7 子智能体那条必须写明「要自己 bind」', () => {
  // 实测结论：spawn 子智能体是全新 agent + 独立 session，
  // 插件身份存 WeakMap 不落事件，所以**不会**自动继承。
  const sub = SEED_ENTRIES.find((s) => s.key === 'subagent');
  assert.ok(sub, '缺 subagent 种子');
  assert.match(sub['主要内容'], /dtm_bind/, '必须写明要调 dtm_bind');
  assert.match(sub['主要内容'], /UNBOUND_IDENTITY/, '必须写明不绑的后果');
  assert.match(sub['主要内容'], /不会自动继承|不落事件/, '必须点明不会自动继承的原因');
});

test('S8 install.mjs 传的 apply 写法必须被接受', () => {
  // 曾经的真实缺陷：install.mjs 调 `seed.mjs apply`（不带横线），
  // 而 seed.mjs 只认 `--apply` → 安装时打印了计划却一个字节没写，
  // 且退出码是 0。这种"看起来成功了"的失败最难发现。
  const src = fs.readFileSync(SEED, 'utf8');
  assert.match(
    src,
    /argv\.includes\('apply'\)/,
    'seed.mjs 必须接受不带横线的 apply（install.mjs 就是这么调的）',
  );
  assert.match(src, /argv\.includes\('--apply'\)/, '同时保留 --apply 写法');
});

test('S9 库非空时默认跳过播种（防污染）', () => {
  const src = fs.readFileSync(SEED, 'utf8');
  assert.match(src, /before\.total > 0/, '必须有非空库判断');
  assert.match(src, /--force/, '必须提供 --force 逃生口');
  assert.match(src, /跳过播种/, '跳过时要有明确提示，不能静默');
});
