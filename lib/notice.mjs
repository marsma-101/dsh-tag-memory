// notice.mjs —— 智能体的「记忆文件」探测 + 托管块维护
//
// 要解决的问题（主子 2026-10-13 的原话）：
//   「MEMORY.md 是我智能体的记忆文件，本来写的是因为没有插件注入导致的漏读的内容。
//     如果用了插件，这个文件可以记其他内容，比如记忆插件的简单说明。插件需要有个检测，
//     检测当前流程中有没有类似记忆文件的内容，然后添加相应的说明或者说明入口，让智能体
//     知道有这个记忆系统在运行。不能轻易删除。」
//
// 于是本模块只做一件事：在一处**受控的、带标记的**区块里，维护一段「记忆系统在运行」的
// 说明。区块之外一个字节都不碰；文件不存在就跳过（主子：「没有就不用管了」）。
//
// 三条不可动摇的规矩：
//   ① **只认标记**：内容永远藏在 BEGIN/END 之间。标记是我们认领这块地的唯一凭据。
//      没有标记 = 用户自己写的 = 不碰（只追加，不重写）。
//   ② **只追加 / 原位替换**：有标记 → 只替换标记之间；无标记 → 追加到文件末尾。
//      任何情况下都不重写、不删除、不重排块外的内容。
//   ③ **首次落笔先留档**：第一次改动某个文件前，先写 `<file>.bak-<时间戳>`。
//
// 「不能轻易删除」的落地：见 `selfHeal()` —— 插件每次挂载都会核对标记还在不在，不在就补回。
// 人被删了块，下次挂载自动长回来；但绝不会因此覆盖用户写在块外的东西。

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

/** 托管块标记。**不带版本号**——版本写进正文，这样升版也能原地替换、不会出现双块。 */
export const NOTICE_BEGIN = '<!-- BEGIN dsh-tag-memory notice -->'
export const NOTICE_END = '<!-- END dsh-tag-memory notice -->'

/** 旧的手工字典块（人在插件上线前贴进 MEMORY.md 的那段）。可由本模块接管替换。 */
export const LEGACY_DICT_BEGIN = '<!-- BEGIN marsma101-tag-memory dict -->'
export const LEGACY_DICT_END = '<!-- END marsma101-tag-memory dict -->'

/** 探测默认只认这个名字（大小写不敏感）。主子定的：只认 MEMORY.md。 */
export const DEFAULT_MEMORY_FILE_NAMES = ['MEMORY.md']

const p2 = (n) => String(n).padStart(2, '0')
/**
 * 本地时间戳 `YYYYMMDD-HHMMSS`，用于 `.bak` 命名。
 *
 * P2-6：原来只到**秒**，同一秒内写两次会撞名——`copyFileSync` 直接把上一份备份盖掉，
 * 「首次落笔先留档」的承诺就漏了一份。这里加毫秒 + 4 位随机后缀，同秒也不可能撞。
 * 保留可读的时间前缀，排序仍按时间。
 */
function stamp(now = new Date()) {
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}-${ms}${rand}`
}

/** `.bak` 保留上限：超出按「最老的先删」，别让备份目录无限长。 */
const MAX_BAK_PER_FILE = 20

/** 把某个记忆文件的 `.bak-*` 轮转到最多 `MAX_BAK_PER_FILE` 份（最老的删）。 */
function rotateBaks(filePath) {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.bak-`
  let names
  try { names = readdirSync(dir).filter((n) => n.startsWith(prefix)) } catch { return }
  if (names.length <= MAX_BAK_PER_FILE) return
  // 时间戳前缀可排序（YYYYMMDD-HHMMSS-...），直接字典序取最老的
  names.sort()
  for (const n of names.slice(0, names.length - MAX_BAK_PER_FILE)) {
    try { unlinkSync(join(dir, n)) } catch { /* 删不掉就算了 */ }
  }
}

// ── 探测：哪些文件算「记忆文件」──────────────────────────

/**
 * 在 presetRoot（形如 `<DSH_HOME>/.agent-presets`）下枚举 `*​/<name>`。
 * 返回 [{ agent, dir, file, path }]；只含**真实存在**的文件。
 * 名字比较大小写不敏感（Windows 上尤其要如此）。
 */
export function detectMemoryFiles(presetRoot, { names = DEFAULT_MEMORY_FILE_NAMES } = {}) {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const out = []
  if (!existsSync(presetRoot)) return out

  let entries
  try { entries = readdirSync(presetRoot, { withFileTypes: true }) } catch { return out }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(presetRoot, e.name)
    let files
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!wanted.has(f.toLowerCase())) continue
      const path = join(dir, f)
      try { if (!statSync(path).isFile()) continue } catch { continue }
      out.push({ agent: e.name, dir, file: f, path })
    }
  }
  return out
}

// ── 生成正文 ────────────────────────────────────────────

/**
 * 渲染托管块正文（含标记）。
 * 内容刻意保持**字节恒定**：它是随 persona 每轮注入的，改一次就伤一次提示词缓存。
 * 所以这里不写会变的绝对路径，只留稳定的相对描述。
 */
