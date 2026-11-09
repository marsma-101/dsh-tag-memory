#!/usr/bin/env node
/**
 * install.mjs —— 纯 node 一键安装。不需要 pnpm、git、网络（包已在本地）、模型。
 *
 * 用法：
 *   node scripts/install.mjs                    # 只读预检 + 打印计划（一个字节不动）
 *   node scripts/install.mjs apply              # 真装（也可写 --apply）
 *   node scripts/install.mjs uninstall          # 预览卸载（只读）
 *   node scripts/install.mjs uninstall apply    # 真卸（也可写 --uninstall --apply）
 *   node scripts/install.mjs apply --profile web --dsh-home <path>
 *   node scripts/install.mjs apply --json
 *
 * 卸载选项（`uninstall` 之后）：
 *   --keep-runtime    运行期产物全部保留（连台账/备份/参数都不清）
 *   --keep-backups    只保留 backup/，其余运行期产物照清
 *   --profile <名>    指定 profile
 *   --dsh-home <path> 指定 DSH_HOME
 *
 * 它做什么（照 0.3.7 的离线安装思路，按 1.2.0 的结构重写）：
 *   1. 校验**本包自己**：名字/版本、bundle 补丁、exports、零框架依赖（不通过就一个字节不写）
 *   2. 把本体拷到稳定位置 <DSH_HOME>/plugins/dsh-tag-memory
 *      （不能直接链到 npx 临时目录：npx 清缓存时链接会指向空气）
 *   3. 在 <profile>/node_modules/dsh-tag-memory 建链接（Windows junction / POSIX symlink）
 *   4. 改 profile 的 package.json：依赖 + dsh.profile.bundles（先备份）
 *   5. 用 checks.mjs 的同一套判据验收；不过就报出来，不谎报成功
 *
 * 卸载做什么（install 的镜像，`uninstall` 段）：
 *   摘链接 → 摘清单条目（依赖 + bundles）→ 清运行期产物
 *   **保留**：记忆库 store/memory.csv、本体副本 <DSH_HOME>/plugins/、
 *            以及用户自己的导出 CSV。
 *
 * 为什么卸载逻辑写在这个脚本里、而不是做成 `dtm_uninstall` 工具：
 *   DSH 的 `dsh plugin remove` 会 `pnpm remove` 把整个包目录删掉，
 *   之后**没有任何插件代码还能执行**。把清理做成工具等于把"清完再卸"
 *   这个时序责任推给用户，而且一旦用户忘了，包没了就再也补不上。
 *   脚本在包外跑，不受这个限制——所以卸载必须在脚本里。
 *
 * 不改的东西：profile 的 cordis.patch.yml（bundle 自带补丁，不需要）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, MIN_VERSION, resolveTarget, readJson, verifyPackage, verifyProfile } from './checks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 本包根目录（scripts/ 的上一层）。 */
const PACKAGE_DIR = path.resolve(HERE, '..')

/* ── 参数 ─────────────────────────────────────────────── */
const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(name)
  if (i < 0) return dflt
  const next = argv[i + 1]
  return next !== undefined && !next.startsWith('-') ? next : dflt
}
const positional = argv.filter((a) => !a.startsWith('-'))
const wantsUninstall = argv.includes('--uninstall') || positional.includes('uninstall')
const wantsCleanup = argv.includes('--cleanup') || positional.includes('cleanup')
const wantsApply = argv.includes('--apply') || positional.includes('apply')
const action = wantsCleanup ? 'cleanup' : wantsUninstall ? 'uninstall' : wantsApply ? 'apply' : 'check'
/** 预演 vs 落盘：`uninstall` / `cleanup` 单独跑是预演，带 apply 才落盘。 */
const doIt = wantsApply
const allProfiles = argv.includes('--all-profiles')
const target = resolveTarget({
  home: flag('--dsh-home', undefined),
  profile: flag('--profile', undefined),
})
const home = target.home
let profile = target.profile

const profileDir = path.join(home, 'profiles', profile)
const manifestPath = path.join(profileDir, 'package.json')
const bodyDir = path.join(home, 'plugins', PACKAGE_NAME)
const linkPath = path.join(profileDir, 'node_modules', PACKAGE_NAME)

