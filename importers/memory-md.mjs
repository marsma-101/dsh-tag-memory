// memory-md.mjs —— MEMORY.md → 标准 21 列 CSV（卡 kmvrga9wrqyvd）
//
// **这是一个独立导入器，不进内核。**
//
// 为什么放插件外面：格式适配是无限长的尾巴——MEMORY.md、mnemon 的 SQLite、Cherry 的
// JOURNAL.jsonl、单位记忆库……每加一种就改内核，内核会变成一堆适配器。
// 内核该守的只有「写入口径」：mergeFrom + validateRow + 事实键，这三件已经够了。
// 缺的只是「把外部格式先转成标准 CSV」这一步。
//
// 所以分工固定：
//   任意来源 → [本导入器] → 标准 21 列 CSV → 插件 mergeFrom（复用准入/判重/快照/校验/脱敏闸）
//
// **本文件不碰库**：只读源文件、只写 CSV 产物。落库由 mergeFrom 负责——
// 这样「预演 → 确认 → 落笔」的全套安全机制自动复用，导入器不可能绕过任何一道闸。
//
// 用法：
//   node importers/memory-md.mjs <MEMORY.md> [-o out.csv] [--project 项目名]

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 标准表头（21 列）。与插件内置模板逐字一致——用例钉这条。 */
export const HEADER = [
  'id', '内容', '时间', '环境', '原因', '备注', '稳定性', '成熟度', '距离', '角色', '项目',
  '状态', '关键词', '工具', '版本', '依据', '类型', '强度', '最后强化', '已验证项目', '使用次数',
]

/** CSV 单元格（与 core 的 cell() 同一规则：含引号/逗号/换行就加引号）。 */
function cell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** 本地日期 YYYY-MM-DD。不用 toISOString（UTC 会错天）。 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 解析 MEMORY.md 正文 → 条目数组。
 *
 * 支持的形态：
 *   1. `- 内容 [source: ...]` / `* 内容` / `1. 内容` —— 列表项，最常见
 *   2. `## 标题` 分节下的列表项 —— 标题不单独成条，只作为上下文记进备注
 *   3. 无标记的连续段落（空行分隔）—— 每段一条
 *
 * 元信息抽取：`[source: part 1 #24; by: Chief; added: 2026-10-23]` 里
 * `added:` 抽成时间、`by:` 抽成角色。抽不到就留空（由 mergeFrom 的 autoFill 建议补）。
 */
export function parseMemoryMd(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let para = []
  let section = ''

  const flushPara = () => {
    const t = para.join(' ').trim()
    para = []
    if (t === '') return
    out.push(makeEntry(t, 0))
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()

    if (line === '') { flushPara(); continue }

    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h !== null) {
      flushPara()
      section = h[1].trim()
      continue
    }

    const li = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (li !== null) {
      flushPara()
      const body = li[1].trim()
      if (body !== '') out.push(makeEntry(body, i + 1, section))
      continue
    }

    para.push(line)
  }
  flushPara()
  return out
}

/** 一条原始文本 → 条目（抽元信息）。 */
function makeEntry(body, lineNo, section = '') {
  let content = body
  let 时间 = ''
  let 角色 = ''

  const srcBlocks = []
  content = content.replace(/\[source:\s*([^\]]+)\]/gi, (_m, inner) => {
    srcBlocks.push(String(inner))
    return ''
  }).trim()

  const all = srcBlocks.join('; ')
  const added = all.match(/added:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i)
  if (added !== null) 时间 = added[1]
  const by = all.match(/by:\s*([^;|]+)/i)
  if (by !== null) 角色 = String(by[1]).trim()

  content = content.replace(/\s{2,}/g, ' ').trim()
  return { 内容: content, 时间, 角色, 原始行: lineNo, 分节: section }
}

/**
 * 条目数组 → 标准 21 列 CSV 文本。
 *
 * **不合格行要标出来，不能静默丢**：缺内容的条目不写进 CSV，但会记进 `skipped`
 * 返回给调用方，由它报给人看。
 */
export function toCsv(entries, opts = {}) {
  const project = typeof opts.project === 'string' && opts.project.trim() !== '' ? opts.project.trim() : '通用'
  const role = typeof opts.role === 'string' && opts.role.trim() !== '' ? opts.role.trim() : '导入器'
  const now = typeof opts.now === 'string' && opts.now.trim() !== '' ? opts.now.trim() : localDate()

  const lines = [HEADER.join(',')]
  const skipped = []
  let seq = 0
  const day = now.replace(/-/g, '')

  for (const e of entries) {
    const content = String(e?.内容 ?? '').trim()
    if (content === '') {
      skipped.push({ 内容: '', 原因: '内容为空' })
      continue
    }
    seq++
    const id = `M-${day}-${String(seq).padStart(3, '0')}`
    // 只填**能确定的**字段，其余留空交给 mergeFrom 的 autoFill 建议（不在这里瞎猜）
    const row = {
      id,
      内容: content,
      时间: String(e?.时间 ?? '').trim() || now,
      // 环境/原因也是必填——转换器必须自己给出**有意义的**默认值，不能留空让 mergeFrom 拒掉
      // （卡片的验收判据：转换器输出必须能通过 validateRow）。
      // 「环境」写来源，因为这条确实是从那儿来的；「原因」写导入目的，用户看备注能追。
      环境: `从 ${e?.来源 ?? 'MEMORY.md'} 导入`,
      原因: '外部记忆源导入，尚无更具体的成立条件与理由',
      备注: e?.分节 ? `来源分节：${e.分节}` : '',
      稳定性: '稳定',
      距离: '按需',
      角色: String(e?.角色 ?? '').trim() || role,
      项目: project,
      状态: '生效',
      依据: '推断',
      类型: '记忆',
      强度: '1',
      最后强化: now,
      使用次数: '0',
    }
    lines.push(HEADER.map((h) => cell(row[h] ?? '')).join(','))
  }
  return { csv: lines.join('\n') + '\n', rows: seq, skipped }
}

/** 命令行入口。 */
function main(argv) {
  const args = argv.slice(2)
  const src = args.find((a) => !a.startsWith('-'))
  if (src === undefined) {
    console.error('用法：node importers/memory-md.mjs <MEMORY.md> [-o out.csv] [--project 项目名]')
    process.exitCode = 2
    return
  }
  const oIdx = args.indexOf('-o')
  const pIdx = args.indexOf('--project')
  const outPath = oIdx >= 0 && args[oIdx + 1] !== undefined ? args[oIdx + 1] : resolve(src, '..', 'imported.csv')
  const project = pIdx >= 0 && args[pIdx + 1] !== undefined ? args[pIdx + 1] : undefined

  let text = ''
  try { text = readFileSync(src, 'utf8') } catch (e) {
    console.error(`读不了源文件：${String(e?.message ?? e)}`)
    process.exitCode = 1
    return
  }
  const entries = parseMemoryMd(text)
  const res = toCsv(entries, { project })
  writeFileSync(outPath, res.csv, 'utf8')

  console.log(`已转换 ${res.rows} 条 → ${outPath}`)
  if (res.skipped.length > 0) {
    console.log(`注意 ${res.skipped.length} 条没转（内容为空）：`)
    for (const s of res.skipped.slice(0, 10)) console.log(`  - ${s.原因}`)
  }
  console.log('')
  console.log('下一步：在插件「记忆」页用「合并」把它并进来（先预演、确认后再落库）。')
  console.log('  转换器不碰库——准入/判重/快照/校验/脱敏闸全部由 mergeFrom 负责。')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv)
}
