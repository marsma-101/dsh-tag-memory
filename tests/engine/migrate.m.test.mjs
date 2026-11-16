/**
 * migrate.m.test — 数据目录搬家（migrate.mjs）的引擎单测
 *
 * 覆盖《架构说明》§六：数据目录 4 级优先级
 *   ①② 优先级高于设置页 → 搬家不生效，必须明确告诉用户改哪一行
 *
 * ── 2026-11-16 新增 M12-M20：路径关系校验 ──────────────────────
 * 起因是一个数据损坏级 bug：旧 canMigrate 只挡 `to === from`，不挡包含关系。
 * 而迁移执行序是 mkdir(dest) → readdir(from) → cp，所以 dest 落在 from 内部时
 * 会读到 dest 自己并递归复制。实测复刻该顺序，嵌套 41 层后因 Windows MAX_PATH 中止
 * （Linux 上不会撞路径上限，会一直复制到磁盘写满）。
 *
 * 这组测试守的就是"这种路径必须被拒绝"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  canMigrate,
  verifyMigration,
  MIGRATE_ITEMS,
  isInsideDir,
  shouldSkipOnMigrate,
  copyTreeFiltered,
} from '../../lib/engine/migrate.mjs'

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

/* ================================================================== *
 * isInsideDir —— 包含关系判据
 * ================================================================== */

test('M12 isInsideDir：真子目录 → true', () => {
  assert.equal(isInsideDir('/a/b', '/a/b/c'), true)
  assert.equal(isInsideDir('/a/b', '/a/b/c/d/e'), true)
})

test('M13 isInsideDir：相等 / 父目录 / 兄弟目录 → false', () => {
  assert.equal(isInsideDir('/a/b', '/a/b'), false, '相等不算"内部"（由 SAME_DIR 单独判）')
  assert.equal(isInsideDir('/a/b', '/a'), false, '父目录不是内部')
  assert.equal(isInsideDir('/a/b', '/a/c'), false, '兄弟目录不是内部')
})

test('M14 isInsideDir：前缀相同但不是子目录 → false（startsWith 会判错的那个坑）', () => {
  // '/a/bc'.startsWith('/a/b') === true，但 /a/bc 并不在 /a/b 里面
  assert.equal(isInsideDir('/a/b', '/a/bc'), false)
  assert.equal(isInsideDir('/a/store', '/a/store2'), false)
})

test('M15 isInsideDir：相对路径与 .. 都能正确解析', () => {
  assert.equal(isInsideDir('/a/b', '/a/b/../b/c'), true, '.. 归一后仍在内部')
  assert.equal(isInsideDir('/a/b', '/a/b/../../c'), false, '.. 逃出外部')
})

/* ================================================================== *
 * canMigrate 的路径关系拒绝（修数据损坏级 bug）
 * ================================================================== */

test('M16 【核心回归】目标在源内部 → 拒绝 TARGET_INSIDE_SOURCE', () => {
  // 这正是会让旧实现无限递归复制的输入
  const r = canMigrate({ source: 'settings', from: '/data/lib', to: '/data/lib/sub' })
  assert.equal(r.ok, false, '目标在源内部必须拒绝，否则 mkdir→readdir→cp 会无限递归')
  assert.equal(r.code, 'TARGET_INSIDE_SOURCE')
  assert.ok(r.message.includes('无限嵌套') || r.message.includes('内部'))
  assert.ok(r.hint, '必须给出怎么办的提示')
})

test('M17 目标是源的父目录 → 拒绝 TARGET_IS_PARENT', () => {
  const r = canMigrate({ source: 'settings', from: '/data/lib', to: '/data' })
  assert.equal(r.ok, false, '目标是源的父目录会让新旧库混在同一目录')
  assert.equal(r.code, 'TARGET_IS_PARENT')
})

test('M18 软链接指向同一目录 → 拒绝（realpath 后判等）', () => {
  // 字符串上 to 与 from 不同，但 realpath 后相同
  const r = canMigrate({
    source: 'settings',
    from: '/data/lib',
    to: '/data/link-to-lib',
    realFrom: '/data/lib',
    realTo: '/data/lib',
  })
  assert.equal(r.ok, false, '软链接指向同一目录必须拒绝，否则照样递归')
  assert.equal(r.code, 'SAME_DIR')
})

test('M19 软链接指向源内部 → 拒绝（realpath 后用包含判断）', () => {
  const r = canMigrate({
    source: 'settings',
    from: '/data/lib',
    to: '/data/link-to-sub',
    realFrom: '/data/lib',
    realTo: '/data/lib/sub',
  })
  assert.equal(r.ok, false, '软链接解析后落在源内部，同样会递归')
  assert.equal(r.code, 'TARGET_INSIDE_SOURCE')
})

test('M20 互不包含的正常路径 → 允许', () => {
  const r = canMigrate({ source: 'settings', from: '/data/lib', to: '/backup/lib2' })
  assert.equal(r.ok, true, '完全无关的两个路径应当允许')
})

test('M20b 路径关系校验先于 locked：锁定时若目标非法，仍报路径错误', () => {
  // 数据安全 > "能不能搬"。即使 config 锁定，目标在源内部也应先报路径问题，
  // 因为这条路径在解除锁定后依然危险。
  const r = canMigrate({ source: 'config', from: '/data/lib', to: '/data/lib/sub' })
  assert.equal(r.code, 'TARGET_INSIDE_SOURCE', '路径非法优先于锁定提示')
})

