// store.mjs —— 定位记忆库、载入字典、取用「一份逻辑」（core）
//
// 定位规则（从宽到窄）：
//   1. 环境变量 DSH_TAG_MEMORY_SKILL_DIR
//   2. <DSH_HOME>/skills/marsma101-tag-memory
// DSH_HOME：环境变量 DSH_HOME，否则 <USERPROFILE|HOME>/.dsh。
//
// 这里**不重写任何读写逻辑**：字典是库里的 references/tags.schema.json，读/写/筛是库里的
// scripts/lib/core.mjs。插件只做 DSH 这一层壳，命令行与界面走的是同一份实现。

import { readFileSync, existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''

/** DSH 家目录（环境变量 `DSH_HOME`，默认 `~/.dsh`）。 */
export const DSH_HOME =
  process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(HOME, '.dsh')

/** 记忆库目录名。 */
export const SKILL_NAME = 'marsma101-tag-memory'

/** 记忆库目录。 */
export const SKILL_DIR =
  process.env.DSH_TAG_MEMORY_SKILL_DIR && process.env.DSH_TAG_MEMORY_SKILL_DIR.trim() !== ''
    ? process.env.DSH_TAG_MEMORY_SKILL_DIR.trim()
    : join(DSH_HOME, 'skills', SKILL_NAME)

/** 智能体档案根：`<DSH_HOME>/.agent-presets`。notice 自愈就在这底下找 MEMORY.md。 */
export const PRESET_ROOT = join(DSH_HOME, '.agent-presets')

export const SCHEMA_PATH = join(SKILL_DIR, 'references', 'tags.schema.json')
export const STORE_DIR = join(SKILL_DIR, 'store')
export const CSV_PATH = join(STORE_DIR, 'memory.csv')
export const INDEX_PATH = join(STORE_DIR, 'index.md')
export const BACKUP_CFG_PATH = join(STORE_DIR, 'backup.json')
export const LOCK_PATH = join(STORE_DIR, '.append.lock')
const CORE_PATH = join(SKILL_DIR, 'scripts', 'lib', 'core.mjs')
const BACKUP_CORE_PATH = join(SKILL_DIR, 'scripts', 'lib', 'backup.mjs')

// ── 字典 ────────────────────────────────────────────────

let _schema
/** 同步载入字典（缓存）。section 的文本函数必须同步，所以这里不用动态 import。 */
export function loadSchema() {
  if (_schema) return _schema
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`找不到标签字典：${SCHEMA_PATH}（记忆库是否已就位？可用 DSH_TAG_MEMORY_SKILL_DIR 指定它的位置）`)
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