/** 复制本体时跳过的东西：版本库、依赖、测试、备份、编辑器残留。 */
const SKIP_ON_COPY = new Set(['.git', 'node_modules', 'tests', '.gitignore', '.npmignore', '.gitattributes'])
const skipOnCopy = (name) => SKIP_ON_COPY.has(name) || /\.bak(-|$)/.test(name) || /\.log$/i.test(name) || name.startsWith('.tmp')

const out = []
const say = (line = '') => {
  out.push(line)
  process.stdout.write(line + '\n')
}
const problems = []

/** 把 realpath 解到「真实、大小写规范」那一版；不存在就返回 resolve 后的原路径。 */
const real = (p) => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * 判断 p 是不是一条链接（Windows junction 或 POSIX symlink），是就返回它指向的真实路径。
 *
 * 为什么不能只看 `lstatSync().isSymbolicLink()`：**Windows junction 的 isSymbolicLink() 是 false**，
 * 而 `readlinkSync()` 对它直接 EINVAL。可靠的办法是把「父目录规范化后的自己」和
 * 「realpath 之后的自己」比一比：真目录两者相等，链接/junction 不相等。
 */
function linkTarget(p) {
  try {
    const resolved = path.resolve(p)
    const parent = fs.realpathSync.native(path.dirname(resolved))
    const canonicalSelf = path.join(parent, path.basename(resolved))
    const realSelf = fs.realpathSync.native(resolved)
    return realSelf === canonicalSelf ? undefined : realSelf
  } catch {
    return undefined
  }
}

/** 摘一条链接：junction/目录链接在 Windows 上要用 rmdir，POSIX 上用 unlink。 */
function removeLink(p) {
  if (process.platform === 'win32') fs.rmdirSync(p)
  else fs.unlinkSync(p)
}

/* ── 数据目录定位（卸载清理用）─────────────────────────────
 *
 * 必须与插件运行时的 5 级优先级**逐条对齐**（lib/engine/core.mjs 的 resolveDataDir），
 * 否则会出现最坏的结局：卸载脚本以为库在 A，实际库在 B，脚本「成功」了，
 * 用户重装后发现记忆没了。所以这里不猜、不兜底，逐级照抄并说明来源。
 *
 * 差别只有一处：①config 和 ②env 在这里只用于**定位**，不参与清理决策——
 * 那两处是用户显式指定的位置，脚本无权假设它归自己管。
 */
const DATA_DIR_NAME = 'tag-memory'

/** 读插件包内 config/data-dir.json（设置页选的库位置）。读不到返回 null。 */
function readSettingsDir(packageDir) {
  const file = path.join(packageDir, 'config', 'data-dir.json')
  if (!fs.existsSync(file)) return null
  const obj = readJson(file)
  return typeof obj?.dataDir === 'string' && obj.dataDir.trim() !== '' ? obj.dataDir.trim() : null
}

/**
 * 按运行时同一套优先级定位数据目录。
 * @returns {{dir: string, source: string, locked: boolean}}
 */
function locateDataDir() {
  const cfg = readJson(manifestPath)
  const cfgDir = cfg?.dsh?.profile?.config?.dataDir ?? cfg?.config?.dataDir
  if (typeof cfgDir === 'string' && cfgDir.trim() !== '') {
    return { dir: cfgDir.trim(), source: '①profile 清单里的 config.dataDir', locked: true }
  }
  const envDir = (process.env.DSH_TAG_MEMORY_DATA_DIR ?? '').trim()
  if (envDir !== '') return { dir: envDir, source: '②环境变量 DSH_TAG_MEMORY_DATA_DIR', locked: true }

  const settingsDir = readSettingsDir(PACKAGE_DIR)
  if (settingsDir !== null) return { dir: settingsDir, source: '③设置页选择的库位置', locked: false }

  return { dir: path.join(home, DATA_DIR_NAME), source: '④$DSH_HOME/tag-memory（默认）', locked: false }
}

/** 递归统计目录大小与文件数；读不到就当 0（预演不能因为没权限就崩）。 */
function measure(target) {
  let bytes = 0
  let files = 0
  const walk = (p) => {
    let st
    try {
      st = fs.statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let names = []
      try {
        names = fs.readdirSync(p)
      } catch {
        return
      }
      for (const n of names) walk(path.join(p, n))
      return
    }
    bytes += st.size
    files += 1
  }
  walk(target)
  return { bytes, files }
}

