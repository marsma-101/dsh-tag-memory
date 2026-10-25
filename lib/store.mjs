// store.mjs —— 定位数据目录、载入字典、取用「一份逻辑」（core）
//
// 这个插件**不再依赖任何外部技能目录**。两件事分开：
//
//   引擎（代码 + 出厂模板）＝ 插件包内 `lib/engine/`，由 `import.meta.url` 推算。
//        core.mjs / backup.mjs / tags.schema.json / templates/*
//        随插件走、随插件升级；**不读、不写**插件目录以外的引擎副本。
//
//   数据（用户自己的记忆库）＝ 独立目录，插件升级 / 重装都不该碰它。
//        推断链：`config.dataDir` → 环境变量 `DSH_TAG_MEMORY_DATA_DIR`
//                →（兼容旧名）`DSH_TAG_MEMORY_SKILL_DIR` → `<DSH_HOME>/tag-memory`
//
// 目录长这样：
//   <DATA_DIR>/store/memory.csv      记忆库本体（一行一条）
//   <DATA_DIR>/store/index.md        索引
//   <DATA_DIR>/store/backup.json     备份配置 + 水位
//   <DATA_DIR>/store/.append.lock    写锁
//   <DATA_DIR>/references/tags.schema.json   **这份库**用的字典（首次建库时从引擎拷一份）
//
// 字典放数据目录、不放引擎：备份 / 恢复要连字典一起走（`backup.mjs` 按 `store/../references/`
// 找它），恢复时还要把它换回旧版。引擎那份是**出厂样张**，盘上这份是**正在用的那一本**。
//
// DSH_HOME：环境变量 DSH_HOME，否则 <USERPROFILE|HOME>/.dsh。
//
// 这里**不重写任何读写逻辑**：读/写/筛是 `lib/engine/core.mjs`，备份是 `lib/engine/backup.mjs`。
// 插件只做 DSH 这一层壳，命令行与界面走的是同一份实现。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { snapshotOrThrow } from './engine/snapshot.mjs'
import { createRequire } from 'node:module'

const requireHere = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''

/** DSH 家目录（环境变量 `DSH_HOME`，默认 `~/.dsh`）。 */
export const DSH_HOME =
  process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(HOME, '.dsh')

// ── 引擎：插件包内，随插件走 ──────────────────────────────

/** 引擎目录：`<插件包>/lib/engine/`。与任何技能目录无关。 */
export const ENGINE_DIR = join(HERE, 'engine')
/** 出厂模板目录。首次建库从这儿取表头 / 索引 / 备份配置。 */
export const TEMPLATES_DIR = join(ENGINE_DIR, 'templates')
/** 出厂字典（**样张**；盘上正在用的那份在数据目录里）。 */
export const ENGINE_SCHEMA_PATH = join(ENGINE_DIR, 'tags.schema.json')
/** 读写核心与备份核心（同一目录，`backup.mjs` 里 `import './core.mjs'` 才成立）。 */
const CORE_PATH = join(ENGINE_DIR, 'core.mjs')
const BACKUP_CORE_PATH = join(ENGINE_DIR, 'backup.mjs')

// ── 数据：独立目录，插件升级不碰 ──────────────────────────

/** 老版本的库位置（只用于**只读**探测与提示，绝不写、绝不自动搬）。 */
export const LEGACY_SKILL_NAME = 'marsma101-tag-memory'
/** @deprecated 旧名，保留给还引用它的地方；新代码请用 `LEGACY_SKILL_NAME`。 */
export const SKILL_NAME = LEGACY_SKILL_NAME
/** 老位置：`<DSH_HOME>/skills/marsma101-tag-memory`。 */
export const LEGACY_DIR = join(DSH_HOME, 'skills', LEGACY_SKILL_NAME)
/** 老库本体：`<DSH_HOME>/skills/marsma101-tag-memory/store/memory.csv`。 */
export const LEGACY_CSV_PATH = join(LEGACY_DIR, 'store', 'memory.csv')

