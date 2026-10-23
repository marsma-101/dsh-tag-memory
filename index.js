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

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, accessSync, appendFileSync, statSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { constants as FS } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path'
import {
  BACKUP_CFG_PATH, CSV_PATH, DATA_DIR, INDEX_PATH, LOCK_PATH, PRESET_ROOT, SCHEMA_PATH, STORE_DIR,
  backupReady, coreStale, getBackupCore, getCore, initInfo, legacyInfo, loadSchema, ready, reloadSchema,
  setDataDir,
} from './lib/store.mjs'
import { DEFAULT_MEMORY_FILE_NAMES, NOTICE_BEGIN, detectMemoryFiles, renderNotice, selfHeal } from './lib/notice.mjs'
import { snapshotOrThrow, snapshotStatus } from './lib/engine/snapshot.mjs'
import { HostConfig } from './lib/config.mjs'

export const name = 'tag-memory'
/** Host 行配置 schema：加载期校验 + 设置页表单描述。 */
export const Config = HostConfig

/** 消费 webServer（挂 API 路由）与 tools（挂 pre-execute 守卫）；不发布服务，故无需 realm。 */
export const inject = ['webServer', 'tools']

const ROUTE = '/tag-memory-api'

/** 两次自愈之间至少隔这么久（毫秒），避免 agent/created 风暴里反复扫盘。 */
const HEAL_COOLDOWN_MS = 3000

// ── 隔离守卫（S-防-1）────────────────────────────────────
//
// 记忆库就是一个 CSV，任何 fs / shell / glob 工具都碰得到它——改一格、删一行、
// 甚至整份覆盖，插件完全不知道。守卫在**工具执行前**拦住所有「参数里出现记忆库路径」
// 的调用，只留插件自己的四个工具当合法通道（它们跑在插件代码里，不经过这条管线）。
//
// 三处细节是刻意这么写的，改之前先读完：
//   ① **逃生口在 import 时读一次**。值在任何 agent 存在之前就固定了，插件、工具、模型
//      都无法在进程生命周期内改它。写成每次调用时读，模型就能靠改环境变量绕开守卫。
//   ② **needle 运行时拼装**。源码里若出现 `tag-memory` 这个字面量，插件自己的源码路径
//      就会被守卫拦下（写这个插件的活直接做不下去）。拼起来，源码里就没有这个串。
//   ③ **扫的是参数里的字符串，而且递归**。shell 命令、glob 通配、文件路径一条规则全覆盖；
//      只看顶层就漏了 `{args:['-c','cat /…/memory.csv']}` 这种。
const GUARD_DISABLED = process.env.DSH_TAG_MEMORY_GUARD === 'off'

/** 基础 needle：默认数据目录名。运行时拼装，源码里不留这个字面量。 */
const GUARD_NEEDLE = ['tag', 'memory'].join('-')

/**
 * 这个调用是不是在碰记忆库。
 *
 * needle 是**一组**、不是一条：基础那条只管默认目录名（`<DSH_HOME>/tag-memory`），
 * 用户把 `dataDir` 配到别处（比如 `/data/mem`）时它一个字都匹配不上——
 * 实测过：`/data/mem/store/memory.csv` 在只有基础 needle 时直接放行。
 * 所以真正生效的 needle 由 `apply()` 把**当前数据目录**拼进去（见 `guardNeedles()`）。
 */
function argumentsTouchGuard(args, needles) {
  if (typeof args === 'string') return needles.some((n) => n !== '' && args.includes(n))
  if (Array.isArray(args)) return args.some((a) => argumentsTouchGuard(a, needles))
  if (args && typeof args === 'object') return Object.values(args).some((a) => argumentsTouchGuard(a, needles))
  return false
}

/** 拒绝话术：告诉模型**该用什么**，而不只是「不许」。 */
function guardDenialReason() {
  return '记忆库只能经插件自己的工具访问：写用 memory_write / 读用 memory_recall / 改旧条用 memory_supersede。'
    + '参数里出现了记忆库的路径，这次调用已拦下——用 fs / shell / glob 直接读写会绕开校验、判重与写锁，'
    + '把库改坏（错列、丢行、并发写坏）插件是发现不了的。要改库请走上面三个工具。'
}

/** 插件自己的四个工具：合法通道，不经过这条管线，必须豁免。 */
const GUARD_EXEMPT_TOOLS = ['memory_write', 'memory_recall', 'memory_supersede', 'memory_review']