/**
 * 列出卸载时**要清掉**的运行期产物。
 *
 * 判据（主子 2026-11-09 明确要求「库保留，其他删除」）：
 *   保留 · store/memory.csv      记忆库本体——用户的资产，删了不可恢复
 *   保留 · store/.memory.lock    空锁文件，正在被用着，删了反而危险
 *   清理 · records/*.jsonl       台账，只用于审计
 *   清理 · backup/               自动备份，库还在就不需要历史备份
 *   清理 · settings.json         运行参数（备份/整理间隔）
 *   清理 · <包根>/config/        设置页选的库位置
 *
 * `keepBackups` 时 backup/ 转为保留——给"想留一份兜底"的用户。
 */
function planRuntimePurge({ dataDir, keepBackups = false }) {
  const items = [
    { rel: 'records', kind: 'dir', label: '台账（write/read/tidy 的 jsonl）' },
    { rel: 'backup', kind: 'dir', label: '自动备份' },
    { rel: 'settings.json', kind: 'file', label: '运行参数（备份/整理间隔）' },
  ]
    .filter((i) => !(keepBackups && i.rel === 'backup'))
    .map((i) => {
      const target = path.join(dataDir, i.rel)
      const stat = measure(target)
      return { ...i, path: target, exists: fs.existsSync(target), ...stat }
    })

  // 包内的设置页状态单独算：它在包根，不在数据目录
  const cfgDir = path.join(PACKAGE_DIR, 'config')
  const cfgStat = measure(cfgDir)
  items.push({
    rel: 'config',
    kind: 'dir',
    label: '设置页选择的库位置（data-dir.json）',
    path: cfgDir,
    exists: fs.existsSync(cfgDir),
    ...cfgStat,
  })

  const libPath = path.join(dataDir, 'store', 'memory.csv')
  const libStat = measure(libPath)
  const library = {
    rel: 'store/memory.csv',
    path: libPath,
    exists: fs.existsSync(libPath),
    ...libStat,
  }

  return {
    items,
    library,
    totalBytes: items.reduce((n, i) => n + i.bytes, 0),
    totalFiles: items.reduce((n, i) => n + i.files, 0),
  }
}

/** 人类可读字节数。 */
function humanBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

/* ── 0. 本包自检（不通过就停，绝不带病安装）───────────── */
const self = verifyPackage(PACKAGE_DIR, { minVersion: MIN_VERSION })
if (!self.ok) {
  say('✗ 本包自检没过，拒绝安装（一个字节没动）：')
  for (const r of self.results) if (!r.ok) say(`   ✗ ${r.title}${r.detail ? ` — ${r.detail}` : ''}`)
  process.exit(1)
}

