/**
 * prompt-tools.h.test — 整理/合并提示词 host 方法（2026-11-17 新增）
 *
 * 走**真实链路**：makeHostCtx 造真宿主 → 调 host 方法 → 检查返回的提示词文本。
 * 守三条硬约束（方案 V9 / V10）：
 *   ① 两个方法**只读**：库 mtime/内容不变、台账无新增、无备份文件
 *   ② 提示词内容正确（含候选清单、归属原样复制说明、标签区分度要求）
 *   ③ 日常注入不变（V10）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeHostCtx, BOUND } from '../_host-ctx.mjs';
import { renderInjection } from '../../preset/prompt.js';
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 造一份有「空标签 + 噪声标签」的库，供整理挑候选。 */
function seedLibrary(dataDir) {
  const dir = path.join(dataDir, 'store');
  fs.mkdirSync(dir, { recursive: true });
  const header = schema.columns.join(',');
  const rows = [
    'M-20261117-001,空标签的一条记忆,技能,通用,通用,,观察,1,生效',
    'M-20261117-002,噪声标签的一条记忆,规则,通用,通用,3190|原话,观察,1,生效',
    'M-20261117-003,正常的一条记忆,事实,通用,通用,npm|发布,观察,1,生效',
  ];
  fs.writeFileSync(path.join(dir, 'memory.csv'), [header, ...rows].join('\r\n') + '\r\n', 'utf8');
}

/* ------------------------------------------------------------------ *
 * dtm_tidy_prompt
 * ------------------------------------------------------------------ */

test('H1 tidyPrompt 返回完整提示词，含候选编号与标签区分度要求', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    seedLibrary(h.dataDir);
    const r = await h.host.tidyPrompt({ limit: 20 });

    assert.equal(r.ok, true, `应成功，实际 ${JSON.stringify(r)}`);
    assert.equal(typeof r.prompt, 'string');
    assert.ok(r.prompt.length > 500, '提示词不该是空的');
    assert.equal(r.readOnly, true);

    // 候选清单
    assert.ok(r.prompt.includes('M-20261117-001'), '空标签条目要进清单');
    assert.ok(r.prompt.includes('M-20261117-002'), '噪声标签条目要进清单');
    assert.ok(!r.prompt.includes('| M-20261117-003 |'), '正常条目不该进清单');

    // 用户三条规则
    assert.ok(r.prompt.includes('尽量详细'), '规则3：标签要详细');
    assert.ok(r.prompt.includes('区分'), '规则3：标签要可区分');
    assert.ok(r.prompt.includes('必须带 `basis`'), 'dtm_retag 的 basis 约束');

    // 统计
    assert.equal(r.stats.byIssue['empty-tags'], 1);
    assert.equal(r.stats.byIssue['noise-tags'], 1);
  } finally {
    h.dispose?.();
  }
});

test('H2 【V9】tidyPrompt 只读：库字节不变、台账无新增、无备份', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    seedLibrary(h.dataDir);
    const lib = path.join(h.dataDir, 'store', 'memory.csv');
    const before = fs.readFileSync(lib);
    const recDir = path.join(h.dataDir, 'records');
    const recBefore = fs.existsSync(recDir) ? fs.readdirSync(recDir).sort() : [];
    const bakBefore = fs.existsSync(path.join(h.dataDir, 'backup'))
      ? fs.readdirSync(path.join(h.dataDir, 'backup'))
      : [];

    const r = await h.host.tidyPrompt({ limit: 20 });
    assert.equal(r.ok, true);

    assert.ok(fs.readFileSync(lib).equals(before), '库文件必须逐字节不变');
    const recAfter = fs.existsSync(recDir) ? fs.readdirSync(recDir).sort() : [];
    assert.deepEqual(recAfter, recBefore, '不得写台账');
    const bakAfter = fs.existsSync(path.join(h.dataDir, 'backup'))
      ? fs.readdirSync(path.join(h.dataDir, 'backup'))
      : [];
    assert.deepEqual(bakAfter, bakBefore, '不得生成备份');
  } finally {
    h.dispose?.();
  }
});

test('H3 tidyPrompt limit=0 → 不截断，返回全部候选', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    seedLibrary(h.dataDir);
    const r = await h.host.tidyPrompt({ limit: 0 });
    assert.equal(r.truncated, false);
    assert.ok(r.prompt.includes('M-20261117-001'));
  } finally {
    h.dispose?.();
  }
});

/* ------------------------------------------------------------------ *
 * dtm_merge_prompt
 * ------------------------------------------------------------------ */

