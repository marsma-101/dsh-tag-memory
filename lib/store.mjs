// store.mjs —— 定位记忆库、载入字典、取用「一份逻辑」（core）
//
// 定位规则（从宽到窄）：
//   1. 配置给的 `libraryDir`（profile 行 / preset 行的 config，由 `setLibraryDir()` 送进来）
//   2. 环境变量 DSH_TAG_MEMORY_SKILL_DIR
//   3. <DSH_HOME>/skills/marsma101-tag-memory
// DSH_HOME：环境变量 DSH_HOME，否则 <USERPROFILE|HOME>/.dsh。
//
// 这里**不重写任何读写逻辑**：字典是库里的 references/tags.schema.json，读/写/筛是库里的
// scripts/lib/core.mjs。插件只做 DSH 这一层壳，命令行与界面走的是同一份实现。

import { readFileSync, existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const requireHere = createRequire(import.meta.url)
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''

/** DSH 家目录（环境变量 `DSH_HOME`，默认 `~/.dsh`）。 */
export const DSH_HOME =
  process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(HOME, '.dsh')

/** 记忆库目录名。 */
export const SKILL_NAME = 'marsma101-tag-memory'

/**
 * 库目录的推断链：显式给的（`config.libraryDir`）→ 环境变量 → `<DSH_HOME>/skills/<SKILL_NAME>`。
 * 不传就是后两条——**与本版之前的行为完全一致**。
 */
export function resolveLibraryDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())
  const env = process.env.DSH_TAG_MEMORY_SKILL_DIR
  if (env !== undefined && env.trim() !== '') return env.trim()
  return join(DSH_HOME, 'skills', SKILL_NAME)
}

let _dir = resolveLibraryDir()

/** 智能体档案根：`<DSH_HOME>/.agent-presets`。notice 自愈就在这底下找 MEMORY.md。 */
export const PRESET_ROOT = join(DSH_HOME, '.agent-presets')

// 库目录底下的那几个路径。**是 let、不是 const**：`config.libraryDir` 换目录时当场重算，
// ESM 的活绑定会让 import 过它们的模块读到新值。不换目录时一个字节都不变。
export let SKILL_DIR = _dir
export let SCHEMA_PATH = join(_dir, 'references', 'tags.schema.json')
export let STORE_DIR = join(_dir, 'store')
export let CSV_PATH = join(STORE_DIR, 'memory.csv')
export let INDEX_PATH = join(STORE_DIR, 'index.md')
export let BACKUP_CFG_PATH = join(STORE_DIR, 'backup.json')
export let LOCK_PATH = join(STORE_DIR, '.append.lock')
let CORE_PATH = join(_dir, 'scripts', 'lib', 'core.mjs')
let BACKUP_CORE_PATH = join(_dir, 'scripts', 'lib', 'backup.mjs')

/** 按 _dir 重算上面那一串路径（换库目录时用）。 */
function derivePaths() {
  SKILL_DIR = _dir
  SCHEMA_PATH = join(_dir, 'references', 'tags.schema.json')
  STORE_DIR = join(_dir, 'store')
  CSV_PATH = join(STORE_DIR, 'memory.csv')
  INDEX_PATH = join(STORE_DIR, 'index.md')
  BACKUP_CFG_PATH = join(STORE_DIR, 'backup.json')
  LOCK_PATH = join(STORE_DIR, '.append.lock')
  CORE_PATH = join(_dir, 'scripts', 'lib', 'core.mjs')
  BACKUP_CORE_PATH = join(_dir, 'scripts', 'lib', 'backup.mjs')
}

// ── 字典 ────────────────────────────────────────────────

let _schema
/** 同步载入字典（缓存）。section 的文本函数必须同步，所以这里不用动态 import。 */
export function loadSchema() {
  if (_schema) return _schema
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`找不到标签字典：${SCHEMA_PATH}（记忆库是否已就位？可用 config.libraryDir 或环境变量 DSH_TAG_MEMORY_SKILL_DIR 指定它的位置）`)
  }
  _schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  return _schema
}

// ── 「一份逻辑」──────────────────────────────────────────

let _core = null
let _coreError = null
try {
  _core = await import(pathToFileURL(CORE_PATH).href)
} catch (e) {
  _coreError = e
}

/** 读写核心（append / filter / 插件共用同一份）。未就绪则抛。 */
export function getCore() {
  if (_core === null) {
    throw new Error(`读写核心未加载：${CORE_PATH}\n${_coreError?.message ?? ''}`)
  }
  return _core
}

