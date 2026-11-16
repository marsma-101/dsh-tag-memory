/**
 * layout.l.test — 数据目录布局（core.mjs 的 layoutOf）与位置描述符
 *
 * ── 2026-11-16 新增 ────────────────────────────────────────────
 * 守两处改动：
 *   ① `backupDir` 可被独立指定（解耦「备份与数据同盘」）
 *   ② `settingsFile` 已删除（它指向的文件从未被写入过，是死字段）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { layoutOf, resolveDataDir } from '../../lib/engine/core.mjs';

/* ------------------------------------------------------------------ *
 * L1 默认布局：backupDir 仍在数据目录下（向后兼容）
 * ------------------------------------------------------------------ */
test('L1 默认 backupDir = <dataDir>/backup（老行为不变）', () => {
  const l = layoutOf('/data/lib');
  assert.equal(l.backupDir, path.join('/data/lib', 'backup'));
  assert.equal(l.backupDirOverridden, false, '没覆盖时该标记为 false');
});

/* ------------------------------------------------------------------ *
 * L2 backupDir 可独立指定
 * ------------------------------------------------------------------ */
test('L2 backupDir 可独立指定 → 备份不再与数据同盘', () => {
  const l = layoutOf('/data/lib', { backupDir: '/mnt/bigdisk/dtm-backup' });
  assert.equal(l.backupDir, '/mnt/bigdisk/dtm-backup', '备份应写到指定位置');
  assert.equal(l.backupDirOverridden, true, 'UI 可据此提示"备份在别处"');
  // 其余路径仍跟随 dataDir，不受影响
  assert.equal(l.libraryCsv, path.join('/data/lib', 'store', 'memory.csv'));
});

/* ------------------------------------------------------------------ *
 * L3 空/空白 backupDir 视为未指定（不能变成空路径）
 * ------------------------------------------------------------------ */
test('L3 backupDir 传空串或空白 → 退回默认，不产生空路径', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const l = layoutOf('/data/lib', { backupDir: bad });
    assert.equal(l.backupDir, path.join('/data/lib', 'backup'), `backupDir=${JSON.stringify(bad)} 应退回默认`);
    assert.equal(l.backupDirOverridden, false);
  }
});

/* ------------------------------------------------------------------ *
 * L4 settingsFile 已删除（死字段清理）
 * ------------------------------------------------------------------ */
test('L4 layoutOf 不再含 settingsFile（该文件从未被写入，是死字段）', () => {
  const l = layoutOf('/data/lib');
  assert.equal(
    Object.prototype.hasOwnProperty.call(l, 'settingsFile'),
    false,
    'settingsFile 指向 <dataDir>/settings.json，但真正的指针在 $DSH_HOME/tag-memory-location.json',
  );
});

/* ------------------------------------------------------------------ *
 * L5 其余字段齐全
 * ------------------------------------------------------------------ */
test('L5 布局字段齐全且都基于 dataDir', () => {
  const d = '/data/lib';
  const l = layoutOf(d);
  assert.equal(l.dataDir, d);
  assert.equal(l.storeDir, path.join(d, 'store'));
  assert.equal(l.recordsDir, path.join(d, 'records'));
  assert.equal(l.lockFile, path.join(d, 'store', '.memory.lock'));
});

/* ------------------------------------------------------------------ *
 * L6 resolveDataDir 优先级（回归：不能被本次改动带坏）
 * ------------------------------------------------------------------ */
test('L6 resolveDataDir 五级优先级不变', () => {
  const base = { dshHomeDir: '/home/.dsh', packageDir: '/pkg' };
  assert.equal(resolveDataDir({ ...base, configDir: '/c' }).source, 'config');
  assert.equal(resolveDataDir({ ...base, envDir: '/e' }).source, 'env');
  assert.equal(resolveDataDir({ ...base, settingsDir: '/s' }).source, 'settings');
  assert.equal(resolveDataDir(base).source, 'dsh-home');
  assert.equal(resolveDataDir({ packageDir: '/pkg' }).source, 'package');

  // 空串/空白视为未设置
  assert.equal(resolveDataDir({ ...base, configDir: '  ', envDir: '/e' }).source, 'env');
});