/**
 * 数据目录的推断链：
 *   `config.dataDir` → `DSH_TAG_MEMORY_DATA_DIR` →（兼容旧名）`DSH_TAG_MEMORY_SKILL_DIR`
 *   → `<DSH_HOME>/tag-memory`
 *
 * 旧名 `DSH_TAG_MEMORY_SKILL_DIR` 仍当**数据目录**认：老安装产物与 selftest 都还在用它，
 * 而且它当年指的就是「库在哪」——语义没变，只是名字里不该再有「技能」。
 */
/**
 * 推断链的**默认**数据目录（不带任何显式值）：`<DSH_HOME>/tag-memory`。
 *
 * `ensureStore()` 拿它当「该不该自动建库」的分界：等于它 = 本来就没有、可以建；
 * 不等于它 = 用户指到别处、目录不在就是配错了，报错不建。
 */
export function defaultDataDir() {
  return join(DSH_HOME, 'tag-memory')
}

export function resolveDataDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())
  for (const key of ['DSH_TAG_MEMORY_DATA_DIR', 'DSH_TAG_MEMORY_SKILL_DIR']) {
    const env = process.env[key]
    if (env !== undefined && env.trim() !== '') return resolve(env.trim())
  }
  return join(DSH_HOME, 'tag-memory')
}

/** @deprecated 旧名别名，等价于 `resolveDataDir`。 */
export function resolveLibraryDir(explicit) {
  return resolveDataDir(explicit)
}

let _dir = resolveDataDir()

/**
 * 智能体档案根 —— notice 自愈就在这底下找 `MEMORY.md`。
 *
 * **DSH 0.2.x 的实际位置是 `~/.agents`**（官方 `@deepseek-ai/dsh-home-paths` 的
 * `AGENTS_HOME_DIR_NAME = '.agents'`，可用环境变量 `DSH_AGENTS_HOME` 覆盖）。
 * 老版本用过 `<DSH_HOME>/.agent-presets`，这里作为**回退**保留：两处都没有时
 * 用新位置（`.agents`），这样界面能明确报「托管未生效」，而不是对着一个
 * 根本不存在的目录假装自愈过了。
 *
 * 之前写死 `.agent-presets` 的后果（问题单 P1-2）：本机 `notice.files` 恒为空，
 * 界面显示 `0/0 记忆文件已托管`，`install --check` 还报 PASS —— 功能等于没跑。
 */
function resolvePresetRoot() {
  const override = process.env.DSH_AGENTS_HOME
  if (override !== undefined && override.trim() !== '') return resolve(override.trim())
  const modern = join(HOME, '.agents')
  const legacy = join(DSH_HOME, '.agent-presets')
  if (existsSync(modern)) return modern
  if (existsSync(legacy)) return legacy
  return modern // 都没有 → 报新位置（界面据此说「没找到记忆文件」）
}

export const PRESET_ROOT = resolvePresetRoot()

// 数据目录底下的那几个路径。**是 let、不是 const**：换目录时当场重算，
// ESM 的活绑定会让 import 过它们的模块读到新值。不换目录时一个字节都不变。
export let DATA_DIR = _dir
/** @deprecated 旧名别名（与 `DATA_DIR` 同值），只为漏改处不崩。 */
export let SKILL_DIR = _dir
export let REFERENCES_DIR = join(_dir, 'references')
export let SCHEMA_PATH = join(REFERENCES_DIR, 'tags.schema.json')
export let STORE_DIR = join(_dir, 'store')
export let CSV_PATH = join(STORE_DIR, 'memory.csv')
export let INDEX_PATH = join(STORE_DIR, 'index.md')
export let BACKUP_CFG_PATH = join(STORE_DIR, 'backup.json')
export let LOCK_PATH = join(STORE_DIR, '.append.lock')
/** 强化/验证日志（O-10=R1 追加式账本）。**不是** memory.csv 的一部分，是它的旁路账。 */
export let REINFORCE_LOG_PATH = join(STORE_DIR, 'reinforce.log')
/** 写前快照目录（S-防-2）。固定落点，不依赖备份地址。 */
export let SNAPSHOT_DIR = join(STORE_DIR, 'snapshots')

