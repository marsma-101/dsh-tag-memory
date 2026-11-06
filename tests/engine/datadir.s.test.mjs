/**
 * datadir.s.test — 数据目录解析的回归测试（防 P0-1 / P0-3 复发）
 *
 * 背景（2026-11-06 实装事故）：
 *   profile 补丁写的是 `- id: tag-memory`，但 bundle 补丁 insert 的 id 是
 *   `dsh-tag-memory`。补丁方言里顶层 `- id:` 是"按 id 覆盖已存在条目"，
 *   找不到目标就**整条静默丢弃**（只打一条 warn），于是 config.dataDir
 *   根本没传进 apply()，数据静默落到插件包内 —— 而包目录会被 pnpm 重装删掉。
 *
 * 本测试守三件事：
 *   A. 传了 config.dataDir 就绝不能降级（source 必须是 'config'）
 *   B. 不传 config 时落 $DSH_HOME/tag-memory（source='dsh-home'），不是包内
 *   C. package 兜底必须能识别出来（供宿主告警），且是最后手段
 *
 * 断言按规格写，不按实现写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { resolveDataDir, DATA_DIR_NAME } from '../../lib/engine/core.mjs'

/* ------------------------------------------------------------------ *
 * A 组：config 是最高优先级，绝不允许降级
 * ------------------------------------------------------------------ */

test('S1 传 configDir 时 source 必须是 config（不许降级）', () => {
  const r = resolveDataDir({ configDir: '/opt/dsh/tag-memory', packageDir: '/pkg' })
  assert.equal(r.source, 'config', 'P0-1 回归：config 必须生效')
  assert.equal(r.dir, '/opt/dsh/tag-memory')
})

test('S2 configDir 优先于其它所有来源', () => {
  const r = resolveDataDir({
    configDir: '/from-config',
    envDir: '/from-env',
    settingsDir: '/from-settings',
    dshHomeDir: '/from-home',
    packageDir: '/from-package',
  })
  assert.equal(r.source, 'config')
  assert.equal(r.dir, '/from-config')
})

test('S3 configDir 是空串/纯空白/非字符串时视为未设置，继续降级', () => {
  for (const bad of ['', '   ', null, undefined, 0, 123, {}, []]) {
    const r = resolveDataDir({ configDir: bad, envDir: '/env', packageDir: '/pkg' })
    assert.equal(r.source, 'env', `configDir=${JSON.stringify(bad)} 应视为未设置`)
  }
})

test('S4 configDir 首尾空白会被 trim（配置里手滑加空格不该失效）', () => {
  const r = resolveDataDir({ configDir: '  /opt/dsh/tag-memory  ' })
  assert.equal(r.source, 'config')
  assert.equal(r.dir, '/opt/dsh/tag-memory')
})

/* ------------------------------------------------------------------ *
 * B 组：不传 config 时落 DSH home，而不是插件包内
 * ------------------------------------------------------------------ */

test('S5 不传 configDir 时落 dshHomeDir/tag-memory，source=dsh-home', () => {
  const r = resolveDataDir({ dshHomeDir: '/opt/dsh', packageDir: '/pkg' })
  assert.equal(r.source, 'dsh-home', 'P0-3 回归：默认不该落插件包内')
  // 用 path.join 表达期望（跨平台：Windows 上分隔符是反斜杠，不该断言 POSIX 字面量）
  assert.equal(r.dir, join('/opt/dsh', DATA_DIR_NAME))
  assert.ok(r.dir.endsWith(DATA_DIR_NAME), `目录应以 ${DATA_DIR_NAME} 结尾，实际 ${r.dir}`)
})

test('S6 dsh-home 优先于 package（package 只是最后手段）', () => {
  const r = resolveDataDir({ dshHomeDir: '/home/u/.dsh', packageDir: '/pkg' })
  assert.equal(r.source, 'dsh-home')
  assert.ok(!r.dir.startsWith('/pkg'), '默认目录不许落在插件包内')
})

test('S7 优先级顺序完整：config > env > settings > dsh-home > package', () => {
  const all = {
    configDir: '/c',
    envDir: '/e',
    settingsDir: '/s',
    dshHomeDir: '/h',
    packageDir: '/p',
  }
  assert.equal(resolveDataDir(all).source, 'config')

  const { configDir, ...noConfig } = all
  assert.equal(resolveDataDir(noConfig).source, 'env')

  const { envDir, ...noEnv } = noConfig
  assert.equal(resolveDataDir(noEnv).source, 'settings')

  const { settingsDir, ...noSettings } = noEnv
  assert.equal(resolveDataDir(noSettings).source, 'dsh-home')

  const { dshHomeDir, ...noHome } = noSettings
  assert.equal(resolveDataDir(noHome).source, 'package')
})

/* ------------------------------------------------------------------ *
 * C 组：package 兜底是最后手段，且可被宿主识别以告警
 * ------------------------------------------------------------------ */

test('S8 只有 packageDir 时才落包内，source=package（供宿主告警）', () => {
  const r = resolveDataDir({ packageDir: '/pkg' })
  assert.equal(r.source, 'package', 'package 必须是可识别的来源，不能静默')
  assert.equal(r.dir, join('/pkg', 'data'))
})

test('S9 连 packageDir 都没有时抛错，不静默返回空目录', () => {
  assert.throws(
    () => resolveDataDir({}),
    /dshHomeDir 与 packageDir 至少要给一个/,
    '拿不到任何兜底依据时必须报错（不许兜底掩盖错误）',
  )
})

/* ------------------------------------------------------------------ *
 * D 组：source 取值域封闭（UI 靠它分支，不能出现未定义来源）
 * ------------------------------------------------------------------ */

test('S10 source 只可能是 5 个已知值之一', () => {
  const allowed = new Set(['config', 'env', 'settings', 'dsh-home', 'package'])
  const cases = [
    { configDir: '/c' },
    { envDir: '/e' },
    { settingsDir: '/s' },
    { dshHomeDir: '/h' },
    { packageDir: '/p' },
  ]
  for (const c of cases) {
    const r = resolveDataDir(c)
    assert.ok(allowed.has(r.source), `出现未知 source：${r.source}`)
  }
})

test('S11 DATA_DIR_NAME 是插件名且不含版本号（主子明确要求）', () => {
  assert.equal(DATA_DIR_NAME, 'tag-memory')
  assert.ok(!/-\d/.test(DATA_DIR_NAME), `目录名不许带版本号，实际 ${DATA_DIR_NAME}`)
})
