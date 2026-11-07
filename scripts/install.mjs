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
 * 它做什么（照 0.3.7 的离线安装思路，按 1.2.0 的结构重写）：
 *   1. 校验**本包自己**：名字/版本、bundle 补丁、exports、零框架依赖（不通过就一个字节不写）
 *   2. 把本体拷到稳定位置 <DSH_HOME>/plugins/dsh-tag-memory
 *      （不能直接链到 npx 临时目录：npx 清缓存时链接会指向空气）
 *   3. 在 <profile>/node_modules/dsh-tag-memory 建链接（Windows junction / POSIX symlink）
 *   4. 改 profile 的 package.json：依赖 + dsh.profile.bundles（先备份）
 *   5. 用 checks.mjs 的同一套判据验收；不过就报出来，不谎报成功
 *
 * 不改的东西：profile 的 cordis.patch.yml（bundle 自带补丁，不需要）、
 * 记忆数据目录（<DSH_HOME>/tag-memory 一个字节不碰）。
 */

import fs from 'node:fs'
import path from 'node:path'
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
  say(`· 本体副本留在 ${bodyDir}（不删：它可能被当作数据目录兜底，删了有丢数据的风险）`)
  say('· 记忆数据目录（<DSH_HOME>/tag-memory）一个字节不碰')
  if (!doIt) {
    say('\n以上是预演（一个字节没动）。加 apply 才真卸。')
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
  say('\nUNINSTALL OK。重启 dsh 后工具才会消失。')
  process.exit(0)
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
  process.exit(0)
}
say('INSTALL FAILED：上面有红项，安装没完成。把这段输出贴出来再排查。')
process.exit(1)