/** 按 _dir 重算上面那一串路径（换数据目录时用）。 */
function derivePaths() {
  DATA_DIR = _dir
  SKILL_DIR = _dir
  REFERENCES_DIR = join(_dir, 'references')
  SCHEMA_PATH = join(REFERENCES_DIR, 'tags.schema.json')
  STORE_DIR = join(_dir, 'store')
  CSV_PATH = join(STORE_DIR, 'memory.csv')
  INDEX_PATH = join(STORE_DIR, 'index.md')
  BACKUP_CFG_PATH = join(STORE_DIR, 'backup.json')
  LOCK_PATH = join(STORE_DIR, '.append.lock')
  REINFORCE_LOG_PATH = join(STORE_DIR, 'reinforce.log')
  SNAPSHOT_DIR = join(STORE_DIR, 'snapshots')
}

// ── 首次启动建库（只在新目录、空库时做）──────────────────

/**
 * 这个数据目录能不能算「全新的空库」。
 *
 * 判据是**只看不写**：库里已经有 `store/memory.csv` → 一律不算（已有库一个字节不动）；
 * `store/` 存在但里面已经有东西（哪怕是别的名字）→ 也不算，宁可不建。
 */
function storeIsPristine() {
  if (existsSync(CSV_PATH)) return false
  if (existsSync(STORE_DIR)) {
    try { if (readdirSync(STORE_DIR).length > 0) return false } catch { return false }
  }
  return true
}

/**
 * 当前目录是否来自**显式配置**，以及那个显式值。
 * （声明提到这里：`ensureStore()` 要用它判断「目录不存在时该不该报错」，
 * 而 ensureStore 在文件下方就会被调用，不能等到声明处才有值。）
 */
let _explicitValue = null
let _explicitSource = ''

/** 最近一次自动建库的结果（界面 / install 自检照实报出来，不装作没发生）。 */
let _init = { attempted: false, created: false, dir: '', files: [], error: null, explicitMissing: false }
export function initInfo() { return { ..._init } }

const TEMPLATE_FILES = [
  ['memory.csv', (d) => join(d, 'store', 'memory.csv')],
  ['index.md', (d) => join(d, 'store', 'index.md')],
  ['backup.json', (d) => join(d, 'store', 'backup.json')],
]

/**
 * 显式配的数据目录**不存在**时的拒绝话术（P2-13 / V2-c）。
 *
 * 为什么不静默建：用户把 `dataDir` 指到一个目录，意思是「我的库在这儿」。
 * 那个目录不在，说明要么路径写错、要么库被挪走/删了、要么换了机器还没拷过来。
 * 这时候**建一本空库**最坏——插件会精神抖擞地跑起来，用户以为老记忆都在，
 * 其实是空库在记账，等到发现时已经写进去一堆新条目，再想分辨哪些是新的就难了。
 * 所以：报错 + 给修法，宁可不启动。
 *
 * 注意**只对显式配置生效**：默认路径（`<DSH_HOME>/tag-memory`）首次启动照旧自动建库，
 * 那是「本来就没有」，不是「配错了」。
 */
function explicitDirMissingError(dir) {
  const err = new Error(
    `数据目录不存在：${dir}。\n`
    + '这是**显式配置**（config.dataDir / 环境变量 DSH_TAG_MEMORY_DATA_DIR）指的目录，'
    + '插件没有替你建——建一本空库会让它看起来正常，其实老记忆一条都不在里面。\n'
    + '修法三选一：\n'
    + `  ① 路径写错了 → 改成正确的；\n`
    + `  ② 库在别处/换了机器 → 把原来那份拷到 ${dir}；\n`
    + `  ③ 确实要在这里开新库 → 先把目录建出来（mkdir -p "${dir}"），再启动；`
    + '空目录会自动按模板建库。',
  )
  err.code = 'TAG_MEMORY_DATA_DIR_MISSING'
  err.dataDir = dir
  return err
}

/**
 * 数据目录不存在（或存在但是空库）时，用插件自带的模板把库起出来。
 *
 * **只在新目录、空库时做**；已有库一个字节不动。建库失败**不抛**——留给 `ready()`
 * 照实说 false，界面出降级提示，而不是让整个插件装载失败。
 *
 * **显式配置的目录不存在时例外**：不建库、记下错误（见 `explicitDirMissingError`）。
 *
 * 字典也在这里落一份到 `<DATA_DIR>/references/tags.schema.json`：
 * 备份 / 恢复要连字典一起走（`backup.mjs` 按 `store/../references/` 找它），
 * 而插件包内那份是**出厂样张**，不该被「恢复旧备份」改写。
 */
