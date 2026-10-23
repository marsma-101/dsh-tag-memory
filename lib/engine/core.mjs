// core.mjs —— 标签记忆的「一份逻辑」（纯函数，无副作用入口）
//
// 谁用：
//   · 技能自己的 CLI：scripts/append.mjs / filter.mjs（薄壳，import 本文件）
//   · DSH 插件 dsh-tag-memory：preset.js 的两个工具（memory_write / memory_recall）
// 一份逻辑不分叉——读写规则只在这里定义一次，技能与插件共用。
//
// 本文件不读 process.argv、不 process.exit；错误用 throw，由调用方决定怎么报。
// 只有 withLock 里的「等锁」是唯一与时间相关的副作用，其余皆纯。

import { readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync, existsSync, renameSync } from 'node:fs'

// ── 时间 / 小工具 ───────────────────────────────────────

/** 本地日期戳 `YYYYMMDD`（用于 id）。**不用 toISOString**——那是 UTC，跨零点会错天。 */
export function localDay(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
}

/** 本地日期 `YYYY-MM-DD`（用于 `时间` 列的默认值）。 */
export function localDate(now = new Date()) {
  const d = localDay(now)
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
}

/** 阻塞等待（拿锁失败时用）。优先 Atomics.wait，退化到忙等。 */
export function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const t = Date.now()
    while (Date.now() - t < ms) { /* busy wait */ }
  }
}

// ── CSV 解析 / 序列化 ───────────────────────────────────

/** 解析 CSV 文本 → 二维数组（保留空行由调用方过滤）。支持引号、转义引号、多行单元格。 */
export function parseCSV(text) {
  const rows = []
  let row = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else q = false
      } else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}

/** 一列值 → CSV 单元格（需要时加引号）。 */
export function cell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * CSV 文本 → 数据行（去掉表头与全空行）。返回 `{ header, rows, ragged }`。
 *
 * `ragged` 是「格子数跟表头对不上」的那些行，每条记 `{ row, id, got, want }`
 * （`row` 是按数据行数的序号，从 1 起——引用时不带行号，因为单元格里可能有换行）。
 *
 * **为什么单列出来**：列是按下标取的。一行少一格，它后面每一格都往前串一位——
 * 界面上「时间」那格显示的是「环境」，人看着有值、其实串到别列去了；
 * 判重拿它跟新条目比，比的也是错字段。这种错位**不报错、不丢行**，最难发现。
 * 所以这里只**点名、不改行、不抛错**：读的路径（界面 / 备份）还得能把这些行读出来，
 * 怎么处置交给上层——写入那道闸在 `appendEntry` 里。
 *
 * **末尾缺列不算错位（0.3.0 起）**：`强度/最后强化/已验证项目/使用次数` 这 4 列是后加的，
 * 老库的存量行天然比新表头少 4 格。这跟「中间错位」是两回事——
 *   · 末尾缺列：前面的格子**位置全对**，只是后加的那几列没有值 → 补默认值即可；
 *   · 中间错位：格子往前串了位 → 每一列都可能是错的 → 必须报 ragged。
 * 判据是 `LEGACY_WIDTH`（老库的列数，写在字典的 `storage.legacyWidth` 里）：
 * 格子数 ≥ LEGACY_WIDTH 且 < 表头长度 → 视为「老行，末尾缺列」。
 *
 * 不加这条会怎样：只把表头改成 21 列、存量行不动，`ragged` 立刻非空，
 * `appendEntry` 的闸一拦，**整本库从此一条都写不进去**（实测复现过）。
 */
export function readTable(csvText, legacyWidth) {
  const all = parseCSV(csvText)
  const header = all[0] ?? []
  const rows = []
  const ragged = []
  const legacyTail = []
  const lw = Number.isFinite(legacyWidth) && legacyWidth > 0 ? Math.floor(legacyWidth) : 0
  for (const r of all.slice(1)) {
    if (!r[0]) continue
    if (r.length !== header.length) {
      // 末尾缺列：够老宽度、但不够新表头 → 是老行，不是错位。
      const isLegacyTail = lw > 0 && r.length >= lw && r.length < header.length
      if (isLegacyTail) {
        legacyTail.push({ row: rows.length + 1, id: String(r[0] ?? ''), got: r.length, want: header.length })
      } else {
        ragged.push({ row: rows.length + 1, id: String(r[0] ?? ''), got: r.length, want: header.length })
      }
    }
    rows.push(r)
  }
  return { header, rows, ragged, legacyTail }
}

/**
 * 新列（0.3.0 加的那 4 列）的默认值。
 *
 * `最后强化` 的默认值是**行级**的：等于这一行自己的 `时间`，不是常量。
 * 拿常量（比如「今天」）会让一条两年前的老记忆衰减起点变成今天——
 * 它明明早该淡出，却因为补了默认值而看起来刚强化过。衰减起点错了，整条链都错。
 */
export const NEW_COLUMNS = ['强度', '最后强化', '已验证项目', '使用次数']

/**
 * 老库的列数（末尾缺列容忍的判据）。
 *
 * 写在字典的 `storage.legacyWidth` 里，而不是硬编码在代码里——将来再加列时，
 * 把老宽度往上挪一格就行，不用改 core。字典没写就退回「现有表头长度减新列数」。
 */
export function legacyWidthOf(schema) {
  const v = schema?.storage?.legacyWidth
  if (Number.isFinite(v) && v > 0) return Math.floor(v)
  const header = schema?.storage?.header
  if (Array.isArray(header) && header.length > 0) return Math.max(1, header.length - NEW_COLUMNS.length)
  return 0
}

/** 一条行的新列默认值（`时间` 列缺失时退回空串，让调用方自己决定）。 */
export function newColumnDefaults(row, get) {
  const t = String((get ? get(row, '时间') : (row?.时间 ?? '')) || '').trim()
  return {
    强度: '1',
    最后强化: t,
    已验证项目: '',
    使用次数: '0',
  }
}

/**
 * 读一条行时，把缺失的新列补上默认值。**只补不写**——返回一份新的取值函数，
 * 绝不回写 CSV（老库文件一个字节都不动，这是 0.3.0 的兼容承诺）。
 *
 * 为什么要这层而不是直接改 rows：`rows` 是二维数组，列是按下标取的；
 * 老行比表头短，`r[i]` 对越界的下标返回 `undefined`。直接往 `rows` 里塞值
 * 会改变行的格子数，而 `ragged` 判定、`buildLine` 都依赖原始格子数——
 * 那是把「读」变成「改」，正是要避免的。所以补在**取值这一层**。
 */
export function withColumnDefaults(header, get) {
  const has = new Set(Array.isArray(header) ? header : [])
  return (row, name) => {
    const raw = get(row, name)
    if (String(raw ?? '') !== '') return raw
    // 表头里**有**这列但值为空 → 尊重空值（用户可能故意清空）。
    // 表头里**没有**这列（老库）→ 才是「缺列」，补默认值。
    if (has.has(name)) return raw
    if (!NEW_COLUMNS.includes(name)) return raw
    const d = newColumnDefaults(row, get)
    return d[name] ?? ''
  }
}