/**
 * 当前该用哪几条 needle 判定。
 *
 * `dataDir` 可配，所以数据目录不一定叫 `tag-memory`。这里把**实际在用的**目录名、
 * 库文件路径、锁文件路径都收进来——用户在 `dataDir` 下直接写 `memory.csv` 也算碰库。
 * 目录名太短（少于 4 字）时跳过：`mem` 这种词会误伤普通对话内容。
 */
function guardNeedles(dataDir, csvPath, lockPath) {
  const out = [GUARD_NEEDLE]
  const add = (v) => { if (typeof v === 'string' && v.trim() !== '') out.push(v.trim()) }
  add(csvPath)
  add(lockPath)
  // 目录名单独也收一条（`cat /data/mem/store/memory.csv` 里 csvPath 能中，
  // 但 `ls /data/mem` 这种只给目录的也得拦）。
  const base = typeof dataDir === 'string' ? dataDir.trim().replace(/[\\/]+$/, '') : ''
  if (base !== '') {
    const name = base.split(/[\\/]/).pop() ?? ''
    if (name.length >= 4) out.push(name)
    out.push(base)
  }
  return Array.from(new Set(out.filter((n) => n !== '')))
}

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
    // 一个文件都没探测到时，界面要能说清「托管未生效」，而不是显示 0/0 装作正常。
    return { enabled: noticeEnabled, presetRoot, names, files, none: files.length === 0 }
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

  // ── 隔离守卫：工具执行前的闸（S-防-1）──────────────────
  //
  // 挂在 **profile 平面**，所以管这个 profile 下所有智能体的所有工具调用。
  // 位置在这里（heal 之后、API 路由之前）是刻意的：守卫比 API 更早生效，
  // 万一路由没挂上（`ctx.webServer` 缺失），库至少还是守着的。
  //
  // 逃生口是**模块级常量**（import 时读一次），不在这里读——见文件头 ①。
  let offGuard = null
  if (!GUARD_DISABLED) {
    const needles = guardNeedles(DATA_DIR, CSV_PATH, LOCK_PATH)
    try {
      offGuard = ctx.on('tools/pre-execute', (exec, next) => {
        // 豁免：插件自己的工具走插件代码，根本不经过这条管线。
        const toolName = typeof exec?.name === 'string' ? exec.name : ''
        if (GUARD_EXEMPT_TOOLS.includes(toolName)) return next()
        if (argumentsTouchGuard(exec?.arguments, needles)) {
          // waterfall：返回即截断，后来者翻不了案。
          return Promise.resolve({ kind: 'deny', reason: guardDenialReason() })
        }
        return next()
      })
      log(`[tag-memory] 隔离守卫生效（needle ${needles.length} 条；逃生口 DSH_TAG_MEMORY_GUARD=off）`)
    } catch (e) {
      // 挂不上不能装作守住了：这条必须出声，否则用户以为库是保护着的。
      log(`[tag-memory] ⚠ 隔离守卫没挂上，库对 fs/shell 工具是敞开的：${String(e?.message ?? e)}`)
    }
  } else {
    log('[tag-memory] 隔离守卫已按 DSH_TAG_MEMORY_GUARD=off 关闭')
  }

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
          // ── 取代 / 归档（0.3.0）─────────────────────────
          if (op === '/supersede' && req.method === 'POST') {
            const body = await readBody(req)
            return send(res, 200, supersedeFrom(body))
          }
          if (op === '/archive' && req.method === 'POST') {
            const body = await readBody(req)
            return send(res, 200, archiveFrom(body))
          }
          if (op === '/snapshots' && req.method === 'GET') {
            return send(res, 200, snapshotStatus(STORE_DIR))
          }

          return send(res, 404, { error: `unknown op "${op}"` })
        } catch (error) {
          const message = error?.message ? String(error.message) : String(error)
          ctx.logger?.warn?.(`tag-memory: ${message}`)
          // 请求体超限 → 413（P2-4）。让客户端能显示「文件太大」，而不是「参数不全」。
          if (error?.code === 'TOO_LARGE') return send(res, 413, { error: message, code: 'TOO_LARGE' })
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
    try { offGuard?.() } catch { /* 已释放 */ }
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
  const { header, rows, ragged } = core.readTable(readFileSync(CSV_PATH, 'utf8'), core.legacyWidthOf(schema))
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
    // P2-1：留白的桶 key 必须用核心认的 `留白`（`matchKey` 里 `s === '留白'` 才判空值）。
    // 原来写成 `（留白）`，界面上选它永远 0 命中——桶名和条件值不是一回事。
    // P2-2：计数用 `filterRows(..., {})` 的口径（排除 被取代/已归档），与「生效条目」一致。
    const liveRows = core.filterRows(schema, header, rows, {})
    if (i >= 0) for (const r of liveRows) { const v = r[i] || '留白'; counts[v] = (counts[v] || 0) + 1 }
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

/**
 * 只读备份配置（保留其它键）。缺文件 → 空对象。
 *
 * P2-5：**解析失败不能静默当 `{}`**。原实现 `catch { return {} }`，接着
 * `setBackupDir` 只把 `backupDir` 写回去 —— 损坏文件里那些**水位**（`lastBackupAt` /
 * `lastCount` / `keepCopies`）就被这一写抹掉了，而且用户毫无察觉。
 * 现在返回 `{ broken: true, error }`，由调用方决定：**读的时候降级显示，
 * 写的时候拒绝覆盖**。
 */
function readCfg() {
  if (!existsSync(BACKUP_CFG_PATH)) return {}
  try {
    const v = JSON.parse(readFileSync(BACKUP_CFG_PATH, 'utf8'))
    return v && typeof v === 'object' ? v : { broken: true, error: '配置不是 JSON 对象' }
  } catch (e) {
    return { broken: true, error: String(e?.message ?? e) }
  }
}

/** 原子写一个 JSON 文件（tmp + rename，同目录）。失败不留半截。 */
function writeJsonAtomic(path, obj) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 没写成或已 rename 掉 */ }
    throw e
  }
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
  // P2-5：配置损坏时**拒绝覆盖**——否则这一写会把水位（lastBackupAt/lastCount/keepCopies）抹掉。
  if (cfg.broken) {
    return {
      ok: false,
      code: 'CFG_BROKEN',
      error: `备份配置读不出来（${cfg.error}），为免抹掉水位，这次没有写入。`
        + `请先修好或删掉 ${BACKUP_CFG_PATH} 再设地址。`,
    }
  }
  cfg.backupDir = raw
  try {
    writeJsonAtomic(BACKUP_CFG_PATH, cfg)
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
    const { header, rows } = core.readTable(csvBytes.toString('utf8'), core.legacyWidthOf(loadSchema()))
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
  //    两层留档，缺一不可：
  //      · 快照（snapshots/，不依赖备份地址）——**这一层保证「任何时候都留得下来」**；
  //      · 全量备份（runBackup，要设备份地址）——用户能在「备份历史」里看见并回退。
  //    原来只有第二层，于是没设备份地址的用户**根本恢复不了**（NO_DIR 直接挡回）。
  //    现在快照先落，全量备份失败只降级成提示，不再否决整个恢复。
  let pre = null
  let preSnapshot = null
  try {
    preSnapshot = snapshotOrThrow({ storeDir: STORE_DIR, csvPath: CSV_PATH, label: `恢复 ${stamp} 之前自动留档` }, '恢复')
  } catch (e) {
    return { ok: false, code: 'PRESNAPSHOT', error: String(e?.message ?? e) }
  }
  let preBackupNote = ''
  try {
    pre = bk.runBackup(STORE_DIR, { label: `恢复 ${stamp} 之前自动留档` })
  } catch (e) {
    // 没设备份地址 / 备份写不进 —— 只影响「备份历史」那份，快照已经在手，恢复照做。
    preBackupNote = `（全量备份没做成：${String(e?.message ?? e)}；快照 ${preSnapshot.name} 已留）`
  }
  // 下面各处要报「回退到哪份」：优先报全量备份的戳（界面能点），没有就报快照的戳。
  // 两个都是**恢复前**的档，语义一样；`pre` 可能为 null（没设备份地址），所以统一走这里。
  const preStamp = pre !== null && typeof pre.stamp === 'string' && pre.stamp !== '' ? pre.stamp : preSnapshot.stamp

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
      error: `替换文件时出错，请用刚留的档回退（${preStamp}）：${String(e?.message ?? e)}`,
      preBackup: preStamp,
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
    afterCount = core.readTable(readFileSync(CSV_PATH, 'utf8'), core.legacyWidthOf(loadSchema())).rows.length
  } catch (e) {
    return { ok: false, code: 'VERIFY', error: `换完读不出来，请用刚留的档回退（${preStamp}）：${String(e?.message ?? e)}`, preBackup: preStamp }
  }
  if (afterCount !== expectCount) {
    return { ok: false, code: 'VERIFY', error: `换完记录数对不上（应为 ${expectCount}，实际 ${afterCount}）——请用刚留的档回退（${preStamp}）`, preBackup: preStamp }
  }

  // ④ 水位：把「现在库里是什么」登记成刚恢复的这一版
  // 水位写回：配置损坏时跳过（不拿 `{}` 去覆盖），并把这件事说出来。
  const cfg = readCfg()
  if (cfg.broken) {
    try { appendFileSync(join(st.dir, 'last-backup.log'),
      `${localIsoTimestamp()}  restore ${stamp}  条目=${afterCount}  恢复前留档=${preStamp}  ⚠ 备份配置损坏，水位未更新\n`, 'utf8') } catch { /* 非致命 */ }
    return { ok: true, stamp, entryCount: afterCount, preBackup: preStamp, preSnapshot: preSnapshot.name, backupNote: preBackupNote, schema: schemaInfo, status: backupStatus(), cfgWarning: `备份配置损坏（${cfg.error}），水位未更新` }
  }
  cfg.lastBackupAt = localIsoTimestamp()
  cfg.lastCount = afterCount
  try { writeJsonAtomic(BACKUP_CFG_PATH, cfg) } catch { /* 非致命 */ }
  try {
    appendFileSync(join(st.dir, 'last-backup.log'),
      `${localIsoTimestamp()}  restore ${stamp}  条目=${afterCount}  恢复前留档=${preStamp}\n`, 'utf8')
  } catch { /* 非致命 */ }

  return { ok: true, stamp, entryCount: afterCount, preBackup: preStamp, preSnapshot: preSnapshot.name, backupNote: preBackupNote, schema: schemaInfo, status: backupStatus() }
}