export function ensureStore() {
  _init = { attempted: true, created: false, dir: _dir, files: [], error: null, explicitMissing: false }
  try {
    // 目录不存在时分两种，判据是「这个路径是不是推断出来的默认值」：
    //   · 默认路径（`<DSH_HOME>/tag-memory`）→ 本来就没有，照旧按模板建库（正控）；
    //   · 显式给的路径（config.dataDir / 环境变量 / setDataDir）→ 报错不建（P2-13）。
    // 判据不能只看 `_explicitValue`：环境变量 `DSH_TAG_MEMORY_DATA_DIR` 也是用户显式指的，
    // 但它走的是 `resolveDataDir()` 推断链，`_explicitValue` 一直是 null——实测会漏判。
    if (!existsSync(_dir) && _dir !== defaultDataDir()) {
      const err = explicitDirMissingError(_dir)
      _init = { attempted: true, created: false, dir: _dir, files: [], error: err.message, explicitMissing: true }
      // 装载期要**当场抛**（不是记一笔就算）：静默降级等于让插件带着一本不存在的库跑。
      throw err
    }
    if (!storeIsPristine()) return false
    // **先看老库**：老位置还有一本、而新目录是空的时候，**不建空库**。
    // 建了会怎样：插件悄悄用一本空库跑起来，用户的老记忆「不见了」——这比报错更糟。
    // 所以这里停手，交给 `legacyInfo()` 在界面上说「检测到旧库，可迁移」，由用户点头再搬。
    if (existsSync(LEGACY_CSV_PATH)) {
      _init = { attempted: true, created: false, dir: _dir, files: [], error: null, legacySkipped: true }
      return false
    }
    mkdirSync(STORE_DIR, { recursive: true })
    mkdirSync(REFERENCES_DIR, { recursive: true })
    const written = []
    for (const [name, target] of TEMPLATE_FILES) {
      const src = join(TEMPLATES_DIR, name)
      const dst = target(_dir)
      if (existsSync(dst)) continue
      if (!existsSync(src)) continue // 模板缺了就跳过：建不齐就让 ready() 说话
      writeFileSync(dst, readFileSync(src))
      written.push(name)
    }
    if (!existsSync(SCHEMA_PATH) && existsSync(ENGINE_SCHEMA_PATH)) {
      writeFileSync(SCHEMA_PATH, readFileSync(ENGINE_SCHEMA_PATH))
      written.push('tags.schema.json')
    }
    _init = { attempted: true, created: written.length > 0, dir: _dir, files: written, error: null, legacySkipped: false }
    return written.length > 0
  } catch (e) {
    // 显式目录不存在 → **必须往外抛**：这一条是「配错了」，不是「建库没建起来」。
    // 吞掉它就会变成「插件带着一本不存在的库跑起来」，正是 P2-13 要防的那种静默。
    // 其余失败（模板缺失、目录不可写…）仍按老规矩降级成 ready()=false，由界面提示。
    if (e?.code === 'TAG_MEMORY_DATA_DIR_MISSING') throw e
    _init = { attempted: true, created: false, dir: _dir, files: [], error: String(e?.message ?? e), legacySkipped: false }
    return false
  }
}

// ── 旧库兼容（只读探测，不搬）────────────────────────────

/**
 * 新数据目录里没有库、但**老位置**还有一本时，照实报出来。
 *
 * **只读不写**：这里一个字节都不往老库上落，也不自动搬。搬库是用户点头之后的事
 * （把老目录整个拷过来，或把 `dataDir` 指过去），插件不替他做主。
 */
export function legacyInfo() {
  const freshMissing = !existsSync(CSV_PATH)
  const legacyExists = existsSync(LEGACY_CSV_PATH)
  return {
    legacyDetected: freshMissing && legacyExists,
    legacyDir: LEGACY_DIR,
    legacyCsvPath: LEGACY_CSV_PATH,
    legacyExists,
    dataDir: _dir,
    csvPath: CSV_PATH,
  }
}
/** @deprecated 旧名别名。 */
export function legacyDetected() { return legacyInfo().legacyDetected }

// ── 字典 ────────────────────────────────────────────────

