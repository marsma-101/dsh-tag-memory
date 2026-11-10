/**
 * tests/gate3/diagnose.test.mjs —— 已有库的检测与分诊
 *
 * 这组测试守的是「不能自动做的事」：
 *   D1 旧格式**有数据** → 必须报 blocking + 给出选项，绝不自动迁移
 *   D2 旧格式**0 行**   → 可以自动处理（没有数据可丢）
 *   D3 新格式正常       → 不打扰（severity=ok）
 *   D4 缺列             → blocking，且说明「不代表你没有记忆」
 *   D5 坏行             → degraded，不丢弃
 *   D6 多份库           → 必须问，不许自动选
 *   D7 体检是只读的     → 跑完文件逐字节不变
 *   D8 库不存在不算问题 → 交给播种流程
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..', '..');

const { diagnoseLibrary, detectLegacyHeader, diagnoseMultiple, findLibraries, SEVERITY } = await import(
  `file://${path.join(PACKAGE_DIR, 'lib', 'engine', 'diagnose.mjs').replaceAll('\\', '/')}`
);
const { loadSchema } = await import(
  `file://${path.join(PACKAGE_DIR, 'lib', 'engine', 'dict.mjs').replaceAll('\\', '/')}`
);

const schema = await loadSchema({ baseDir: path.join(PACKAGE_DIR, 'lib', 'engine', 'templates') });
const NEW_HEADER = schema.columns.join(',');

/** 0.3.7 的 17 列表头（实测取自 F:\dsh记忆库备份 里的旧库）。 */
const OLD_HEADER =
  'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-diag-'));
}

