/**
 * seed-diagnosable.test.mjs — 「装完空库」必须可诊断，不能静默
 *
 * 真实事故（2026-11-11，主子在容器里装 v1.2.8）：
 *   1.2.8 的 `package.json files` 还没有 `data/**`（初始记忆是 v1.2.9 才随包发布），
 *   所以安装后的插件目录里**没有** `data/store/memory.csv`。
 *   `seedInitialLibrary()` 读它得到 ENOENT，被 `catch` **静默吞掉**
 *   （旧注释：「包里没带初始库（旧版本包）」）——
 *   用户只看到「怎么什么都没有」，分不清「本来就没有」和「播种失败」。
 *
 * 本文件守两件事：
 *   ① ENOENT（包里没带种子）必须变成**可查询的状态**，不是静默；
 *   ② overview 在空库时要给出人能看懂的解释（emptyHint）。
 *
 * 这属于「把读不到伪装成没有」的同一族缺陷（见 tests/LIMITS.md 教训 7）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { makeHostCtx } from '../_host-ctx.mjs';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST_SRC = fs.readFileSync(path.join(PACKAGE_DIR, 'index.js'), 'utf8');

test('S1 ENOENT 不得被静默吞掉（源码级：必须有 no-bundled-seed 分支）', () => {
  assert.ok(
    HOST_SRC.includes('no-bundled-seed'),
    '必须为「包里没带初始库」定义可见原因码，不能只写日志就 return',
  );
  // 旧写法是 `if (err?.code !== 'EEXIST' && err?.code !== 'ENOENT')` —— 把 ENOENT 排除在告警之外
  assert.equal(
    /err\?\.code !== 'EEXIST' && err\?\.code !== 'ENOENT'/.test(HOST_SRC),
    false,
    '不得再用「ENOENT 和 EEXIST 都当正常」的写法：ENOENT 是可用性问题，必须可见',
  );
  assert.ok(HOST_SRC.includes('seedState'), '必须有 seedState 记录播种结论');
})

test('S2 overview 暴露 seed 状态与空库提示', () => {
  assert.ok(HOST_SRC.includes('seed: seedState'), 'overview 要返回 seed 状态');
  assert.ok(HOST_SRC.includes('emptyHint'), 'overview 要返回空库提示');
})

test('S3 首次初始化：包内有种子 → 真的铺上（当前源码含 data/）', async () => {
  // 当前源码确实自带初始库（1.2.9 起）
  const bundled = path.join(PACKAGE_DIR, 'data', 'store', 'memory.csv');
  assert.ok(fs.existsSync(bundled), '源码仓必须自带 data/store/memory.csv');

  // seed: true —— 打开播种，验证「包内有种子 → 真的铺上」这条链路
  const h = await makeHostCtx({ identity: { 智能体: 'seed-agent', 项目: 'seed-project' }, seed: true });
  try {
    // 真实环境里这是启动时异步跑的（registerStartup 不 await）；
    // 测试必须显式等它完成，否则读到的是「还没初始化」的中间态。
    await h.host._ensureInitialized();
    // Windows 上 copyFile 刚返回时文件句柄可能尚未完全释放（EBUSY），
    // 短暂等待后重读——这是本地文件系统时序，不影响生产逻辑。
    let ov = null;
    for (let i = 0; i < 20; i += 1) {
      try {
        ov = await h.host.getOverview();
        break;
      } catch (err) {
        if (err?.code !== 'EBUSY') throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    assert.ok(ov, 'getOverview 应最终成功');
    assert.equal(ov.ok, true);
    assert.ok(ov.seed && typeof ov.seed === 'object', 'overview 必须带 seed 状态');
    assert.notEqual(ov.seed.reason, 'no-bundled-seed', '源码含种子，不该报「包里没带」');
    assert.equal(ov.seed.seeded, true, '包内有种子时应真正铺上');
    assert.ok(ov.total > 0, `铺完种子后库不该为空，实际 ${ov.total}`);
  } finally {
    h.cleanup();
  }
})

test('S4 空库时 overview 给 emptyHint（不是让用户猜）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtm-empty-'));
  // 默认 seed:false，模拟「包里没带种子」或用户主动清空
  const h = await makeHostCtx({ identity: { 智能体: 'a', 项目: 'p' }, dataDir: tmp });
  try {
    await h.host._ensureInitialized();
    const ov = await h.host.getOverview();
    assert.equal(ov.total, 0, '（前提）库为空');
    assert.ok(typeof ov.emptyHint === 'string' && ov.emptyHint.length > 0, '空库必须给 emptyHint');
    assert.ok(ov.emptyHint.includes('不是坏了') || ov.emptyHint.includes('正常'), '要说明空库不是故障');
  } finally {
    h.cleanup();
  }
})