let _schema
/** 同步载入字典（缓存）。section 的文本函数必须同步，所以这里不用动态 import。 */
export function loadSchema() {
  if (_schema) return _schema
  // 盘上这份（数据目录）优先；数据目录还没建字典时退回插件自带的样张——
  // 这样「引擎内置」在字典上也成立：哪怕库还没建，字典段也能照常注入。
  const path = existsSync(SCHEMA_PATH) ? SCHEMA_PATH : (existsSync(ENGINE_SCHEMA_PATH) ? ENGINE_SCHEMA_PATH : '')
  if (path === '') {
    throw new Error(`找不到标签字典：${SCHEMA_PATH}（插件包内的 ${ENGINE_SCHEMA_PATH} 也不在——安装是否完整？）`)
  }
  _schema = JSON.parse(readFileSync(path, 'utf8'))
  return _schema
}

/**
 * 把字典缓存丢掉，下次 `loadSchema()` 重新读盘。
 *
 * 什么时候需要：**盘上的字典被换掉了，而这个进程还活着**——目前只有一处，
 * 「恢复备份」把 `references/tags.schema.json` 一起换回旧版。
 * 不丢缓存的话，界面显示了新字典、注入用的还是老字典，又是一次「看着成功、其实没生效」。
 */
export function reloadSchema() {
  _schema = undefined
}

// ── 读取缓存（M-读-3 / V4-c）────────────────────────────
//
// 每轮注入的快照、每次召回、每次界面取数，都要把整本 CSV 读进来再解析。
// 库没变的时候这是纯浪费——一个 1000 条的库，一次解析就够，却可能一秒解析几十次。
//
// 判据是 **mtime + size**：两个都没变就复用上一次的解析结果。
// 为什么两个都要：只比 mtime，某些文件系统（或同一毫秒内的两次写）mtime 精度不够；
// 只比 size，内容改了但长度没变（比如一个字符换一个字符）会读到旧数据。
// 两个一起比，误判概率极低，而且**失效只会变慢、不会读错**（见下面的 `statSync` 失败处理）。
//
// **缓存只缓存「解析结果」，不缓存「筛选结果」**：条件每次都不同，缓存筛选结果
// 既占内存又容易读到过期语义（比如刚取代完，旧条应该退场了）。

const _tableCache = new Map()

/**
 * 读 CSV 并解析，带 mtime+size 缓存。**返回共享对象，调用方不要改它**。
 *
 * @param {string} csvPath
 * @param {object} core  读写核心（`readTable` / `legacyWidthOf` 从它取）
 * @param {object} schema
 * @returns {{header:string[], rows:any[][], ragged:any[], legacyTail:any[], cached:boolean}}
 */
export function readTableCached(csvPath, core, schema) {
  let st = null
  try { st = statSync(csvPath) } catch {
    // 文件不在 / 读不到 → **不缓存**，直接走原路（让调用方拿到它该拿的错）。
    return { ...core.readTable(readFileSync(csvPath, 'utf8'), core.legacyWidthOf(schema)), cached: false }
  }
  const key = resolve(csvPath)
  const stamp = `${st.mtimeMs}:${st.size}`
  const hit = _tableCache.get(key)
  if (hit !== undefined && hit.stamp === stamp) {
    _cacheStats.hits++
    return { ...hit.table, cached: true }
  }
  _cacheStats.misses++
  const table = core.readTable(readFileSync(csvPath, 'utf8'), core.legacyWidthOf(schema))
  _tableCache.set(key, { stamp, table })
  return { ...table, cached: false }
}

/**
 * 缓存现状（自检 / 诊断用）。
 *
 * `hits` 是**命中次数**——用例要能「可观测地」证明缓存真的生效，
 * 光断「两次结果一样」是不够的（不缓存也两次一样）。
 */
let _cacheStats = { hits: 0, misses: 0 }
export function cacheStats() { return { ..._cacheStats } }

/** 把缓存丢掉（库被外部改了、或换了数据目录时用）。 */
export function invalidateCache() { _tableCache.clear() }

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

