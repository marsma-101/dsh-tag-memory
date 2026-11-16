/**
 * backup.n.test — 备份清理策略（2026-11-16 新增）
 *
 * 起因：旧 pruneBackups 只认 `memory-*.csv`，于是 `export-*.csv` **永不清理**。
 * 实测生产数据里 3 个 2026-11-10 的 export 一直留着，6 天没动过。
 *
 * 这组测试守两件事：
 *   ① memory-*.csv 按份数清、export-*.csv 按天数清，两者独立
 *   ② **绝不碰用户自己放进来的文件**（这是旧实现写明的承诺，不能因重写而丢）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { pruneBackups, listBackups, backupStamp } from '../../lib/engine/backup.mjs';

/** 造一个临时 backup 目录，并塞入指定文件（可指定 mtime 天数偏移）。 */
async function makeDir(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dtm-backup-'));
  for (const f of files) {
    const full = path.join(dir, f.name);
    await fsp.writeFile(full, f.content ?? 'x', 'utf8');
    if (typeof f.ageDays === 'number') {
      const t = new Date(Date.now() - f.ageDays * 24 * 60 * 60 * 1000);
      await fsp.utimes(full, t, t);
    }
  }
  return dir;
}

const names = async (dir) => (await fsp.readdir(dir)).sort();

/* ------------------------------------------------------------------ *
 * N1 export-*.csv 现在会被清理（旧实现的核心缺陷）
 * ------------------------------------------------------------------ */
test('N1 export-*.csv 超过保留天数 → 被清理（旧实现永不清理）', async () => {
  const dir = await makeDir([
    { name: 'export-20260101-000000.csv', ageDays: 100 },
    { name: 'export-20260102-000000.csv', ageDays: 5 },
  ]);

  const r = await pruneBackups(dir, { keepDays: 90 });
  assert.deepEqual(r.removed, ['export-20260101-000000.csv'], '100 天前的 export 应被清掉');
  assert.deepEqual(await names(dir), ['export-20260102-000000.csv'], '5 天前的应保留');
  await fsp.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * N2 memory-*.csv 按份数清（旧行为不能丢）
 * ------------------------------------------------------------------ */
test('N2 memory-*.csv 超出保留份数 → 按 mtime 留最近的', async () => {
  const dir = await makeDir([
    { name: 'memory-20260101-000000.csv', ageDays: 10 },
    { name: 'memory-20260102-000000.csv', ageDays: 8 },
    { name: 'memory-20260103-000000.csv', ageDays: 1 },
  ]);

  const r = await pruneBackups(dir, { keep: 2 });
  assert.deepEqual(r.removed, ['memory-20260101-000000.csv'], '最老的一份被清');
  assert.deepEqual(
    await names(dir),
    ['memory-20260102-000000.csv', 'memory-20260103-000000.csv'],
    '留最近 2 份',
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * N3 两类产物策略独立：只给 keep 不该动 export
 * ------------------------------------------------------------------ */
test('N3 只给 keep 时 export-*.csv 不受影响（策略独立）', async () => {
  const dir = await makeDir([
    { name: 'memory-20260101-000000.csv', ageDays: 10 },
    { name: 'memory-20260102-000000.csv', ageDays: 1 },
    { name: 'export-20250101-000000.csv', ageDays: 400 }, // 极老，但没给 keepDays
  ]);

  const r = await pruneBackups(dir, { keep: 1 });
  assert.deepEqual(r.removed, ['memory-20260101-000000.csv']);
  assert.ok(
    (await names(dir)).includes('export-20250101-000000.csv'),
    '没给 keepDays 就不该动 export',
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * N4 绝不碰用户文件（旧实现的明确承诺）
 * ------------------------------------------------------------------ */
test('N4 用户自己放进 backup 的文件一律不动', async () => {
  const dir = await makeDir([
    { name: 'memory-20260101-000000.csv', ageDays: 10 },
    { name: 'memory-20260102-000000.csv', ageDays: 1 },
    { name: '我的笔记.csv', ageDays: 999 },
    { name: 'important.txt', ageDays: 999 },
    { name: 'export-backup-of-mine.csv', ageDays: 999 }, // 不符合 export-<stamp> 但确实匹配前缀
    { name: 'memory.csv', ageDays: 999 }, // 没有时间戳，不是插件产物
  ]);

  await pruneBackups(dir, { keep: 1, keepDays: 1 });
  const left = await names(dir);

  assert.ok(left.includes('我的笔记.csv'), '用户文件不得删除');
  assert.ok(left.includes('important.txt'), '用户文件不得删除');
  assert.ok(left.includes('memory.csv'), '无时间戳的 memory.csv 不是插件产物，不得删');
  await fsp.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * N5 includeExports=false 可完全关掉 export 清理
 * ------------------------------------------------------------------ */
test('N5 includeExports=false 时即使超期也不清 export', async () => {
  const dir = await makeDir([{ name: 'export-20250101-000000.csv', ageDays: 400 }]);
  const r = await pruneBackups(dir, { keepDays: 1, includeExports: false });
  assert.deepEqual(r.removed, []);
  assert.ok((await names(dir)).includes('export-20250101-000000.csv'));
  await fsp.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * N6 兼容旧签名 pruneBackups(dir, 30)
 * ------------------------------------------------------------------ */
test('N6 旧签名 pruneBackups(dir, number) 仍按份数工作', async () => {
  const dir = await makeDir([
    { name: 'memory-20260101-000000.csv', ageDays: 10 },
    { name: 'memory-20260102-000000.csv', ageDays: 1 },
  ]);
  const r = await pruneBackups(dir, 1);
  assert.deepEqual(r.removed, ['memory-20260101-000000.csv'], '旧调用方式不能被改坏');
  await fsp.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * N7 目录不存在时安静返回（不抛）
 * ------------------------------------------------------------------ */
test('N7 目录不存在 → 返回空 removed，不抛错', async () => {
  const r = await pruneBackups(path.join(os.tmpdir(), 'dtm-not-exist-' + Date.now()), { keep: 1 });
  assert.deepEqual(r.removed, []);
});

/* ------------------------------------------------------------------ *
 * N8 listBackups 能同时列出两类产物
 * ------------------------------------------------------------------ */
test('N8 listBackups 列出 memory-* 与 export-*（旧的按 mtime 降序）', async () => {
  const dir = await makeDir([
    { name: 'memory-20260101-000000.csv', ageDays: 5 },
    { name: 'export-20260102-000000.csv', ageDays: 1 },
  ]);
  const { backups } = await listBackups({ backupDir: dir });
  assert.equal(backups.length, 2);
  assert.equal(backups[0].name, 'export-20260102-000000.csv', '新的在前');
  await fsp.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * N9 backupStamp 格式可被正则识别（产物命名的前提）
 * ------------------------------------------------------------------ */
test('N9 backupStamp 产出 YYYYMMDD-HHMMSS，能被清理正则识别', () => {
  const s = backupStamp(new Date('2026-11-16T12:34:56'));
  assert.match(s, /^\d{8}-\d{6}$/, `实际 ${s}`);
  assert.match(`memory-${s}.csv`, /^memory-.*\.csv$/);
  assert.match(`export-${s}.csv`, /^export-.*\.csv$/);
});
