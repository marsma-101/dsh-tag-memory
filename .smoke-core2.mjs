// 临时冒烟脚本（跑完即删）：编号 / 锁 / 路径 / 文件封装
import { readFileSync, rmSync, existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  formatLocalDate, localIsoString, parseId, isValidId, nextId,
  resolveDataDir, layoutOf, withFileLock,
  readLibraryCsv, appendRecordCsv, replaceRecordCsv, writeLibraryCsv, appendJsonl, readJsonl,
} from './lib/engine/core.mjs';

const schema = JSON.parse(readFileSync('./lib/engine/templates/schema.json', 'utf8'));
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };

// --- 编号 ---
assert(formatLocalDate(new Date(2026, 10, 5)) === '20261105', 'local date');
// C6：UTC 2026-11-05T17:00:00Z 在 +08 是 11-06 01:00
const utcLate = new Date('2026-11-05T17:00:00Z');
const offMin = -utcLate.getTimezoneOffset();
if (offMin === 480) {
  assert(formatLocalDate(utcLate) === '20261106', 'C6 跨零点应得 20261106，实际 ' + formatLocalDate(utcLate));
  assert(utcLate.toISOString().slice(0, 10).replace(/-/g, '') === '20261105', 'toISOString 会错天（对照）');
  console.log('  C6 通过：本地 20261106 vs toISOString 20261105');
} else {
  console.log('  跳过 C6（本机偏移不是 +08:00，实际 ' + offMin + ' 分钟）');
}

assert(parseId('M-20261105-001').seq === 1, 'parseId seq');
assert(parseId('M-20261105-001').date === '20261105', 'parseId date');
assert(parseId('bad') === null, 'parseId invalid');
assert(isValidId('M-20261105-999'), 'isValidId');
assert(nextId([], new Date(2026, 10, 5)) === 'M-20261105-001', 'nextId empty');
assert(nextId(['M-20261105-001', 'M-20261105-007'], new Date(2026, 10, 5)) === 'M-20261105-008', 'nextId max+1');
assert(nextId(['M-20261104-009'], new Date(2026, 10, 5)) === 'M-20261105-001', 'nextId other day ignored');
assert(nextId(['M-20261105-999'], new Date(2026, 10, 5)) === 'M-20261105-1000', 'nextId overflow keeps 4 digits');

// localIsoString 带本地偏移
const iso = localIsoString(new Date(2026, 10, 5, 20, 57, 37));
assert(/^2026-11-05T20:57:37[+-]\d{2}:\d{2}$/.test(iso), 'localIsoString format: ' + iso);

// --- 路径解析 ---
const r1 = resolveDataDir({ configDir: '/c', envDir: '/e', settingsDir: '/s', packageDir: '/p' });
assert(r1.dir === '/c' && r1.source === 'config', 'priority config');
const r2 = resolveDataDir({ envDir: '/e', settingsDir: '/s', packageDir: '/p' });
assert(r2.source === 'env', 'priority env');
const r3 = resolveDataDir({ settingsDir: '/s', packageDir: '/p' });
assert(r3.source === 'settings', 'priority settings');
const r4 = resolveDataDir({ packageDir: '/p' });
assert(r4.source === 'package' && r4.dir === path.join('/p', 'data'), 'priority package default');
assert(resolveDataDir({ configDir: '  ', packageDir: '/p' }).source === 'package', 'blank config ignored');

