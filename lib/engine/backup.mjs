// backup.mjs（lib）—— 备份的「一份逻辑」
//
// 技能 CLI（scripts/backup.mjs）和 DSH 插件（dsh-tag-memory）共用这一份：
//   · CLI  = 薄壳，解析 --label / --dir 后调 runBackup()
//   · 插件  = GET /tag-memory-api/backup 调 readBackupStatus()，POST 调 runBackup()
// 这样「界面点的备份」和「命令行敲的备份」走的是同一条代码路径，不会各写一套。
//
// 备份哪四个：store/index.md、store/memory.csv、store/backup.json、
//             references/tags.schema.json（**字典**——见下面那条注释）
// 备份到哪：store/backup.json 的 backupDir。**没有默认目录**——没设就是没备份，
//           由调用方决定是提示还是弹设置（界面是「降级成设置备份地址」）。
// 校验四项：字节数一致 + SHA-256 一致 + 解析器数出的记录数一致 + 副本无 BOM。
//           验不过 → 抛错，**不更新水位**（下次还会提醒你备份）。
//
// 为什么字典也要备：**字典是解释这份库的那本说明书**——取值、必填、留白算不算数，全由它定。
// 库和字典版本错位，恢复完就会出现「表里有个值，字典里没有这个词」（越界行）。
// 两套库已经因为 `类型` 列分叉过一次，所以字典跟库**一起走**。
// 恢复时要不要连字典一起换回去，是调用方的决定（本文件只负责**备**好它）。

import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync,
  readdirSync, unlinkSync, appendFileSync, statSync, statfsSync, accessSync,
} from 'node:fs'
import { constants as FS } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { parseCSV } from './core.mjs'

/**
 * 备份的三件套：store 里的原名 → 备份文件名的词干。
 * `identity: true` 的是「这套库」的身份证——同戳撞车只认它们：
 *   · memory.csv / index.md 同戳且内容不同 ⇒ 目录里躺的是**另一套库**，硬写会互相覆盖；
 *   · backup.json 每次备份后水位都会变，天然逐次不同，拿它判撞车会误报（同一分钟内连备两次必中）。
 */
export const BACKUP_FILES = [
  { src: 'memory.csv', stem: 'memory', ext: 'csv', identity: true },
  { src: 'index.md', stem: 'index', ext: 'md', identity: true },
  { src: 'backup.json', stem: 'backup', ext: 'json', identity: false },
  // 字典在 store 的**上一级**（`<技能>/references/`），所以多一个 `up` 说它往上走几层。
  // `identity: false`：字典不参与「同戳撞车」判定——同一个戳上字典该不该重写，
  // 由 memory.csv / index.md 那两条身份证决定（字典是它们的说明书，不是另一套库的标志）。
  { src: 'tags.schema.json', stem: 'schema', ext: 'json', identity: false, up: 1, dir: 'references' },
  // 强化/验证日志（O-10=R1 的追加式账本，O-13 拍板进备份）。
  // **必须跟着库走**：日志里记着「哪条被用过几次、在哪些项目验证过」，
  // 恢复库却不恢复日志 → 所有强化记录凭空消失，强度退回 1、晋升候选全部作废。
  // `identity: false`：它不是「这套库的身份证」，同戳撞车由 memory.csv/index.md 判。
  // 源文件不存在时会被 `plansOf` 自动跳过（并记进 `skipped`），所以老库没有这个日志也能备份。
  { src: 'reinforce.log', stem: 'reinforce', ext: 'log', identity: false },
]

/** 这一件东西**在盘上的实际路径**（`up` 是「从 store 目录往上几层」）。 */
export function sourcePathOf(storeDir, f) {
  const base = f.up === undefined || f.up === 0 ? storeDir : join(storeDir, ...Array(f.up).fill('..'))
  return f.dir === undefined ? join(base, f.src) : join(base, f.dir, f.src)
}

