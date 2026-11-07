/**
 * checks.mjs —— 安装状态检查（纯函数，只读，无副作用）。
 *
 * 被两个 CLI 共用：
 *   - scripts/verify-install.mjs  ：装完自检
 *   - scripts/install.mjs         ：装前预检 + 装后验收
 *
 * 为什么单独抽出来：安装脚本必须在**写盘之后**用同一套判据验收，
 * 否则「装完」就只是脚本自己说的，不是文件说的。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PACKAGE_NAME = 'dsh-tag-memory'
export const MIN_VERSION = '1.2.0'

/** DSH_HOME：显式参数 > $DSH_HOME > ~/.dsh（与 @deepseek-ai/dsh-home-paths 一致）。 */
export function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim())
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  return fromEnv !== '' ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh')
}

/**
 * 定位「要装进哪个 profile」——优先认**正在跑的这个实例**，而不是猜 ~/.dsh。
 *
 * 规则（从强到弱）：
 *   1. 命令行显式 `--dsh-home` / `--profile`
 *   2. `$DSH_PROFILE_DIR`：DSH 在每个 shell 调用里都会带上它，容器里就是 `/opt/dsh/profiles/web`
 *      （由它反推 home 与 profile，避免容器里 agent 装到 `~/.dsh` 这个空壳上）
 *   3. `$DSH_HOME` + `$DSH_PROFILE`
 *   4. `~/.dsh` + `web`
 *
 * @returns {{home: string, profile: string, source: string}}
 */
export function resolveTarget({ home: homeFlag, profile: profileFlag } = {}) {
  const profileDirEnv = (process.env.DSH_PROFILE_DIR ?? '').trim()
  const profileEnv = (process.env.DSH_PROFILE ?? '').trim()
  const homeEnv = (process.env.DSH_HOME ?? '').trim()
  const envTarget = () => {
    if (profileDirEnv !== '') {
      const dir = path.resolve(profileDirEnv)
      return { home: path.dirname(path.dirname(dir)), profile: path.basename(dir), source: '$DSH_PROFILE_DIR（当前实例）' }
    }
    if (homeEnv !== '') return { home: path.resolve(homeEnv), profile: profileEnv || 'web', source: '$DSH_HOME' }
    return { home: path.join(os.homedir(), '.dsh'), profile: 'web', source: '默认 ~/.dsh' }
  }

  if (typeof homeFlag === 'string' && homeFlag.trim() !== '') {
    const fallback = envTarget()
    return { home: path.resolve(homeFlag.trim()), profile: profileFlag || fallback.profile, source: '--dsh-home' }
  }
  if (typeof profileFlag === 'string' && profileFlag.trim() !== '') {
    const target = envTarget()
    return { home: target.home, profile: profileFlag.trim(), source: `${target.source} + --profile` }
  }
  return envTarget()
}

/** 读 JSON；顺手去掉 BOM（Windows 记事本会写 BOM）。坏文件返回 undefined，不猜。 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/** 只比 major.minor.patch；预发布后缀不参与。 */
export function versionCore(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

export function versionGte(a, b) {
  const x = versionCore(a)
  const y = versionCore(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i += 1) {
    if (x[i] > y[i]) return true
    if (x[i] < y[i]) return false
  }
  return true
}

/** 框架包的 import / re-export（有它 = profile 里解析不到 = 插件加载失败）。 */
const FRAMEWORK_IMPORT = /^\s*(?:import|export)\b[^\n]*?from\s+['"](?:@deepseek-ai\/[\w-]+|cordis)['"]/m

/** 递归找框架 import，返回 ["相对路径: 命中行", ...]。 */
export function findFrameworkImports(packageDir) {
  const offenders = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(?:m?js)$/.test(entry.name)) {
        const hit = FRAMEWORK_IMPORT.exec(fs.readFileSync(full, 'utf8'))
        if (hit) offenders.push(`${path.relative(packageDir, full)}: ${hit[0].trim()}`)
      }
    }
  }
  walk(path.join(packageDir, 'preset'))
  walk(path.join(packageDir, 'lib'))
  return offenders
}

/**
 * 检查一个包**自身**是否可安装（与装到哪儿无关）。
 * @returns {{ok: boolean, results: Array<{ok: boolean, title: string, detail?: string}>}}
 */