/**
 * 这份库的表头是不是还没跟上字典（缺 0.3.0 的 4 列）。
 *
 * 返回 `{ needed, missing }`。`needed=true` 的意思是：
 *   · 读：完全没问题（读时按默认值补，见 `withColumnDefaults`）；
 *   · 写：**新列的值落不了盘**——`buildLine` 按**磁盘上那份表头**拼行，
 *         表头没有这几列，写进去的行就只有 17 格，新列下次读还是默认值。
 * 所以「能读」和「能写新列」是两件事，必须分开报，不能拿「读得出来」冒充「迁移完成」。
 */
export function headerMigrationNeeded(schema, header) {
  const want = Array.isArray(schema?.storage?.header) ? schema.storage.header : []
  const have = Array.isArray(header) ? header : []
  const missing = want.filter((c) => !have.includes(c))
  return { needed: missing.length > 0, missing }
}

/**
 * 把库表头**升到字典那一版**（只改第 1 行，数据行逐字节不动）。
 *
 * 为什么必须显式做、不能「读的时候顺手升」：
 *   读路径一旦会写盘，「我只是看了一眼」就变成「我改了库」——备份、sha256 校验、
 *   只读审计全部失真。所以升级是一个**动作**，由调用方在快照之后主动发起。
 *
 * 为什么只改表头就够了：老数据行是 17 格、新表头 21 格，`readTable` 靠 `legacyWidth`
 * 把它们认成「末尾缺列的老行」而不是错位行——所以数据行一格都不用动。
 *
 * @returns {{ ok: boolean, changed: boolean, before: number, after: number, error: string }}
 */
export function migrateHeader({ schema, csvPath, lockPath }) {
  const out = { ok: false, changed: false, before: 0, after: 0, error: '' }
  if (!existsSync(csvPath)) { out.error = '找不到 ' + csvPath; return out }
  const want = Array.isArray(schema?.storage?.header) ? schema.storage.header : []
  if (want.length === 0) { out.error = '字典里没有 storage.header，不知道该升成什么样'; return out }

  return withLock(lockPath, () => {
    const text = readFileSync(csvPath, 'utf8')
    const firstNl = text.indexOf('\n')
    if (firstNl < 0) { out.error = '库文件里连表头都没有（没有换行）'; return out }
    const headLine = text.slice(0, firstNl)
    const rest = text.slice(firstNl) // 含那个 \n，数据行一个字节不碰
    const parsed = parseCSV(headLine + '\n')[0] ?? []
    out.before = parsed.length
    out.after = want.length
    if (parsed.length === want.length && parsed.every((c, i) => c === want[i])) {
      out.ok = true
      out.changed = false
      return out
    }
    const newHead = want.map(cell).join(',')
    // tmp + rename：中途崩溃不能留下「半截表头 + 数据行」这种读不出来的状态。
    const tmp = csvPath + '.tmp-' + Date.now()
    writeFileSync(tmp, newHead + rest, 'utf8')
    renameSync(tmp, csvPath)
    out.ok = true
    out.changed = true
    return out
  })
}

// ── 字典名 ↔ CSV 列 ─────────────────────────────────────

/** 字典名 → CSV 列名（`深度`→`成熟度` 等映射在 schema 里；无映射则同名）。 */
export function fieldToColumn(schema, name) {
  const d = schema.dimensions?.[name] ?? schema.auxiliary?.[name]
  return d && d.column ? d.column : name
}

/** 维度/辅助项的允许取值；不可枚举返回 null（表示「不校验」）。 */
export function enumValues(schema, name) {
  const d = schema.dimensions?.[name] ?? schema.auxiliary?.[name]
  if (!d || typeof d.values !== 'object' || Array.isArray(d.values)) return null
  return Object.keys(d.values)
}

/** 造一个「字典名 → 列下标」的解析器（列缺失返回 -1）。 */
export function makeResolver(schema, header) {
  const dictToCol = {}
  for (const [name, spec] of Object.entries({ ...schema.dimensions, ...schema.auxiliary })) {
    if (spec.column) dictToCol[name] = spec.column
  }
  return (name) => header.indexOf(dictToCol[name] ?? name)
}

// ── 校验（照 schema）────────────────────────────────────

/**
 * 校验一条待写入的行（字段名用字典名）。
 * 返回 { ok, errors: string[] }；不改入参。
 */
export function validateRow(schema, row) {
  const errors = []
  const required = (schema.rules?.required ?? []).filter((k) => k !== 'id')
  const missing = required.filter((k) => !String(row[k] ?? '').trim())
  // 拒绝的话得**说清为什么**，不然只丢一句「不能为空」，写的人（模型）只会随便填一个值糊过去。
  // 空值不是格式问题，是**这条记忆凭什么成立**的问题——所以这里说的是「缺了它会怎样」。
  if (missing.length) {
    errors.push('必填项缺失：' + missing.join(' / ') +
      '。这几项说的是「这条记忆在什么条件下成立、凭什么」——' +
      '缺了它们，这条换到另一个项目就会被当成通用做法误用。请补上再写' +
      '（确实是长期有效的规矩，用 `深度=程序` + `距离=常驻` 写明适用场景）。')
  }

  if (String(row.时间 ?? '') && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.时间))) {
    errors.push('`时间` 必须是 YYYY-MM-DD，当前：' + row.时间 +
      '。库里按这个写法排先后，别的写法排不出来。')
  }

  for (const [name, spec] of Object.entries({ ...schema.dimensions, ...schema.auxiliary })) {
    const v = row[name]
    if (v == null || v === '') continue
    const allowed = enumValues(schema, name)
    if (allowed && !allowed.includes(String(v))) {
      errors.push(`\`${name}\` 取值非法：${v}（允许：${allowed.join(' / ')}）。` +
        '字典里只认这几个取值，自己造一个词进去，按这一维筛的时候就永远筛不到它。')
    }
    void spec
  }

  // 激活规则：`深度` 仅当 类型=记忆
  const gate = schema.dimensions?.深度?.gated
  const col = schema.dimensions?.深度?.column
  const depthValue = col ? (row.深度 ?? row[col]) : row.深度
  if (gate && row.类型 && row.类型 !== '记忆' && String(depthValue ?? '').trim()) {
    errors.push(`\`类型=${row.类型}\` 时 \`深度\` 必须留白` +
      '（字典规则：`深度` 说的是「这条被提炼到什么程度」，只有 类型=记忆 才谈得上；' +
      '`原文` 是原样保存、`固定` 是本机硬信息，两者都不判深度）。')
  }

  return { ok: errors.length === 0, errors }
}

