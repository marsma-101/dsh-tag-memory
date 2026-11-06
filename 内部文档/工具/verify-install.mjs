#!/usr/bin/env node
/**
 * verify-install.mjs — 装完插件后跑一遍，验证「补丁 id 对齐 + 数据目录正确」
 *
 * 为什么需要这个脚本（2026-11-06 实装事故）：
 *   1. bundle 补丁（插件自带）insert 的 id 是 `dsh-tag-memory` / `dsh-tag-memory-tools`
 *   2. profile 补丁（部署环境）却写成 `- id: tag-memory` / `- id: tag-memory-preset`
 *   3. Loader 的补丁方言里，顶层 `- id: xxx` 是**按 id 覆盖已存在条目**，
 *      找不到目标就整条**静默丢弃**，只打一条 warn
 *   4. 于是 config.dataDir 根本没传进 apply()，数据静默落到插件包内
 *   5. 包目录会被 pnpm 重装整个删除 → 用户数据丢失
 *
 * 这个脚本就检查第 2、3 步这类错误：**profile 有、bundle 没有的 id**。
 *
 * 用法：
 *   node verify-install.mjs                           # 自动探测当前 DSH profile
 *   node verify-install.mjs --profile <dir>           # 指定 profile 目录
 *   node verify-install.mjs --bundle <pkg-dir>        # 指定插件包目录
 *   node verify-install.mjs --profile <dir> --bundle <dir> --json
 *
 * 退出码：
 *   0 = 全部检查通过
 *   1 = 发现问题（有会被静默丢弃的 id / dataDir 落包内 / 补丁解析失败）
 *   2 = 无法完成检查（找不到文件、缺少 YAML 解析器）
 *
 * 依赖：只用 node: 内置。YAML 解析优先用 profile 里的 yaml，缺失时退回
 *       极简解析器（只认本项目的补丁方言，够用；失败会明确说"未真解析"）。
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
/** 本脚本在 <仓库>/内部文档/工具/ 下 → 仓库根是上两级 */
const REPO_ROOT = resolve(SELF_DIR, '..', '..')

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const hasFlag = (name) => argv.includes(name)

const AS_JSON = hasFlag('--json')

/* ------------------------------------------------------------------ *
 * 输出（人读 / JSON 两套）
 * ------------------------------------------------------------------ */
const report = {
  ok: true,
  problems: [],
  notes: [],
  bundle: { dir: null, patchFile: null, insertIds: [] },
  profile: { dir: null, patchFile: null, overrideIds: [] },
  dataDir: { dir: null, source: null },
}

function problem(code, message, detail) {
  report.ok = false
  report.problems.push({ code, message, detail: detail ?? null })
}
function note(message) {
  report.notes.push(message)
}

function out(...lines) {
  if (AS_JSON) return
  console.log(lines.join('\n'))
}

/* ------------------------------------------------------------------ *
 * YAML 解析：优先真解析器，缺失时用极简补丁方言解析器
 * ------------------------------------------------------------------ */

/**
 * 极简解析器：只认本项目的补丁方言（顶层数组 + id/name/config/insert）。
 * 目的不是通用 YAML —— 而是**在没装 yaml 包的机器上也能查出 id 对不上**。
 * 解析不确定时返回 null，让调用方明确报"未真解析"，绝不假装通过。
 */