/** 记忆库是否就绪（工具据此给出可读的降级提示，而不是抛栈）。 */
export function ready() {
  return _core !== null && existsSync(SCHEMA_PATH) && existsSync(CSV_PATH)
}

// ── 备份的「一份逻辑」────────────────────────────────────

let _backup = null
let _backupError = null
try {
  _backup = await import(pathToFileURL(BACKUP_CORE_PATH).href)
} catch (e) {
  _backupError = e
}

/**
 * 备份核心（和 `node scripts/backup.mjs` 共用同一份）。
 * 界面上的「立即备份」走这里，所以界面和命令行的行为永远一致。
 */
export function getBackupCore() {
  if (_backup === null) {
    throw new Error(`备份核心未加载：${BACKUP_CORE_PATH}\n${_backupError?.message ?? ''}`)
  }
  return _backup
}

/** 备份功能是否可用（库太旧、没有 backup.mjs 时，界面显示成「不可用」而不是崩）。 */
export function backupReady() {
  return _backup !== null && existsSync(CSV_PATH)
}

// ── 换库目录（config.libraryDir）─────────────────────────

/** 「库目录换了，但这份 Node 不能同步重载核心」——置位后由 overview 照实报出来，不静默。 */
let _coreStale = false
export function coreStale() { return _coreStale }

/** 同步取一份库里的逻辑；取不到就把原因带回来（调用方决定是报错还是降级）。 */
function requireFromLibrary(p) {
  try { return { mod: requireHere(p), err: null } } catch (e) { return { mod: null, err: e } }
}
/** 这份 Node 能不能同步 require 一份 ESM（22.12+ 才行；更老的版本只会抛这两个码）。 */
const isNoSyncEsm = (e) => e?.code === 'ERR_REQUIRE_ESM' || e?.code === 'ERR_REQUIRE_ASYNC_MODULE'

/**
 * 换记忆库目录（配置项 `libraryDir`）。返回是否真的换了。
 *
 * **为什么得当场重载**：`apply()` 是同步的，换完马上就有工具要读写；而核心（core.mjs /
 * backup.mjs）是从**目录里**加载的，换了目录不重载，它就一直用老库那一份。
 * Node 22.12+ 能同步 `require()` 一份没有顶层 await 的 ESM，所以这里当场就能换；
 * 更老的 Node 上同步 load 不了 ESM，那就**留住已加载的那份**并置 `coreStale`，
 * 由 overview 说清「重启 DSH 才生效」——宁可明说，也不静默用错的库。
 *
 * 不传（没配）时走原来的推断链；推断结果与当前一致就**什么都不做**——没配 = 行为与旧版一样。
 */
export function setLibraryDir(explicit) {
  const next = resolveLibraryDir(explicit)
  if (next === _dir) return false

  _dir = next
  derivePaths()
  _schema = undefined // 字典是库里的，换了库必须重新读

  const c = requireFromLibrary(CORE_PATH)
  if (c.mod) { _core = c.mod; _coreError = null; _coreStale = false }
  else if (isNoSyncEsm(c.err)) { _coreStale = true } // 老 Node：重载不了，别把手上那份弄丢
  else { _core = null; _coreError = c.err; _coreStale = false }

  const b = requireFromLibrary(BACKUP_CORE_PATH)
  if (b.mod) { _backup = b.mod; _backupError = null }
  else if (!isNoSyncEsm(b.err)) { _backup = null; _backupError = b.err }

  return true
}

// ── 智能体身份 ──────────────────────────────────────────

/**
 * 解析调用方智能体名（用于 `角色` 列）。
 * 优先 config.agent，其次 preset 目录名（config.dir），再次 agent.id。
 */
export function resolveAgentId(config = {}, agent) {
  if (typeof config.agent === 'string' && config.agent.trim() !== '') return config.agent.trim()
  if (typeof config.dir === 'string' && config.dir.trim() !== '') return basename(resolve(config.dir))
  const id = agent?.id
  if (typeof id === 'string' && id.trim() !== '') return id.trim()
  return '临时智能体'
}

/** 调用方当前工作目录（用于 `项目` 列与置顶判断）。 */
export function cwdOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}

/** 当前工作区文件夹名（`项目` 列的默认值）。 */
export function projectName(cwd) {
  return cwd === undefined ? '' : basename(resolve(cwd))
}