// ── 写入去重 ────────────────────────────────────────────

/** 判重看这三样：同一句「什么」、同一个「用在哪」、同一种「是哪一类」。 */
const DUP_KEYS = ['内容', '项目', '类型']

/**
 * 库里有没有一条「内容 + 项目 + 类型」都一样的**生效**条目。
 *
 * 为什么要在写入这一层拦：同一句话写十遍，库看起来只是变长，
 * 但**筛出来就是两条一模一样的东西**——读的时候不知道该信哪一条，
 * 而且两条会各自演进（一条改了、另一条没改），越往后越说不清哪条算数。
 * 正确姿势是**取代**：新的那条写进来，旧的那条改成 `状态=被取代` 退场（库里不删行）。
 *
 * `被取代` / `已归档` 的条目不算重复——它们本来就该被新的一条顶掉。
 */
export function findDuplicate(header, rows, row) {
  const idx = DUP_KEYS.map((k) => header.indexOf(k))
  if (idx.some((i) => i < 0)) return null // 老库缺列：判不了就不判，不装作判过了
  const want = DUP_KEYS.map((k) => String(row[k] ?? '').trim())
  if (want[0] === '') return null
  const statusIdx = header.indexOf('状态')
  const idIdx = header.indexOf('id')
  for (const r of rows) {
    const st = statusIdx < 0 ? '' : String(r[statusIdx] ?? '').trim()
    if (st === '被取代' || st === '已归档') continue
    if (DUP_KEYS.every((_, n) => String(r[idx[n]] ?? '').trim() === want[n])) {
      return { id: idIdx < 0 ? '' : String(r[idIdx] ?? '') }
    }
  }
  return null
}

/**
 * 库里已经有「格子数对不上」的行时，写入要停下来。
 *
 * 为什么不是「照写不误、只提醒一句」：错位的行**不报错、不丢行**，它就静静躺在那儿，
 * 但是判重是按下标比字段的——拿一条串了位的行去跟新条目比「内容」，比的根本不是内容。
 * 于是「这条库里已经有了」判不出来，同一句话又写进去一条，库里从此两条各自演进。
 * 宁可当场停下、把坏的那一条点名，也不要让它继续长。
 *
 * 修法两条：把那一行补齐到与表头同样多的格子；拿不准就用「恢复」退回上一份备份——
 * 备份是整份替换，从来不看列数对不对，所以**旧备份里带着错位行也救得回来**。
 */
function raggedError(ragged) {
  const who = ragged.slice(0, 3)
    .map((r) => `第 ${r.row} 条（${r.id || '没有 id'}：${r.got} 格 / 应为 ${r.want} 格）`)
    .join('、')
  return new Error(
    `这份库里已经有 ${ragged.length} 行字段数对不上（${who}${ragged.length > 3 ? ' 等' : ''}），先修好再写。` +
    '列是按位置读的：错位的那一行，它后面每一格都串到别的字段上了，' +
    '这时候再往里写，判重会比错字段、界面会把别的列当这一列显示——错的地方只会越摊越大。' +
    '修法：把那一行补齐（或拆成两行）到与表头同样多的格子；' +
    '拿不准就用「恢复」退回上一份备份（备份是整份替换，不看列数，一定救得回来）。',
  )
}

/** 这份库支持哪些后加的机制（插件与自检据此**诚实降级**，而不是假装有）。 */
export const CORE_FEATURES = {
  teachingErrors: true,
  writeDedupe: true,
  raggedGuard: true,
  // 0.3.0 新增：末尾缺列容忍（老库表头加了列也能继续写）、新列读时补默认值、取代与读侧反查
  legacyTailTolerant: true,
  columnDefaults: true,
  supersede: true,
}

// ── 并发安全：文件锁 ────────────────────────────────────

/**
 * 拿独占文件锁跑 fn，跑完释放。
 * 锁 = `openSync(lockPath,'wx')` 的独占创建；陈旧锁（mtime 超过 staleMs）自动夺。
 * fn 抛错也保证释放。拿不到锁 → throw。
 */
export function withLock(lockPath, fn, { retries = 60, waitMs = 50, staleMs = 30000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        return fn()
      } finally {
        closeSync(fd)
        try { unlinkSync(lockPath) } catch { /* 别人已清 */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue }
      } catch { /* 锁刚好被放掉 */ }
      sleep(waitMs)
    }
  }
  throw new Error('拿不到写锁（' + lockPath + '）。若确认没有别的进程在写，删掉该锁文件重试。')
}

// ── 取号 + 组装一行 ─────────────────────────────────────

/** 当天已有最大序号 +1 → `M-YYYYMMDD-NNN`。 */
export function nextId(header, rows, now = new Date()) {
  const idIdx = header.indexOf('id')
  if (idIdx < 0) throw new Error('CSV 表头里没有 `id` 列')
  const prefix = `M-${localDay(now)}-`
  let max = 0
  for (const r of rows) {
    const v = r[idIdx] || ''
    if (v.startsWith(prefix)) {
      const n = parseInt(v.slice(prefix.length), 10)
      if (n > max) max = n
    }
  }
  return prefix + String(max + 1).padStart(3, '0')
}

/** 按表头列顺序，把字典名字段拼成一条 CSV 行。 */
export function buildLine(schema, header, row) {
  const names = Object.keys({ ...schema.dimensions, ...schema.auxiliary, id: 1 })
  return header.map((col) => {
    for (const name of names) {
      if (fieldToColumn(schema, name) === col) return cell(row[name])
    }
    return cell(row[col])
  }).join(',') + '\n'
}

// ── 衰减与强化（M-整-1，惰性结算）────────────────────────
//
// 公式照抄 MM（`改进计划 §C-5`，常量在 MM `lib/store.js` L88-98）：
//     强度 = 上次强化强度 × e^(−λ × 小时数)，λ = ln2 / 半衰期
//     半衰期：情景 30 天 / 语义 90 天 / 程序 120 天
//     阈值 ARCHIVE_THRESHOLD = 0.1（只产候选，**不自动归档**）
//     强化 REINFORCE_BOOST = 0.3（封顶 1.0）
//
// **关键决定：不写 memory.csv。**
// MM 有个 `settle()` 把衰减写回文件。在 CSV 上照抄会打架：并发写、锁、界面显示
// 三件事全都会出问题，而且「每读一次就写一次盘」会让 sha256 校验、只读审计全失真。
// 所以这里**只算不写**；真正的落盘只有一件事——**recall 命中时往 reinforce.log 追加一行**。
// 强度是「日志 + 老值」算出来的，CSV 数据行一个字节都不动。