function parsePatchFallback(text) {
  const lines = text.split(/\r?\n/)
  const patches = []
  let cur = null
  let mode = null // 'insert' | 'config' | null
  let curIndent = 0
  let insertIndent = -1

  const indentOf = (l) => l.match(/^\s*/)[0].length

  for (const raw of lines) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const indent = indentOf(raw)
    const line = raw.trim()

    // 顶层 `- id: xxx` 或 `- insert:`
    if (line.startsWith('- ') && indent === 0) {
      const body = line.slice(2).trim()
      if (body.startsWith('insert:')) {
        cur = { insert: [] }
        patches.push(cur)
        mode = 'insert'
        insertIndent = -1
        continue
      }
      cur = {}
      patches.push(cur)
      mode = null
      curIndent = indent
      const idm = /^id:\s*(.+)$/.exec(body)
      if (idm) cur.id = unquote(idm[1])
      const nm = /^name:\s*(.+)$/.exec(body)
      if (nm) cur.name = unquote(nm[1])
      continue
    }
    if (!cur) continue

    if (mode === 'insert') {
      if (line.startsWith('- ') && indent > 0) {
        insertIndent = indent
        cur.insert.push({})
        const body = line.slice(2).trim()
        applyKey(cur.insert[cur.insert.length - 1], body)
        continue
      }
      if (insertIndent >= 0 && indent > insertIndent && cur.insert.length > 0) {
        // insert 条目的续行（如 config:\n  dataDir: ...）
        const last = cur.insert[cur.insert.length - 1]
        if (line === 'config:') {
          last.config = {}
          continue
        }
        const km = /^([^:]+):\s*(.*)$/.exec(line)
        if (km && last.config && typeof last.config === 'object') {
          last.config[unquote(km[1])] = unquote(km[2])
        } else {
          applyKey(last, line)
        }
        continue
      }
      continue
    }

    // 非 insert 补丁的字段
    const km = /^([^:]+):\s*(.*)$/.exec(line)
    if (!km) continue
    const key = unquote(km[1])
    const val = km[2]
    if (key === 'config') {
      if (val === '') {
        cur.config = {}
        mode = 'config'
      }
      continue
    }
    if (mode === 'config' && cur.config) {
      cur.config[key] = unquote(val)
      continue
    }
    if (key === 'id') cur.id = unquote(val)
    else if (key === 'name') cur.name = unquote(val)
    else cur[key] = unquote(val)
  }
  return patches
}

function unquote(s) {
  const t = String(s ?? '').trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1)
  return t
}

function applyKey(obj, line) {
  const km = /^([^:]+):\s*(.*)$/.exec(line)
  if (!km) return
  obj[unquote(km[1])] = unquote(km[2])
}