// 首次启动建库放在核心载入之后：引擎在不在、能不能读，先有个结论再动盘。
ensureStore()
// 表头迁移放在建库之后、ready() 之前：新库本来就 21 列（不需要迁），
// 老库才会真的走一次「快照 + 升表头」。失败不抛——见 ensureMigrated 的注释。
const _migration = ensureMigrated()

/** 数据目录是否就绪（工具据此给出可读的降级提示，而不是抛栈）。 */
/**
 * 表头迁移接线（P1-1，2026-10-25）。
 *
 * 0.3.0 给 CSV 加了 4 列（强度/最后强化/已验证项目/使用次数），但**老库的表头还是 17 列**。
 * `readTable` 的末尾缺列容忍让老库**能读**，可 `buildLine` 是按**磁盘上那份表头**拼行的——
 * 表头没有那 4 列，新写入的值就落不了盘（读的时候再补默认值，永远是 1/空/0）。
 * 所以「能读」和「能写新列」是两件事，必须在启动时把表头升上去。
 *
 * 三步，顺序不能变：**检测 → 快照 → 迁移**。
 *   · 检测用 `headerMigrationNeeded`（表头缺列才动，不缺就什么都不做）；
 *   · 快照是硬要求：改表头虽然只动第 1 行，但那是「动库」，改坏了没档可回就是事故；
 *   · 迁移本身幂等（`migrateHeader` 发现已经是最新就不写盘）。
 *
 * **失败不阻断启动**：迁移失败（磁盘满、权限不对）只记一笔，让 `ready()` 照实报状态。
 * 理由是「库还能读、写入也还能用（只是新列落不了盘）」比「整个插件起不来」好得多。
 *
 * @returns {{ checked: boolean, needed: boolean, migrated: boolean, snapshot: string, error: string }}
 */
export function ensureMigrated() {
  const out = { checked: false, needed: false, migrated: false, snapshot: '', error: '' }
  if (_core === null || !existsSync(CSV_PATH) || !existsSync(SCHEMA_PATH)) return out
  try {
    const schema = loadSchema()
    const text = readFileSync(CSV_PATH, 'utf8')
    const { header } = _core.readTable(text, _core.legacyWidthOf(schema))
    const need = _core.headerMigrationNeeded(schema, header)
    out.checked = true
    out.needed = need.needed
    if (!need.needed) return out

    // 快照先落（改库之前）。快照目录就是 `<store>/snapshots/`。
    const snap = snapshotOrThrow(
      { storeDir: STORE_DIR, csvPath: CSV_PATH, label: `表头迁移 ${header.length}→${schema.storage.header.length} 列` },
      '表头迁移',
    )
    out.snapshot = snap.name
    const mig = _core.migrateHeader({ schema, csvPath: CSV_PATH, lockPath: LOCK_PATH })
    out.migrated = mig.ok === true && mig.changed === true
    if (!mig.ok) out.error = mig.error
    return out
  } catch (e) {
    out.error = String(e?.message ?? e)
    return out
  }
}

/** 最近一次表头迁移的结果（界面 / 自检照实报出来）。 */
export function migrationInfo() { return { ..._migration } }

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
 * 备份核心（和插件自带的引擎共用同一份）。
 * 界面上的「立即备份」走这里，所以界面和命令行的行为永远一致。
 */
export function getBackupCore() {
  if (_backup === null) {
    throw new Error(`备份核心未加载：${BACKUP_CORE_PATH}\n${_backupError?.message ?? ''}`)
  }
  return _backup
}

/** 备份功能是否可用（引擎缺件时界面显示成「不可用」而不是崩）。 */
export function backupReady() {
  return _backup !== null && existsSync(CSV_PATH)
}

// ── 换数据目录（config.dataDir）──────────────────────────

/**
 * 「库目录换了，但这份 Node 不能同步重载核心」——**这一版起不会再出现**：
 * 核心在插件包内，换数据目录不影响它，所以永远是 false。
 * 保留这个导出只是为了让 `index.js` 的 `overview` 与界面不必大改。
 */
export function coreStale() { return false }