export function verifyPackage(packageDir, { minVersion = MIN_VERSION } = {}) {
  const results = []
  const add = (ok, title, detail) => results.push({ ok, title, detail })
  const manifestPath = path.join(packageDir, 'package.json')

  if (!fs.existsSync(manifestPath)) {
    add(false, '包里没有 package.json', manifestPath)
    return { ok: false, results }
  }
  const manifest = readJson(manifestPath)
  if (manifest === undefined) {
    add(false, 'package.json 解析失败', manifestPath)
    return { ok: false, results }
  }

  add(manifest.name === PACKAGE_NAME, `包名是 ${PACKAGE_NAME}`, `实际：${JSON.stringify(manifest.name)}`)
  add(versionGte(manifest.version, minVersion), `版本 ≥ ${minVersion}`, `实际：${JSON.stringify(manifest.version)}`)

  const patchRel = manifest.dsh?.bundle?.patch
  add(
    typeof patchRel === 'string' && fs.existsSync(path.join(packageDir, patchRel)),
    '声明了 dsh.bundle.patch 且文件存在',
    typeof patchRel === 'string' ? patchRel : '缺 dsh.bundle.patch',
  )

  const peekOld = Boolean(manifest.peerDependencies?.['@deepseek-ai/dsh-tools'])
  add(!peekOld, '没有 @deepseek-ai/dsh-tools 这个 peer', peekOld ? '1.1.0 及更早的旧结构：profile 里解析不到，工具全丢' : undefined)

  const offenders = findFrameworkImports(packageDir)
  add(offenders.length === 0, 'preset / lib 不 import 框架包', offenders.slice(0, 5).join('\n') || undefined)

  for (const [key, expectFile] of [
    ['./preset', 'preset/index.js'],
    ['./client', 'client.js'],
    ['./icon', 'icon.svg'],
  ]) {
    const target = manifest.exports?.[key]
    const ok = typeof target === 'string' && fs.existsSync(path.join(packageDir, target))
    add(ok, `exports["${key}"] 指向真实文件`, ok ? undefined : `实际：${JSON.stringify(target)}（期望 ${expectFile}）`)
  }

  add(
    fs.existsSync(path.join(packageDir, 'preset', 'define-tool.js')),
    'preset/define-tool.js 在（1.2.0 自带 defineTool）',
    undefined,
  )

  return { ok: results.every((r) => r.ok), results }
}

/**
 * 检查某个 profile 里装得成不成。
 * @returns {{ok: boolean, results: Array, profileDir: string, installedDir: string, manifest?: object, installed?: object, spec?: string}}
 */
export function verifyProfile({ home, profile, minVersion = MIN_VERSION }) {
  const results = []
  const add = (ok, title, detail) => results.push({ ok, title, detail })

  const profileDir = path.join(home, 'profiles', profile)
  const installedDir = path.join(profileDir, 'node_modules', PACKAGE_NAME)
  const manifestPath = path.join(profileDir, 'package.json')

  /** 已收集到的检查状态（早退也要能带上）。 */
  let manifest
  let installed
  let spec
  const final = () => ({
    ok: results.every((r) => r.ok),
    results,
    profileDir,
    installedDir,
    manifest,
    installed,
    spec,
  })

  if (!fs.existsSync(manifestPath)) {
    add(false, `找不到 profile「${profile}」`, `期望 ${manifestPath}。先启动一次 dsh（会初始化 profile），或用 --profile 指定正确的名字。`)
    return final()
  }
  manifest = readJson(manifestPath)
  if (manifest === undefined) {
    add(false, 'profile 的 package.json 解析失败', `${manifestPath} 不是合法 JSON（可能被手工改坏）。`)
    return final()
  }

  spec = manifest.dependencies?.[PACKAGE_NAME]
  add(
    typeof spec === 'string',
    typeof spec === 'string' ? '依赖已登记' : 'profile 的 package.json 里没有 dsh-tag-memory 依赖',
    typeof spec === 'string' ? `spec = ${spec}` : '说明安装没跑完（或被中断），重跑安装命令。',
  )

  const installedManifestPath = path.join(installedDir, 'package.json')
  if (!fs.existsSync(installedManifestPath)) {
    add(
      false,
      'node_modules 里没有装好的包',
      typeof spec === 'string'
        ? `期望 ${installedDir}。依赖登记了但没落盘：安装中断在半路，重跑安装命令。`
        : `期望 ${installedDir}。依赖都没登记，说明安装命令没跑。`,
    )
    return final()
  }
  installed = readJson(installedManifestPath)
  if (installed === undefined) {
    add(false, '装好的包 package.json 解析失败', `${installedManifestPath} 不是合法 JSON。`)
    return final()
  }

  add(true, `已安装版本 ${installed.version}`, installedDir)
  add(
    versionGte(installed.version, minVersion),
    `版本 ≥ ${minVersion}`,
    versionGte(installed.version, minVersion)
      ? undefined
      : '低于 1.2.0 的版本在 preset/tools.js 顶层 import @deepseek-ai/dsh-tools，profile 里解析不到 → 10 个 dtm_* 工具全丢。',
  )

  for (const r of verifyPackage(installedDir, { minVersion }).results) results.push(r)

  const bundles = manifest.dsh?.profile?.bundles ?? []
  add(
    bundles.includes(PACKAGE_NAME),
    bundles.includes(PACKAGE_NAME) ? 'profile 的 dsh.profile.bundles 已登记' : 'dsh.profile.bundles 里没有它（装了也不会装载）',
    bundles.includes(PACKAGE_NAME) ? undefined : '安装脚本会登记它；手工 cp 不会。重跑 `install.mjs apply` 可补登记。',
  )

  return final()
}