/** 三档半衰期（天）。抄 MM L88-92，别自创数值。 */
export const HALF_LIFE_DAYS = { 情景: 30, 语义: 90, 程序: 120 }
/** 归档候选阈值（MM L95）。低于它只是「候选」，进待整理清单，不自动归档。 */
export const ARCHIVE_THRESHOLD = 0.1
/** 每次强化加多少（MM L98）。 */
export const REINFORCE_BOOST = 0.3
/** 晋升阈值：独立项目数（MM L105）。**不是调用次数**。 */
export const PROMOTE_PROJECT_THRESHOLD = 3

/** 深度缺失时的兜底半衰期：取语义档（中间值），不取最短的——宁可少衰减，别误伤。 */
const DEFAULT_HALF_LIFE = 90

/**
 * 一条记忆**现在**的强度。纯函数，不碰盘。
 *
 * 豁免（O-2 拍板，两个都豁免）：
 *   · `距离=常驻` → 1。主子的长期偏好是免死金牌，钉住的就不该淡出。
 *   · `类型=固定` → 1。硬信息（文件在哪、装在哪）不会过期，衰减它没有意义。
 *
 * @param {object} row    字段用**字典名**（不是列名），`强度/最后强化/深度/类型/距离` 都要有
 * @param {Date}   [now]
 * @returns {number} 0~1
 */
export function currentStrength(row, now = new Date()) {
  if (String(row?.距离 ?? '') === '常驻') return 1
  if (String(row?.类型 ?? '') === '固定') return 1

  const last = String(row?.最后强化 ?? '').trim() || String(row?.时间 ?? '').trim()
  if (last === '') return 1 // 连时间都没有：算不出来，按「没衰减」处理，别误伤

  const base = Number(row?.强度)
  const strength0 = Number.isFinite(base) && base >= 0 ? Math.min(1, base) : 1

  const depth = String(row?.深度 ?? '').trim()
  const halfDays = HALF_LIFE_DAYS[depth] ?? DEFAULT_HALF_LIFE
  const t0 = Date.parse(last + 'T00:00:00')
  if (!Number.isFinite(t0)) return strength0
  const hours = (now.getTime() - t0) / 3600000
  if (hours <= 0) return strength0 // 未来时间（时钟漂移）：不衰减
  const lambda = Math.LN2 / (halfDays * 24) // 每小时
  return Math.max(0, Math.min(1, strength0 * Math.exp(-lambda * hours)))
}

/** 是不是归档候选（强度 < 0.1）。**只读判断**——不会改任何东西。 */
export function isArchiveCandidate(row, now = new Date()) {
  return currentStrength(row, now) < ARCHIVE_THRESHOLD
}

/** 强化后的强度（封顶 1）。纯计算，不落盘。 */
export function boostedStrength(row) {
  const base = Number(row?.强度)
  const s0 = Number.isFinite(base) && base >= 0 ? base : 1
  return Math.min(1, s0 + REINFORCE_BOOST)
}

/**
 * 拆 `已验证项目`（分号分隔）→ 项目名数组（去重、去空）。
 *
 * 分隔符三种都收：分号、逗号、竖线。用户手打时这三种都有人用，
 * 只认分号会把「通用；workspace, 测试文件夹」这种写法数成 2 个项目（实际 3 个）。
 */
export function verifiedProjects(row) {
  const raw = String(row?.已验证项目 ?? '')
  if (raw.trim() === '') return []
  return Array.from(new Set(raw.split(/[;；,，|｜]/).map((x) => x.trim()).filter((x) => x !== '')))
}

/**
 * 晋升候选：**独立项目数 ≥ 3**。只读，不改状态。
 *
 * 判据是「独立项目数」而不是「调用次数」——同一条在同一个项目里用 100 次，
 * 仍然是关于这个项目的规则。这条是 MM 的设计，也是「错晋升」这道闸的全部意义。
 */
export function isPromotionCandidate(row) {
  return verifiedProjects(row).length >= PROMOTE_PROJECT_THRESHOLD
}

// ── 强化日志（R1 追加式账本）──────────────────────────────
//
// 为什么是日志不是改行：memory.csv 的铁律是「只追加」，而强化要改某条已有行的 3 个格子。
// 底盘的 core.mjs 原本只有一处 appendFileSync、没有任何改行能力（改行得整表重写）。
// 所以强化落在一个**旁路账本**里，读的时候把账本合并到行上——
// CSV 数据行一个字节不动，审计、sha256 校验、并发写三件事全都保住了。
//
// 账本一行一条，CSV 格式：
//     <id>,<YYYY-MM-DD>,<项目>,<kind>
//   kind = `reinforce`（召回命中，强度+0.3、次数+1）
//        = `verify`（召回命中且当前项目没验证过，记一个独立项目）
// 一行可能同时产生两条记录（既强化又验证），各管各的，读的时候分别合并。

/** 账本一行的形态。逗号分隔，字段里出现逗号就加引号（项目名一般不会有）。 */
function logLine(id, day, project, kind) {
  return [cell(id), cell(day), cell(project), cell(kind)].join(',') + '\n'
}

/**
 * 读强化日志 → 按 id 汇总。
 *
 * @returns {{ byId: Map<string, {uses:number, last:string, projects:string[], lines:number}> }}
 *   `last` 取**最晚**的日期（不是最后一行——日志可能乱序或补写老日期）
 */
export function readReinforceLog(logPath) {
  const out = new Map()
  if (!logPath || !existsSync(logPath)) return out
  let text = ''
  try { text = readFileSync(logPath, 'utf8') } catch { return out }
  for (const r of parseCSV(text)) {
    if (!r[0] || String(r[0]).trim() === '') continue
    const id = String(r[0]).trim()
    const day = String(r[1] ?? '').trim()
    const project = String(r[2] ?? '').trim()
    const kind = String(r[3] ?? '').trim()
    let e = out.get(id)
    if (e === undefined) { e = { uses: 0, last: '', projects: [], lines: 0 }; out.set(id, e) }
    e.lines++
    if (kind === 'reinforce') {
      e.uses++
      if (day !== '' && day > e.last) e.last = day // 字典序即日期序（YYYY-MM-DD）
    } else if (kind === 'verify' && project !== '' && !e.projects.includes(project)) {
      e.projects.push(project)
    }
  }
  return out
}

/**
 * 把日志合并到一行上，返回**这一行现在的样子**（新对象，不改入参）。
 *
 * 合并规则：
 *   · `使用次数` = CSV 里的基数 + 日志里的 reinforce 次数；
 *   · `最后强化` = CSV 值与日志里最晚日期，取**更晚**的那个；
 *   · `强度` = 基数 × e^(−λ×距最后强化的小时)，但**每次 reinforce 都把时间往前推**——
 *     等价于「从最后一次强化开始衰减」，比逐次累加强度简单且不会算错。
 *     实际做法：基数 + 0.3×次数，封顶 1，再从最后强化时间衰减。
 *   · `已验证项目` = CSV 里的 ∪ 日志里的。
 *
 * 为什么「基数 + 0.3×次数」而不是「逐次累加」：日志里同一条可能被强化几十次，
 * 逐次累加要按时间顺序重放，还得处理「中间又衰减过」——而惰性结算的语义就是
 * 「最后一次强化决定当前值」，按次数一次性加成与逐次加成在**封顶 1.0** 时结果相同。
 */