/* ================================================================== *
 * shouldSkipOnMigrate —— 搬什么不搬什么
 * ================================================================== */

test('M21 shouldSkipOnMigrate：锁文件、临时文件、迁移临时目录都不搬', () => {
  assert.equal(shouldSkipOnMigrate('.memory.lock'), true, '锁文件搬过去会让新目录首次操作 LOCK_TIMEOUT')
  assert.equal(shouldSkipOnMigrate('memory.csv.tmp'), true, '临时文件是半成品')
  assert.equal(shouldSkipOnMigrate('x.tmp'), true)
  assert.equal(shouldSkipOnMigrate('.migrating-20261116-120000'), true, '迁移自己的临时目录绝不搬')
})

test('M22 shouldSkipOnMigrate：正常条目要搬（backup 目录也在内）', () => {
  assert.equal(shouldSkipOnMigrate('store'), false)
  assert.equal(shouldSkipOnMigrate('records'), false)
  assert.equal(shouldSkipOnMigrate('backup'), false, '备份目录要跟着搬（旧实现曾漏过）')
  assert.equal(shouldSkipOnMigrate('settings.json'), false)
  assert.equal(shouldSkipOnMigrate(''), true, '空名字视为跳过')
})

/* ================================================================== *
 * copyTreeFiltered —— 递归复制时逐层应用跳过规则
 *
 * 【重要】这是**端到端实测才发现的缺陷**，纯逻辑单测测不出来：
 *   fsp.cp({recursive:true}) 会整棵树搬过去，不回调跳过规则，
 *   于是 store/.memory.lock 被原样带到新目录 → 新目录首次操作 LOCK_TIMEOUT。
 * ================================================================== */

/** 造一个内存文件树，供 copyTreeFiltered 测试（不碰真实磁盘）。 */
function makeFakeTree(tree) {
  const copied = []
  const readdirFn = async (p) => {
    const rel = p.replace(/^\/root/, '').replace(/^\//, '')
    let node = tree
    if (rel !== '') {
      for (const seg of rel.split('/')) node = node?.[seg]?.children
    }
    if (!node) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return Object.entries(node).map(([name, v]) => ({
      name,
      isDirectory: () => Array.isArray(v.children) || v.children !== undefined,
    }))
  }
  const cpFn = async (s, d) => { copied.push(d) }
  const mkdirFn = async () => {}
  return { readdirFn, cpFn, mkdirFn, copied }
}

test('M23 copyTreeFiltered：递归时不搬 store/.memory.lock（端到端发现的缺陷）', async () => {
  const tree = {
    store: { children: {
      'memory.csv': {},
      '.memory.lock': {},   // ← 必须被跳过
    } },
    records: { children: { 'write.jsonl': {} } },
  }
  const { readdirFn, cpFn, mkdirFn, copied } = makeFakeTree(tree)
  await copyTreeFiltered({ src: '/root', dst: '/dst', cpFn, readdirFn, mkdirFn })

  const joined = copied.join('|')
  assert.ok(!joined.includes('.memory.lock'), `锁文件不得被复制，实际复制了：${joined}`)
  assert.ok(joined.includes('memory.csv'), '库本体必须复制')
  assert.ok(joined.includes('write.jsonl'), '台账必须复制')
})

test('M24 copyTreeFiltered：递归时不搬任意层级的 *.tmp', async () => {
  const tree = {
    store: { children: {
      'memory.csv': {},
      'memory.csv.123.tmp': {},  // ← 必须跳过
      'sub': { children: { 'x.tmp': {} } },  // ← 深层也要跳过
    } },
  }
  const { readdirFn, cpFn, mkdirFn, copied } = makeFakeTree(tree)
  await copyTreeFiltered({ src: '/root', dst: '/dst', cpFn, readdirFn, mkdirFn })

  const joined = copied.join('|')
  assert.ok(!joined.includes('.tmp'), `任何层级的 .tmp 都不得复制，实际：${joined}`)
  assert.ok(joined.includes('memory.csv'))
})

test('M25 copyTreeFiltered：backup 目录正常递归复制', async () => {
  const tree = {
    backup: { children: {
      'memory-20260101-000000.csv': {},
      'memory-20260102-000000.csv': {},
    } },
  }
  const { readdirFn, cpFn, mkdirFn, copied } = makeFakeTree(tree)
  await copyTreeFiltered({ src: '/root', dst: '/dst', cpFn, readdirFn, mkdirFn })
  assert.equal(copied.length, 2, `备份目录应完整复制，实际复制 ${copied.length} 个`)
})

test('M26 copyTreeFiltered：跳过项会被如实报告，且带层级路径（便于日志与排错）', async () => {
  const tree = { store: { children: { 'memory.csv': {}, '.memory.lock': {} } } }
  const { readdirFn, cpFn, mkdirFn } = makeFakeTree(tree)
  const r = await copyTreeFiltered({ src: '/root', dst: '/dst', cpFn, readdirFn, mkdirFn })
  // 带层级是刻意的：一堆同名的 .memory.lock 分不清是哪个目录的
  assert.deepEqual(r.skipped, ['store/.memory.lock'], '跳过项要能报出来，且标明所在层级')
})
