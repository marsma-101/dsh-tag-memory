// index.js —— profile 平面的一半：记忆文件托管 + 设置页用的只读 API
//
// 它**不绑智能体**，所以放在 profile 平面（由 cordis.patch.yml 插入）。两件事：
//
//   ① 记忆文件托管：探测各智能体的 MEMORY.md，维护一段受控的「记忆系统在运行」说明块；
//      挂载自愈（「不能轻易删除」）。细则见 lib/notice.mjs。
//   ② 只读 API（/tag-memory-api/*）：给浏览器设置页（client.js 的「记忆」页）取数据。
//
// 三条规矩（细则全在 lib/notice.mjs）：
//   ① 只认标记：只动 `<!-- BEGIN dsh-tag-memory notice -->` 之间的内容，块外一个字节不碰。
//   ② 只追加 / 原位替换：有标记就替换块内，没有则追加末尾。
//   ③ 首次落笔先留 .bak；每次挂载（及新智能体出现时）核对标记，不在就补回。

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, accessSync, appendFileSync } from 'node:fs'
import { constants as FS } from 'node:fs'
import { basename, join, isAbsolute, resolve } from 'node:path'
import {
  BACKUP_CFG_PATH, CSV_PATH, INDEX_PATH, LOCK_PATH, PRESET_ROOT, SKILL_DIR, STORE_DIR,
  backupReady, getBackupCore, getCore, loadSchema, ready,
} from './lib/store.mjs'
import { DEFAULT_MEMORY_FILE_NAMES, NOTICE_BEGIN, detectMemoryFiles, renderNotice, selfHeal } from './lib/notice.mjs'

export const name = 'tag-memory'

/** 消费 webServer（挂 API 路由）；不发布服务，故无需 realm。 */
export const inject = ['webServer']

const ROUTE = '/tag-memory-api'

/** 两次自愈之间至少隔这么久（毫秒），避免 agent/created 风暴里反复扫盘。 */
const HEAL_COOLDOWN_MS = 3000