export function applyReinforceLog(row, get, entry) {
  const merged = { ...row }
  const csvUses = Number(get(row, '使用次数'))
  const uses = (Number.isFinite(csvUses) && csvUses >= 0 ? csvUses : 0) + (entry?.uses ?? 0)
  merged.使用次数 = String(uses)

  const csvLast = String(get(row, '最后强化') ?? '').trim()
  const logLast = entry?.last ?? ''
  const last = logLast !== '' && (csvLast === '' || logLast > csvLast) ? logLast : csvLast
  merged.最后强化 = last

  const csvProjects = verifiedProjects({ 已验证项目: get(row, '已验证项目') })
  const projects = Array.from(new Set([...csvProjects, ...(entry?.projects ?? [])]))
  merged.已验证项目 = projects.join(';')

  const csvStrength = Number(get(row, '强度'))
  const base0 = Number.isFinite(csvStrength) && csvStrength >= 0 ? csvStrength : 1
  // 每次 reinforce +0.3，封顶 1（与 boostedStrength 同一条规矩，只是按次数批量算）
  merged.强度 = String(Math.min(1, base0 + REINFORCE_BOOST * (entry?.uses ?? 0)))
  return merged
}

/**
 * 追加一条强化/验证记录。**调用方必须已持写锁**（与 appendEntry 同一把）。
 *
 * @returns {{ ok: boolean, wrote: number, error: string }}
 */
export function appendReinforceLog({ logPath, id, project = '', day, reinforce = false, verify = false }) {
  const out = { ok: false, wrote: 0, error: '' }
  const theDay = String(day ?? '').trim()
  if (!logPath || String(id ?? '').trim() === '') { out.error = '日志路径或 id 为空'; return out }
  if (!reinforce && !verify) { out.error = '既不是强化也不是验证，没东西可写'; return out }
  try {
    let buf = ''
    if (reinforce) buf += logLine(id, theDay, project, 'reinforce')
    if (verify) buf += logLine(id, theDay, project, 'verify')
    appendFileSync(logPath, buf, 'utf8')
    out.ok = true
    out.wrote = (reinforce ? 1 : 0) + (verify ? 1 : 0)
    return out
  } catch (e) {
    out.error = String(e?.message ?? e)
    return out
  }
}

// ── 盘点四清单（一份逻辑，两个入口）──────────────────────
//
// 模型用 `memory_review({类型:'盘点'})` 调，界面用 `GET /review` 调。
// **判据只写一遍**：写两遍迟早会分叉（改了强度阈值忘了改项目数，或者反过来），
// 而分叉的后果是「界面说该整理、工具说不用整理」——最难查的那种不一致。

/**
 * 盘点四张清单。**只读**：不改库、不改状态、不落盘。
 *
 * @param {object} o
 * @param {object} o.schema
 * @param {string[]} o.header
 * @param {any[][]} o.rows
 * @param {Map} [o.logMap]   强化日志汇总（`readReinforceLog` 的结果）
 * @param {Date} [o.now]
 * @returns {{衰减候选:any[], 晋升候选:any[], 原文总结未配对:any[], 缺口未补:any[], 统计:object}}
 */
export function reviewInventory({ schema, header, rows, logMap = new Map(), now = new Date() }) {
  const resolve = makeResolver(schema, header)
  const pick = (row, name) => { const i = resolve(name); return i >= 0 ? String(row[i] ?? '') : '' }
  const fieldOf = (row) => {
    // **`id` 必须显式收进来**：它不是字典维度、也不是辅助项，只按
    // `dimensions + auxiliary` 收会漏掉它 → 清单里的条目没有 id，
    // 界面上「归档」按钮拿到的是 undefined，点了没反应（这个 bug 是自检抓出来的）。
    const o = { id: pick(row, 'id') }
    for (const name of Object.keys({ ...schema.dimensions, ...schema.auxiliary })) o[name] = pick(row, name)
    for (const col of ['内容', '时间', '环境', '原因', '备注', '状态']) o[col] = pick(row, col)
    return o
  }
  const brief = (o) => ({ id: o.id, 内容: String(o.内容 ?? '').split('\n')[0].slice(0, 42), 项目: o.项目, 时间: o.时间 })

  // 只看「生效」条目：退场的条目不该出现在任何整理清单里。
  const live = filterRows(schema, header, rows, {}).map(fieldOf)

  const decay = []
  const promote = []
  const gaps = []
  for (const f of live) {
    const merged = applyReinforceLog(f, (x, n) => x[n] ?? '', logMap.get(String(f.id ?? '').trim()))
    const strength = currentStrength(merged, now)
    if (strength < ARCHIVE_THRESHOLD) {
      decay.push({ ...brief(f), 强度: Number(strength.toFixed(3)), 深度: f.深度, 距离: f.距离, 最后强化: merged.最后强化 })
    }
    if (isPromotionCandidate({ 已验证项目: merged.已验证项目 })) {
      const projs = verifiedProjects({ 已验证项目: merged.已验证项目 })
      promote.push({ ...brief(f), 已验证项目: merged.已验证项目, 项目数: projs.length })
    }
    const note = String(f.备注 ?? '')
    const kw = String(f.关键词 ?? '')
    if ((note.includes('缺口') || kw.includes('缺口')) && String(f.状态 ?? '') === '生效') gaps.push(brief(f))
  }

  // 原文-总结配对：靠 `备注` 里的「配套：<id>」互指。两边都记进 `paired`。
  const paired = new Set()
  for (const f of live) {
    for (const m of String(f.备注 ?? '').match(/配套[：:]\s*([^\s,，;；|｜]+)/g) || []) {
      const id = m.replace(/^配套[：:]\s*/, '').trim()
      if (id !== '') { paired.add(id); paired.add(String(f.id ?? '').trim()) }
    }
  }
  const unpaired = []
  for (const f of live) {
    const id = String(f.id ?? '').trim()
    if (String(f.类型 ?? '').trim() !== '记忆') continue   // 只看「总结」
    if (paired.has(id)) continue                          // 配上了
    if (String(f.关键词 ?? '').includes('缺口')) continue   // 缺口是提醒，不是结论，不参与配对
    unpaired.push(brief(f))
  }

  return {
    衰减候选: decay.sort((a, b) => a.强度 - b.强度),
    晋升候选: promote.sort((a, b) => b.项目数 - a.项目数),
    原文总结未配对: unpaired,
    缺口未补: gaps,
    统计: {
      生效条目: live.length,
      衰减候选: decay.length,
      晋升候选: promote.length,
      未配对: unpaired.length,
      缺口: gaps.length,
    },
  }
}