function writeCsv(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('D1 旧格式有数据 → blocking + 必须给选项，绝不自动迁移', async () => {
  const dir = tmpdir();
  try {
    // 表头 + 2 条数据（每行 17 个字段，与表头对齐）
    const row = Array.from({ length: 17 }, (_, i) => `v${i}`).join(',');
    const p = writeCsv(dir, 'old.csv', `${OLD_HEADER}\r\n${row}\r\n${row}\r\n`);

    const r = await diagnoseLibrary(p, schema);

    assert.equal(r.severity, SEVERITY.blocking, '旧格式有数据必须判 blocking');
    assert.equal(r.code, 'LEGACY_FORMAT_WITH_DATA');
    assert.equal(r.found.rows, 2, '要如实报出有多少条，不能只说"不兼容"');
    assert.ok(r.question, '必须给出能直接读给用户听的问题');
    assert.ok(r.options.length >= 2, '必须给出至少两个可执行选项，不能只报错');
    // 关键：不许标成 autoFixable——有数据就不能自动动
    assert.notEqual(r.autoFixable, true, '有数据的旧格式绝不能被自动处理');
    // 选项里必须有「先不动」这条退路
    assert.ok(
      r.options.some((o) => o.id === 'keep-as-is'),
      '必须提供「先不动」选项，用户有权拒绝任何改动',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 旧格式但 0 行 → 可自动处理（没有数据可丢）', async () => {
  const dir = tmpdir();
  try {
    const p = writeCsv(dir, 'old-empty.csv', `${OLD_HEADER}\r\n`);
    const r = await diagnoseLibrary(p, schema);

    assert.equal(r.code, 'LEGACY_FORMAT_EMPTY');
    assert.equal(r.autoFixable, true, '0 行旧格式没有数据可丢，允许自动换掉');
    assert.equal(r.found.rows, 0);
    // 即便能自动做，也不该带 question——不需要问
    assert.equal(r.question, null, '不需要用户决策时不要抛问题');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D3 新格式正常 → 不打扰（severity=ok，无 question）', async () => {
  const dir = tmpdir();
  try {
    const p = writeCsv(
      dir,
      'ok.csv',
      `${NEW_HEADER}\r\nM-20260101-001,一条正常记忆,事实,通用,通用,测试|标签,观察,1,生效\r\n`,
    );
    const r = await diagnoseLibrary(p, schema);

    assert.equal(r.severity, SEVERITY.ok);
    assert.equal(r.code, null, '正常时不该有错误码');
    assert.equal(r.question, null, '正常时不要问用户');
    assert.equal(r.found.rows, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D4 表头缺列 → blocking，且必须说明「不代表你没有记忆」', async () => {
  const dir = tmpdir();
  try {
    const p = writeCsv(dir, 'missing.csv', '编号,主要内容,形态\r\nM-1,内容,事实\r\n');
    const r = await diagnoseLibrary(p, schema);

    assert.equal(r.severity, SEVERITY.blocking);
    assert.equal(r.code, 'HEADER_INCOMPLETE');
    assert.ok(r.found.missing.length > 0, '要点名缺了哪些列');
    // 这条文案最要紧：库读不出来 ≠ 用户没有记忆
    assert.match(r.message, /不代表你没有记忆/, '必须明确区分「读不出来」和「没有记忆」');
    assert.equal(r.autoFixable === true, false, '缺列可能有数据，不能自动处理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D5 坏行 → degraded，报出来但绝不丢弃', async () => {
  const dir = tmpdir();
  try {
    // 第 2 行少字段（只有 3 个，表头 9 个）
    const p = writeCsv(
      dir,
      'bad-row.csv',
      `${NEW_HEADER}\r\nM-20260101-001,正常,事实,通用,通用,a|b,观察,1,生效\r\nM-20260101-002,坏行,事实\r\n`,
    );
    const r = await diagnoseLibrary(p, schema);

    assert.equal(r.severity, SEVERITY.degraded, '部分坏行 = 库可用但有问题');
    assert.equal(r.code, 'ROWS_MALFORMED');
    assert.ok(r.found.badRows >= 1, '要报出坏了几行');
    assert.ok(r.question, '要不要修坏行必须问用户');
    assert.ok(
      r.options.some((o) => o.id === 'keep-as-is'),
      '必须允许「先这样用」——不许替用户决定丢弃坏行',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D6 多份库 → 必须问，不许自动选', async () => {
  const dir = tmpdir();
  try {
    const a = writeCsv(dir, 'a.csv', `${NEW_HEADER}\r\nM-20260101-001,a,事实,通用,通用,x|y,观察,1,生效\r\n`);
    const b = writeCsv(
      dir,
      'b.csv',
      `${NEW_HEADER}\r\nM-20260101-002,b1,事实,通用,通用,p|q,观察,1,生效\r\nM-20260101-003,b2,事实,通用,通用,p|q,观察,1,生效\r\n`,
    );
    // 再造一个空库（0 条）——它不该算进「有内容的库」
    writeCsv(dir, 'empty.csv', `${NEW_HEADER}\r\n`);

    const libs = await findLibraries({ current: a, candidates: [b, path.join(dir, 'empty.csv')] });
    const r = diagnoseMultiple(libs);

    assert.ok(r, '两份有内容的库必须触发提醒');
    assert.equal(r.code, 'MULTIPLE_LIBRARIES');
    assert.ok(r.question, '必须问用户');
    assert.equal(r.found.libraries.length, 2, '只算有内容的库，空库不算');
    assert.ok(
      r.options.some((o) => o.id === 'keep-as-is'),
      '必须允许「保持现状」',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7 体检是只读的 —— 跑完文件逐字节不变', async () => {
  const dir = tmpdir();
  try {
    const p = writeCsv(dir, 'readonly.csv', `${OLD_HEADER}\r\n${Array(17).fill('x').join(',')}\r\n`);
    const before = fs.readFileSync(p);

    await diagnoseLibrary(p, schema);
    await diagnoseLibrary(p, schema); // 跑两次也要一样

    const after = fs.readFileSync(p);
    assert.deepEqual(after, before, '体检绝不能修改用户的库文件——一个字节都不行');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D8 库不存在不算问题（交给播种流程）', async () => {
  const dir = tmpdir();
  try {
    const r = await diagnoseLibrary(path.join(dir, 'nope.csv'), schema);

    assert.equal(r.ok, true, '不存在不是错误');
    assert.equal(r.exists, false);
    assert.equal(r.severity, SEVERITY.ok, '不存在是正常状态（首次安装），不该告警');
    assert.equal(r.question, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D9 detectLegacyHeader 不误判新格式（同名列不能当旧格式）', () => {
  // 新格式里也有「稳定性」「项目」「状态」这些与旧版同名的列，
  // 单看一个列名就判旧格式会误伤。
  const r = detectLegacyHeader(schema.columns);
  assert.equal(r.legacy, false, '新格式表头不能被判成旧格式');

  // 旧格式独有列命中 ≥2 才算
  assert.equal(detectLegacyHeader(['id', '内容']).legacy, true);
  assert.equal(detectLegacyHeader(['id']).legacy, false, '只命中 1 个不足以判定');
});