export function renderNotice({ skillName = 'marsma101-tag-memory', pluginName = 'dsh-tag-memory', tools = ['memory_write', 'memory_recall'] } = {}) {
  const eol = '\n'
  return [
    NOTICE_BEGIN,
    `## 记忆：插件 ${pluginName} 正在运行（本文件只留说明）`,
    '',
    // 正门排在最前（2026-10-30 主子纠正）：这段每轮随 persona 注入，是模型动手前读到的东西。
    // 以前第一句先说库文件在哪、工具排第三句——等于又把模型往文件系统引。先说走哪个门，再提位置。
    `- **要记 / 要查：调用 \`${tools.join('\` / \`')}\` 工具**（同一份读写逻辑）；`
      + '不要用 read / cat / grep 直接打开库文件，也不要用 write / edit / shell 重定向改它。',
    '- 标签字典**每轮由插件自动注入**——不必每轮手动加载才发现记忆存在。',
    '- 库文件（\`store/memory.csv\`，只追加的标签记忆）的位置只是**排查用的参考**，日常读写一律走上面的工具。',
    NOTICE_END,
  ].join(eol)
}

// ── 写入：托管块 upsert ─────────────────────────────────

/** 用文件主流的换行风格（CRLF 文件别被我们改成 LF）。 */
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 把含标记的区块从 text 里摘掉，返回 { text, found, malformed }。块外的内容原样保留。
 *
 * **只有 BEGIN、没有 END 时不猜**（2026-10-22 P1-1）：以前这里截到 BEGIN 之前，等于把
 * 「BEGIN 之后的所有内容」当成块内内容删掉——END 被误删时，用户写在下面的正文会整段消失。
 * 现在原样返回 + malformed 标记，由调用方**放弃这次改动**，一个字节都不动。
 */
function stripBlock(text, begin, end) {
  const b = text.indexOf(begin)
  if (b < 0) return { text, found: false, malformed: false }
  const e = text.indexOf(end, b)
  if (e < 0) return { text, found: true, malformed: true } // 孤立 BEGIN：不截尾，原文照还
  return { text: text.slice(0, b) + text.slice(e + end.length), found: true, malformed: false }
}

/** malformed 时的统一说法（upsert / remove 共用，界面与日志都读这一句）。 */
function malformedMessage(kind) {
  return `标记不完整（有 BEGIN 没有 END${kind ? `：${kind}` : ''}）——为避免删掉块外内容，本次不修改文件。`
}

/**
 * 对一个记忆文件做 upsert。**只在标记之间动手，或追加到末尾。**
 * 返回 { changed, action, backup, removedLegacy, malformed, error }；不抛错（由 selfHeal 兜）。
 *
 *   action: 'unchanged' | 'added' | 'replaced' | 'malformed'
 *   - 已有同名标记块，且内容相同 → unchanged（一个字节不写）
 *   - 已有标记块，内容不同     → replaced（块内替换）
 *   - 无标记块                 → added（追加到末尾）
 *   - 标记不完整（有 BEGIN 没 END）→ malformed（**不动文件**，见下）
 *
 * malformed 有两处来源，处理方式不同：
 *   ① 我们自己的块只有 BEGIN → 不截尾、不追加、不备份，**整份文件一个字节不动**（malformed: true）；
 *   ② 旧字典块只有 BEGIN、摘它会截尾 → **只放弃迁移**（保留旧块），文件本身照常按
 *      「块内替换 / 末尾追加」走；这个放弃记在 `legacyMalformed` + `warning` 里，不算失败。
 * 任何情况下块外的用户正文逐字节保留。
 *
 * `migrateLegacyDict`：若文件里有旧的手工字典块，一并摘掉（用新的 notice 取代它）。
 * 这是「插件接管手工注入」的一次性迁移；默认开。
 */