/**
 * 一份备份的戳：`YYYYMMDD-HHMMSS`（到秒）。
 * 到秒不是洁癖：恢复的第一步是「先把现在这一版留档」，紧接着才换文件——
 * 只到分钟的话，这两件事必然撞同一个文件名，留档会**把你要恢复的那一份覆盖掉**。
 * 老备份是 4 位（`YYYYMMDD-HHMM`），所以两条正则都收 4~6 位时间，轮转照旧能认出它们。
 */
export const STAMP_RE = /^\d{8}-\d{4,6}$/
const MEM_RE = /^memory-(\d{8}-\d{4,6})\.csv$/

/** 备份还没设地址时的错。调用方（界面 / CLI）按这个码决定说什么。 */
export class BackupNoDirError extends Error {
  constructor() { super('还没有设置备份地址'); this.code = 'NO_DIR' }
}
/** 备份校验没过（拷完比对不通过）。不更新水位。 */
export class BackupVerifyError extends Error {
  constructor(checks) { super('备份校验没过——不更新水位'); this.code = 'VERIFY'; this.checks = checks }
}
/**
 * 同一个戳上已经躺着**内容不一样**的文件，且往后挪也腾不出位置。
 * 正常永远碰不到（戳到秒、且会自动往后挪）；碰到说明目录里乱得不太对劲。
 */
export class BackupConflictError extends Error {
  constructor(names) { super('备份地址里同名的文件内容对不上，腾不出位置'); this.code = 'CONFLICT'; this.names = names }
}

// ── 小工具 ──────────────────────────────────────────────

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const hasBOM = (p) => {
  const b = readFileSync(p)
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
}

/** 字典自己声明的版本号（`version` 字段）。读不出来就给空串——不装作知道。 */
export function schemaVersionOf(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return typeof v?.version === 'string' ? v.version : ''
  } catch { return '' }
}

/** 用 CSV 解析器数记录数（不数换行——单元格里可以有换行）。 */
export function countEntries(csvText) {
  return parseCSV(csvText).slice(1).filter((r) => r[0] && String(r[0]).trim()).length
}

/**
 * 本地时间 ISO 串，保留**真实时区偏移**。
 * 不能拿 `toISOString()` 去硬贴 `+08:00`——那串是 UTC，贴上去等于把时间写早 8 小时。
 */
