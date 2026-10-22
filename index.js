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

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, accessSync, appendFileSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { constants as FS } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, isAbsolute, resolve } from 'node:path'
import {
  BACKUP_CFG_PATH, CSV_PATH, DATA_DIR, INDEX_PATH, LOCK_PATH, PRESET_ROOT, SCHEMA_PATH, STORE_DIR,
  backupReady, coreStale, getBackupCore, getCore, initInfo, legacyInfo, loadSchema, ready, reloadSchema,
  setDataDir,
} from './lib/store.mjs'
import { DEFAULT_MEMORY_FILE_NAMES, NOTICE_BEGIN, detectMemoryFiles, renderNotice, selfHeal } from './lib/notice.mjs'
import { HostConfig } from './lib/config.mjs'

export const name = 'tag-memory'
/** Host 行配置 schema：加载期校验 + 设置页表单描述。 */
export const Config = HostConfig

/** 消费 webServer（挂 API 路由）；不发布服务，故无需 realm。 */
export const inject = ['webServer']

const ROUTE = '/tag-memory-api'

/** 两次自愈之间至少隔这么久（毫秒），避免 agent/created 风暴里反复扫盘。 */
const HEAL_COOLDOWN_MS = 3000

export function apply(ctx, config = {}) {
  // 数据目录：配置优先（`dataDir`，兼容旧名 `libraryDir`）；没配就是推断链
  // （环境变量 → 旧环境变量 → <DSH_HOME>/tag-memory）。空目录会当场按模板建库。
  //
  // **「没配」不再覆盖已配好的目录**（P0-1）：preset 行没配时，它 `apply()` 不再把
  // 这里配好的目录重置回默认。两半配了不同的值 → `setDataDir` 当场抛，这里只**记一笔再抛**，
  // 绝不吞掉：宁可装载期报错，也不要静默读写到另一本库上。
  try {
    setDataDir(config.dataDir ?? config.libraryDir, 'host 行')
  } catch (e) {
    try { ctx.logger?.error?.(`[tag-memory] ${String(e?.message ?? e)}`) } catch { /* logger 不可用则忽略 */ }
    throw e
  }

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

  /**
   * 给 /tag-memory-api 做 request admission。
   *
   * 官方 WebServer 明确不做服务器级认证；`@deepseek-ai/dsh-client-connection`
   * 提供的 `connection` 服务同时负责 Host/Origin fence 与浏览器认证。直接复用
   * 它，才能和官方 `/api` 使用同一份信任判断（而不是自己拍一套 Host 检查）。
   * 返回 null 表示放行；否则返回应回给浏览器的 HTTP 状态码。
   */
  function requestRejection(req) {
    try {
      const connection = ctx.get?.('connection')
      if (connection !== null && connection !== undefined
        && typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        return typeof rejection === 'number' ? rejection : null
      }
    } catch { /* 服务查询或认证异常都按失败关闭处理 */ }
    return 503
  }

  // ── 只读 API（设置页取数）──────────────────────────────
  let offRoute = null
  try {
    offRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        try {
          // DSH 的 WebServer 本身不做认证；官方约定由路由 owner 自己执行
          // Host/Origin 与浏览器会话校验。`connection` 是 web 组合里的
          // client-connection 服务，requestRejection() 返回 401/403 或 undefined。
          // 没有这个服务时 fail closed，不能让只读库或写接口裸奔。
          const rejection = requestRejection(req)
          if (rejection !== null) {
            return send(res, rejection, {
              error: rejection === 401
                ? '未认证：请从 DSH 页面访问本接口'
                : rejection === 403
                  ? '请求来源被拒绝'
                  : '这个 DSH 没有可用的连接认证服务，接口已关闭',
            })
          }

          const url = new URL(req.url ?? '/', 'http://localhost')
          const op = url.pathname.slice(ROUTE.length)

          if (op === '/overview' && req.method === 'GET') return send(res, 200, overview(noticeState()))
          if (op === '/dict' && req.method === 'GET') return send(res, 200, dictFacts())
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

  return () => {
    try { offRoute?.() } catch { /* 已释放 */ }
    try { off?.() } catch { /* 已释放 */ }
  }
}

// ── 取数实现 ────────────────────────────────────────────

function overview(notice) {
  // `header` 是库自己的列序——表格视图照它排，库长什么样就显示什么样。
  // dataDir = **实际在用的数据目录**（config.dataDir 指到哪就报哪）；csvPath = 库文件。
  // `skillDir` 是旧字段名（同值），留着给还没更新的客户端用，别让老页面报 undefined。
  // `legacy` = 新数据目录里没库、但老位置（`<DSH_HOME>/skills/…`）还有一本时的**只读**报告：
  // 插件不自动搬库，只在界面上提示「可迁移」。
  // `health.ragged` = 「格子数跟表头对不上」的那些行。列是按下标读的，一行错位，
  // 它后面每一格都串到别列上——**界面照样有值、只是值是错的**。所以这里照实报出来，
  // 由界面明说「这些行显示的值不可信」，而不是让人对着串了位的表继续做判断。
  // 库老一点（readTable 不返回 ragged）时按「没有」处理——不装作查过了。
  const legacy = legacyInfo()
  const base = {
    ready: ready(), dataDir: DATA_DIR, skillDir: DATA_DIR, csvPath: CSV_PATH,
    coreStale: coreStale(), legacy, init: initInfo(),
    notice, sorts: SORT_ORDER, header: [], dimensions: [], statusValues: [], total: 0, active: 0,
    byDimension: {}, health: { ok: true, ragged: [] },
  }
  if (!base.ready) return base
  const schema = loadSchema()
  const core = getCore()
  const { header, rows, ragged } = core.readTable(readFileSync(CSV_PATH, 'utf8'))
  const resolve = core.makeResolver(schema, header)
  base.header = header
  const raggedRows = Array.isArray(ragged) ? ragged : []
  base.health = { ok: raggedRows.length === 0, ragged: raggedRows }
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

// ── 标签字典（设置页的只读展示）─────────────────────────
//
// 把库里的 `references/tags.schema.json` **摊成界面好渲染的形状**。只做这一件事：
// 读文件 + 拍平成数组。**不写任何文件、不改字典、不动那四个维度。**
//
// 为什么要在服务端摊：schema 里 `values` 有两副长相——多数地方是「取值 → 说明」的对象，
// `角色` / `项目` / `关键词` 那几个则是一句话（不是枚举）。这层方言不该让浏览器去猜。
//
// ⚠️ 报的是**运行时装载的那一份**（`loadSchema()` 的缓存），不是磁盘上现读的。
// 两份不一致时（有人改了文件还没重启）用 `stale` 说出来——**不能让人以为「我改了文件，
// 界面就跟着变」**，那是这套东西最怕的那种「看着成功、其实没生效」。

/** 维度 / 辅助列共有的那几个字符串字段。 */
const DICT_SCALARS = ['role', 'question', 'note', 'how', 'when', 'lifts']

/** 一个维度（或一个辅助列）→ 界面好渲染的形状。取值对象与取值说明串在这里分开。 */
function dictNode(name, node) {
  const src = node && typeof node === 'object' && !Array.isArray(node) ? node : {}
  const out = { name, values: [], text: '', column: null, required: false, status: '', cap: null, gate: null }
  for (const k of DICT_SCALARS) out[k] = typeof src[k] === 'string' ? src[k] : ''
  out.column = src.column === undefined || src.column === null ? null : String(src.column)
  out.required = src.required === true
  out.status = typeof src.status === 'string' ? src.status : ''
  out.cap = Number.isFinite(src.cap) ? src.cap : null
  // `gated`：这个维度的值受别的维度管（`深度` 只在 `类型=记忆` 时才打，其余时候留白）。
  out.gate = src.gated && typeof src.gated === 'object'
    ? { when: String(src.gated.when ?? ''), otherwise: String(src.gated.else ?? '') }
    : null

  const v = src.values
  if (typeof v === 'string') out.text = v
  else if (Array.isArray(v)) out.values = v.map((x) => ({ value: String(x), desc: '' }))
  else if (v && typeof v === 'object') {
    out.values = Object.entries(v).map(([value, desc]) => ({ value, desc: typeof desc === 'string' ? desc : '' }))
  }
  return out
}

function dictFacts() {
  const out = { ready: false, path: SCHEMA_PATH, mtime: null, stale: false, error: null }
  if (!existsSync(SCHEMA_PATH)) {
    out.error = `找不到标签字典：${SCHEMA_PATH}（记忆库还没就位？）`
    return out
  }
  let raw
  try { raw = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) } catch (e) {
    out.error = `字典读不出来：${String(e?.message ?? e)}`
    return out
  }
  try { out.mtime = statSync(SCHEMA_PATH).mtime.toISOString() } catch { /* 拿不到时辰不算错 */ }

  let live
  try { live = loadSchema() } catch (e) { out.error = String(e?.message ?? e); return out }
  // 盘上这份与装在进程里那份是不是同一版——**改完没重启**时它俩不一样。
  try { out.stale = JSON.stringify(live) !== JSON.stringify(raw) } catch { out.stale = false }

  const str = (v) => (typeof v === 'string' ? v : '')
  out.ready = true
  out.name = str(raw.name)
  out.version = str(raw.version)
  out.comment = str(raw.$comment)

  const st = raw.storage && typeof raw.storage === 'object' ? raw.storage : {}
  out.storage = {
    file: str(st.file),
    header: Array.isArray(st.header) ? st.header.map(String) : [],
    appendOnly: st.appendOnly === true,
    migration: st.migration && typeof st.migration === 'object'
      ? { status: str(st.migration.status), pending: Array.isArray(st.migration.pending) ? st.migration.pending.map(String) : [], note: str(st.migration.note) }
      : null,
  }

  const rl = raw.rules && typeof raw.rules === 'object' ? raw.rules : {}
  out.rules = {
    model: str(rl.model),
    blank: str(rl.blank),
    universal: str(rl.universal),
    universalValue: str(rl.universalValue),
    required: Array.isArray(rl.required) ? rl.required.map(String) : [],
    operators: Array.isArray(rl.operators) ? rl.operators.map(String) : [],
  }
  out.dimensions = Object.entries(raw.dimensions ?? {}).map(([n, v]) => dictNode(n, v))
  out.auxiliary = Object.entries(raw.auxiliary ?? {}).map(([n, v]) => dictNode(n, v))

  const wr = raw.writeRoutes && typeof raw.writeRoutes === 'object' ? raw.writeRoutes : {}
  out.writeRoutes = {
    comment: str(wr.$comment),
    rules: Array.isArray(wr.rules) ? wr.rules.map(String) : [],
  }

  const rc = raw.recall && typeof raw.recall === 'object' ? raw.recall : {}
  out.recall = {
    order: Array.isArray(rc.order) ? rc.order.map(String) : [],
    takeFirst: Number.isFinite(rc.takeFirst) ? rc.takeFirst : null,
    reportTotalFirst: rc.reportTotalFirst === true,
    miss: str(rc.miss),
    timeFilter: str(rc.timeFilter),
  }
  return out
}

function entries(params) {
  if (!ready()) return { error: '记忆库未就绪（找不到记忆库目录或 store/memory.csv）', hits: [], total: 0 }
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
  if (!backupReady()) throw new Error('备份核心未加载（缺 scripts/lib/backup.mjs）')
  return getBackupCore()
}

function backupStatus() {
  if (!backupReady()) return { available: false, error: '备份核心未加载（缺 scripts/lib/backup.mjs）', storeDir: STORE_DIR }
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
 * 原子替换一个文件：先写同目录临时文件，再 `renameSync` 盖过去。
 *
 * 为什么必须这样：`writeFileSync` 直接覆盖，**中途崩溃/断电就留下半截文件**——
 * 恢复本来是为了救库，结果把库弄成半截，比恢复前更糟。同目录 rename 在同一分区上
 * 是原子的：要么还是旧文件，要么已经是完整的新文件，没有「一半」这个状态。
 *
 * 临时文件必须落在**同一目录**（跨盘 rename 不是原子操作，会退化成复制）。
 * 失败时把临时文件清掉，别在 store/ 里留垃圾——`readdirSync` 数条目的地方会把它数进去。
 */
function atomicReplace(targetPath, bytes) {
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(tmpPath, bytes)
    renameSync(tmpPath, targetPath)
  } catch (e) {
    try { unlinkSync(tmpPath) } catch { /* 没写成或已 rename 掉 */ }
    throw e
  }
}

/**
 * 从某一份备份**整体替换**当前记忆库。
 * 语义是替换不是合并——目的就是「把搞乱的那一版换掉」。
 * 所以：① 先强制把现在这一版留档（用户要求「恢复之前需要提醒备份」）；
 *      ② backup.json 不还原（它装的是「备份地址/水位」这类设置，不是记忆内容）。
 *
 * 两处硬要求（审查报告 S3）：
 *   · **整个恢复过程持写锁**——不加锁的话，恢复期间别的智能体正在 `appendEntry`，
 *     它会往马上要被换掉的那份文件里写，写完连人带字一起没了。锁与写入用同一把
 *     （`LOCK_PATH`），所以「判重—落笔」和「整体替换」不会擦肩而过。
 *   · **落盘用 tmp + rename**——见 `atomicReplace()`。
 * `withLock` 是同步的、本函数也是同步的，直接包住即可。
 */
function restoreFrom(body) {
  const stamp = typeof body?.stamp === 'string' ? body.stamp.trim() : ''
  if (!/^\d{8}-\d{4,6}$/.test(stamp)) return { ok: false, error: '要指明用哪一份备份（形如 20261014-160101）' }
  // 锁要早拿：验证备份、留档、替换、复核全在同一把锁里，中途没有缝。
  try {
    return getCore().withLock(LOCK_PATH, () => restoreFromLocked(stamp))
  } catch (e) {
    return { ok: false, code: 'LOCK', error: `拿不到写锁，本次没有恢复（库还是原样）：${String(e?.message ?? e)}` }
  }
}

/** `restoreFrom` 的锁内主体（调用方已持 `LOCK_PATH`）。 */
function restoreFromLocked(stamp) {
  const bk = backupCore()
  const core = getCore()
  const st = bk.readBackupStatus(STORE_DIR, { recent: 50 })
  if (!st.dirSet) return { ok: false, code: 'NO_DIR', error: '还没有设置备份地址' }

  const src = {
    csv: join(st.dir, `memory-${stamp}.csv`),
    md: join(st.dir, `index-${stamp}.md`),
    schema: join(st.dir, `schema-${stamp}.json`),
  }
  if (!existsSync(src.csv)) return { ok: false, error: `这份备份不完整：缺 memory-${stamp}.csv` }
  if (!existsSync(src.md)) return { ok: false, error: `这份备份不完整：缺 index-${stamp}.md` }

  // 先验这份备份本身还能不能读，并**把内容读进内存**——
  // 后面的「恢复前留档」还会往同一个目录写，先读下来才不会被自己盖掉。
  let expectCount = null
  let csvBytes = null
  let mdBytes = null
  let schemaBytes = null
  let schemaVersion = ''
  try {
    csvBytes = readFileSync(src.csv)
    mdBytes = readFileSync(src.md)
    const { header, rows } = core.readTable(csvBytes.toString('utf8'))
    if (header.indexOf('id') < 0) return { ok: false, error: '这份备份的表头里没有 id 列，不像是记忆库' }
    expectCount = rows.length
    // 字典随库一起备（P-8）。老备份里没有它——那就**不动字典**，并在结果里说清楚，
    // 别让人以为「换回来了整份」。（先在这里解析一遍：坏字典要在**留下任何东西之前**拦下。）
    if (existsSync(src.schema)) {
      schemaBytes = readFileSync(src.schema)
      const parsed = JSON.parse(schemaBytes.toString('utf8'))
      schemaVersion = typeof parsed?.version === 'string' ? parsed.version : ''
    }
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
  //    tmp + rename：要么还是旧库，要么已经是完整的新库，没有「半截」这个中间态。
  //    两步之间要是崩了，memory.csv 与 index.md 可能一新一旧——所以下面 ③ 必须复核条数；
  //    复核不过就如实报 VERIFY 并指向刚留的档，不装作成功。
  try {
    atomicReplace(CSV_PATH, csvBytes)
    atomicReplace(INDEX_PATH, mdBytes)
  } catch (e) {
    return {
      ok: false,
      code: 'WRITE',
      error: `替换文件时出错，请用刚留的档回退（${pre.stamp}）：${String(e?.message ?? e)}`,
      preBackup: pre.stamp,
    }
  }

  // ②b 字典跟着一起换回去——「恢复 = 整体替换」的应有之义：库和**解释这份库的说明书**不能分家，
  //     不然换回一份老库、字典还是新的，就会出现「表里有个值、字典里没这个词」的越界行。
  //     老备份里没有字典（加这一条之前备的）就**不动它**，并明说——不装作整份都换回来了。
  let curSchemaBytes = null
  try { curSchemaBytes = readFileSync(SCHEMA_PATH) } catch { curSchemaBytes = null }
  const schemaInfo = { available: schemaBytes !== null, version: schemaVersion, swapped: false, note: '' }
  if (schemaBytes === null) {
    schemaInfo.note = '这份备份里没有字典（是加字典之前的备份）——字典保持现在这一份，没动。'
  } else if (curSchemaBytes !== null && curSchemaBytes.equals(schemaBytes)) {
    schemaInfo.note = '备份里的字典和现在这份逐字节一样，没动。'
  } else {
    try {
      atomicReplace(SCHEMA_PATH, schemaBytes)
      // ⚠️ 必须丢缓存：`loadSchema()` 是**进程内**缓存的，不丢的话界面显示了新字典、
      //    每轮注入给模型的还是老字典——又是一次「看着成功、其实没生效」。
      reloadSchema()
      schemaInfo.swapped = true
      schemaInfo.note = `字典也换回这一版${schemaVersion === '' ? '' : `（${schemaVersion}）`}，当场生效，不必重启。`
    } catch (e) {
      schemaInfo.note = `字典没换成功：${String(e?.message ?? e)}（库已经换好了，字典还是现在这份）`
    }
  }

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
  cfg.lastBackupAt = localIsoTimestamp()
  cfg.lastCount = afterCount
  try { writeFileSync(BACKUP_CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8') } catch { /* 非致命 */ }
  try {
    appendFileSync(join(st.dir, 'last-backup.log'),
      `${localIsoTimestamp()}  restore ${stamp}  条目=${afterCount}  恢复前留档=${pre.stamp}\n`, 'utf8')
  } catch { /* 非致命 */ }

  return { ok: true, stamp, entryCount: afterCount, preBackup: pre.stamp, schema: schemaInfo, status: backupStatus() }
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
 * 守铁律：**先备份 / 只追加不重写 / 不删任何条目 / id 撞号按内容判**。
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
    // 来源库没有 `类型` 列 —— 迁移前的老库（含别的机器上的库）。这类库里的条目
    // 都是「从对话里提炼的结论」，正是 `记忆` 的定义，所以按 `记忆` 落。
    // 不兜这一下的话，并进来的行 `类型` 全是空的 —— 而留白=黑名单，一按 `类型` 筛，
    // 这些新条目就全筛没了（不报错、静默少东西，最难查的那种坏）。
    if (!ih.includes(core.fieldToColumn(schema, '类型') ?? '类型') && !fields.类型) fields.类型 = '记忆'
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
  const TAG_FIELDS = ['类型', '稳定性', '深度', '距离', '角色', '项目', '状态', '依据']
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
/** 对外报的档位全集（含 file_desc）。客户端拿 `overview.sorts` 过滤自己的下拉——**旧宿主**
 *  不报这一项，客户端就只摆老的四档，不会给出一颗点了没反应的「最近加入」。 */
const SORT_ORDER = ['id_desc', 'file_desc', 'time_desc', 'time_asc', 'id_asc']

function sortRows(rows, resolve, sort) {
  // 「最近加入」＝把文件原序倒过来。库是只追加的，越靠后＝越晚写进去。
  // 它跟 `id_desc` 不是一回事：并库进来的条目，id 带着**来源那边的日期**，
  // 按 id 排会插回老位置——想看「这一趟新进来的」就得用这一档。
  if (sort === 'file_desc') return rows.slice().reverse()
  const spec = SORTS[sort]
  if (spec === undefined) return rows
  const i = resolve(spec[0])
  if (i < 0) return rows
  // 第一列并列时，拿「在文件里的先后」当第二把尺。V8 的 sort 是稳定的，并列就保留文件原序
  // ——那对降序来说正好是**最老的在前**，跟「最新的排最上面」拧着来；库里同一天写进去的条目
  // 「时间」全一样，没有这把尺，`时间 ↓` 等于没排。
  const pos = new Map(rows.map((r, k) => [r, k]))
  return rows.slice().sort((a, b) => {
    const d = spec[1] * natCompare(a[i] || '', b[i] || '')
    return d !== 0 ? d : spec[1] * (pos.get(a) - pos.get(b))
  })
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

/** 本地时间 ISO 串，保留真实时区偏移（不能拿 UTC 去硬贴 +08:00）。 */
function localIsoTimestamp(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`
    + `T${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`
    + `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
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