/** 尝试真 YAML 解析（在 profile 的 node_modules 里找 yaml）。 */
async function loadYamlParser(profileDir) {
  const candidates = [
    profileDir ? join(profileDir, 'node_modules', 'yaml', 'dist', 'index.js') : null,
    join(REPO_ROOT, 'node_modules', 'yaml', 'dist', 'index.js'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (!existsSync(c)) continue
    try {
      const m = await import(pathToFileURL(c).href)
      if (typeof m.parse === 'function') return { parse: m.parse, source: c }
    } catch {
      /* 继续试下一个 */
    }
  }
  return null
}

async function parsePatchFile(file, profileDir) {
  // 剥掉 BOM：Windows 编辑器 / PowerShell 的 `Set-Content -Encoding utf8` 常带 U+FEFF，
  // 不剥会让回退解析器第一行 `startsWith('- ')` 失败 → 悄悄漏掉第一个条目。
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const yaml = await loadYamlParser(profileDir)
  if (yaml) {
    try {
      return { patches: yaml.parse(text), parsedBy: yaml.source }
    } catch (e) {
      return { patches: null, parsedBy: null, error: `YAML 解析失败：${e?.message ?? e}` }
    }
  }
  const patches = parsePatchFallback(text)
  if (!Array.isArray(patches)) return { patches: null, parsedBy: null, error: '回退解析失败' }
  return { patches, parsedBy: '内置极简解析器（未真解析，建议装 yaml 包复核）' }
}

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

function detectDshHome() {
  const env = (process.env.DSH_HOME || '').trim()
  if (env) return resolve(env)
  return join(os.homedir(), '.dsh')
}

function detectProfileDir() {
  const explicit = argOf('--profile')
  if (explicit) return resolve(explicit)
  const home = detectDshHome()
  const names = []
  // DSH 里 profile 名通常是 web / headless；按存在性挑
  for (const n of ['web', 'headless', 'default']) {
    const p = join(home, 'profiles', n)
    if (existsSync(p)) names.push(p)
  }
  return names[0] ?? null
}

function detectBundleDir(profileDir) {
  const explicit = argOf('--bundle')
  if (explicit) return resolve(explicit)
  if (!profileDir) return null
  // profile/node_modules/dsh-tag-memory 通常是软链，realpath 到真实包目录
  const p = join(profileDir, 'node_modules', 'dsh-tag-memory')
  if (!existsSync(p)) return null
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** 从包目录读 dsh.bundle.patch 指向的补丁文件名。 */
function bundlePatchFile(bundleDir) {
  const pkgFile = join(bundleDir, 'package.json')
  if (!existsSync(pkgFile)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const rel = pkg?.dsh?.bundle?.patch ?? './cordis.patch.yml'
    return isAbsolute(rel) ? rel : join(bundleDir, rel)
  } catch {
    return join(bundleDir, 'cordis.patch.yml')
  }
}

/**
 * child 是否在 parent 目录内（含相等）。
 *
 * ⚠️ 必须先把分隔符统一：补丁里常写 POSIX 风格的 `/`，而 `realpathSync`
 * 在 Windows 上给 `\`。不归一化就会漏判「数据目录写在包内」这种致命问题
 * （实测踩过：`C:/x/pkg/data` vs `C:\x\pkg` 直接 startsWith 是 false）。
 */
function isInside(child, parent) {
  const norm = (p) => String(p).replace(/[\\/]+/g, sep()).replace(/[\\/]+$/, '')
  const c = norm(resolve(child)).toLowerCase()
  const p = norm(resolve(parent)).toLowerCase()
  return c === p || c.startsWith(p + sep())
}

/** 宿主平台的分隔符。 */
function sep() {
  return process.platform === 'win32' ? '\\' : '/'
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const profileDir = detectProfileDir()
  const bundleDir = detectBundleDir(profileDir)

  out('=== verify-install：dsh-tag-memory 安装校验 ===')
  out(`DSH_HOME:  ${detectDshHome()}`)
  out(`profile:   ${profileDir ?? '(未找到)'}`)
  out(`插件包:    ${bundleDir ?? '(未找到)'}`)
  out('')

  report.profile.dir = profileDir
  report.bundle.dir = bundleDir

  if (!bundleDir) {
    problem('BUNDLE_NOT_FOUND', '找不到已安装的插件包（profile/node_modules/dsh-tag-memory）', {
      profileDir,
      hint: '先确认插件已安装；或显式传 --bundle <包目录>',
    })
    return finish()
  }

  /* ---- 1. bundle 补丁的 insert id ---- */
  const bFile = bundlePatchFile(bundleDir)
  report.bundle.patchFile = bFile
  if (!bFile || !existsSync(bFile)) {
    problem('BUNDLE_PATCH_MISSING', `插件包里找不到补丁文件：${bFile ?? '(未声明)'}`)
    return finish()
  }

  const bParsed = await parsePatchFile(bFile, profileDir)
  if (!bParsed.patches) {
    problem('BUNDLE_PATCH_UNPARSABLE', `bundle 补丁解析失败：${bParsed.error}`)
    return finish()
  }
  note(`bundle 补丁解析方式：${bParsed.parsedBy}`)

  const insertIds = []
  for (const p of bParsed.patches ?? []) {
    for (const e of p?.insert ?? []) if (e?.id) insertIds.push(e.id)
  }
  report.bundle.insertIds = insertIds

  if (insertIds.length === 0) {
    problem('BUNDLE_NO_INSERT', 'bundle 补丁里没有 insert 条目（插件装不上）', { file: bFile })
    return finish()
  }

  /* ---- 2. profile 补丁的非 insert id ---- */
  const pFile = join(profileDir, 'cordis.patch.yml')
  report.profile.patchFile = pFile

  if (!existsSync(pFile)) {
    note(`profile 补丁不存在（${pFile}）—— 插件将用默认数据目录（$DSH_HOME/tag-memory）`)
    return finish()
  }

  const pParsed = await parsePatchFile(pFile, profileDir)
  if (!pParsed.patches) {
    problem('PROFILE_PATCH_UNPARSABLE', `profile 补丁解析失败：${pParsed.error}`, { file: pFile })
    return finish()
  }
  note(`profile 补丁解析方式：${pParsed.parsedBy}`)

  const overrideIds = []
  for (const p of pParsed.patches ?? []) {
    if (p?.insert) continue // insert 是新增，不参与 id 匹配
    if (p?.id) overrideIds.push(p.id)
  }
  report.profile.overrideIds = overrideIds

  /* ---- 3. 关键检查：profile 有、bundle 没有 → 会被静默丢弃 ---- */
  const insertSet = new Set(insertIds)
  const orphan = overrideIds.filter((id) => !insertSet.has(id))

  // 只关心"看起来是本插件的"孤儿：名字里带 tag-memory 的，或历史上用过的 id
  const TM_RE = /tag[-_]?memory/i
  const tmOrphans = orphan.filter((id) => TM_RE.test(id))

  if (tmOrphans.length > 0) {
    problem(
      'PATCH_ID_MISMATCH',
      `profile 补丁里有 ${tmOrphans.length} 个 id 在 bundle 补丁的 insert 里不存在 —— 这些条目会被 Loader **静默丢弃**（config 不生效）`,
      {
        orphanIds: tmOrphans,
        bundleInsertIds: insertIds,
        fix:
          '把 profile 补丁里这些行的 id 改成 bundle insert 的 id：' +
          insertIds.map((x) => `"${x}"`).join(' / '),
        why:
          '补丁方言里顶层 `- id: xxx` 是"按 id 覆盖已存在条目"，不是新增。找不到目标就整条丢弃，只打一条 warn。',
      },
    )
  }

  // 全部孤儿都报一遍（不限本插件），但只作为 note，避免别的插件的正常情况误判
  const otherOrphans = orphan.filter((id) => !TM_RE.test(id))
  if (otherOrphans.length > 0) {
    note(`另有 ${otherOrphans.length} 个其它插件的 id 不在本 bundle 里（正常，它们属于别的包）：${otherOrphans.slice(0, 8).join(', ')}${otherOrphans.length > 8 ? ' …' : ''}`)
  }

  /* ---- 4. dataDir 实际解析结果 ---- */
  const cfgRow = (pParsed.patches ?? []).find((p) => !p?.insert && insertSet.has(p?.id) && TM_RE.test(String(p?.id)))
  const profileDataDir = cfgRow?.config?.dataDir ?? null
  const envDataDir = (process.env.DSH_TAG_MEMORY_DATA_DIR || '').trim() || null

  if (profileDataDir) {
    report.dataDir = { dir: profileDataDir, source: 'config' }
  } else if (envDataDir) {
    report.dataDir = { dir: envDataDir, source: 'env' }
  } else {
    // 与 resolveDataDir 的 ④ 一致
    report.dataDir = { dir: join(detectDshHome(), 'tag-memory'), source: 'dsh-home' }
  }

  /* ---- 5. 数据目录不许落在插件包内（P0-3） ---- */
  const dd = report.dataDir.dir
  if (dd && isInside(dd, bundleDir)) {
    problem(
      'DATA_DIR_IN_PACKAGE',
      '数据目录落在插件包内 —— pnpm 重装/升级会整个删除该目录，用户数据会丢',
      { dataDir: dd, bundleDir, fix: '把 config.dataDir 指到包外，例如 $DSH_HOME/tag-memory' },
    )
  }

  return finish()
}

function finish() {
  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.ok ? 0 : 1)
  }

  out('--- bundle 补丁 insert id ---')
  out(report.bundle.insertIds.length ? report.bundle.insertIds.map((x) => `  · ${x}`).join('\n') : '  (无)')

  out('')
  out('--- profile 补丁覆盖 id（非 insert）---')
  out(report.profile.overrideIds.length ? report.profile.overrideIds.map((x) => `  · ${x}`).join('\n') : '  (无)')

  out('')
  out('--- 数据目录（实际生效）---')
  out(`  路径：${report.dataDir.dir ?? '(未知)'}`)
  out(`  来源：${report.dataDir.source ?? '(未知)'}`)
  if (report.dataDir.source === 'package') {
    out('  ⚠️  落在插件包内：pnpm 重装会删除，必须改 config.dataDir')
  }

  if (report.notes.length) {
    out('')
    out('--- 说明 ---')
    for (const n of report.notes) out(`  · ${n}`)
  }

  out('')
  if (report.ok) {
    out('✅ 校验通过')
    process.exit(0)
  }

  out('❌ 校验未通过：')
  for (const p of report.problems) {
    out(`  [${p.code}] ${p.message}`)
    if (p.detail) out(`      ${JSON.stringify(p.detail, null, 2).split('\n').join('\n      ')}`)
  }
  process.exit(1)
}

main().catch((e) => {
  console.error(`verify-install 内部错误：${e?.stack ?? e}`)
  process.exit(2)
})