/* ── uninstall ────────────────────────────────────────── */
if (action === 'uninstall') {
  const plan = []
  const note = (mark, msg) => plan.push(`${mark} ${msg}`)

  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : undefined
  if (manifest === undefined && fs.existsSync(manifestPath)) {
    say(`✗ profile 的 package.json 解析失败，不敢动：${manifestPath}`)
    process.exit(1)
  }

  let unlink = false
  const existingTarget = fs.existsSync(linkPath) ? linkTarget(linkPath) : undefined
  if (existingTarget === undefined) {
    if (fs.existsSync(linkPath)) note('留', `${linkPath} 是实体目录（不是链接），不动——要删请自己动手`)
    else note('·', `${linkPath} 不存在，跳过`)
  } else if (readJson(path.join(existingTarget, 'package.json'))?.name === PACKAGE_NAME) {
    unlink = true
    note('摘', `链接 ${linkPath} → ${existingTarget}`)
  } else {
    note('留', `${linkPath} 是链接但目标不是本包（${existingTarget}），不动`)
  }

  let manifestNext = null
  if (manifest !== undefined) {
    const next = structuredClone(manifest)
    let touched = false
    if (next.dependencies && PACKAGE_NAME in next.dependencies) {
      delete next.dependencies[PACKAGE_NAME]
      if (Object.keys(next.dependencies).length === 0) delete next.dependencies
      touched = true
    }
    const bundles = next.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
      next.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE_NAME)
      if (next.dsh.profile.bundles.length === 0) {
        delete next.dsh.profile.bundles
        if (Object.keys(next.dsh.profile).length === 0) {
          delete next.dsh.profile
          if (Object.keys(next.dsh).length === 0) delete next.dsh
        }
      }
      touched = true
    }
    if (touched) {
      manifestNext = JSON.stringify(next, null, 2) + '\n'
      note('摘', `清单里的依赖条目与 bundle 条目（${manifestPath}）`)
    } else note('·', '清单里没有我们的条目，跳过')
  } else {
    note('·', `${manifestPath} 不存在，跳过`)
  }

  say(plan.join('\n'))
  say('')

  /* ── 运行期产物清理（库保留）──────────────────────────
   * 默认就清（主子要求「库保留，其他删除」），但**先摆出清单**让用户看见。
   * `--keep-runtime` 可整段跳过；`--keep-backups` 只留备份。 */
  const keepRuntime = argv.includes('--keep-runtime')
  const keepBackups = argv.includes('--keep-backups')
  const located = locateDataDir()
  let purge = null
  let purged = null

  if (keepRuntime) {
    say(`· 数据目录 ${located.dir}（${located.source}）：按 --keep-runtime 全部保留`)
  } else {
    purge = planRuntimePurge({ dataDir: located.dir, keepBackups })
    say(`数据目录：${located.dir}`)
    say(`  （来源：${located.source}${located.locked ? '，该位置由配置/环境变量指定' : ''}）`)
    say('')
    if (purge.library.exists) {
      say(`✓ 保留记忆库：store/memory.csv（${humanBytes(purge.library.bytes)}，${purge.library.files} 个文件）`)
    } else {
      say(`· 记忆库不存在（${purge.library.path}）—— 清理前就没有，不是本次删的`)
    }
    if (keepBackups) say('✓ 保留 backup/（--keep-backups）')

    const willPurge = purge.items.filter((i) => i.exists)
    if (willPurge.length > 0) {
      say('')
      say(`将清理 ${willPurge.length} 项运行期产物，共 ${humanBytes(purge.totalBytes)}：`)
      for (const i of willPurge) say(`  · ${i.rel}  ${i.label}  ${humanBytes(i.bytes)}`)
    } else {
      say('· 没有运行期产物需要清理')
    }
  }

  say('')
  if (!doIt) {
    say('以上是预演（一个字节没动）。加 apply 才真卸。')
    process.exit(0)
  }

  if (unlink) {
    removeLink(linkPath)
    say(`✓ 已摘链接 ${linkPath}`)
  }
  if (manifestNext !== null) {
    const bak = `${manifestPath}.bak-tag-memory-${Date.now()}`
    fs.copyFileSync(manifestPath, bak)
    fs.writeFileSync(manifestPath, manifestNext, 'utf8')
    say(`✓ 已摘清单条目（备份 ${bak}）`)
  }

  /* ── 执行清理：逐项删、逐项报，单项失败不影响其他项 ──
   * 为什么不用一把梭：Windows 上文件可能被占用，一把梭会在第一个错误处
   * 中断并留下半清理状态。逐项删才能如实报出「哪些没删成、为什么」。 */
  if (purge !== null) {
    const deleted = []
    const failed = []
    for (const item of purge.items) {
      if (!item.exists) continue
      try {
        fs.rmSync(item.path, { recursive: item.kind === 'dir', force: true })
        if (fs.existsSync(item.path)) {
          failed.push({ rel: item.rel, error: '删除后仍存在（可能被其他程序占用）' })
          continue
        }
        deleted.push(item.rel)
      } catch (err) {
        failed.push({ rel: item.rel, error: err?.message ?? String(err) })
      }
    }

    // 唯一不能出错的事：库必须还在
    if (purge.library.exists && !fs.existsSync(purge.library.path)) {
      say('')
      say(`✗✗ 严重：清理后记忆库不见了！${purge.library.path}`)
      say('   立即从 backup/ 恢复（若 backup 已被清，从你自己的备份恢复）。')
      process.exitCode = 1
    } else {
      if (deleted.length > 0) {
        say('')
        say(`✓ 已清理 ${deleted.length} 项运行期产物：${deleted.join('、')}`)
      }
      if (failed.length > 0) {
        say('')
        say(`⚠ ${failed.length} 项没删成（不影响记忆库）：`)
        for (const f of failed) say(`   · ${f.rel}：${f.error}`)
        say('   关掉占用它的程序后重试，或手动删除。')
        process.exitCode = 1
      }
      if (purge.library.exists) {
        say(`✓ 记忆库完好：${purge.library.path}`)
      }
    }
  }

  say('\nUNINSTALL OK。重启 dsh 后工具才会消失。')
  say('重装后记忆库可直接继续用（它不在插件包内，卸载不碰它）。')
  process.exit(process.exitCode ?? 0)
}