// ── 合并 ────────────────────────────────────────────────

/** 归一化正文：折叠空白 —— 判「同一条」用（§6.2 按内容判，不按 id）。 */
const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const preview = (s, n = 42) => {
  const t = normText(s)
  return t.length > n ? t.slice(0, n) + '…' : t
}

// ── 合并来源的闸门（R-7）──────────────────────────────────
//
// 合并 = **把一份外来文件的内容灌进记忆库**，而记忆库会进每轮系统提示词。
// 原先只做「绝对路径 + 存在 + 可读」三件事，等于开了两个口子：
//   ① 任意路径存在性探针（拿报错文案就能问「这个文件在不在」）；
//   ② 带 `内容` 表头的任意 CSV 都能进来 —— 记忆投毒；
//   ③ 大文件能把进程拖垮。
// 所以：只认「备份目录里的文件」/「库目录里的文件」，或调用方显式确认的可信来源；
// 目录、超大、超行数一律在读之前拦下。报错只说路径，**不回显文件内容**。

/** 单份来源的字节上限。10MB 的 CSV 已经够把几十万行记忆塞进来了。 */
const MERGE_MAX_BYTES = 10 * 1024 * 1024
/** 单份来源的数据行上限（判重是逐行比，行数不封顶就是给自己找卡死）。 */
const MERGE_MAX_ROWS = 50000

