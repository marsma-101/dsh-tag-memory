// core.mjs —— 标签记忆的「一份逻辑」（纯函数，无副作用入口）
//
// 谁用：
//   · 技能自己的 CLI：scripts/append.mjs / filter.mjs（薄壳，import 本文件）
//   · DSH 插件 dsh-tag-memory：preset.js 的两个工具（memory_write / memory_recall）
// 一份逻辑不分叉——读写规则只在这里定义一次，技能与插件共用。
//
// 本文件不读 process.argv、不 process.exit；错误用 throw，由调用方决定怎么报。
// 只有 withLock 里的「等锁」是唯一与时间相关的副作用，其余皆纯。

import { readFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync, existsSync } from 'node:fs'

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
 */
export function readTable(csvText) {
  const all = parseCSV(csvText)
  const header = all[0] ?? []
  const rows = []
  const ragged = []
  for (const r of all.slice(1)) {
    if (!r[0]) continue
    if (r.length !== header.length) {
      ragged.push({ row: rows.length + 1, id: String(r[0] ?? ''), got: r.length, want: header.length })
    }
    rows.push(r)
  }
  return { header, rows, ragged }
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
export const CORE_FEATURES = { teachingErrors: true, writeDedupe: true, raggedGuard: true }

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
  return rows.filter((r) => {
    if (!explicitStatus && statusIdx >= 0) {
      const s = r[statusIdx] || ''
      if (s === '被取代' || s === '已归档') return false
    }
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

  const v = validateRow(schema, full)
  if (!v.ok) throw new Error(v.errors.join('；'))

  if (!existsSync(csvPath)) {
    throw new Error('找不到 ' + csvPath + '（空库请先用 templates/memory.csv 起表头，见 storage-init.md）')
  }

  return withLock(lockPath, () => {
    const text = readFileSync(csvPath, 'utf8')
    const { header, rows, ragged } = readTable(text)

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
  const { header, rows } = readTable(readFileSync(csvPath, 'utf8'))
  return { header, hits: filterRows(schema, header, rows, cond, warn) }
}