/* ── cleanup：清历史残留（0.x / 1.x 早期安装写进 profile 的东西）── */
const LEGACY_START = /^# >>> dsh-tag-memory/
const LEGACY_END = /^# <<< dsh-tag-memory/

/** 摘掉 `# >>> dsh-tag-memory-… >>>` … `# <<< … <<<` 成对的旧安装块；没有成对结束标记就不动。 */
function stripLegacyBlocks(text) {
  const lines = text.split('\n')
  const kept = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (LEGACY_START.test(lines[i].trim())) {
      let j = i + 1
      while (j < lines.length && !LEGACY_END.test(lines[j].trim())) j += 1
      if (j < lines.length) {
        i = j
        removed += 1
        continue
      }
    }
    kept.push(lines[i])
  }
  return { text: kept.join('\n'), removed }
}

/** 摘完之后如果只剩注释 + 一个 `[]`，就还原成合法的最小补丁。 */
function normalizeEmptyPatch(text) {
  const meaningful = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  return meaningful.length === 1 && meaningful[0] === '[]' ? '[]\n' : text
}

/** 算一个 profile 该清什么（只计算，不落盘）。 */
function planCleanupFor(dir) {
  const changes = []
  const manifestPath = path.join(dir, 'package.json')
  const patchPath = path.join(dir, 'cordis.patch.yml')
  let manifestNext
  let patchNext

  const manifest = readJson(manifestPath)
  if (manifest !== undefined) {
    const next = structuredClone(manifest)
    const spec = next.dependencies?.[PACKAGE_NAME]
    let dangling = false
    if (typeof spec === 'string') {
      const targetPath = /^(?:link|file):/.test(spec) ? spec.replace(/^(?:link|file):/, '') : undefined
      dangling = targetPath !== undefined && !fs.existsSync(targetPath)
      if (dangling) {
        delete next.dependencies[PACKAGE_NAME]
        if (Object.keys(next.dependencies).length === 0) delete next.dependencies
        changes.push(`摘掉悬空依赖：${PACKAGE_NAME} → ${targetPath}（目标不存在）`)
      }
    }
    const bundles = next.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME) && (dangling || typeof spec !== 'string')) {
      next.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE_NAME)
      if (next.dsh.profile.bundles.length === 0) {
        delete next.dsh.profile.bundles
        if (Object.keys(next.dsh.profile).length === 0) {
          delete next.dsh.profile
          if (Object.keys(next.dsh).length === 0) delete next.dsh
        }
      }
      changes.push('从 dsh.profile.bundles 摘掉 dsh-tag-memory')
    }
    if (changes.length > 0) manifestNext = JSON.stringify(next, null, 2) + '\n'
  }

  if (fs.existsSync(patchPath)) {
    const before = fs.readFileSync(patchPath, 'utf8')
    const { text, removed } = stripLegacyBlocks(before)
    if (removed > 0) {
      patchNext = normalizeEmptyPatch(text)
      changes.push(`摘掉 cordis.patch.yml 里 ${removed} 段旧安装块（# >>> dsh-tag-memory-…）`)
    }
  }

  return { dir, changes, manifestNext, patchNext }
}