export function localIsoTimestamp(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`
    + `T${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`
    + `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
}

/** 打戳（本地时间，到秒）。传入 now 便于测试。 */
export function stampOf(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

// ── 配置 ────────────────────────────────────────────────

export function configPathOf(storeDir) { return join(storeDir, 'backup.json') }

/** 读 store/backup.json。不抛：缺文件 / JSON 坏了都给个空的，让状态显示成「没配」。 */
export function readBackupConfig(storeDir) {
  const path = configPathOf(storeDir)
  if (!existsSync(path)) return { path, exists: false, config: {}, broken: false }
  try {
    return { path, exists: true, config: JSON.parse(readFileSync(path, 'utf8')), broken: false }
  } catch {
    return { path, exists: true, config: {}, broken: true }
  }
}

/** 备份地址（去空白）。没有默认——空串就是「没设」。 */
export function backupDirOf(config) {
  return typeof config?.backupDir === 'string' ? config.backupDir.trim() : ''
}

// ── 状态（只读，界面每次进来都调）────────────────────────

/**
 * 备份现状。只读，不创建任何东西。
 * @returns {{dirSet:boolean, dir:string, dirExists:boolean, dirWritable:boolean, freeBytes:number|null,
 *            lastBackupAt:string, lastCount:number|null, currentCount:number, delta:number|null,
 *            copies:number, totalBytes:number, recent:Array, log:Array, due:boolean, dueReason:string[],
 *            staleDays:number, promptEveryEntries:number, keepCopies:number, storeDir:string, configPath:string}}
 */
export function readBackupStatus(storeDir, opts = {}) {
  const recentLimit = Number.isFinite(opts.recent) ? Number(opts.recent) : 5
  const { path: configPath, config, exists: configExists, broken } = readBackupConfig(storeDir)
  const dir = backupDirOf(config)

  const csvPath = join(storeDir, 'memory.csv')
  const currentCount = existsSync(csvPath) ? countEntries(readFileSync(csvPath, 'utf8')) : 0

  const lastBackupAt = typeof config.lastBackupAt === 'string' ? config.lastBackupAt : ''
  const lastCount = Number.isFinite(config.lastCount) ? config.lastCount : null
  const staleDays = Number(config.staleDays) > 0 ? Number(config.staleDays) : 30
  const promptEveryEntries = Number(config.promptEveryEntries) > 0 ? Number(config.promptEveryEntries) : 20
  const keepCopies = Number(config.keepCopies) > 0 ? Number(config.keepCopies) : 10

  // 字典这一格：现在这份 vs 上次备份时那份。**不静默**——两套库就是因为 `类型` 列分叉过一次。
  const schemaPath = join(storeDir, '..', 'references', 'tags.schema.json')
  const st = {
    storeDir, configPath, configExists, configBroken: broken,
    dir, dirSet: dir !== '',
    dirExists: false, dirWritable: false, freeBytes: null, dirError: '',
    lastBackupAt, lastCount, currentCount,
    delta: lastCount === null ? null : currentCount - lastCount,
    copies: 0, totalBytes: 0, recent: [], log: [],
    due: false, dueReason: [],
    staleDays, promptEveryEntries, keepCopies,
    schemaPath: existsSync(schemaPath) ? schemaPath : '',
    currentSchemaVersion: existsSync(schemaPath) ? schemaVersionOf(schemaPath) : '',
    lastSchemaVersion: typeof config.lastSchemaVersion === 'string' ? config.lastSchemaVersion : '',
    // null = 「无从判断」（没见过字典 / 上次备份距今没有它的记录），false 才是「确实一样」。
    schemaChangedSinceBackup: null,
  }
  if (st.schemaPath !== '' && typeof config.lastSchemaSha === 'string' && config.lastSchemaSha !== '') {
    try { st.schemaChangedSinceBackup = sha(st.schemaPath) !== config.lastSchemaSha } catch { /* 读不了就不下判断 */ }
  }

  // 目录体检
  if (st.dirSet) {
    if (!isAbsolute(dir)) {
      st.dirError = '备份地址不是绝对路径'
    } else if (!existsSync(dir)) {
      st.dirError = '备份地址还不存在（点备份时会自动建）'
    } else {
      st.dirExists = true
      try { accessSync(dir, FS.W_OK); st.dirWritable = true }
      catch { st.dirError = '备份地址不可写（权限）' }
      try {
        const fsStat = statfsSync(dir)
        st.freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize)
      } catch { /* 某些盘 / Node 版本拿不到，非致命 */ }
    }
  }

  // 目录里有什么（只认 memory-<stamp>.csv 这个戳）
  if (st.dirExists) {
    let names = []
    try { names = readdirSync(dir) } catch { names = [] }
    const stamps = names.filter((f) => MEM_RE.test(f)).map((f) => MEM_RE.exec(f)[1]).sort()
    st.copies = stamps.length
    for (const n of names) {
      try { st.totalBytes += statSync(join(dir, n)).size } catch { /* 跳过 */ }
    }
    for (const s of stamps.slice(-recentLimit).reverse()) {
      // `complete` 只管原来那三件（老备份照样是「完整」的，照样能恢复——只是没有字典）；
      // 字典有没有另记 `hasSchema`，界面上单独出一个标签。**别把老备份报成不完整**：
      // 那是拿新规矩去判旧东西，只会让人以为自己的备份坏了。
      const row = { stamp: s, at: '', count: null, label: '', complete: true, hasSchema: false, bytes: 0 }
      const parts = [
        ['memory', 'csv'], ['index', 'md'], ['backup', 'json'], ['schema', 'json'],
      ]
      for (const [stem, ext] of parts) {
        const p = join(dir, `${stem}-${s}.${ext}`)
        if (!existsSync(p)) { if (stem !== 'schema') row.complete = false; continue }
        row.bytes += statSync(p).size
        if (stem === 'schema') row.hasSchema = true
        if (stem === 'memory') {
          try { row.count = countEntries(readFileSync(p, 'utf8')) } catch { row.count = null }
        }
      }
      st.recent.push(row)
    }
    // 日志尾巴（拿说明 + 时间反填）
    try {
      const logPath = join(dir, 'last-backup.log')
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim() !== '')
        st.log = lines.slice(-recentLimit).reverse()
        for (const line of st.log) {
          // 戳到秒是 6 位（`YYYYMMDD-HHMMSS`），老备份是 4 位（`YYYYMMDD-HHMM`）——两位都收，
          // 只认 4 位会让 `at` / `label` 永远填不上。
          const m = /^(\S+)\s+backup\s+(\d{8}-\d{4,6})\s+条目=(\d+)\s*(.*)$/.exec(line)
          if (!m) continue
          const row = st.recent.find((r) => r.stamp === m[2])
          if (row) { row.at = m[1]; row.count = Number(m[3]); row.label = m[4].trim() }
        }
      }
    } catch { /* 日志坏了不影响 */ }
  }

  // 到点了没
  if (!st.dirSet) {
    st.due = true; st.dueReason.push('未设置备份地址')
  } else if (lastBackupAt === '') {
    st.due = true; st.dueReason.push('从未备份过')
  } else {
    const t = Date.parse(lastBackupAt)
    if (Number.isFinite(t)) {
      const days = (Date.now() - t) / 86400000
      if (days >= staleDays) { st.due = true; st.dueReason.push(`距上次备份已 ${Math.floor(days)} 天（阈值 ${staleDays}）`) }
    }
    if (st.copies === 0) { st.due = true; st.dueReason.push('备份目录里一份都没有') }
  }
  if (!st.due && st.delta !== null && st.delta >= promptEveryEntries) {
    st.due = true; st.dueReason.push(`新增 ${st.delta} 条（阈值 ${promptEveryEntries}）`)
  }
  // 字典改过而备份里还是旧的那一份——这也算「没备份完」。两套库分叉过，这条不能等出事才发现。
  if (!st.due && st.schemaChangedSinceBackup === true) {
    st.due = true
    st.dueReason.push(`标签字典改过，备份里还是 ${st.lastSchemaVersion === '' ? '旧的那一份' : st.lastSchemaVersion}`)
  }

  return st
}