export function apply(ctx, config = {}) {
  const presetRoot =
    typeof config.presetRoot === 'string' && config.presetRoot.trim() !== ''
      ? config.presetRoot.trim()
      : PRESET_ROOT

  const names = Array.isArray(config.memoryFileNames) && config.memoryFileNames.length > 0
    ? config.memoryFileNames.map(String)
    : DEFAULT_MEMORY_FILE_NAMES

  const noticeEnabled = config.notice !== false && config.noticeEnabled !== false
  const migrateLegacyDict = config.migrateLegacyDict !== false

  const noticeText = renderNotice({
    skillName: typeof config.skillName === 'string' ? config.skillName : undefined,
    pluginName: config.pluginName,
    tools: Array.isArray(config.tools) ? config.tools : undefined,
  })

  const log = (msg) => { try { ctx.logger?.info?.(msg) } catch { /* logger 不可用则忽略 */ } }

  /** 各记忆文件当前是否带着托管块 / 有几个备份（设置页要显示）。 */
  function noticeState() {
    const files = detectMemoryFiles(presetRoot, { names }).map((f) => {
      let hasNotice = false
      try { hasNotice = readFileSync(f.path, 'utf8').includes(NOTICE_BEGIN) } catch { /* 读失败算没有 */ }
      let backups = 0
      try { backups = readdirSync(f.dir).filter((n) => n.startsWith(`${basename(f.file)}.bak-`)).length } catch { /* ignore */ }
      return { agent: f.agent, file: f.file, hasNotice, backups }
    })
    return { enabled: noticeEnabled, presetRoot, names, files }
  }

  /**
   * 「选文件夹为什么弹不出来」自查：把这台 DSH 的目录选择现状照实报出来。
   *
   * DSH 的目录选择是**两套互斥的后端**，开机时按「绑定地址 / 是否 SSH 启动 / 平台 / 有没有显示器」
   * 一次性定死（`dsh-host-directory-picker-auto` 的 resolve.ts）：`native` 只响应 `pick`（弹系统框），
   * `browse` 只响应 `list`/`create`（列目录）。**另一个必然缺席**——所以系统框拿不到时，
   * 界面上那条「内建浏览」兜底也一并列不出来，是**正常**的，不是坏了。
   * 拿不准是哪一种时先问这里，别猜。
   */
  function pickerFacts() {
    const out = { service: false, kind: null, host: null, error: null }
    try { out.host = ctx.webServer?.host ?? null } catch { /* 拿不到就算了 */ }
    try {
      const dp = ctx.get?.('directoryPicker')
      out.service = dp != null
      if (dp != null) out.kind = dp.capability?.()?.kind ?? null
    } catch (e) {
      out.error = String((e && e.message) || e)
    }
    return out
  }

  function healNow() {
    return noticeEnabled
      ? selfHeal({ presetRoot, names, noticeText, migrateLegacyDict })
      : { enabled: false, checked: 0, written: 0, unchanged: 0, items: [] }
  }

  let lastHealAt = 0
  let firstRun = true

  function heal(reason) {
    if (!noticeEnabled) return null
    const now = Date.now()
    if (!firstRun && now - lastHealAt < HEAL_COOLDOWN_MS) return null
    lastHealAt = now
    let summary
    try {
      summary = healNow()
    } catch (e) {
      log(`[tag-memory] 记忆文件自愈失败：${String(e?.message ?? e)}`)
      return null
    }
    firstRun = false
    if (summary.written > 0) {
      const which = summary.items.filter((i) => i.changed).map((i) => `${i.agent}/${i.file}`).join('、')
      log(`[tag-memory] ${reason}：已写入记忆说明块 → ${which}（共 ${summary.written} 个）`)
    } else if (summary.checked > 0) {
      log(`[tag-memory] ${reason}：${summary.checked} 个记忆文件说明块均在位。`)
    }
    for (const e of summary.items.filter((i) => i.error)) log(`[tag-memory] ⚠ ${e.agent}/${e.file} 自愈出错：${e.error}`)
    return summary
  }

  heal('挂载')
  const off = ctx.on('agent/created', () => heal('新智能体'))

  // ── 只读 API（设置页取数）──────────────────────────────
  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const op = url.pathname.slice(ROUTE.length)

          if (op === '/overview' && req.method === 'GET') return send(res, 200, overview(noticeState()))
          if (op === '/entries' && req.method === 'GET') return send(res, 200, entries(url.searchParams))
          if (op === '/heal' && req.method === 'POST') return send(res, 200, { summary: healNow(), notice: noticeState() })
          if (op === '/picker' && req.method === 'GET') return send(res, 200, pickerFacts())

          // ── 备份 / 恢复 / 合并 ──────────────────────────
          if (op === '/backup' && req.method === 'GET') return send(res, 200, backupStatus())
          if (op === '/backup' && req.method === 'POST') {
            const body = await readBody(req)
            return send(res, 200, backupNow(body))
          }
          if (op === '/backup/dir' && req.method === 'POST') {
            const body = await readBody(req)
            return send(res, 200, setBackupDir(body))
          }
          if (op === '/restore' && req.method === 'POST') {
            const body = await readBody(req)
            return send(res, 200, restoreFrom(body))
          }
          if (op === '/merge' && req.method === 'POST') {
            const body = await readBody(req)
            return send(res, 200, mergeFrom(body))
          }

          return send(res, 404, { error: `unknown op "${op}"` })
        } catch (error) {
          const message = error?.message ? String(error.message) : String(error)
          ctx.logger?.warn?.(`tag-memory: ${message}`)
          return send(res, 500, { error: message })
        }
      },
    })
  } catch (e) {
    log(`[tag-memory] API 路由未挂上：${String(e?.message ?? e)}`)
  }

  return () => { try { off?.() } catch { /* 已释放 */ } }
}

// ── 取数实现 ────────────────────────────────────────────

function overview(notice) {
  // `header` 是库自己的列序——表格视图照它排，库长什么样就显示什么样。
  const base = { ready: ready(), skillDir: SKILL_DIR, csvPath: CSV_PATH, notice, header: [], dimensions: [], statusValues: [], total: 0, active: 0, byDimension: {} }
  if (!base.ready) return base
  const schema = loadSchema()
  const core = getCore()
  const { header, rows } = core.readTable(readFileSync(CSV_PATH, 'utf8'))
  const resolve = core.makeResolver(schema, header)
  base.header = header
  base.total = rows.length
  base.active = core.filterRows(schema, header, rows, {}).length
  // 设置页的「含已归档」开关要拿全部状态取值（+ 留白）拼显式条件。
  const statusNode = schema.auxiliary?.状态?.values
  base.statusValues = statusNode && typeof statusNode === 'object' && !Array.isArray(statusNode) ? Object.keys(statusNode) : []
  base.dimensions = Object.entries(schema.dimensions).map(([name, d]) => ({
    name,
    column: d.column ?? null,
    values: d.values && typeof d.values === 'object' && !Array.isArray(d.values) ? Object.keys(d.values) : [],
  }))
  for (const dim of base.dimensions) {
    const i = resolve(dim.name)
    const counts = {}
    if (i >= 0) for (const r of rows) { const v = r[i] || '（留白）'; counts[v] = (counts[v] || 0) + 1 }
    base.byDimension[dim.name] = counts
  }
  return base
}

