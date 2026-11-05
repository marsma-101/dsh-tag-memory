/**
 * migrate.m.test — 数据目录搬家（migrate.mjs）的引擎单测
 *
 * 覆盖《架构说明》§六：数据目录 4 级优先级
 *   ①② 优先级高于设置页 → 搬家不生效，必须明确告诉用户改哪一行
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canMigrate, verifyMigration, MIGRATE_ITEMS } from '../../lib/engine/migrate.mjs'

// ── canMigrate ────────────────────────────────────────────

test('M1 搬家：config 锁定时拒绝并给出改哪一行', () => {
  const r = canMigrate({ source: 'config', from: '/a', to: '/b' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DATA_DIR_LOCKED')
  assert.ok(r.message.includes('cordis.patch.yml'))
  assert.ok(r.hint.includes('config.dataDir'))
})

test('M2 搬家：env 锁定时拒绝并说明清哪个变量', () => {
  const r = canMigrate({ source: 'env', from: '/a', to: '/b' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DATA_DIR_LOCKED')
  assert.ok(r.message.includes('DSH_TAG_MEMORY_DATA_DIR'))
})

test('M3 搬家：settings 来源允许', () => {
  const r = canMigrate({ source: 'settings', from: '/a', to: '/b' })
  assert.equal(r.ok, true)
})

test('M4 搬家：package 来源允许（出厂默认可搬）', () => {
  const r = canMigrate({ source: 'package', from: '/a', to: '/b' })
  assert.equal(r.ok, true)
})

test('M5 搬家：目标为空拒绝', () => {
  const r = canMigrate({ source: 'settings', from: '/a', to: '   ' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'TARGET_EMPTY')
})

test('M6 搬家：目标与源相同拒绝', () => {
  const r = canMigrate({ source: 'settings', from: '/a', to: '/a' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SAME_DIR')
})

// ── verifyMigration ───────────────────────────────────────

test('M7 校验：记录数一致 → 成功', () => {
  const r = verifyMigration({ bytes: 100, records: 10 }, { bytes: 100, records: 10 })
  assert.equal(r.ok, true)
})

test('M8 校验：目标为空而源非空 → 失败', () => {
  const r = verifyMigration({ bytes: 100, records: 10 }, { bytes: 0, records: 0 })
  assert.equal(r.ok, false)
  assert.ok(r.message.length > 0)
})

test('M9 校验：记录数变少 → 失败（搬家不完整）', () => {
  const r = verifyMigration({ bytes: 100, records: 10 }, { bytes: 100, records: 5 })
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('记录数变少'))
})

test('M10 校验：无法读大小 → 不判成功也不判失败，要求人工检查', () => {
  const r = verifyMigration({ bytes: NaN, records: 10 }, { bytes: 100, records: 10 })
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('人工检查'))
})

// ── MIGRATE_ITEMS ─────────────────────────────────────────

test('M11 清单：库本体是必需项，其余可选', () => {
  const lib = MIGRATE_ITEMS.find((x) => x.kind === 'library')
  assert.ok(lib, '必须列出库本体')
  assert.equal(lib.required, true)

  const others = MIGRATE_ITEMS.filter((x) => x.kind !== 'library')
  assert.ok(others.length > 0)
  assert.ok(others.every((x) => x.required === false))
})