if (action === 'cleanup') {
  const profilesDir = path.join(home, 'profiles')
  const names =
    allProfiles && fs.existsSync(profilesDir)
      ? fs
          .readdirSync(profilesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [profile]
  const plans = names.map((name) => planCleanupFor(path.join(profilesDir, name)))

  say(`dsh-tag-memory 残留清理  (DSH_HOME=${home}，${allProfiles ? '全部 profile' : `profile=${profile}`})`)
  say('')
  let total = 0
  for (const plan of plans) {
    if (plan.changes.length === 0) {
      say(`· ${path.basename(plan.dir)}：干净`)
      continue
    }
    say(`✎ ${path.basename(plan.dir)}：`)
    for (const change of plan.changes) {
      say(`    - ${change}`)
      total += 1
    }
  }
  say('')
  if (total === 0) {
    say('没有需要清的东西。')
    process.exit(0)
  }
  say('· 不动：插件本体 <DSH_HOME>/plugins、记忆数据 <DSH_HOME>/tag-memory、其它依赖与补丁内容')
  if (!doIt) {
    say('\n以上是预演（一个字节没动）。加 apply 才真清。')
    process.exit(0)
  }
  for (const plan of plans) {
    if (plan.changes.length === 0) continue
    const name = path.basename(plan.dir)
    if (plan.manifestNext !== undefined) {
      const mp = path.join(plan.dir, 'package.json')
      const bak = `${mp}.bak-tag-memory-cleanup-${Date.now()}`
      fs.copyFileSync(mp, bak)
      fs.writeFileSync(mp, plan.manifestNext, 'utf8')
      say(`✓ ${name}：已改清单（备份 ${bak}）`)
    }
    if (plan.patchNext !== undefined) {
      const pp = path.join(plan.dir, 'cordis.patch.yml')
      const bak = `${pp}.bak-tag-memory-cleanup-${Date.now()}`
      fs.copyFileSync(pp, bak)
      fs.writeFileSync(pp, plan.patchNext, 'utf8')
      say(`✓ ${name}：已修补丁（备份 ${bak}）`)
    }
  }
  say('\nCLEANUP OK。重启 dsh 后生效。')
  process.exit(0)
}

/* ── apply：预检 ──────────────────────────────────────── */
if (!fs.existsSync(manifestPath)) {
  problems.push(`找不到 profile「${profile}」：${manifestPath}。先启动一次 dsh（会初始化 profile），或用 --profile 指定名字。`)
}
const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : undefined
if (fs.existsSync(manifestPath) && manifest === undefined) {
  problems.push(`profile 的 package.json 解析失败：${manifestPath}`)
}

/** 目标链接位：是实体目录就拒绝（不能删用户的东西）。 */
let linkIsOurs = false
if (fs.existsSync(linkPath)) {
  const target = linkTarget(linkPath)
  if (target === undefined) {
    problems.push(`${linkPath} 是实体目录（不是链接）。不删用户目录；请先自己删掉它再装。`)
  } else if (readJson(path.join(target, 'package.json'))?.name === PACKAGE_NAME) {
    linkIsOurs = true
  } else {
    problems.push(`${linkPath} 已是一条链接但目标不是本包（${target}），不覆盖`)
  }
}

/** 本体副本位：已存在就必须是本包，否则不覆盖。 */
const bodySameAsSource = real(bodyDir) === real(PACKAGE_DIR)
if (fs.existsSync(bodyDir) && !bodySameAsSource) {
  const existing = readJson(path.join(bodyDir, 'package.json'))
  if (existing?.name !== PACKAGE_NAME) {
    problems.push(`${bodyDir} 已存在且不是本包，不覆盖——换个 --dsh-home 或自己清掉它。`)
  }
}

/** 写权限预检：agent 的 workspace-write 沙箱写不了 DSH_HOME，早说清楚，别装到一半才 EPERM。 */
const assertWritable = (dir, label) => {
  let p = dir
  while (!fs.existsSync(p)) p = path.dirname(p)
  try {
    fs.accessSync(p, fs.constants.W_OK)
  } catch {
    problems.push(
      `${label}没有写权限：${p}。容器/宿主里请在完整权限下运行；` +
        'agent 的受限沙箱写不了 DSH_HOME——请让用户在自己的终端执行同一条命令，或用 plugin_manager 的 install_bundle（需批准）。',
    )
  }
}
assertWritable(bodyDir, '本体目录')
assertWritable(profileDir, 'profile 目录')

if (problems.length > 0) {
  say('✗ 预检没过，拒绝安装（一个字节没动）：')
  for (const p of problems) say(`   ✗ ${p}`)
  process.exit(1)
}

/* ── apply：计划 ──────────────────────────────────────── */
const legacy = planCleanupFor(profileDir)
say(`dsh-tag-memory ${JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version} → profile「${profile}」`)
say(`  目标来源  = ${target.source}`)
say(`  DSH_HOME = ${home}`)
say(`  本体      = ${bodyDir}${bodySameAsSource ? '（就在这儿，不复制）' : '（从这里复制）'}`)
say(`  链接      = ${linkPath}`)
say(`  清单      = ${manifestPath}`)
say('  bundle    = 会把 "dsh-tag-memory" 追加进 dsh.profile.bundles（已登记则跳过）')
say('  不动      = profile 的 cordis.patch.yml、记忆数据目录 <DSH_HOME>/tag-memory')
if (legacy.changes.length > 0) {
  say(`  ⚠ 历史残留 = ${legacy.changes.length} 项（旧安装留下的悬空依赖/坏补丁块）——建议先跑 cleanup apply`)
  for (const change of legacy.changes) say(`      - ${change}`)
}
say('')

if (!doIt) {
  say('以上是预检 + 计划（一个字节没动）。加 apply 才真装。')
  process.exit(0)
}

/* ── apply：落盘 ──────────────────────────────────────── */
// 1) 本体副本
if (!bodySameAsSource) {
  if (fs.existsSync(bodyDir)) fs.rmSync(bodyDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(bodyDir), { recursive: true })
  fs.cpSync(PACKAGE_DIR, bodyDir, {
    recursive: true,
    force: true,
    filter: (src) => !skipOnCopy(path.basename(src)),
  })
  say(`✓ 已复制本体 → ${bodyDir}`)
} else {
  say(`· 本体已在 ${bodyDir}，跳过复制`)
}

// 2) 链接
fs.mkdirSync(path.dirname(linkPath), { recursive: true })
if (fs.existsSync(linkPath)) {
  removeLink(linkPath)
  say(`· 旧链接已摘：${linkPath}`)
}
fs.symlinkSync(bodyDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
say(`✓ 已建链接 ${linkPath} → ${bodyDir}`)

// 3) profile 清单
const next = structuredClone(manifest)
next.dependencies = { ...(next.dependencies ?? {}), [PACKAGE_NAME]: `link:${bodyDir}` }
const bundles = Array.isArray(next.dsh?.profile?.bundles) ? [...next.dsh.profile.bundles] : []
if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
next.dsh = { ...(next.dsh ?? {}), profile: { ...(next.dsh?.profile ?? {}), bundles } }
const bak = `${manifestPath}.bak-tag-memory-${Date.now()}`
fs.copyFileSync(manifestPath, bak)
fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
say(`✓ 已登记依赖 + bundle 条目（备份 ${bak}）`)

/* ── 验收：同一套判据，不谎报 ────────────────────────── */
say('')
const report = verifyProfile({ home, profile, minVersion: MIN_VERSION })
for (const r of report.results) {
  say(`  ${r.ok ? '✓' : '✗'} ${r.title}${r.detail ? `\n      ${String(r.detail).replace(/\n/g, '\n      ')}` : ''}`)
}
say('')
if (report.ok) {
  say('INSTALL OK：装好了，重启 dsh 后才生效（bundle 补丁只在启动时装配）。')
  say('容器：docker restart <容器名>；本机前台：Ctrl-C 再起。之后 10 个 dtm_* 工具会出来。')

  /* ── 顺带播种（空库才有意义；已有内容则跳过，不打扰）──────────
   *
   * 为什么放在 install 而不是插件启动时：启动时写库会与用户自己的写入
   * 抢锁，且插件被禁用/重装时行为不可控。安装是一次性动作，适合做这件事。
   *
   * 为什么只在「库为空」时播：用户已经积累记忆后再塞种子，就是污染。
   */
  if (!argv.includes('--no-seed')) {
    try {
      const seedPath = path.join(PACKAGE_DIR, 'scripts', 'seed.mjs')
      if (fs.existsSync(seedPath)) {
        say('')
        say('── 初始记忆（空库才播）────────────────────────────')
        const r = spawnSync(process.execPath, [seedPath, 'apply'], {
          stdio: 'inherit',
          env: { ...process.env, DSH_HOME: home },
        })
        if (r.status !== 0) {
          // 播种失败不影响安装结论：插件已装好，种子只是锦上添花
          say('（播种没成功，不影响插件使用；可稍后手动 node scripts/seed.mjs apply）')
        }
      }
    } catch (e) {
      say(`（播种跳过：${e?.message ?? e}）`)
    }
  }

  process.exit(0)
}
say('INSTALL FAILED：上面有红项，安装没完成。把这段输出贴出来再排查。')
process.exit(1)