/** 字节数说成人话（错误消息里要同时给出上限与实际大小）。 */
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n} 字节`
}

/** `child` 是否落在 `dir` 之内（含 `dir` 本身）。两边都先取真实路径，符号链接绕不出去。 */
function insideDir(child, dir) {
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  const rel = relative(real(dir), real(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 合并来源的准入判断。返回 `{ error, code }` 或 `{ size, confirmed, inBackupDir }`。
 *
 * 允许的路径：
 *   ① 在备份目录（`readCfg().backupDir`）之下；
 *   ② 在库目录之下（`STORE_DIR` 的同级，即数据目录）；
 *   ③ 调用方显式传 `body.confirmOutside === true`（界面上那颗「我确认这是可信来源」）。
 * 备份目录**没设**时只有 ③ 这一条路——不能因为「没配」就默认放行任意路径。
 */
function mergeSourceVerdict(raw, body) {
  if (!isAbsolute(raw)) return { code: 'SOURCE_NOT_ABSOLUTE', error: '来源要写绝对路径' }
  if (!existsSync(raw)) return { code: 'SOURCE_MISSING', error: `找不到这个文件：${raw}` }
  let st
  try { st = statSync(raw) } catch (e) { return { code: 'SOURCE_UNREADABLE', error: `看不了这个路径：${String(e?.message ?? e)}` } }
  // 目录要单独拦：读目录在部分平台上会抛 EISDIR，但那条消息对用户毫无意义。
  if (st.isDirectory()) return { code: 'SOURCE_IS_DIR', error: `来源必须是文件，不能是目录：${raw}` }
  if (!st.isFile()) return { code: 'SOURCE_NOT_FILE', error: `来源必须是普通文件：${raw}` }
  if (st.size > MERGE_MAX_BYTES) {
    return {
      code: 'SOURCE_TOO_LARGE',
      error: `这个文件有 ${fmtBytes(st.size)}，超过单份 ${fmtBytes(MERGE_MAX_BYTES)} 的上限，没有读它。`
        + '请先在来源那边拆成小份，再一份一份合并。',
    }
  }

  const confirmed = body?.confirmOutside === true
  const cfg = readCfg()
  const backupDir = typeof cfg.backupDir === 'string' ? cfg.backupDir.trim() : ''
  const libDir = dirname(STORE_DIR) // STORE_DIR 的同级 = 数据目录（库本体就在 STORE_DIR 里）
  const inBackupDir = backupDir !== '' && insideDir(raw, backupDir)
  const inLibDir = insideDir(raw, libDir)
  if (confirmed || inBackupDir || inLibDir) {
    return { size: st.size, confirmed, inBackupDir, inLibDir }
  }
  return {
    code: 'SOURCE_OUTSIDE',
    error: '这个路径不在备份目录里。如果你确认要合并这个文件，请在界面上勾选「我确认这是可信来源」'
      + (backupDir === ''
        ? '（备份地址还没设，所以除了库目录里的文件，别的路径都得先确认）'
        : `（备份目录：${backupDir}）`),
  }
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
  let sourceInfo = null
  if (srcPath !== '') {
    const v = mergeSourceVerdict(srcPath, body)
    if (v.error !== undefined) return { ok: false, code: v.code, error: v.error }
    try { incomingText = readFileSync(srcPath, 'utf8') } catch (e) { return { ok: false, error: `读不了：${String(e?.message ?? e)}` } }
    sourceLabel = srcPath
    sourceInfo = {
      bytes: v.size,
      confirmedOutside: v.confirmed,
      inBackupDir: v.inBackupDir,
      inLibDir: v.inLibDir,
    }
  } else if (srcText.trim() !== '') {
    incomingText = srcText
    sourceLabel = '（粘贴的 CSV）'
  } else {
    return { ok: false, error: '要么给一个 memory.csv 的绝对路径，要么把 CSV 内容粘进来' }
  }

  let ih, irows
  try { ({ header: ih, rows: irows } = core.readTable(incomingText)) } catch (e) { return { ok: false, error: `这份 CSV 读不出来：${String(e?.message ?? e)}` } }
  if (ih.indexOf('内容') < 0) return { ok: false, error: '来源 CSV 的表头里没有「内容」列，不像是记忆库' }
  // 行数闸门：解析之后才数得准（引号里可以有换行，数 `\n` 会数错）。
  // 放在逐行判之前——50001 行逐行比对本身就是要命的开销。
  if (irows.length > MERGE_MAX_ROWS) {
    return {
      ok: false,
      code: 'SOURCE_TOO_MANY_ROWS',
      error: `这份来源有 ${irows.length} 条数据行，超过单次 ${MERGE_MAX_ROWS} 行的上限，没有合并。`
        + '请先在来源那边分拆成几份，再一份一份合并。',
    }
  }

  const { header, rows } = core.readTable(readFileSync(CSV_PATH, 'utf8'), core.legacyWidthOf(schema))

  // 判重键**对齐写入**（core.mjs 的 DUP_KEYS = 内容 + 项目 + 类型）：
  //   · 只按内容判，会把「A 项目的规矩并进 B 项目」整条误丢——报告只说「重复」，
  //     用户以为本来就有，实际漏并了；
  //   · `已归档` / `被取代` 的行不参与判重，与写入同一条口径（它们本来就该被新的一条顶掉）。
  // 老库缺列时**不装作判过**：`null` 表示这一维比不了，按「不同」处理（宁多一条，不静默丢）。
  const localKeyIdx = ['内容', '项目', '类型'].map((k) => header.indexOf(core.fieldToColumn(schema, k) ?? k))
  // 三列缺一列就**判不了**：写入那边（core.mjs 的 findDuplicate）遇到缺列也是「不判」。
  // 这里不装作判过——缺列时一律按「不同」处理，宁可多并一条，也不静默丢一条。
  const canJudge = localKeyIdx.every((i) => i >= 0)
  const localStatusIdx = header.indexOf('状态')
  const localByContent = new Map() // 内容 → 该内容在库里出现过的生效行（已归档/被取代不进索引）
  if (canJudge) {
    for (const r of rows) {
      const k = normText(r[localKeyIdx[0]])
      if (k === '') continue
      const st = localStatusIdx < 0 ? '' : normText(r[localStatusIdx])
      if (st === '被取代' || st === '已归档') continue // 退场的条目不算「库里已经有」
      const list = localByContent.get(k)
      if (list === undefined) localByContent.set(k, [r])
      else list.push(r)
    }
  }
  const sameKey = (localRow, key, project, type) =>
    normText(localRow[localKeyIdx[0]]) === key
    && normText(localRow[localKeyIdx[1]]) === project
    && normText(localRow[localKeyIdx[2]]) === type
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
    const inProject = normText(fields.项目)
    const inType = normText(fields.类型)
    const hits = canJudge ? (localByContent.get(key) ?? []) : []
    const same = hits.find((lr) => sameKey(lr, key, inProject, inType))
    if (same !== undefined) {
      // 真重复：同项目同类型同内容 —— 跳过（§6.5 的标签差异照旧报出来）
      items.push({ kind: 'duplicate', id: fields.id ?? '', fields, local: same })
      continue
    }
    // 仅内容相同、项目/类型不同 → **不是重复**，是新增（这正是跨项目并库的常态）
    const other = hits[0]
    // 预演就得说实话：必填缺项 / 取值不合规的行**现在**标出来，别等真合并才一条条失败——
    // 否则预演说「要加 3 条」、真合并只进去 2 条，用户会以为合并吞了一条。
    const vres = core.validateRow(schema, fields)
    const verr = Array.isArray(vres) ? vres : (vres?.errors ?? [])
    if (verr.length > 0) {
      items.push({ kind: 'invalid', id: fields.id ?? '', why: verr.join('；'), preview: preview(fields.内容) })
      continue
    }
    const why = localIds.has(String(fields.id ?? '')) ? `id ${fields.id} 已被库里另一条占用，会另给新号` : ''
    items.push({
      kind: 'new',
      id: fields.id ?? '',
      fields,
      why,
      otherProject: other === undefined ? null : {
        id: other[0] ?? '',
        项目: localKeyIdx[1] < 0 ? '' : normText(other[localKeyIdx[1]]),
        类型: localKeyIdx[2] < 0 ? '' : normText(other[localKeyIdx[2]]),
      },
    })
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
  const dupSameProject = items.filter((i) => i.kind === 'duplicate')
  // 同内容、别项目/别类型的那批：它们**已经算在 `new` 里**（要并进去），
  // 单列一个计数只是为了让报告说清「这几条不是重复，只是别处也有同句」。
  const dupOtherProject = newItems.filter((i) => i.otherProject !== null)
  const report = {
    ok: true,
    dryRun: body?.apply !== true,
    source: sourceLabel,
    ...(sourceInfo === null ? {} : { sourceInfo }),
    incomingTotal: irows.length,
    localTotal: rows.length,
    headerMismatch: ih.join(',') !== header.join(','),
    missingColumns,
    counts: {
      new: newItems.length,
      // `duplicate` 保留为「跳过」的总数（= 同项目真重复），老客户端/自检照旧读得懂；
      // 新客户端改读下面两项细分。
      duplicate: dupSameProject.length,
      duplicateSameProject: dupSameProject.length,
      duplicateOtherProject: dupOtherProject.length,
      idCollision: newItems.filter((i) => i.why !== '').length,
      invalid: items.filter((i) => i.kind === 'invalid').length,
      tagDiff: tagDiffs.length,
    },
    newList: newItems.slice(0, 50).map((i) => ({
      id: i.id,
      preview: preview(i.fields.内容),
      why: i.why,
      时间: i.fields.时间 ?? '',
      ...(i.otherProject === null ? {} : { otherProject: i.otherProject }),
    })),
    duplicateOtherProjectList: dupOtherProject.slice(0, 50).map((i) => ({
      id: i.id,
      preview: preview(i.fields.内容),
      项目: i.fields.项目 ?? '',
      类型: i.fields.类型 ?? '',
      local: i.otherProject,
    })),
    invalidList: items.filter((i) => i.kind === 'invalid').slice(0, 50).map((i) => ({ id: i.id, why: i.why, preview: i.preview ?? '' })),
    tagDiffs: tagDiffs.slice(0, 50),
  }

  if (report.dryRun) return report

  // ④ 落笔：先留档 → 只追加
  if (newItems.length === 0) return { ...report, applied: [], note: '没有需要新增的条目（全是重复），一个字节都没动' }
  // 留档两层，与恢复同一条规矩：快照先落（不依赖备份地址），全量备份失败只降级成提示。
  // 原来只有全量备份，没设备份地址的用户连合库都做不了。
  let preSnap
  try {
    preSnap = snapshotOrThrow({ storeDir: STORE_DIR, csvPath: CSV_PATH, label: '合并外来记忆库之前自动留档' }, '合并')
  } catch (e) {
    return { ok: false, code: 'PRESNAPSHOT', error: String(e?.message ?? e) }
  }
  let pre = null
  let preBackupNote = ''
  try {
    pre = backupCore().runBackup(STORE_DIR, { label: '合并外来记忆库之前自动留档' })
  } catch (e) {
    preBackupNote = `（全量备份没做成：${String(e?.message ?? e)}；快照 ${preSnap.name} 已留）`
  }
  const preStamp = pre !== null && typeof pre.stamp === 'string' && pre.stamp !== '' ? pre.stamp : preSnap.stamp

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

  return { ...report, dryRun: false, preBackup: preStamp, preSnapshot: preSnap.name, appended, failed, note: preBackupNote, status: backupStatus() }
}

// ── 取代 / 归档（界面按钮走这两个口）──────────────────

/**
 * 界面上的「标记为被取代」：与 `memory_supersede` 工具同一条路。
 *
 * 参数与工具对齐（`目标id` + 新字段），这样「模型调的」和「人点的」行为不会分叉。
 * 与工具的唯一区别：**界面不填新内容也允许**（等于「这条不要了，但留个说明」）。
 */
function supersedeFrom(body) {
  const core = getCore()
  const schema = loadSchema()
  const targetId = typeof body?.目标id === 'string' ? body.目标id.trim() : (typeof body?.targetId === 'string' ? body.targetId.trim() : '')
  if (targetId === '') return { ok: false, code: 'NO_TARGET', error: '要指明取代哪一条（目标id，形如 M-20261024-001）' }

  // 留档失败就不许动库（S-防-2）
  let snap
  try {
    snap = snapshotOrThrow({ storeDir: STORE_DIR, csvPath: CSV_PATH, label: `界面取代 ${targetId}` }, '取代')
  } catch (e) {
    return { ok: false, code: 'PRESNAPSHOT', error: String(e?.message ?? e) }
  }

  const row = {}
  for (const k of ['内容', '环境', '原因', '类型', '深度', '稳定性', '距离', '依据', '项目', '角色', '关键词', '备注', '时间']) {
    const v = typeof body?.[k] === 'string' ? body[k].trim() : ''
    if (v !== '') row[k] = v
  }
  // 界面没给内容时，写一句「被取代」的说明——否则新行内容为空会过不了必填校验，
  // 用户看到的是「失败」，而不是「这条已经退场了」。
  if (row.内容 === undefined) row.内容 = `（被取代：${targetId}）`

  try {
    const r = core.supersedeEntry({ schema, csvPath: CSV_PATH, lockPath: LOCK_PATH, targetId, row })
    if (!r.ok) return { ok: false, code: 'SUPERSEDE', error: r.error }
    return { ok: true, targetId: r.targetId, id: r.id, version: r.version, snapshot: snap.name, status: backupStatus() }
  } catch (e) {
    return { ok: false, code: 'SUPERSEDE', error: String(e?.message ?? e) }
  }
}

/**
 * 归档：把一条**改状态**成 `已归档`。
 *
 * ⚠️ 这是 0.3.0 里**唯一**改已有行的操作，与「只追加」有张力，所以规矩写死在这里：
 *   · **必须**先留快照，留不下来就不许归档；
 *   · 只改 `状态` 这一格，其它格一个字节不动；
 *   · tmp + rename 整体替换（同目录，原子）；
 *   · 改完复核：行数不变、目标行的 `状态` 确实变了、其它行逐字节一致。
 * 取代走追加、归档走改状态——两条路分开，是因为语义不同：
 * 取代 = 「这条被一条新的顶掉了」；归档 = 「这条不要了，但也没有新的」。
 */
function archiveFrom(body) {
  const core = getCore()
  const targetId = typeof body?.目标id === 'string' ? body.目标id.trim() : (typeof body?.targetId === 'string' ? body.targetId.trim() : '')
  const want = typeof body?.状态 === 'string' ? body.状态.trim() : '已归档'
  if (targetId === '') return { ok: false, code: 'NO_TARGET', error: '要指明归档哪一条（目标id）' }
  if (!['已归档', '生效'].includes(want)) {
    return { ok: false, code: 'BAD_STATUS', error: `只能归档成「已归档」或复活成「生效」，收到「${want}」` }
  }

  let snap
  try {
    snap = snapshotOrThrow({ storeDir: STORE_DIR, csvPath: CSV_PATH, label: `归档 ${targetId} → ${want}` }, '归档')
  } catch (e) {
    return { ok: false, code: 'PRESNAPSHOT', error: String(e?.message ?? e) }
  }

  try {
    return core.withLock(LOCK_PATH, () => {
      const text = readFileSync(CSV_PATH, 'utf8')
      const { header, rows } = core.readTable(text, core.legacyWidthOf(loadSchema()))
      const idIdx = header.indexOf('id')
      const stIdx = header.indexOf('状态')
      if (idIdx < 0 || stIdx < 0) return { ok: false, code: 'BAD_HEADER', error: '表头缺 id 或 状态 列' }

      const at = rows.findIndex((r) => String(r[idIdx] ?? '').trim() === targetId)
      if (at < 0) return { ok: false, code: 'NOT_FOUND', error: `库里没有 id 为 ${targetId} 的条目` }
      const before = String(rows[at][stIdx] ?? '').trim()
      if (before === want) return { ok: true, targetId, from: before, to: want, changed: false, snapshot: snap.name }

      // 只改这一格。行是二维数组，改完按原表头重新序列化——**其它格逐字节保留**
      // （`cell()` 会按需加引号，与 parseCSV 对称，所以往返不丢信息）。
      const line = rows[at].slice()
      line[stIdx] = want
      const newLine = line.map((v) => core.cell(v)).join(',')

      // 整份重写：表头 + 逐行（目标行换新、其余原样）。用 tmp + rename。
      const lines = text.split('\n')
      // 找到目标行在**文本**里的位置（数据行序号 at 对应第 at+1 行，第 0 行是表头）
      let seen = -1
      let replaced = false
      for (let i = 0; i < lines.length; i++) {
        if (i === 0) continue
        if (lines[i].trim() === '') continue
        seen++
        if (seen === at) { lines[i] = newLine; replaced = true; break }
      }
      if (!replaced) return { ok: false, code: 'LOCATE', error: '定位到目标行失败，没有改动' }
      atomicReplace(CSV_PATH, Buffer.from(lines.join('\n'), 'utf8'))

      // 复核：行数不变、目标状态确实变了
      const after = core.readTable(readFileSync(CSV_PATH, 'utf8'), core.legacyWidthOf(loadSchema()))
      const at2 = after.rows.findIndex((r) => String(r[after.header.indexOf('id')] ?? '').trim() === targetId)
      const okRow = at2 >= 0 && String(after.rows[at2][after.header.indexOf('状态')] ?? '').trim() === want
      if (after.rows.length !== rows.length || !okRow) {
        return { ok: false, code: 'VERIFY', error: `归档后复核没通过（行数 ${rows.length}→${after.rows.length}），请用快照 ${snap.name} 回退` }
      }
      return { ok: true, targetId, from: before, to: want, changed: true, snapshot: snap.name, status: backupStatus() }
    })
  } catch (e) {
    return { ok: false, code: 'ARCHIVE', error: String(e?.message ?? e) }
  }
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

/**
 * 读 POST 的 JSON 体。
 *
 * P2-4：超大时**不能再静默变成 `{}`**——上层拿到空对象只会报「参数不全」，
 * 用户看到的是「你填的东西没生效」，而不是「文件太大」。这里抛一个带
 * `code: 'TOO_LARGE'` 的错误，由路由层翻成 413 + 人话。
 * 体坏了仍给 `{}`（那是「参数不全」，语义正确）。
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024
function readBody(req) {
  return new Promise((done, fail) => {
    let raw = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true
        raw = ''
        const err = new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB 上限`)
        err.code = 'TOO_LARGE'
        fail(err)
        try { req.destroy() } catch { /* 已断 */ }
      }
    })
    req.on('end', () => { if (!tooLarge) { try { done(raw.trim() === '' ? {} : JSON.parse(raw)) } catch { done({}) } } })
    req.on('error', () => { if (!tooLarge) done({}) })
  })
}