test('H4 mergePrompt 解析 Markdown，返回含三条用户规则的提示词', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    // 外来文件必须落在数据目录内（confinePath 白名单）
    const foreign = path.join(h.dataDir, 'other-agent-memory.md');
    fs.writeFileSync(
      foreign,
      [
        '# 免 OTP 发布',
        'npm 发布可以用 granular token 绕过 2FA。',
        '',
        '## 代理问题',
        'HTTPS_PROXY 指向本地代理会报证书错误。',
      ].join('\n'),
      'utf8',
    );

    const r = await h.host.mergePrompt({ path: foreign });
    assert.equal(r.ok, true, `应成功，实际 ${JSON.stringify(r)}`);
    assert.equal(r.readOnly, true);
    assert.equal(r.format, 'markdown');
    assert.equal(r.parsed, 2);
    assert.equal(r.exact, true);

    // 用户规则 1：不论格式，以内容为主题
    assert.ok(r.prompt.includes('不论来源是什么格式'));
    assert.ok(r.prompt.includes('以记忆内容为主题'));
    // 用户规则 2：固定标签按写入规则，归属原样复制
    assert.ok(r.prompt.includes('原样复制来源里的值'));
    assert.ok(r.prompt.includes('不重新推断、不映射'));
    assert.ok(r.prompt.includes('稳定性'));
    // 用户规则 3：自由标签详细可区分
    assert.ok(r.prompt.includes('尽量详细'));
    assert.ok(r.prompt.includes('区分开'));
    // 方式 A/B（dtm_write 会覆盖归属这个坑）
    assert.ok(r.prompt.includes('方式 A'));
    assert.ok(r.prompt.includes('方式 B'));
    assert.ok(r.prompt.includes('判断标准'));
    // 候选原文
    assert.ok(r.prompt.includes('granular token'));
    assert.ok(r.prompt.includes('【免 OTP 发布】'));
  } finally {
    h.dispose?.();
  }
});

test('H5 【V9】mergePrompt 只读：库不变、台账无新增、无备份', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    seedLibrary(h.dataDir);
    const lib = path.join(h.dataDir, 'store', 'memory.csv');
    const before = fs.readFileSync(lib);
    const foreign = path.join(h.dataDir, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify([{ content: '外来记忆 A' }, { content: '外来记忆 B' }]), 'utf8');
    const recDir = path.join(h.dataDir, 'records');
    const recBefore = fs.existsSync(recDir) ? fs.readdirSync(recDir).sort() : [];

    const r = await h.host.mergePrompt({ path: foreign });
    assert.equal(r.ok, true);
    assert.equal(r.parsed, 2);

    assert.ok(fs.readFileSync(lib).equals(before), '库文件必须逐字节不变');
    const recAfter = fs.existsSync(recDir) ? fs.readdirSync(recDir).sort() : [];
    assert.deepEqual(recAfter, recBefore, '不得写台账');
  } finally {
    h.dispose?.();
  }
});

test('H6 mergePrompt 路径越界 → 拒绝（与 dtm_merge 同一围栏）', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    seedLibrary(h.dataDir);
    // ⚠️ 平台中立的越界路径（2026-11-19 修）：
    // 旧版硬编码 'C:\\Windows\\win.ini'——Windows 上它真实存在，stat 成功后
    // 走到 confinePath 报 PATH_NOT_ALLOWED；Linux runner 上它是不存在的相对
    // 路径，mergePrompt「先 stat 再围栏」的顺序里 stat 先报 ENOENT，
    // 返回 MERGE_SOURCE_NOT_FOUND，断言必挂（v1.6.0/v1.6.1 CI 因此红）。
    // 白名单（数据目录）的**兄弟目录**在任何平台都在围栏外，且可控制其
    // 存在性：写一个真实文件进去，stat 必成功，必然走到围栏判定。
    const outside = path.join(path.dirname(h.dataDir), 'outside-fence', 'foreign.json');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '[]', 'utf8');
    const r = await h.host.mergePrompt({ path: outside });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PATH_NOT_ALLOWED');
  } finally {
    h.dispose?.();
  }
});

test('H7 mergePrompt 文件不存在 → 明确拒绝，不伪装成空库', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    seedLibrary(h.dataDir);
    const r = await h.host.mergePrompt({ path: path.join(h.dataDir, '__not_exist__.md') });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MERGE_SOURCE_NOT_FOUND');
  } finally {
    h.dispose?.();
  }
});

test('H8 mergePrompt 纯文本兜底 → 返回 warnings 且 exact=false', async () => {
  const h = await makeHostCtx({ identity: BOUND });
  try {
    seedLibrary(h.dataDir);
    const foreign = path.join(h.dataDir, 'notes.txt');
    fs.writeFileSync(foreign, '第一段记忆。\n\n第二段记忆。', 'utf8');
    const r = await h.host.mergePrompt({ path: foreign });

    assert.equal(r.ok, true);
    assert.equal(r.format, 'text');
    assert.equal(r.exact, false);
    assert.ok(r.warnings.some((w) => w.includes('可能不准')));
    assert.ok(r.prompt.includes('可能不准'));
  } finally {
    h.dispose?.();
  }
});

/* ------------------------------------------------------------------ *
 * V10 日常注入不变
 * ------------------------------------------------------------------ */

test('H9 【V10】新增两个工具后日常注入仍含 12 个入口，字节 ≤6000', () => {
  const text = renderInjection({ writeRoutes: schema.writeRoutes, dimensions: schema.dimensions });
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes <= 6000, `注入 ${bytes} 字节超过 Q1 上限 6000`);
  for (const t of ['dtm_tidy_prompt', 'dtm_merge_prompt']) {
    assert.ok(text.includes(t), `注入里应含 ${t}`);
  }
  assert.ok(text.includes('读写**只用这些工具**'), '「只用这 10 个工具」的旧文案应改成不写死数字');
});