function entries(params) {
  if (!ready()) return { error: '记忆技能未就绪（找不到技能目录或真库）', hits: [], total: 0 }
  const core = getCore()
  const schema = loadSchema()
  const rawCond = params.get('cond') ?? ''
  let cond = {}
  if (rawCond.trim() !== '') {
    try { cond = JSON.parse(rawCond) } catch { return { error: '条件不是合法 JSON', hits: [], total: 0 } }
  }
  const limit = Math.max(1, Math.min(200, parseInt(params.get('limit') ?? '50', 10) || 50))
  const offset = Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0)
  const sort = (params.get('sort') ?? '').trim()
  const { header, hits } = core.recallEntries({ schema, csvPath: CSV_PATH, cond })
  const kw = (params.get('q') ?? '').trim().toLowerCase()
  const filtered = kw === '' ? hits : hits.filter((r) => r.some((c) => String(c).toLowerCase().includes(kw)))

  const resolve = core.makeResolver(schema, header)
  const sorted = sortRows(filtered, resolve, sort)
  const page = sorted.slice(offset, offset + limit)
  const pick = (row, col) => { const i = resolve(col); return i >= 0 ? (row[i] || '') : '' }
  const out = page.map((row) => {
    const o = { id: pick(row, 'id') }
    for (const dim of [...Object.keys(schema.dimensions ?? {}), ...Object.keys(schema.auxiliary ?? {})]) o[dim] = pick(row, dim)
    for (const col of ['内容', '时间', '环境', '原因', '备注']) o[col] = pick(row, col)
    return o
  })
  return { total: sorted.length, shown: out.length, offset, hasMore: offset + out.length < sorted.length, hits: out }
}

// ── 备份 ────────────────────────────────────────────────

function backupCore() {
  if (!backupReady()) throw new Error('备份核心未加载（技能里缺 scripts/lib/backup.mjs）')
  return getBackupCore()
}

function backupStatus() {
  if (!backupReady()) return { available: false, error: '备份核心未加载（技能里缺 scripts/lib/backup.mjs）', storeDir: STORE_DIR }
  return { available: true, ...backupCore().readBackupStatus(STORE_DIR, { recent: 6 }) }
}