// ── 备份（写）────────────────────────────────────────────

/**
 * 跑一次备份。校验不过会抛 BackupVerifyError（水位不动）。
 * @param {string} storeDir  技能 store 目录
 * @param {object} [opts]
 * @param {string} [opts.dir]        覆盖配置里的地址（界面「设置地址后立刻备份」用）
 * @param {string} [opts.label]      说明，写进水位日志
 * @param {Date}   [opts.now]        打戳用（测试）
 * @returns {{stamp:string, dir:string, entryCount:number, files:string[], checks:Array, rotated:string[]}}
 */
export function runBackup(storeDir, opts = {}) {
  const { config } = readBackupConfig(storeDir)
  const dir = (opts.dir !== undefined && opts.dir !== null && String(opts.dir).trim() !== ''
    ? String(opts.dir).trim()
    : backupDirOf(config))
  if (dir === '') throw new BackupNoDirError()
  if (!isAbsolute(dir)) throw new Error('备份地址必须是绝对路径：' + dir)
  if (resolve(dir) === resolve(storeDir)) throw new Error('备份地址不能就是 store 目录本身')

  const csvPath = join(storeDir, 'memory.csv')
  if (!existsSync(csvPath)) throw new Error('找不到 ' + csvPath)
  const entryCount = countEntries(readFileSync(csvPath, 'utf8'))

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const d = opts.now instanceof Date ? opts.now : new Date()
  const label = typeof opts.label === 'string' ? opts.label.trim() : ''

  // ── 挑一个不会盖掉别人的戳 ──
  // 同戳同名但**内容不一样** = 这个位置已经被另一份东西占了（另一套库、或同分钟里更早的一份）。
  // 备份永远不覆盖已有内容——往后挪一秒再试，最多挪 5 秒。
  const plansOf = (stamp) => BACKUP_FILES
    .filter((f) => existsSync(sourcePathOf(storeDir, f)))
    .map((f) => ({ ...f, s: sourcePathOf(storeDir, f), t: join(dir, `${f.stem}-${stamp}.${f.ext}`), name: `${f.stem}-${stamp}.${f.ext}` }))
  const taken = (plans) => plans.filter((p) => existsSync(p.t) && sha(p.s) !== sha(p.t)).map((p) => p.name)

  let stamp = stampOf(d)
  let plans = plansOf(stamp)
  let shifted = 0
  for (let i = 0; i < 5 && taken(plans).length > 0; i++) {
    shifted = i + 1
    stamp = stampOf(new Date(d.getTime() + shifted * 1000))
    plans = plansOf(stamp)
  }
  if (taken(plans).length > 0) throw new BackupConflictError(taken(plans))

  // ── 拷 ──
  const skipped = []
  for (const p of plans) {
    copyFileSync(p.s, p.t)
  }
  for (const f of BACKUP_FILES) if (!existsSync(sourcePathOf(storeDir, f))) skipped.push(f.src)

  // ── 校验四项 ──
  const checks = []
  let ok = true
  for (const p of plans) {
    const sameBytes = statSync(p.s).size === statSync(p.t).size
    const sameSha = sha(p.s) === sha(p.t)
    const bom = hasBOM(p.t)
    const good = sameBytes && sameSha && !bom
    if (!good) ok = false
    checks.push({ name: p.name, sameBytes, sameSha, noBom: !bom, ok: good })
  }
  const csvPlan = plans.find((p) => p.src === 'memory.csv')
  if (csvPlan) {
    const copyCount = countEntries(readFileSync(csvPlan.t, 'utf8'))
    const good = copyCount === entryCount
    if (!good) ok = false
    checks.push({ name: `记录数一致（原件 ${entryCount} / 副本 ${copyCount}）`, ok: good, count: copyCount })
  }
  if (!ok) throw new BackupVerifyError(checks)

  // ── 水位（写回配置）──────────────────────────────────
  // 注意：opts.dir 只是「这一次用哪个地址」，不写回配置——写回地址是「设置备份地址」那件事。
  const next = { ...config }
  next.lastBackupAt = localIsoTimestamp(d)
  next.lastCount = entryCount
  // 记下**这一刻的字典**。往后字典一改，`readBackupStatus` 就能说出「字典变了，库还没重合」——
  // 这正是两套库分叉过的那种事，不记下来就只能靠人记得。
  const schemaPlan = plans.find((p) => p.src === 'tags.schema.json')
  if (schemaPlan) {
    next.lastSchemaVersion = schemaVersionOf(schemaPlan.s)
    next.lastSchemaSha = sha(schemaPlan.s)
  }
  writeFileSync(configPathOf(storeDir), JSON.stringify(next, null, 2) + '\n', 'utf8')

  // ── 轮转 ────────────────────────────────────────────
  const keep = Number.isFinite(opts.keepCopies) ? Number(opts.keepCopies) : (next.keepCopies || 10)
  const rotated = []
  const memBackups = readdirSync(dir).filter((f) => MEM_RE.test(f)).sort()
  if (memBackups.length > keep) {
    for (const f of memBackups.slice(0, memBackups.length - keep)) {
      const stampPart = MEM_RE.exec(f)[1]
      for (const name of [`memory-${stampPart}.csv`, `index-${stampPart}.md`, `backup-${stampPart}.json`, `schema-${stampPart}.json`]) {
        try { if (existsSync(join(dir, name))) unlinkSync(join(dir, name)) } catch { /* 忽略 */ }
      }
      rotated.push(stampPart)
    }
  }

  // ── 日志 ────────────────────────────────────────────
  const line = `${localIsoTimestamp(d)}  backup ${stamp}  条目=${entryCount}  ${label}`.trim()
  try { appendFileSync(join(dir, 'last-backup.log'), line + '\n', 'utf8') } catch { /* 日志非致命 */ }

  return { stamp, dir, entryCount, skipped, rotated, checks, shifted, files: plans.map((p) => p.name) }
}