export function upsertNotice(filePath, noticeText, { migrateLegacyDict = true, now = new Date(), backup = true } = {}) {
  const none = { changed: false, action: 'absent', backup: null, removedLegacy: false, malformed: false, legacyMalformed: false, error: null, warning: null }
  if (!existsSync(filePath)) return none

  const original = readFileSync(filePath, 'utf8')
  const eol = eolOf(original)
  const notice = eol === '\r\n' ? noticeText.replace(/\n/g, '\r\n') : noticeText

  // 1) 先摘掉旧的手工字典块（若开了迁移）。孤立 BEGIN → 放弃迁移，旧块原样留着。
  let work = original
  let removedLegacy = false
  let legacyMalformed = false
  let warning = null
  if (migrateLegacyDict) {
    const r = stripBlock(work, LEGACY_DICT_BEGIN, LEGACY_DICT_END)
    if (r.malformed) {
      // 旧块不完整：不摘它（摘了就会连带删掉它后面的用户正文），其余照常。
      legacyMalformed = true
      warning = `旧字典块标记不完整（有 BEGIN 没有 END）：已放弃迁移、旧块原样保留。`
    } else if (r.found) {
      work = r.text
      removedLegacy = true
    }
  }

  // 2) 再看有没有我们自己的块
  const before = work.indexOf(NOTICE_BEGIN)
  const afterEnd = before >= 0 ? work.indexOf(NOTICE_END, before) : -1

  // 2b) 只有 BEGIN、没有 END：不猜块到哪儿结束，整份文件一个字节不动。
  if (before >= 0 && afterEnd < 0) {
    return { changed: false, action: 'malformed', backup: null, removedLegacy: false, malformed: true, legacyMalformed, error: malformedMessage('dsh-tag-memory notice'), warning }
  }
  const hasOwn = before >= 0 && afterEnd >= 0
  const existing = hasOwn ? work.slice(before, afterEnd + NOTICE_END.length) : null

  // 3) 只有「自己的块没变」且「没摘过旧块」（work 仍等于原文）时，才算真正没变
  if (hasOwn && existing === notice && work === original) {
    return { changed: false, action: 'unchanged', backup: null, removedLegacy: false, malformed: false, legacyMalformed, error: null, warning }
  }

  let next
  let action
  if (hasOwn) {
    next = work.slice(0, before) + notice + work.slice(afterEnd + NOTICE_END.length)
    action = 'replaced'
  } else {
    const trimmed = work.replace(/[ \t\r\n]+$/, '')
    next = (trimmed === '' ? '' : trimmed + eol + eol) + notice + eol
    action = 'added'
  }

  if (next === original) return { changed: false, action: 'unchanged', backup: null, removedLegacy, malformed: false, legacyMalformed, error: null, warning }

  let backupPath = null
  if (backup) {
    backupPath = `${filePath}.bak-${stamp(now)}`
    copyFileSync(filePath, backupPath)
    rotateBaks(filePath)
  }
  writeFileSync(filePath, next, 'utf8')
  return { changed: true, action, backup: backupPath, removedLegacy, malformed: false, legacyMalformed, error: null, warning }
}

// ── 卸载：把托管块摘掉 ─────────────────────────────────

/**
 * 把托管块从记忆文件里摘掉，**块外原样保留**（卸载时用）。
 * 规矩与 upsert 对称：**只认标记**——没有标记就当是用户自己写的，一个字节都不动。
 * 摘完把文件末尾多余的空白收成一个换行：upsert 追加时在块前留了空行，收掉才能让
 * 「装 → 卸」回到装之前那一版。
 *
 * 返回 { changed, action, backup, malformed, error }；
 * action: 'absent' | 'unchanged' | 'removed' | 'malformed'
 *
 * 标记不完整（有 BEGIN 没 END）→ malformed：**不动文件**。卸载是常规操作，宁可留下一个
 * 残缺块，也不能因为「猜不到块在哪儿结束」就把用户写在后面的正文整段删掉。
 */
export function removeNotice(filePath, { backup = true, now = new Date() } = {}) {
  if (!existsSync(filePath)) return { changed: false, action: 'absent', backup: null, malformed: false, error: null }

  const original = readFileSync(filePath, 'utf8')
  const eol = eolOf(original)
  const r = stripBlock(original, NOTICE_BEGIN, NOTICE_END)
  if (r.malformed) {
    return { changed: false, action: 'malformed', backup: null, malformed: true, error: malformedMessage('dsh-tag-memory notice') }
  }
  if (!r.found) return { changed: false, action: 'unchanged', backup: null, malformed: false, error: null }

  const trimmed = r.text.replace(/[ \t\r\n]+$/, '')
  const next = trimmed === '' ? '' : trimmed + eol
  if (next === original) return { changed: false, action: 'unchanged', backup: null, malformed: false, error: null }

  let backupPath = null
  if (backup) {
    backupPath = `${filePath}.bak-${stamp(now)}`
    copyFileSync(filePath, backupPath)
    rotateBaks(filePath)
  }
  writeFileSync(filePath, next, 'utf8')
  return { changed: true, action: 'removed', backup: backupPath, malformed: false, error: null }
}

// ── 自愈：挂载时核对所有记忆文件 ────────────────────────

/**
 * 探测 presetRoot 下所有记忆文件，逐个 upsert。
 * 这就是「不能轻易删除」的落地：块被删了，下次挂载补回来。
 * 单个文件失败不影响其余；绝不 throw。
 *
 * 返回 { checked, written, unchanged, malformed, absent, items: [...] }
 * 标记不完整的文件在 items 里带 `malformed: true` + `error`，**不计入 written**（没写就是没写）。
 */
export function selfHeal({ presetRoot, names = DEFAULT_MEMORY_FILE_NAMES, noticeText, migrateLegacyDict = true, now = new Date() } = {}) {
  const summary = { checked: 0, written: 0, unchanged: 0, malformed: 0, items: [] }
  const files = detectMemoryFiles(presetRoot, { names })
  const text = noticeText ?? renderNotice()

  for (const f of files) {
    summary.checked++
    let r
    try {
      r = upsertNotice(f.path, text, { migrateLegacyDict, now })
    } catch (e) {
      summary.items.push({ ...f, malformed: false, error: String(e?.message ?? e) })
      continue
    }
    if (r.changed) summary.written++
    else if (r.malformed) summary.malformed++
    else if (r.action === 'unchanged') summary.unchanged++
    summary.items.push({ ...f, ...r })
  }
  return summary
}