/** 只读备份配置（保留其它键）。缺文件 → 空对象。 */
function readCfg() {
  if (!existsSync(BACKUP_CFG_PATH)) return {}
  try {
    const v = JSON.parse(readFileSync(BACKUP_CFG_PATH, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

/**
 * 立即备份。
 * **没设地址时不是「提醒」，而是把 code 抛给界面** —— 界面拿到 `NO_DIR` 就切进
 * 「设置备份地址」那个状态（跟点那颗按钮一模一样），而不是弹一条黄条。
 */
function backupNow(body) {
  let result = null
  let error = null
  let code = null
  let checks = null
  try {
    result = backupCore().runBackup(STORE_DIR, {
      dir: typeof body?.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : undefined,
      label: typeof body?.label === 'string' ? body.label : '',
    })
  } catch (e) {
    code = e?.code ?? 'ERROR'
    error = String(e?.message ?? e)
    if (code === 'CONFLICT') error += `（撞上的是：${(e.names ?? []).join('、')}）`
    if (code === 'VERIFY') checks = e?.checks ?? null
  }
  const status = backupStatus()
  if (result) return { ok: true, code: 'OK', result, status }
  return { ok: false, code, error, checks, status }
}

/**
 * 设置备份地址。地址不存在就建；建不了 / 不可写就报错，不落配置。
 * 不设默认目录——这里必须有人给出一个绝对路径。
 */
function setBackupDir(body) {
  const raw = typeof body?.dir === 'string' ? body.dir.trim() : ''
  if (raw === '') return { ok: false, error: '备份地址不能是空的' }
  if (!isAbsolute(raw)) return { ok: false, error: '备份地址要写绝对路径，比如 D:\\backup\\记忆库' }
  if (resolve(raw) === resolve(STORE_DIR)) return { ok: false, error: '备份地址不能就是记忆库 store 目录本身' }
  let created = false
  try {
    if (!existsSync(raw)) { mkdirSync(raw, { recursive: true }); created = true }
    accessSync(raw, FS.W_OK)
  } catch (e) {
    return { ok: false, error: `这个地址建不了或不可写：${String(e?.message ?? e)}` }
  }
  const cfg = readCfg()
  cfg.backupDir = raw
  try {
    writeFileSync(BACKUP_CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  } catch (e) {
    return { ok: false, error: `写不进备份配置：${String(e?.message ?? e)}` }
  }
  return { ok: true, dir: raw, created, status: backupStatus() }
}

/**
 * 从某一份备份**整体替换**当前记忆库。
 * 语义是替换不是合并——目的就是「把搞乱的那一版换掉」。
 * 所以：① 先强制把现在这一版留档（用户要求「恢复之前需要提醒备份」）；
 *      ② backup.json 不还原（它装的是「备份地址/水位」这类设置，不是记忆内容）。
 */
function restoreFrom(body) {
  const bk = backupCore()
  const core = getCore()
  const stamp = typeof body?.stamp === 'string' ? body.stamp.trim() : ''
  if (!/^\d{8}-\d{4,6}$/.test(stamp)) return { ok: false, error: '要指明用哪一份备份（形如 20261014-160101）' }
  const st = bk.readBackupStatus(STORE_DIR, { recent: 50 })
  if (!st.dirSet) return { ok: false, code: 'NO_DIR', error: '还没有设置备份地址' }

  const src = { csv: join(st.dir, `memory-${stamp}.csv`), md: join(st.dir, `index-${stamp}.md`) }
  if (!existsSync(src.csv)) return { ok: false, error: `这份备份不完整：缺 memory-${stamp}.csv` }
  if (!existsSync(src.md)) return { ok: false, error: `这份备份不完整：缺 index-${stamp}.md` }

  // 先验这份备份本身还能不能读，并**把内容读进内存**——
  // 后面的「恢复前留档」还会往同一个目录写，先读下来才不会被自己盖掉。
  let expectCount = null
  let csvBytes = null
  let mdBytes = null
  try {
    csvBytes = readFileSync(src.csv)
    mdBytes = readFileSync(src.md)
    const { header, rows } = core.readTable(csvBytes.toString('utf8'))
    if (header.indexOf('id') < 0) return { ok: false, error: '这份备份的表头里没有 id 列，不像是记忆库' }
    expectCount = rows.length
  } catch (e) {
    return { ok: false, error: `这份备份读不出来：${String(e?.message ?? e)}` }
  }

  // ① 强制先备份当前这一版 —— 失败就不许恢复
  let pre = null
  try {
    pre = bk.runBackup(STORE_DIR, { label: `恢复 ${stamp} 之前自动留档` })
  } catch (e) {
    return { ok: false, code: 'PREBACKUP', error: `恢复前留档没成功，已中止：${String(e?.message ?? e)}` }
  }

  // ② 整体替换（用上面读下来的那份字节，不用磁盘上现在这个名字——它可能刚被留档覆盖）
  writeFileSync(CSV_PATH, csvBytes)
  writeFileSync(INDEX_PATH, mdBytes)

  // ③ 换完复核
  let afterCount = null
  try {
    afterCount = core.readTable(readFileSync(CSV_PATH, 'utf8')).rows.length
  } catch (e) {
    return { ok: false, code: 'VERIFY', error: `换完读不出来，请用刚留的档回退（${pre.stamp}）：${String(e?.message ?? e)}`, preBackup: pre.stamp }
  }
  if (afterCount !== expectCount) {
    return { ok: false, code: 'VERIFY', error: `换完记录数对不上（应为 ${expectCount}，实际 ${afterCount}）——请用刚留的档回退（${pre.stamp}）`, preBackup: pre.stamp }
  }

  // ④ 水位：把「现在库里是什么」登记成刚恢复的这一版
  const cfg = readCfg()
  cfg.lastBackupAt = new Date().toISOString().slice(0, 19) + '+08:00'
  cfg.lastCount = afterCount
  try { writeFileSync(BACKUP_CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8') } catch { /* 非致命 */ }
  try {
    appendFileSync(join(st.dir, 'last-backup.log'),
      `${new Date().toISOString().slice(0, 19)}  restore ${stamp}  条目=${afterCount}  恢复前留档=${pre.stamp}\n`, 'utf8')
  } catch { /* 非致命 */ }

  return { ok: true, stamp, entryCount: afterCount, preBackup: pre.stamp, status: backupStatus() }
}

// ── 合并 ────────────────────────────────────────────────

/** 归一化正文：折叠空白 —— 判「同一条」用（§6.2 按内容判，不按 id）。 */
const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const preview = (s, n = 42) => {
  const t = normText(s)
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 把来源 CSV 的一行，按字段名摊成对象（未知列丢掉，缺的列留空）。 */
function rowToFields(core, schema, header, row) {
  const byCol = {}
  for (let i = 0; i < header.length; i++) byCol[header[i]] = row[i] ?? ''
  const names = [
    ...Object.keys(schema.dimensions ?? {}), ...Object.keys(schema.auxiliary ?? {}),
    'id', '内容', '时间', '环境', '原因', '备注',
  ]
  const out = {}
  for (const n of names) {
    const col = core.fieldToColumn(schema, n) ?? n
    if (Object.prototype.hasOwnProperty.call(byCol, col)) out[n] = byCol[col]
  }
  return out
}

/**
 * 合并一份外来的 memory.csv（别的机器 / 别的库）。
 * 守技能 §6 的铁律：**先备份 / 只追加不重写 / 不删任何条目 / id 撞号按内容判**。
 * `apply !== true` 就是预演（dryRun），只出报告不落笔。
 */
function mergeFrom(body) {
  const core = getCore()
  const schema = loadSchema()

  // ① 取来源
  const srcPath = typeof body?.path === 'string' ? body.path.trim() : ''
  const srcText = typeof body?.text === 'string' ? body.text : ''
  let incomingText = ''
  let sourceLabel = ''
  if (srcPath !== '') {
    if (!isAbsolute(srcPath)) return { ok: false, error: '来源要写绝对路径' }
    if (!existsSync(srcPath)) return { ok: false, error: `找不到这个文件：${srcPath}` }
    try { incomingText = readFileSync(srcPath, 'utf8') } catch (e) { return { ok: false, error: `读不了：${String(e?.message ?? e)}` } }
    sourceLabel = srcPath
  } else if (srcText.trim() !== '') {
    incomingText = srcText
    sourceLabel = '（粘贴的 CSV）'
  } else {
    return { ok: false, error: '要么给一个 memory.csv 的绝对路径，要么把 CSV 内容粘进来' }
  }

  let ih, irows
  try { ({ header: ih, rows: irows } = core.readTable(incomingText)) } catch (e) { return { ok: false, error: `这份 CSV 读不出来：${String(e?.message ?? e)}` } }
  if (ih.indexOf('内容') < 0) return { ok: false, error: '来源 CSV 的表头里没有「内容」列，不像是记忆库' }

  const { header, rows } = core.readTable(readFileSync(CSV_PATH, 'utf8'))
  const localByIdx = header.indexOf('内容')
  const localNorm = new Map()
  for (const r of rows) {
    const k = normText(r[localByIdx])
    if (k !== '') localNorm.set(k, r)
  }
  const localIds = new Set(rows.map((r) => r[0]).filter(Boolean))
  const missingColumns = header.filter((c) => !ih.includes(c))

  // ② 逐行判
  const items = [] // { kind, fields, id, why }
  for (const r of irows) {
    if (!r[0] || String(r[0]).trim() === '') continue // 空行 / 纯空白
    const fields = rowToFields(core, schema, ih, r)
    const key = normText(fields.内容)
    if (key === '') { items.push({ kind: 'invalid', id: fields.id ?? '', why: '「内容」是空的', preview: '' }); continue }
    if (localNorm.has(key)) { items.push({ kind: 'duplicate', id: fields.id ?? '', fields, local: localNorm.get(key) }); continue }
    // 预演就得说实话：必填缺项 / 取值不合规的行**现在**标出来，别等真合并才一条条失败——
    // 否则预演说「要加 3 条」、真合并只进去 2 条，用户会以为合并吞了一条。
    const vres = core.validateRow(schema, fields)
    const verr = Array.isArray(vres) ? vres : (vres?.errors ?? [])
    if (verr.length > 0) {
      items.push({ kind: 'invalid', id: fields.id ?? '', why: verr.join('；'), preview: preview(fields.内容) })
      continue
    }
    const why = localIds.has(String(fields.id ?? '')) ? `id ${fields.id} 已被库里另一条占用，会另给新号` : ''
    items.push({ kind: 'new', id: fields.id ?? '', fields, why })
  }

  // ③ 标签差异：内容一样但标签不一样 —— §6.5 不删，报出来让人决定
  // 比标签要按**列名**比（维度名和列名不一定同名，比如 深度↔成熟度）。
  const TAG_FIELDS = ['稳定性', '深度', '距离', '角色', '项目', '状态', '依据']
  const tagDiffs = []
  for (const it of items) {
    if (it.kind !== 'duplicate') continue
    const diffs = []
    for (const f of TAG_FIELDS) {
      const i = header.indexOf(core.fieldToColumn(schema, f) ?? f)
      const a = i >= 0 ? normText(it.local[i]) : ''
      const b = normText(it.fields[f])
      if (a !== b) diffs.push({ field: f, local: a, incoming: b })
    }
    if (diffs.length > 0) tagDiffs.push({ id: it.local[0], preview: preview(it.fields.内容), diffs })
  }

  const newItems = items.filter((i) => i.kind === 'new')
  const report = {
    ok: true,
    dryRun: body?.apply !== true,
    source: sourceLabel,
    incomingTotal: irows.length,
    localTotal: rows.length,
    headerMismatch: ih.join(',') !== header.join(','),
    missingColumns,
    counts: {
      new: newItems.length,
      duplicate: items.filter((i) => i.kind === 'duplicate').length,
      idCollision: newItems.filter((i) => i.why !== '').length,
      invalid: items.filter((i) => i.kind === 'invalid').length,
      tagDiff: tagDiffs.length,
    },
    newList: newItems.slice(0, 50).map((i) => ({ id: i.id, preview: preview(i.fields.内容), why: i.why, 时间: i.fields.时间 ?? '' })),
    invalidList: items.filter((i) => i.kind === 'invalid').slice(0, 50).map((i) => ({ id: i.id, why: i.why, preview: i.preview ?? '' })),
    tagDiffs: tagDiffs.slice(0, 50),
  }

  if (report.dryRun) return report

  // ④ 落笔：先留档 → 只追加
  if (newItems.length === 0) return { ...report, applied: [], note: '没有需要新增的条目（全是重复），一个字节都没动' }
  let pre
  try {
    pre = backupCore().runBackup(STORE_DIR, { label: '合并外来记忆库之前自动留档' })
  } catch (e) {
    return { ok: false, code: e?.code ?? 'ERROR', error: `合并前留档没成功，已中止（一个字节都没动）：${String(e?.message ?? e)}` }
  }

  const appended = []
  const failed = []
  for (const it of newItems) {
    try {
      const id = core.appendEntry({ schema, csvPath: CSV_PATH, lockPath: LOCK_PATH, row: it.fields })
      appended.push({ id, from: it.id })
    } catch (e) {
      failed.push({ id: it.id, preview: preview(it.fields.内容), why: String(e?.message ?? e) })
    }
  }

  return { ...report, dryRun: false, preBackup: pre.stamp, appended, failed, status: backupStatus() }
}

// ── 允许的排序：时间 / id 的升序降序。未指定或列不存在 → 原序。 ──
const SORTS = { time_desc: ['时间', -1], time_asc: ['时间', 1], id_desc: ['id', -1], id_asc: ['id', 1] }

function sortRows(rows, resolve, sort) {
  const spec = SORTS[sort]
  if (spec === undefined) return rows
  const i = resolve(spec[0])
  if (i < 0) return rows
  return rows.slice().sort((a, b) => spec[1] * natCompare(a[i] || '', b[i] || ''))
}

/** 自然序：数字段按数值比，其余按字符——`M-20260101-002` 这类也能排对。 */
function natCompare(a, b) {
  const pa = String(a).match(/\d+|\D+/g) ?? []
  const pb = String(b).match(/\d+|\D+/g) ?? []
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const x = pa[k], y = pb[k]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function send(res, status, obj) {
  // 客户端可能已经走了（关页面/刷新）。这时响应对象已废，往里写会抛。吞掉：没人收了，报了也没用。
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(obj))
  } catch { /* 客户端已经走了 */ }
}

/** 读 POST 的 JSON 体。体坏了 / 超大 → 给个空对象，让上层按「参数不全」报错。 */
function readBody(req) {
  return new Promise((done) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 8 * 1024 * 1024) { raw = ''; try { req.destroy() } catch { /* 已断 */ } }
    })
    req.on('end', () => { try { done(raw.trim() === '' ? {} : JSON.parse(raw)) } catch { done({}) } })
    req.on('error', () => done({}))
  })
}
