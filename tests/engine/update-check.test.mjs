/**
 * update-check.test.mjs — 版本更新检查验收（方案 C）
 *
 * 起因（主子 2026-11-11 实测）：本地停在 1.2.8、npm 都发到 1.4.1 了，
 * 插件页却没有任何提示 —— 因为 DSH 插件管理器的更新按钮依赖官方
 * `updateRefusal()` 的一堆内部条件（availability/source/shipped...），
 * 插件侧既改不动也预测不了。所以本插件自带检查 + 自带展示。
 *
 * 本文件守四件事：
 *   ① 版本比较正确（含 prerelease、非法值不崩）；
 *   ② 多源回退：镜像优先、官方兜底 —— 单源写死在本环境 100% 失败；
 *   ③ 「检查失败」与「已是最新」必须能区分（不能把网络错误说成没更新）；
 *   ④ 宿主把 version/update 暴露出来，且手动检查与启动检查共用同一实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isNewerVersion,
  fetchLatestFrom,
  fetchLatestVersion,
  checkForUpdate,
  REGISTRY_ENDPOINTS,
} from '../../lib/engine/update-check.mjs';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ================================================================== *
 * A. 版本比较（纯函数）
 * ================================================================== */

test('U1 版本比较：常规递增', () => {
  assert.equal(isNewerVersion('1.4.2', '1.4.1'), true);
  assert.equal(isNewerVersion('1.4.1', '1.4.1'), false);
  assert.equal(isNewerVersion('1.4.0', '1.4.1'), false);
  assert.equal(isNewerVersion('1.5.0', '1.4.9'), true);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
  assert.equal(isNewerVersion('v1.4.2', '1.4.1'), true, '允许 v 前缀');
});

test('U2 版本比较：prerelease 规则', () => {
  // 1.4.1-beta 主版本(1,4,1) 高于 1.4.0 → 判为更新
  assert.equal(isNewerVersion('1.4.1-beta', '1.4.0'), true, '预发布的主版本更高时仍算更新');
  // 同主版本：正式版 > 预发布版
  assert.equal(isNewerVersion('1.4.1', '1.4.1-beta'), true, '同号正式版高于预发布');
  assert.equal(isNewerVersion('1.4.1-beta', '1.4.1'), false, '预发布低于同号正式版');
});

test('U2b 预发布按 semver §11 分段比（2026-11-12 P1-8：rc.10 不得被判旧于 rc.2）', () => {
  // 旧实现整串字典序：'rc.10' < 'rc.2'（因 '1'<'2'）→ 误判。分段数值比才对。
  assert.equal(isNewerVersion('1.5.0-rc.10', '1.5.0-rc.2'), true, 'rc.10 应新于 rc.2');
  assert.equal(isNewerVersion('1.5.0-rc.2', '1.5.0-rc.10'), false, 'rc.2 应旧于 rc.10');
  assert.equal(isNewerVersion('1.5.0-rc.2', '1.5.0-rc.2'), false, '相同预发布不算更新');
  // 数字段 < 字母段；段数少且前缀相同 → 更小
  assert.equal(isNewerVersion('1.5.0-alpha', '1.5.0-1'), true, '字母段高于数字段');
  assert.equal(isNewerVersion('1.5.0-rc.1.1', '1.5.0-rc.1'), true, '多一段更大');
  assert.equal(isNewerVersion('1.5.0-beta', '1.5.0-alpha'), true, '字母段字典序');
});