// ── 取代（S-防-3 的「状态翻转」在 0.3.0 的落地）────────────
//
// 方案 a：**追加式取代**。旧行一个字节不改，新行 `备注` 写 `取代：<旧id>`，
// 读侧反查这个备注把旧行当退场。为什么不在旧行上把 `状态` 改成 `被取代`：
//   ① 底盘是纯追加的（core.mjs 只有一处 appendFileSync，没有改行能力）；
//   ② 改行要整表重写，中途崩溃就得靠快照救，风险远大于收益；
//   ③ 追加式可回滚：想恢复，把新行状态改成「已归档」，旧行自然复活（备注还在，但反查集合空了）。
//
// 代价：旧行的 `状态` 列会一直显示「生效」。所以界面与召回**都必须**走反查，
// 只读 `状态` 列的地方会看到旧条（这正是 0.2.x 的 P0-2）。

/** 备注里「取代：<id>」的形态。全角/半角冒号都收（用户手打时两种都有人用）。 */
const SUPERSEDE_RE = /取代[：:]\s*([^\s,，;；|｜]+)/g

/**
 * 从备注里抽出「这条取代了谁」。
 * 返回 id 数组（可能为空；备注里可以写多个「取代：A；取代：B」）。
 */
export function supersedesOf(note) {
  const out = []
  const text = String(note ?? '')
  for (const m of text.matchAll(SUPERSEDE_RE)) {
    const id = String(m[1] ?? '').trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 扫全库，建「已被取代的 id」集合。
 *
 * **这是读侧退场的唯一判据**：`filterRows` / 快照 / 关键词兜底 / 界面列表四处都要用它，
 * 漏一处就会出现「快照里没有、recall 却查得到」这种最坑的不一致。
 *
 * 两条防呆：
 *   · 只认**生效**的新行——新行自己被归档了，它的取代关系就不该再生效（旧条复活）；
 *   · 自己取代自己（备注写错）不算，否则会把一条本来好好的条目弄消失。
 */
export function supersededIds(header, rows) {
  const noteIdx = header.indexOf('备注')
  const idIdx = header.indexOf('id')
  const statusIdx = header.indexOf('状态')
  const set = new Set()
  if (noteIdx < 0 || idIdx < 0) return set
  for (const r of rows) {
    const st = statusIdx < 0 ? '' : String(r[statusIdx] ?? '').trim()
    if (st === '已归档') continue // 归档掉的新行，不再行使取代效力
    const self = String(r[idIdx] ?? '').trim()
    for (const oldId of supersedesOf(r[noteIdx])) {
      if (oldId !== '' && oldId !== self) set.add(oldId)
    }
  }
  return set
}

/**
 * 校验一次取代请求，返回目标行的位置与内容。
 *
 * 拒绝的三种情形各给**不同的**话（不是统一一句「目标无效」）：
 *   · 不存在 → 多半是 id 抄错，把库里的 id 长什么样提示一下；
 *   · 已被取代 → 指出取代它的那条，让模型去改那一条；
 *   · 已归档 → 说明归档是终态，要复活得先改状态。
 */
export function findSupersedeTarget(schema, header, rows, targetId) {
  const id = String(targetId ?? '').trim()
  if (id === '') return { ok: false, error: '要取代哪一条？必须点名 `目标id`（形如 M-20261024-001），不点名不改。' }
  const idIdx = header.indexOf('id')
  const statusIdx = header.indexOf('状态')
  if (idIdx < 0) return { ok: false, error: '这份库的表头里没有 `id` 列，没法定位目标。' }

  const dead = supersededIds(header, rows)
  let hit = null
  for (const r of rows) if (String(r[idIdx] ?? '').trim() === id) { hit = r; break }
  if (hit === null) {
    return { ok: false, error: `库里没有 id 为 ${id} 的条目（id 形如 M-YYYYMMDD-NNN，先用 memory_recall 查准）。` }
  }
  const st = statusIdx < 0 ? '' : String(hit[statusIdx] ?? '').trim()
  if (st === '已归档') {
    return { ok: false, error: `${id} 是**已归档**状态，归档是终态，不能直接取代。要接着用这条，先把它的 \`状态\` 改回 \`生效\`。` }
  }
  if (st === '被取代' || dead.has(id)) {
    const by = rows.find((r) => supersedesOf(r[header.indexOf('备注')]).includes(id) && String(r[idIdx] ?? '') !== id)
    const byId = by === undefined ? '' : String(by[idIdx] ?? '')
    return { ok: false, error: `${id} 已经被取代过了${byId === '' ? '' : `（取代它的是 ${byId}）`}。要改的是**现在生效的那一条**。` }
  }
  return { ok: true, row: hit, status: st }
}

/** 把「取代：<旧id>」接到一条备注上（原有备注保留，分号接在后面）。 */
export function withSupersedeNote(note, oldId) {
  const base = String(note ?? '').trim()
  const tag = `取代：${oldId}`
  if (base === '') return tag
  // 已经写过了就不重复接
  if (supersedesOf(base).includes(String(oldId))) return base
  return `${base}；${tag}`
}

/** `版本` 进位：空或 v1 → v2；vN → v(N+1)；认不出的原样带上再补 v2。 */
export function nextVersion(version) {
  const v = String(version ?? '').trim()
  const m = v.match(/^v(\d+)$/i)
  if (m) return `v${parseInt(m[1], 10) + 1}`
  if (v === '') return 'v2'
  return `${v}→v2`
}

/**
 * 追加式取代：写一条新条目，备注指向旧 id；旧行**一个字节不动**。
 *
 * 流程（全部在写锁内，中途失败不落笔）：
 *   1. 校验目标：存在、状态=生效、没被别人取代过；
 *   2. 以旧行为底，合并新内容/新字段（没给的字段沿用旧行——取代不是「重写」，是「换一条更好的」）；
 *   3. `备注` 接上 `取代：<旧id>`；`版本` 进位；`状态`=生效；
 *   4. 取号、组装、追加。
 *
 * **不做判重**：取代的场景本来就是「内容变了」，`findDuplicate` 会拿新内容和库里那条旧的比——
 * 但旧的那条马上要被取代，比中了也不该拦。反之若新内容撞上**另一条无关的**条目，
 * 那是用户该自己看清的事（工具回执里会把新 id 报出来，撞了能立刻发现）。
 *
 * @returns {{ ok: boolean, id: string, targetId: string, version: string, error: string }}
 */
export function supersedeEntry({ schema, csvPath, lockPath, targetId, row, now = new Date() }) {
  const out = { ok: false, id: '', targetId: String(targetId ?? '').trim(), version: '', error: '' }
  if (!existsSync(csvPath)) { out.error = '找不到 ' + csvPath; return out }

  return withLock(lockPath, () => {
    const text = readFileSync(csvPath, 'utf8')
    const { header, rows, ragged } = readTable(text, legacyWidthOf(schema))
    if (ragged && ragged.length > 0) throw raggedError(ragged)

    const found = findSupersedeTarget(schema, header, rows, out.targetId)
    if (!found.ok) { out.error = found.error; return out }

    // 以旧行为底：没给的新字段沿用旧值（取代一条记忆时，环境/原因/项目这些通常不用重填）。
    // 逐列按下标取——`found.row` 就是库里的那一行，不是副本。
    const merged = {}
    for (let i = 0; i < header.length; i++) merged[header[i]] = found.row[i] ?? ''
    for (const [k, v] of Object.entries(row ?? {})) {
      if (v === undefined || v === null || String(v).trim() === '') continue
      merged[k] = String(v).trim()
    }
    // 旧 id 不继承：新行要拿自己的号
    delete merged.id
    merged.状态 = '生效'
    if (!String(merged.时间 ?? '').trim()) merged.时间 = localDate(now)
    merged.备注 = withSupersedeNote(merged.备注, out.targetId)
    merged.版本 = nextVersion(merged.版本)
    out.version = merged.版本

    const v = validateRow(schema, merged)
    if (!v.ok) { out.error = v.errors.join('；'); return out }

    const id = nextId(header, rows, now)
    merged.id = id
    const sep = text === '' || text.endsWith('\n') ? '' : '\n'
    appendFileSync(csvPath, sep + buildLine(schema, header, merged), 'utf8')
    out.ok = true
    out.id = id
    return out
  })
}

// ── 读：条件求值 ────────────────────────────────────────

const asArr = (x) => (Array.isArray(x) ? x : [x])

/** 条件里是否显式提到某列（用于「状态」默认排除那类规则）。 */
export function mentions(col, node) {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((n) => mentions(col, n))
  return Object.entries(node).some(([k, v]) => k === col || mentions(col, v))
}

function inRange(val, r) {
  if (!Array.isArray(r) || r.length !== 2) throw new Error('区间要写成 ["起","止"]')
  const [lo, hi] = r
  return val !== '' && val >= lo && val <= hi // ISO 日期可直接字典序比较
}

/**
 * 白名单值。**注意**：`schema.rules.universal` 是一句中文说明（给人读的），
 * 不是值本身——早期 `filter.mjs` 误把它当值用，等于白名单从未生效。这里用词表里的
 * 字面量 `通用`；若 schema 显式给了 `rules.universalValue` 则以它为准。
 */
export const UNIVERSAL_VALUE = '通用'

function matchKey(schema, resolve, col, v, row, warn) {
  const idx = resolve(col)
  if (idx < 0) { warn?.(col); return true } // 列不存在 → 不限
  const val = row[idx] || ''
  const universal = schema.rules?.universalValue ?? UNIVERSAL_VALUE

  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    if ('区间' in v) return inRange(val, v.区间)
    return matchNode(schema, resolve, v, row, warn)
  }

  return asArr(v).some((x) => {
    const s = String(x)
    if (s === '留白') return val === ''
    if (val === '') return false
    if (val === universal) return true
    return val === s
  })
}

/** 条件节点求值。支持 与/或/非、数组=或、区间、留白、多值、`通用`白名单。 */
export function matchNode(schema, resolve, node, row, warn) {
  if (node == null) return true
  if (Array.isArray(node)) return node.some((n) => matchNode(schema, resolve, n, row, warn))
  if (typeof node !== 'object') throw new Error('条件写法不对：' + JSON.stringify(node))

  if ('或' in node) return asArr(node.或).some((n) => matchNode(schema, resolve, n, row, warn))
  if ('非' in node) return !matchNode(schema, resolve, node.非, row, warn)
  if ('与' in node) return asArr(node.与).every((n) => matchNode(schema, resolve, n, row, warn))

  return Object.entries(node).every(([col, v]) => matchKey(schema, resolve, col, v, row, warn))
}

/**
 * 一次完整筛选。
 *   schema/header/rows：来自 readTable
 *   cond：结构化条件
 * 返回命中行数组（默认排除 状态=被取代/已归档，除非条件显式提到 状态）。
 */
export function filterRows(schema, header, rows, cond, warn) {
  const resolve = makeResolver(schema, header)
  const explicitStatus = mentions('状态', cond)
  const statusIdx = resolve('状态')
  const idIdx = resolve('id')
  // 读侧反查：旧行状态还是「生效」，但新行备注写了「取代：旧id」→ 旧行算退场。
  // 只算一次、全表共用；每行都现算会把 O(n²) 塞进召回路径。
  const dead = explicitStatus ? new Set() : supersededIds(header, rows)
  return rows.filter((r) => {
    if (!explicitStatus && statusIdx >= 0) {
      const s = r[statusIdx] || ''
      if (s === '被取代' || s === '已归档') return false
    }
    // 显式提了「状态」就不剔——用户/界面要查历史（含已归档）时得看得见旧条。
    if (!explicitStatus && idIdx >= 0 && dead.has(String(r[idIdx] ?? '').trim())) return false
    return matchNode(schema, resolve, cond, r, warn)
  })
}

// ── 字典渲染（每轮注入的片段）───────────────────────────
//
// 同一份渲染：
//   · 技能 CLI `render-dict.mjs` 用它把片段写进 persona 文件（人肉注入）
//   · DSH 插件 dsh-tag-memory 的 preset.js 用它做 systemPrompt.section（自动注入）
// 插件上线后，人肉那路退役——见 SKILL.md「四道门槛」下方关于插件接管的说明。

export const DICT_BEGIN = '<!-- BEGIN marsma101-tag-memory dict -->'
export const DICT_END = '<!-- END marsma101-tag-memory dict -->'

/** 从 schema 渲染字典片段正文（**不含** BEGIN/END 标记）。 */
export function renderDict(schema) {
  const vals = (name) => {
    const d = schema.dimensions?.[name]
    if (!d || !d.values) return ''
    if (Array.isArray(d.values)) return d.values.join(' / ')
    if (typeof d.values === 'object') return Object.keys(d.values).join(' / ')
    return String(d.values)
  }
  const aux = (name) => {
    const a = schema.auxiliary?.[name]
    if (!a) return ''
    let v = ''
    if (a.values && typeof a.values === 'object' && !Array.isArray(a.values)) v = Object.keys(a.values).join('/')
    else if (typeof a.values === 'string') v = a.values.split(/[（(，,。；;／/]/)[0].trim()
    return v ? `${name}(${v})` : name
  }
  const q = (name) =>
    String(schema.dimensions?.[name]?.question || '')
      .replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').replace(/[？?。]\s*$/, '').trim()

  const D = schema.dimensions
  const lines = []
  lines.push('## 记忆字典（每轮守）· marsma101-tag-memory')
  lines.push('> 完整规则见本插件的 `docs/tags.md` 等文档；库：`store/memory.csv`。')
  lines.push('')
  lines.push('**四个维度**（一列一维，写时逐维填；定不了就留白）：')
  lines.push(`- \`类型\`：${vals('类型')}（${D['类型']?.role || '主开关'}）`)
  lines.push(`- \`深度\`：${vals('深度')}（${D['深度']?.gated ? `仅 ${D['深度'].gated.when} 时填` : ''}）`)
  lines.push(`- \`稳定性\`：${vals('稳定性')}（${q('稳定性')}）`)
  lines.push(`- \`距离\`：${vals('距离')}（${q('距离')}；硬上限 ${D['距离']?.cap ?? 10}）`)
  lines.push('')
  lines.push(`**辅助**：${['角色', '依据', '项目', '状态', '关键词', '工具', '版本'].map(aux).join('  ')}`)
  lines.push(`> 必填：${(schema.rules?.required ?? []).filter((k) => k !== 'id').join(' / ')}`)
  lines.push('')
  lines.push(`**召回**：${(schema.recall?.order ?? []).join(' → ')}。`)
  lines.push(`- 一次取 ${schema.recall?.takeFirst ?? 3} 条；` + (schema.recall?.reportTotalFirst ? '先报命中总数。' : ''))
  lines.push(`- 筛不到：${schema.recall?.miss ?? ''}`)
  lines.push(`- 算子：${(schema.rules?.operators ?? []).join(' / ')}；\`通用\`=白名单，留白=黑名单。`)
  lines.push('')
  // 写入路由：先判这条输入是哪一类，再决定写几条。判据本身在 schema 里（`writeRoutes`），
  // 这里只负责渲染——换措辞不用改代码，改 schema 就行。
  const routes = Array.isArray(schema.writeRoutes?.rules) ? schema.writeRoutes.rules : []
  if (routes.length) {
    lines.push('**写入路由**（先判这条输入是哪一类，再决定写几条）：')
    for (const r of routes) lines.push('- ' + r)
    lines.push('')
  }
  // 用户画像（M-嵌-3 / V4-c）：画像就是库里的普通条目（固定+常驻+通用），
  // 所以它自动进快照全文、自动豁免衰减——不需要另一套存储。
  // 这里把「怎么收集、怎么算维度、怎么维护」渲染给模型看，它才知道该怎么推。
  const pf = schema.profile
  if (pf && typeof pf === 'object') {
    lines.push('')
    lines.push('**用户画像**（让解释的深浅跟着用户水平走，不用每轮从零猜）：')
    if (typeof pf.rule === 'string') lines.push(`- 落库姿势：${pf.rule}`)
    if (Array.isArray(pf.collect)) for (const c of pf.collect) lines.push(`- ${c}`)
    if (Array.isArray(pf.dimensions)) for (const d of pf.dimensions) lines.push(`- ${d}`)
    if (typeof pf.maintain === 'string') lines.push(`- 维护：${pf.maintain}`)
  }

  lines.push('')
  lines.push('**写入**：只追加；改已有条目先问用户。')
  return lines.join('\n')
}

/** 渲染带标记的字典片段（CLI 用人肉注入时用；插件只需要 renderDict）。 */
export function renderDictBlock(schema) {
  return DICT_BEGIN + '\n' + renderDict(schema) + '\n' + DICT_END
}

// ── 组装后的高层动作（技能 CLI 与插件共用）───────────────

/**
 * 追加一条记忆。返回新 id。
 * 抛错即不写入。lockPath 所在目录需已存在（store/ 存在）。
 */
export function appendEntry({ schema, csvPath, lockPath, row, now = new Date() }) {
  const full = { ...row }
  full.状态 = full.状态 || '生效'
  if (!full.时间) full.时间 = localDate(now)
  // 0.3.0 的 4 个新列：写侧从第一条起就带全值（读侧给老库补默认值是另一条路）。
  // `最后强化` 跟着 `时间` 走——新写的一条就是「此刻刚强化过」。
  for (const [name, def] of Object.entries(newColumnDefaults(full))) {
    if (String(full[name] ?? '').trim() === '') full[name] = def
  }

  const v = validateRow(schema, full)
  if (!v.ok) throw new Error(v.errors.join('；'))

  if (!existsSync(csvPath)) {
    throw new Error('找不到 ' + csvPath + '（空库请先用 templates/memory.csv 起表头，见 storage-init.md）')
  }

  return withLock(lockPath, () => {
    const text = readFileSync(csvPath, 'utf8')
    // 带上 `legacyWidth`：老库（表头 17 列）的存量行末尾缺 4 格，那是「老行」不是「错位」。
    // 不带这个参数，只把表头加了列就会让整本库锁死写入（ragged 闸一拦就全停）。
    const { header, rows, ragged } = readTable(text, legacyWidthOf(schema))

    // 先看库**自己**有没有毛病：有错位的行就先不写（判重会拿错位行比错字段）。
    if (ragged && ragged.length > 0) throw raggedError(ragged)

    // 同一句话写第二遍，拦在这里。写在**锁里**：判重和落笔得看见同一份库，
    // 不然两个写入擦肩而过，两条同款照样进得去。
    const dup = findDuplicate(header, rows, full)
    if (dup) {
      throw new Error(
        `这条库里已经有了（${dup.id || '同内容同项目同类'}）。` +
        '同一句话写两条，筛出来就是两条一模一样的东西——读的时候不知道信哪条，' +
        '两条还会各自演进，越往后越说不清哪条算数。' +
        '若这条是要**取代**那条，正确做法是：先确认新内容写清楚，' +
        `再把旧的那条（${dup.id || '上面那条'}）的 \`状态\` 改成 \`被取代\` 让它退场` +
        '（库只追加、不删行，整理时做这一步）。' +
        '若两条其实不是一回事（比如同一个做法在两个项目下各自的规矩），把 `项目` 写具体。',
      )
    }

    const id = nextId(header, rows, now)
    full.id = id
    // 落笔前先看文件末尾有没有换行，没有就自己补一个。
    // 少了这一步，新条目会**粘在上一行的尾巴上**变成一行 32 列——
    // 2026-10-12 就这么丢过一条（M-20261012-015 被并进了 M-20261012-014，
    // 解析出来只剩 31 列，那条记忆实际上等于不存在）。`buildLine` 只保证**结尾**有换行，
    // 保证不了**开头**，所以这个补丁得留在这儿。
    const sep = text === '' || text.endsWith('\n') ? '' : '\n'
    appendFileSync(csvPath, sep + buildLine(schema, header, full), 'utf8')
    return id
  })
}

/** 读一条 CSV 并筛选。返回 { header, hits }。 */
export function recallEntries({ schema, csvPath, cond, warn }) {
  const { header, rows } = readTable(readFileSync(csvPath, 'utf8'), legacyWidthOf(schema))
  return { header, hits: filterRows(schema, header, rows, cond, warn) }
}