// --- 文件层 ---
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dtm-smoke-'));
try {
  const { libraryCsv, lockFile } = layoutOf(tmp);

  // 空库读取不报错
  const empty = await readLibraryCsv(libraryCsv, schema);
  assert(empty.records.length === 0 && empty.errors.length === 0, 'read missing file = empty lib');

  // 首次追加自动写表头
  const recA = {
    编号: 'M-20261105-001',
    主要内容: '部署时先跑 build 再跑 test, 否则旧产物会被打进包',
    形态: '技能', 项目: '用户设置', 智能体: '通用',
    自由标签: ['发版检查', '需先build', '部署'],
    稳定性: '观察', 时距: 1, 状态: '生效',
  };
  await appendRecordCsv(libraryCsv, recA, schema);
  const text1 = readFileSync(libraryCsv, 'utf8');
  assert(text1.startsWith(schema.columns.join(',')), 'header written first');
  assert(text1.trim().split(/\r?\n/).length === 2, 'header + 1 row');

  // 追加第二条：取号必须在锁内
  await withFileLock(lockFile, async () => {
    const { records } = await readLibraryCsv(libraryCsv, schema);
    const id = nextId(records.map((r) => r['编号']), new Date(2026, 10, 5));
    assert(id === 'M-20261105-002', 'id in lock: ' + id);
    await appendRecordCsv(libraryCsv, {
      编号: id, 主要内容: '含\n换行 与 "引号"', 形态: '流程', 项目: 'P1', 智能体: 'A1',
      自由标签: ['a', 'b'], 稳定性: '观察', 时距: 1, 状态: '生效',
    }, schema);
  });
  assert(!existsSync(lockFile), 'lock released');

  const lib = await readLibraryCsv(libraryCsv, schema);
  assert(lib.records.length === 2, '2 records');
  assert(lib.records[0]['主要内容'] === recA['主要内容'], 'body with comma roundtrip on disk');
  assert(lib.records[1]['主要内容'] === '含\n换行 与 "引号"', 'body with newline+quote on disk');
  assert(JSON.stringify(lib.records[0]['自由标签']) === JSON.stringify(recA['自由标签']), 'tags on disk');
  assert(lib.records[0]['时距'] === 1, 'tick int');

  // 只追加：旧行字节不变
  const before = readFileSync(libraryCsv, 'utf8');
  const oldLines = before.trim().split(/\r?\n/);
  await appendRecordCsv(libraryCsv, {
    编号: 'M-20261105-003', 主要内容: 'x', 形态: '事实', 项目: '通用', 智能体: '通用',
    自由标签: [], 稳定性: '观察', 时距: 1, 状态: '生效',
  }, schema);
  const after = readFileSync(libraryCsv, 'utf8').trim().split(/\r?\n/);
  assert(after.length === oldLines.length + 1, 'append only adds one line');
  assert(after[1] === oldLines[1], 'old rows unchanged');

  // 整行替换（整理路径）
  const rep = await replaceRecordCsv(libraryCsv, { ...lib.records[0], 状态: '已归档', 自由标签: ['发版检查'] }, schema);
  assert(rep.replaced === true, 'replace ok');
  const lib2 = await readLibraryCsv(libraryCsv, schema);
  assert(lib2.records[0]['状态'] === '已归档', 'status replaced');
  assert(lib2.records[0]['主要内容'] === recA['主要内容'], 'body untouched by replace');
  assert(lib2.records.length === 3, 'row count unchanged by replace');
  const notFound = await replaceRecordCsv(libraryCsv, { 编号: 'M-19990101-001' }, schema);
  assert(notFound.replaced === false && notFound.reason === 'ID_NOT_FOUND', 'replace miss');

  // 全量重写
  const w = await writeLibraryCsv(libraryCsv, lib2.records.slice(0, 2), schema);
  assert(w.count === 2, 'writeLibrary count');
  assert((await readLibraryCsv(libraryCsv, schema)).records.length === 2, 'writeLibrary persisted');

  // JSONL
  const rec = path.join(tmp, 'records', 'write.jsonl');
  await appendJsonl(rec, { ts: iso, ok: true });
  await appendJsonl(rec, { ts: iso, ok: false });
  const jsonl = await readJsonl(rec);
  assert(jsonl.items.length === 2 && jsonl.errors.length === 0, 'jsonl roundtrip');
  await fsp.appendFile(rec, 'not json\n', 'utf8');
  const bad = await readJsonl(rec);
  assert(bad.items.length === 2 && bad.errors.length === 1, 'jsonl bad line skipped');

  // 锁串行化：并发 10 次，序号不能撞
  const libPath2 = path.join(tmp, 'store2', 'memory.csv');
  await appendRecordCsv(libPath2, { 编号: 'M-20261105-001', 主要内容: 'seed', 形态: '技能', 项目: '通用', 智能体: '通用', 自由标签: [], 稳定性: '观察', 时距: 1, 状态: '生效' }, schema);
  const lock2 = path.join(tmp, 'store2', '.memory.lock');
  await Promise.all(Array.from({ length: 10 }, () => withFileLock(lock2, async () => {
    const { records } = await readLibraryCsv(libPath2, schema);
    const id = nextId(records.map((r) => r['编号']), new Date(2026, 10, 5));
    await appendRecordCsv(libPath2, { 编号: id, 主要内容: 'c', 形态: '技能', 项目: '通用', 智能体: '通用', 自由标签: [], 稳定性: '观察', 时距: 1, 状态: '生效' }, schema);
  })));
  const finalLib = await readLibraryCsv(libPath2, schema);
  const ids = finalLib.records.map((r) => r['编号']);
  assert(new Set(ids).size === ids.length, 'no id collision under concurrency: ' + ids.join(','));
  assert(ids.length === 11, '11 records, got ' + ids.length);

  console.log('OK: core 编号/锁/路径/文件层全部冒烟通过');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