test('U3 版本比较：非法值不崩、判为「不更新」', () => {
  assert.equal(isNewerVersion('abc', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', 'abc'), false);
  assert.equal(isNewerVersion(null, '1.0.0'), false);
  assert.equal(isNewerVersion(undefined, undefined), false);
  assert.doesNotThrow(() => isNewerVersion({}, []));
});

/* ================================================================== *
 * B. 多源回退
 * ================================================================== */

test('U4 端点顺序：镜像在官方之前（本环境官方源 TLS 不通）', () => {
  assert.ok(REGISTRY_ENDPOINTS.length >= 2, '必须有回退源');
  assert.equal(REGISTRY_ENDPOINTS[0].name, 'npmmirror', '第一顺位应是实测能通的镜像');
  const names = REGISTRY_ENDPOINTS.map((e) => e.name);
  assert.ok(names.includes('npmjs'), '必须保留官方源兜底');
});

test('U5 单源失败 → resolve 成 ok:false（绝不 reject、绝不抛）', async () => {
  // 指向一个必然解析失败的域名，验证「失败不抛」这条硬纪律
  const r = await fetchLatestFrom(
    { base: 'https://this-host-must-not-exist.invalid', name: 'dsh-tag-memory' },
    { timeoutMs: 1500 },
  );
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '要给出失败原因');
  assert.ok(Number.isFinite(r.ms), '要记录耗时（便于诊断）');
});

test('U6 全源失败 → ok:false 且保留每条尝试记录（可诊断）', async () => {
  const r = await fetchLatestVersion('dsh-tag-memory', {
    endpoints: [
      { name: 'bad1', base: 'https://this-host-must-not-exist.invalid' },
      { name: 'bad2', base: 'https://also-not-exist.invalid' },
    ],
    timeoutMs: 1200,
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 2, '每个源都要留下尝试记录');
  for (const a of r.attempts) assert.ok(a.reason, `${a.source} 应带失败原因`);
});

/* ================================================================== *
 * C. 检查失败 vs 已是最新（必须能分清）
 * ================================================================== */

test('U7 全源失败时：error 非空、latest 为 null（≠「已是最新」）', async () => {
  const r = await checkForUpdate({
    currentVersion: '1.4.1',
    name: 'dsh-tag-memory',
    endpoints: [{ name: 'bad', base: 'https://this-host-must-not-exist.invalid' }],
    timeoutMs: 1200,
  });
  assert.equal(r.hasUpdate, false);
  assert.equal(r.latest, null, '没查到时 latest 必须是 null，不能伪造一个版本号');
  assert.ok(r.error, '检查失败必须有 error，UI 才能显示「检查失败」而不是「已是最新」');
  assert.equal(r.current, '1.4.1');
});

test('U8 端点顺序生效：前一个失败会自动试下一个', async () => {
  const r = await fetchLatestVersion('dsh-tag-memory', {
    endpoints: [
      { name: 'bad', base: 'https://this-host-must-not-exist.invalid' },
      { name: 'npmmirror', base: 'https://registry.npmmirror.com' },
    ],
    timeoutMs: 8000,
  });
  assert.equal(r.ok, true, '第二个源应成功');
  assert.equal(r.attempts[0].ok, false, '第一个源应记录失败');
  assert.equal(r.attempts[1].ok, true, '第二个源应成功');
  assert.ok(r.version, '要拿到版本号');
});

/* ================================================================== *
 * D. 宿主接线（源码级 + 运行时）
 * ================================================================== */

test('U9 宿主暴露 version/update 且手动检查是零参（gateway 按 Function.length 校验）', () => {
  const src = fs.readFileSync(path.join(PACKAGE_DIR, 'index.js'), 'utf8');
  assert.ok(src.includes('version: currentVersion()'), 'getSettings/overview 要暴露当前版本');
  assert.ok(src.includes('update: updateState'), '要暴露最近一次检查结果');
  // checkUpdate 必须是零参实现（gateway 按 Function.length 校验，声明参数会被判成「要传参」）
  assert.ok(
    /const checkUpdate = \(\) => checkUpdateNow\(/.test(src),
    'checkUpdate 必须是零参箭头函数',
  );
  assert.ok(src.includes('checkUpdate: []'), 'REMOTE_SIGNATURES 里必须登记 checkUpdate 且无参数');
  assert.ok(src.includes('registerStartup'), '启动时要挂后台检查');
});

test('U10 客户端三处接线齐全（spec / api / lazy 白名单）', () => {
  const src = fs.readFileSync(path.join(PACKAGE_DIR, 'client.js'), 'utf8');
  assert.ok(src.includes("'tagMemory/checkUpdate'"), '客户端 spec 要有端点声明');
  assert.ok(src.includes("checkUpdate: function () { return call('checkUpdate') }"), 'api 要有调用器');
  assert.ok(/methods\s*=\s*\[[\s\S]*?'checkUpdate'/.test(src), 'lazy 白名单要包含 checkUpdate');
  assert.ok(src.includes('cardVersionTitle'), '要有版本卡片文案');
  // zh / en 两套文案都要有
  assert.equal((src.match(/cardVersionTitle:/g) || []).length, 2, 'zh/en 各一份');
});

test('U11 当前源码版本号可读且与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, '版本号必须是 semver');
  assert.equal(pkg.name, 'dsh-tag-memory', '升级检查查的包名必须与 package.json 一致');
});