/**
 * 当前目录是否来自**显式配置**，以及那个显式值。
 *
 * 非 `null` 即「已由显式配置设定」（相当于需求里说的 `_explicitlySet` 标记）。
 * 为什么需要它：`dataDir` 有两处配置——host 行（`index.js`）与 preset 行（`preset.js`），
 * 两半各自 `apply()` 一次。以前「没配」的那一侧也走推断链，于是 preset 行没配时，
 * 它一 `apply()` 就把 host 行配好的目录**悄悄重置回默认**——不报错，还可能读写到另一本旧库上。
 * `_explicitSource` 只用于冲突报错时说清是哪一侧配的（'host 行' / 'preset 行'）。
 */

/** 把配置里的值规范成「显式目录」；不是字符串 / 全是空白 → `''`（＝**没给**）。 */
function explicitDirOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? resolve(value.trim()) : ''
}

/** 真的换到 `next`：重算路径、丢字典缓存、空目录当场建库。返回是否换了。 */
function adoptDir(next) {
  if (next === _dir) return false
  const prev = _dir
  _dir = next
  derivePaths()
  _schema = undefined // 字典是数据目录里的，换了目录必须重新读
  _tableCache.clear() // 缓存是按路径存的，换了目录不能留着旧库的解析结果
  try {
    ensureStore()
  } catch (e) {
    // 换目录失败（显式目录不存在）→ **回滚到换之前的目录**，再把错抛出去。
    // 不回滚的话，进程会停在一个不存在的库路径上：后续每个 `ready()` 都是 false，
    // 界面上「数据目录」显示的是那个坏路径，人以为库被搬走了——而它其实好好的。
    _dir = prev
    derivePaths()
    _schema = undefined
    throw e
  }
  return true
}

/**
 * 换数据目录。返回是否真的换了。
 *
 * 换了只重算路径、丢字典缓存；**核心不重载**——它跟着插件走，与数据目录无关。
 * 新目录是空的话，当场按模板起库（与首次启动同一条路）。
 *
 * 三种情形（这是 P0-1 的修法）：
 *   ① **没给**（`undefined` / `null` / 空白串）→ 不覆盖已经由显式配置定下的目录，直接返回 false；
 *      还没人显式配过时才走原来的推断链（保持首启行为）。
 *      ⚠️ `resolveDataDir()` 的「空就往下推断」语义**原样不动**——它是首次初始化用的。
 *   ② **给了、且与已生效的显式值相同** → 幂等，返回 false（同一侧重复 apply 不报错）。
 *   ③ **给了、但与已生效的显式值不同** → 两处配置打架，**当场抛错**，不「后到者赢」。
 *      同一侧（`source` 相同且非空）改配置不算冲突：那是重新配置，以新值为准。
 *
 * @param {unknown} explicit `config.dataDir ?? config.libraryDir`
 * @param {string} [source] 这一侧的称呼（`'host 行'` / `'preset 行'`），只用于冲突报错
 */
export function setDataDir(explicit, source = '') {
  const wanted = explicitDirOf(explicit)
  const side = typeof source === 'string' ? source.trim() : ''

  // ① 没给：不把已显式配好的目录重置回推断链的结果
  if (wanted === '') {
    if (_explicitValue !== null) return false
    return adoptDir(resolveDataDir())
  }

  // ③ 与已生效的显式值不同 → 冲突（同一侧重新配置除外）
  //    `source` 两处都报了、且不同 → 才算「两半打架」。都没报（脚本 / 测试直接调用）
  //    就维持老语义「后到者赢」——那时没有第二处配置可打架，报错只会伤到老用法。
  if (_explicitValue !== null && wanted !== _explicitValue) {
    const bothDeclared = side !== '' && _explicitSource !== ''
    if (bothDeclared && side !== _explicitSource) {
      const err = new Error(
        `数据目录冲突：${_explicitSource}配的是「${_explicitValue}」，`
        + `${side}配的是「${wanted}」。两处必须一致，或只配一处。`,
      )
      err.code = 'TAG_MEMORY_DATA_DIR_CONFLICT'
      err.effectiveDir = _explicitValue
      err.incomingDir = wanted
      throw err
    }
  }

  // ② 记下这个显式值（同值时也算「已由显式配置设定」）
  _explicitValue = wanted
  _explicitSource = side
  return adoptDir(wanted)
}

/** @deprecated 旧名别名（配置字段当年叫 `libraryDir`）。 */
export function setLibraryDir(explicit, source = '') {
  return setDataDir(explicit, source)
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
