/**
 * 把 dsh-tag-memory 装进一个 DSH profile，离线完成。
 *
 *   node scripts/install.mjs                       # 只读校验（profile: web），并预览会写哪些记忆文件
 *   node scripts/install.mjs --apply               # 真正安装（Host + 智能体半都由 bundle patch 接线）
 *   node scripts/install.mjs --profile <name>      # 换个 profile
 *   node scripts/install.mjs --apply --wire-presets  # 兼容老版本：仅在 bundle 没自带接线时才改 profile 补丁
 *   node scripts/install.mjs --uninstall           # 预览要摘掉哪些东西（只读）
 *   node scripts/install.mjs --uninstall --apply   # 真卸（摘回原样；记忆库一个字不碰）
 *   node scripts/install.mjs --dsh-home <path>     # 换个 DSH_HOME（装到别的 DSH 时用）
 *   node scripts/install.mjs --data-dir <path>     # 换个数据目录（记忆库放哪；默认 <DSH_HOME>/tag-memory）
 *   node scripts/install.mjs --apply --dest <path> # 把本体拷到 <path>，再从那儿发链接
 *   node scripts/install.mjs --apply --seed        # 顺带给**空库**播初始记忆（库里已有条目就一条不写）
 *
 * 写入（仅 apply）：
 *   0. （--dest）<path>                                            （本体副本；不从会话下载目录发链接）
 *   1. <DSH_HOME>/profiles/<profile>/node_modules/dsh-tag-memory  （junction → 本仓库 / --dest）
 *   2. <DSH_HOME>/profiles/<profile>/package.json                 （依赖 + bundle 条目）
 *   3. <DSH_HOME>/.agent-presets/<智能体>/MEMORY.md               （探测到才写；写的是受控说明块）
 *   4. （--wire-presets，仅兼容老 bundle）<profile>/cordis.patch.yml（接 /preset 行；先备份、装完校验）
 *   5. （--seed）<数据目录>/store/memory.csv                      （**只在该库 0 条时**写初始记忆）
 *
 * `--uninstall` 把安装时动过的那几项**逐条摘回去**（先备份、逐条校验）。**数据目录（记忆库与字典）
 * 一个字都不碰**——卸插件不等于删记忆。
 *
 * **引擎随插件走**：读写核心 / 备份核心 / 字典样张 / 出厂模板全在 `lib/engine/`，不再依赖任何技能目录。
 * **数据独立**：用户的库放 `<DSH_HOME>/tag-memory`（可配），插件升级 / 重装都不碰它。
 *
 * 本包自带 bundle patch，加载器把它当一层应用。patch 同时插入 **Host 半**（index.js：
 * 设置页 API + 记忆文件托管）和 **智能体半**（preset.js：字典段 + memory_write /
 * memory_recall），所以官方安装路径一次装齐；`--wire-presets` 只用于老 bundle 兼容。
 * 记忆文件的写法规矩见 lib/notice.mjs —— 只认标记、只追加/原位替换、块外一字节不碰。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  copyFileSync,
  cpSync,
  rmSync,
  unlinkSync,
  realpathSync,
  readdirSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_MEMORY_FILE_NAMES, detectMemoryFiles, renderNotice, removeNotice, upsertNotice } from '../lib/notice.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 源码所在（本仓库 / 解压出来的那一份）。 */
const PACKAGE_DIR = resolve(HERE, '..')

const argv = process.argv.slice(2)
const mode = argv.includes('--apply') ? 'apply' : 'check'
const wirePresets = argv.includes('--wire-presets')
/** 给**空库**播初始记忆。显式开关：不带就一个字都不往库里写。 */
const seedMemories = argv.includes('--seed')
const getFlag = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PROFILE_NAME = getFlag('--profile', 'web')

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const DSH_HOME = getFlag('--dsh-home', process.env.DSH_HOME?.trim() || join(HOME, '.dsh'))
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME)
const PROFILE_MANIFEST = join(PROFILE_DIR, 'package.json')
const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
/** 本包自带 bundle patch；智能体半是否已全局接线以它为准。 */
const BUNDLE_PATCH = join(PACKAGE_DIR, 'cordis.patch.yml')
const PRESET_ROOT = join(DSH_HOME, '.agent-presets')

const EXPECTED_NAME = 'dsh-tag-memory'
/** 智能体半的接线标记：profile 补丁里出现这一串，就算接上了。 */
const WIRE_MARK = 'dsh-tag-memory/preset'
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name

// ── 本体放哪（--dest）─────────────────────────────────────
//
// 链接默认直接指向源码目录。源码要是在**会话下载目录**里（`downloads\` 之类），
// 被清理＝挂载本体凭空消失、装载报错——所以给一个 `--dest <路径>`：先把本体拷过去，
// 再从那儿发链接。不填就与以前逐字一致（一个字节都不拷）。
const DEST = getFlag('--dest', '')
/** 装完之后本体所在处：给了 --dest 就是它，否则就是源码目录本身。 */
const BODY_DIR = DEST ? resolve(DEST) : PACKAGE_DIR
/** 这些是「只在本机、不该跟着搬」的东西：git 元数据、依赖锚点、开发记录、运行时落盘。 */
const DEST_SKIP = new Set(['.git', 'node_modules', 'privhub', 'store', 'backups'])
const destSkip = (name) => DEST_SKIP.has(name) || /\.bak(-|$)/.test(name) || /\.log$/i.test(name)

const LINK_PATH = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME)
/** 解到「真实路径、大小写规范」那一版，用来比对两条链接指的到底是不是同一处。 */
const real = (p) => { try { return resolve(realpathSync(p)) } catch { return resolve(p) } }
/** 那条链接是不是「我们这条」：解到哪儿都行，但那儿得是个装着我们这个包的目录。 */
const isOurLink = (p) => {
  try {
    if (!lstatSync(p).isSymbolicLink()) return false
    return JSON.parse(readFileSync(join(real(p), 'package.json'), 'utf8')).name === EXPECTED_NAME
  } catch { return false }
}

const report = []
const fail = []
const check = (label, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) fail.push(label)
}

// ── 包自身 ──────────────────────────────────────────────

check('package directory exists', existsSync(PACKAGE_DIR), PACKAGE_DIR)
check('package name', PACKAGE_NAME === EXPECTED_NAME, PACKAGE_NAME)
check('declares dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('main entry exists', existsSync(join(PACKAGE_DIR, manifest.main ?? 'index.js')))

const presetExport = manifest.exports?.['./preset']
const presetPath = typeof presetExport === 'string' ? presetExport : presetExport?.default
check('exports ./preset', typeof presetPath === 'string', String(presetPath))
check('preset half exists', typeof presetPath === 'string' && existsSync(join(PACKAGE_DIR, presetPath)), String(presetPath))

const clientExport = manifest.exports?.['./client']
const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports ./client', typeof clientPath === 'string', String(clientPath))
check('client half exists', typeof clientPath === 'string' && existsSync(join(PACKAGE_DIR, clientPath)), String(clientPath))
check('declares dsh.client (web)', manifest.dsh?.client?.platform === 'web')
check('declares engines.dsh', typeof manifest.engines?.dsh === 'string', String(manifest.engines?.dsh))
check('declares @deepseek-ai/dsh-tools peer', typeof manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] === 'string', String(manifest.peerDependencies?.['@deepseek-ai/dsh-tools']))
check('exports locale + icon metadata', manifest.exports?.['./locale/*.json'] === './locale/*.json' && manifest.exports?.['./icon'] === './icon.svg')
const clientText = typeof clientPath === 'string' && existsSync(join(PACKAGE_DIR, clientPath))
  ? readFileSync(join(PACKAGE_DIR, clientPath), 'utf8')
  : ''
check('client uses the module-loader contract', clientText.includes('window.__ModuleLoader__.load'))
check('client registers settings.section', clientText.includes("'settings.section'"))

const entryText = readFileSync(join(PACKAGE_DIR, manifest.main ?? 'index.js'), 'utf8')
check('host entry exports apply()', /export\s+function\s+apply\s*\(/.test(entryText))
check('host entry exports Config schema', /export\s+const\s+Config\s*=/.test(entryText))
check('host entry runs notice self-heal', /selfHeal/.test(entryText))
check('host entry cleans up its listener', /return\s*\(\)\s*=>/.test(entryText))
check('host entry serves the settings API', /webServer\.register\(/.test(entryText) && /\/tag-memory-api/.test(entryText))

const presetText = typeof presetPath === 'string' && existsSync(join(PACKAGE_DIR, presetPath))
  ? readFileSync(join(PACKAGE_DIR, presetPath), 'utf8')
  : ''
check('preset entry exports apply()', /export\s+function\s+apply\s*\(/.test(presetText))
check('preset entry exports Config schema', /export\s+const\s+Config\s*=/.test(presetText))
// 段必须是**函数值**（每轮重读）；参数可有可无——注入快照要拿 `context.agent` 切当前项目。
check('preset registers a function-valued section', /systemPrompt\.section\(\{/.test(presetText) && /text:\s*\([^)]*\)\s*=>/.test(presetText))
check('preset registers memory_write + memory_recall', /'memory_write'/.test(presetText) && /'memory_recall'/.test(presetText))

// ── bundle patch ────────────────────────────────────────

// 目标 profile 的 node_modules 里未必有 js-yaml，所以按几处锚点依次找。
const yaml = loadYaml()

function loadYaml() {
  const anchors = [
    PROFILE_MANIFEST, // profile 自己的依赖树
    join(PROFILE_DIR, '..', 'node_modules', 'package.json'), // profile 的 hoist 目录
    join(PACKAGE_DIR, 'package.json'), // 本包自己的依赖锚点
  ]
  for (const a of anchors) {
    try { return createRequire(a)('js-yaml') } catch { /* 试下一个 */ }
  }
  return null
}

if (yaml) {
  const patch = yaml.load(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'))
  const rows = Array.isArray(patch) ? patch.flatMap((l) => l?.insert ?? []) : []
  check('bundle patch is one plain insert with host + preset rows',
    Array.isArray(patch) && patch.length === 1 && rows.length === 2, JSON.stringify(rows))
  check('bundle patch rows name the package and its preset export',
    rows[0]?.name === PACKAGE_NAME && rows[0]?.id === 'tag-memory'
      && rows[1]?.name === `${PACKAGE_NAME}/preset` && rows[1]?.id === 'tag-memory-preset',
    JSON.stringify(rows))
} else {
  report.push('SKIP  bundle patch yaml parse (js-yaml unavailable)')
}

// ── 补丁里那一小段声明：长什么样、怎么加上去、怎么摘回来 ──────
//
// 装与卸共用同一段字面量，所以「摘」的前提是**当初是我们写的**：整段照抄地对上就摘，
// 对不上（被人手改过）就报错让人自己删——宁可不摘，也不猜着改别人的文件。

const WIRE_BLOCK = [
  '# ── 记忆：标签记忆（dsh-tag-memory）—— 智能体半 ──────────────────',
  '# 0.2.0 起 preset 是声明行：这一段在 **profile 平面全局注册**，因此对该 profile 下',
  '# 所有智能体生效（含以后新建的），不必逐个 preset 挂。缺了它，界面照样能用，',
  '# 但谁也拿不到标签字典、也调不到 memory_write / memory_recall。',
  '# 回滚：删掉这一段。',
  '- insert:',
  '    - id: tag-memory-preset',
  `      name: '${WIRE_MARK}'`,
].join('\n')

/** 解析补丁文本并确认顶层是数组；坏了一律抛（调用方据此不落盘）。 */
function parsePatch(t, what) {
  if (!yaml) throw new Error('没有 js-yaml，不敢动 profile 补丁（装了 js-yaml 再来）')
  let v
  try { v = yaml.load(t) } catch (e) { throw new Error(`${what} 不是合法 YAML：${e.message}`) }
  if (v === null || v === undefined) v = []
  if (!Array.isArray(v)) throw new Error(`${what} 顶层不是数组（期望一串 loader patch 条目）`)
  return v
}
const patchHasWire = (v) => v.some((entry) => Array.isArray(entry?.insert) && entry.insert.some((row) => row?.name === WIRE_MARK))

/** 返回追加后的全文；改不动就抛（调用方据此回滚，原文件不落盘）。 */
function appendDeclaration(text) {
  const before = parsePatch(text, 'profile 补丁')
  // 空补丁模板写的是 `[]`：直接把它换成我们的条目，别在数组后面接一行（那是非法 YAML）。
  const EMPTY = /^[ \t]*\[[ \t]*\][ \t]*$/m
  const next = before.length === 0 && EMPTY.test(text)
    ? text.replace(EMPTY, WIRE_BLOCK)
    : text.replace(/\s*$/, '') + '\n\n' + WIRE_BLOCK + '\n'
  if (!patchHasWire(parsePatch(next, '接线后的补丁'))) throw new Error('写进去以后解析不出那一行')
  return next
}

/** 摘回原样：把 appendDeclaration 加的那一段拿走，返回摘后的全文；摘不干净就抛。 */
function stripDeclaration(text) {
  let next
  if (text.includes('\n\n' + WIRE_BLOCK + '\n')) {
    // 追加那一路：连前面那个空行一起拿掉，再把文件尾的空白收成一个换行——回到追加前那一版
    next = text.replace('\n\n' + WIRE_BLOCK + '\n', '').replace(/\s*$/, '') + '\n'
  } else if (text.includes(WIRE_BLOCK)) {
    // 空模板那一路：当初是把 `[]` 换成这一段，换回去就是原样
    next = text.replace(WIRE_BLOCK, '[]')
  } else {
    throw new Error(`补丁里有 ${WIRE_MARK}，但不是我们写的那一段（像是被人改过）——请自己把那几行删掉`)
  }
  if (next.trim() === '') next = '[]\n' // 整个文件只剩我们那段的话，摘完得留个合法的空补丁
  if (patchHasWire(parsePatch(next, '摘完的补丁'))) throw new Error('摘完以后那行还在，没摘干净')
  return next
}

// ── 卸载（--uninstall）──────────────────────────────────
//
// 装的时候动过这几处，卸就把它们逐条摘回去：
//   ① <profile>/node_modules/dsh-tag-memory  （junction；只解我们自己拉的那条）
//   ② <profile>/package.json                 （依赖条目 + bundle 层条目）
//   ③ <profile>/cordis.patch.yml             （仅老安装产物留下的那段声明）
//   ④ 各智能体的 MEMORY.md                   （托管说明块；只认标记，块外不碰）
// **数据目录（记忆库与字典）一个字都不碰。**
// 规矩同装：先备份、写完校验、一项不通就**整批不落盘**（宁可不卸，也不留半截）。

if (argv.includes('--uninstall')) {
  const doIt = mode === 'apply'
  const plan = []
  const note = (mark, msg) => plan.push(`${mark}  ${msg}`)

  const curManifest = existsSync(PROFILE_MANIFEST) ? JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8')) : null
  // 当初那条链接指向哪，就认哪——装了 `--dest` 的话，指向的是本体副本、不是本仓库。
  // 清单里记着（`link:<路径>`），照它认；老版本装的（或清单没记）才回落到源码目录。
  const recordedSpec = curManifest?.dependencies?.[PACKAGE_NAME]
  const expectedLink = typeof recordedSpec === 'string' && recordedSpec.startsWith('link:')
    ? resolve(recordedSpec.slice('link:'.length))
    : resolve(PACKAGE_DIR)

  // ① 链接：只解「当初是我们拉的那条」；实体目录、别人的链接一律不碰
  let unlinkLink = false
  try {
    if (lstatSync(LINK_PATH).isSymbolicLink()) {
      const to = real(LINK_PATH)
      if (to === real(expectedLink)) { unlinkLink = true; note('摘', `解链 ${LINK_PATH} → ${to}`) }
      else note('留', `${LINK_PATH} 是一条链接，但指向别处（${to}）——不动`)
    } else {
      note('留', `${LINK_PATH} 不是链接（像是拷进来的实体），不动——要删请自己动手`)
    }
  } catch { note('·', `${LINK_PATH} 不存在，跳过`) }

  // ② profile 清单：摘依赖条目与 bundle 层条目（其它键原样保留）
  let manifestNext = null
  if (curManifest) {
    const next = structuredClone(curManifest)
    let touched = false
    if (next.dependencies && PACKAGE_NAME in next.dependencies) {
      delete next.dependencies[PACKAGE_NAME]
      // 摘空了就整个删掉——空对象没意义，也回不到「本来就没有这个键」
      if (Object.keys(next.dependencies).length === 0) delete next.dependencies
      touched = true
    }
    const bundles = next.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
      next.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE_NAME)
      touched = true
      // 摘空了就把我们自己搭起来的空壳一层层收掉——留着空的 bundles / profile / dsh，
      // 就回不到「本来就没有这个键」那一版（卸载后 diff 不为空就是这么来的）。
      // 只为别的插件写的那些键（非空数组、别的子键）一律不碰。
      if (next.dsh.profile.bundles.length === 0) {
        delete next.dsh.profile.bundles
        if (Object.keys(next.dsh.profile).length === 0) {
          delete next.dsh.profile
          if (Object.keys(next.dsh).length === 0) delete next.dsh
        }
      }
    }
    if (touched) { manifestNext = JSON.stringify(next, null, 2) + '\n'; note('摘', `清单里的依赖条目与 bundle 条目（${PROFILE_MANIFEST}）`) }
    else note('·', '清单里没有我们的条目，跳过')
  } else {
    note('·', `${PROFILE_MANIFEST} 不存在，跳过`)
  }

  // ③ 补丁：整段照抄地对上才摘
  let patchNext = null
  if (existsSync(PROFILE_PATCH)) {
    const cur = readFileSync(PROFILE_PATCH, 'utf8')
    if (!cur.includes(WIRE_MARK)) note('·', '补丁里没有我们那段，跳过')
    else {
      // 分两种「有」：① 顶层那一段是我们加的 → 照抄地对上才摘；
      // ② 名字出现在**别处**（某个 preset 自己的 plugins 里挂的那一行）→ 那是谁的 preset 谁管，
      //    不是我们写的，摘了反而拆了别人的智能体。
      let ours = false
      try { ours = patchHasWire(parsePatch(cur, 'profile 补丁')) } catch { ours = false }
      if (!ours) {
        note('留', `补丁里另有 ${WIRE_MARK} 的引用（像是某个 preset 自己的 plugins 里挂的）——那是它的配置，我们不碰`)
      } else {
        try { patchNext = stripDeclaration(cur); note('摘', `补丁里那段声明（${PROFILE_PATCH}）`) }
        catch (e) { note('✗', `补丁摘不掉：${String(e?.message ?? e)}`) }
      }
    }
  } else {
    note('·', `${PROFILE_PATCH} 不存在，跳过`)
  }

  // ④ 记忆文件里的托管块
  const memoryFiles = detectMemoryFiles(PRESET_ROOT, { names: DEFAULT_MEMORY_FILE_NAMES })
  for (const f of memoryFiles) {
    const text = readFileSync(f.path, 'utf8')
    note(text.includes('<!-- BEGIN dsh-tag-memory notice -->') ? '摘' : '·',
      `${f.agent}/${f.file} 里的说明块${text.includes('<!-- BEGIN dsh-tag-memory notice -->') ? '' : '（没有，跳过）'}`)
  }
  if (memoryFiles.length === 0) note('·', `${PRESET_ROOT} 下没有记忆文件，跳过`)

  const blocked = plan.some((l) => l.startsWith('✗'))

  if (!doIt) {
    console.log(plan.join('\n'))
    console.log(`\n以上是预演（一个字节没动）。加 --apply 才会真卸。`)
    console.log('⚠ 记忆库（store/memory.csv 与字典）不在清单里——**卸插件不删记忆**。')
    process.exit(blocked ? 1 : 0)
  }
  if (blocked) {
    console.log(plan.join('\n'))
    console.error('\n拒绝卸载：上面有摘不掉的项。一个字节没动——先把它处理掉再来。')
    process.exit(1)
  }

  // 落盘：先备份，再写
  if (unlinkLink) {
    unlinkSync(LINK_PATH)
    console.log(`✓ 已解链 ${LINK_PATH}`)
  }
  if (manifestNext !== null) {
    const bak = `${PROFILE_MANIFEST}.bak-tag-memory-${Date.now()}`
    copyFileSync(PROFILE_MANIFEST, bak)
    writeFileSync(PROFILE_MANIFEST, manifestNext, 'utf8')
    console.log(`✓ 已摘清单条目 → ${PROFILE_MANIFEST}（备份 ${bak}）`)
  }
  if (patchNext !== null) {
    const bak = `${PROFILE_PATCH}.bak-tag-memory-${Date.now()}`
    copyFileSync(PROFILE_PATCH, bak)
    writeFileSync(PROFILE_PATCH, patchNext, 'utf8')
    console.log(`✓ 已摘补丁里的声明 → ${PROFILE_PATCH}（备份 ${bak}）`)
  }
  let removed = 0
  for (const f of memoryFiles) {
    try {
      const r = removeNotice(f.path)
      if (r.changed) { removed++; console.log(`✓ 已摘说明块 → ${f.agent}/${f.file}（备份 ${r.backup}）`) }
      else if (r.malformed || r.action === 'malformed') {
        // 标记残缺（有 BEGIN 没 END）：**故意不动那个文件**——宁可块留着，
        // 也不能为了「摘干净」把块外用户正文一起截掉。这里必须显式警告，
        // 不能只说「说明块不在」：用户得知道这个文件需要自己看一眼。
        console.log(`⚠ 标记不完整，未改动 → ${f.agent}/${f.file}`
          + `（${r.error ?? '有 BEGIN 没有 END'}；块外正文一个字节没动，请手工检查该文件）`)
      }
      else console.log(`· 说明块不在 → ${f.agent}/${f.file}`)
    } catch (e) {
      console.error(`✗ 说明块摘除失败 ${f.agent}/${f.file}：${String(e?.message ?? e)}`)
    }
  }
  console.log(`\nUNINSTALL OK（摘说明块 ${removed} 个；记忆库一个字节没动）`)
  console.log('\n⚠ 改动只在重启 DSH 后生效：宿主半与补丁层都只在进程启动时装载。')
  process.exit(0)
}

// ── 目标 profile ────────────────────────────────────────

check('profile manifest exists', existsSync(PROFILE_MANIFEST), PROFILE_MANIFEST)
const before = existsSync(PROFILE_MANIFEST) ? JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8')) : {}
const depSpec = before.dependencies?.[PACKAGE_NAME]
check('profile dependency spec', depSpec === undefined || depSpec.startsWith('link:'), String(depSpec))

// ── 本体放哪 ────────────────────────────────────────────
// 链接指向哪儿，加载器就从哪儿读。指向**会话下载目录**（`downloads\` / `tmp\` 之类）是实的风险：
// 那里被清理＝挂载本体凭空消失，界面与工具一起没了，而且不会报错，只是「本来有的东西不见了」。
const SESSION_DIR = /(^|[\\/])(downloads|tmp|temp)([\\/]|$)/i
if (BODY_DIR !== resolve(PACKAGE_DIR)) {
  const there = join(BODY_DIR, 'package.json')
  if (!existsSync(BODY_DIR) || readdirSync(BODY_DIR).length === 0) {
    report.push(`PASS  本体将装到 ${BODY_DIR}（--dest；现在是空的，apply 时拷过去）`)
  } else if (existsSync(there) && JSON.parse(readFileSync(there, 'utf8')).name === EXPECTED_NAME) {
    report.push(`PASS  本体将装到 ${BODY_DIR}（--dest；已有一份同包，apply 时覆盖刷新）`)
  } else {
    check(`--dest 目录可用（${BODY_DIR}）`, false, '那里有东西且不是本包——换个空目录')
  }
} else if (DEST) {
  report.push(`PASS  本体就在源码目录 ${BODY_DIR}（--dest 指的正是它，不拷）`)
} else {
  report.push(`PASS  本体就地：${PACKAGE_DIR}（没给 --dest）`)
  if (SESSION_DIR.test(PACKAGE_DIR)) {
    report.push(`WARN  本体现在在**会话目录**里（${PACKAGE_DIR}）——那里被清理＝挂载本体消失，`)
    report.push('      界面上什么都不报，只是「本来有的东西不见了」。加 --dest <持久路径> 重装一次可解。')
  }
}

// 已经装着的那条链接指向哪儿？与即将用的本体**不一致**就得说——否则「重装一次」看着成功，
// 链接还指着老地方（比如已经被清理的下载目录），人以为迁完了其实没有。
try {
  if (lstatSync(LINK_PATH).isSymbolicLink()) {
    const at = real(LINK_PATH)
    // apply 且不一致时会被重指，这里只按 check 的口径报；一致就不吭声
    if (at !== real(BODY_DIR)) {
      report.push(`WARN  profile 里那条链接指向别处：${at}`)
      report.push(isOurLink(LINK_PATH)
        ? `      本次要用的本体是 ${BODY_DIR}——apply 会把它重指过去（解到的地方确实是本包）。`
        : `      本次要用的本体是 ${BODY_DIR}——但解到的地方不是本包，apply 不会动它，请自己处理。`)
    }
  }
} catch { /* 没有链接：还没装过，正常 */ }

// ── 智能体半接没接上 ────────────────────────────────────
// 宿主半（设置页 / 记忆文件托管）由本包的 bundle patch 自动接上；**字典段与两个工具**
// 在 preset 半里，得靠 profile 补丁里的内联声明。没接上时界面照样能用，只是智能体
// 永远看不到字典、也调不到那两个工具——所以这里必须报出来，不能静默。
const patchText = existsSync(PROFILE_PATCH) ? readFileSync(PROFILE_PATCH, 'utf8') : ''
const bundlePatchText = existsSync(BUNDLE_PATCH) ? readFileSync(BUNDLE_PATCH, 'utf8') : ''
// 「接上了」有四种情形：bundle patch 自带（官方安装/新版推荐）/ profile 补丁里的全局声明
// （老版安装脚本留下的）/ 只挂在某个 preset 里（用户自己挂的）/ 压根没有。
let wireState = 'none' // 'bundle' | 'global' | 'scoped' | 'none'
if (bundlePatchText.includes(WIRE_MARK)) wireState = 'bundle'
else if (patchText.includes(WIRE_MARK)) {
  try { wireState = patchHasWire(parsePatch(patchText, 'profile 补丁')) ? 'global' : 'scoped' }
  catch { wireState = 'scoped' } // 解析不了就不乱断言
}
let wired = wireState === 'bundle' || wireState === 'global' // apply 时可能被 wire() 改写
report.push(
  wireState === 'bundle'
    ? `PASS  智能体半已接线（bundle patch、profile 平面全局）— ${BUNDLE_PATCH}`
    : wireState === 'global'
      ? `PASS  智能体半已接线（profile 平面、全局）— ${PROFILE_PATCH}`
      : wireState === 'scoped'
        ? `PASS  智能体半已接线，但只挂在某个 preset 里 —— 换个智能体就没有；新版 bundle patch 会全局接线（${PROFILE_PATCH}）`
        : `WARN  智能体半未接线 —— 字典段与 memory_write / memory_recall 不会出现在任何智能体里（${PROFILE_PATCH}）`,
)

// ── 记忆文件探测（check 模式下预览，apply 模式下写入）───

const memoryFiles = detectMemoryFiles(PRESET_ROOT, { names: DEFAULT_MEMORY_FILE_NAMES })
if (memoryFiles.length === 0) {
  report.push(`PASS  记忆文件探测：${PRESET_ROOT} 下没有 ${DEFAULT_MEMORY_FILE_NAMES.join('/')}（没有就不管）`)
} else {
  report.push(`PASS  记忆文件探测：命中 ${memoryFiles.length} 个 → ${memoryFiles.map((f) => f.agent + '/' + f.file).join('、')}`)
}

// ── 引擎（插件内置）与数据（独立目录）齐不齐 ──────────────
//
// 这一版起，读写核心、备份核心、字典样张、出厂模板**都随插件走**（`lib/engine/`），
// 不再去任何技能目录找。所以这道闸分两段查：
//   ① 引擎：在**插件包内**（PACKAGE_DIR/lib/engine）——缺了是安装不完整，必须 FAIL；
//   ② 数据：在**数据目录**（推断链与 lib/store.mjs 一致）——缺了会在首次启动时
//      自动按模板建库，所以这里只提示，不算失败。
const ENGINE_DIR = join(PACKAGE_DIR, 'lib', 'engine')
const ENGINE_MUST_HAVE = [
  'core.mjs',
  'backup.mjs',
  'tags.schema.json',
  'templates/memory.csv',
  'templates/index.md',
  'templates/backup.json',
]
const engineMissing = ENGINE_MUST_HAVE.filter((f) => !existsSync(join(ENGINE_DIR, f)))
check(`插件内置引擎齐（${ENGINE_DIR}）`, engineMissing.length === 0,
  engineMissing.length === 0 ? '' : `缺 ${engineMissing.join('、')} —— 插件装不完整，重装本包`)
if (engineMissing.length > 0) {
  report.push('      修法：引擎文件随插件发布，不该缺；请重装 / 重新解压本包，不要手工拼装')
}

/** 数据目录：`--data-dir` → `DSH_TAG_MEMORY_DATA_DIR` →（旧名）`DSH_TAG_MEMORY_SKILL_DIR` → `<DSH_HOME>/tag-memory`。 */
const DATA_DIR = getFlag('--data-dir',
  process.env.DSH_TAG_MEMORY_DATA_DIR?.trim()
  || process.env.DSH_TAG_MEMORY_SKILL_DIR?.trim()
  || join(DSH_HOME, 'tag-memory'))
const DATA_CSV = join(DATA_DIR, 'store', 'memory.csv')
const dataMissing = !existsSync(DATA_CSV)
check(`数据目录可用（${DATA_DIR}）`, true,
  dataMissing
    ? '还没有库 —— 插件首次启动会按内置模板自动建库（也可用 --seed 播初始记忆）'
    : '库已就位')
// 旧库兼容：新位置没库、老位置还有一本时，只提示，不自动搬。
const LEGACY_CSV = join(DSH_HOME, 'skills', 'marsma101-tag-memory', 'store', 'memory.csv')
if (dataMissing && existsSync(LEGACY_CSV)) {
  report.push(`WARN  检测到旧库：${LEGACY_CSV}`)
  report.push(`      插件不会自动搬库。要沿用旧库，把 ${DATA_DIR} 指过去，`)
  report.push(`      或把 ${join(DSH_HOME, 'skills', 'marsma101-tag-memory')} 整个拷到 ${DATA_DIR}（拷完重启 DSH）`)
}

// ── 初始记忆（--seed）：只在**空库**上写 ────────────────
// 出厂带两条「记什么 / 怎么算通用」（与机器无关），装机时再生成一条本机硬信息。
// 库里已经有条目就**一条都不写**——重复安装、升级插件都不会塞回这些种子，
// 也就不会有「更新一次多两条我没用过的记忆」这种事。
const SEED_FILE = join(PACKAGE_DIR, 'seed', 'memory.seed.json')
if (existsSync(SEED_FILE) && engineMissing.length === 0) {
  try {
    const lines = readFileSync(DATA_CSV, 'utf8').split('\n').filter((l) => l.trim() !== '')
    report.push(lines.length <= 1
      ? 'PASS  记忆库是空的 → 加 --seed 会写入 3 条初始记忆（记什么 / 怎么算通用 / 本机库在哪）'
      : 'PASS  记忆库里已有条目 → --seed 不会写任何东西（重复安装不会塞回种子）')
  } catch {
    report.push('SKIP  初始记忆状态读不出来（库还没建出来，--seed 时会先建库再播）')
  }
}

// ── check 模式收尾 ──────────────────────────────────────

if (mode === 'check') {
  console.log(report.join('\n'))
  console.log(`\n${fail.length === 0 ? 'CHECK OK' : `CHECK FAILED (${fail.length})`}`)
  if (memoryFiles.length > 0) {
    console.log(`\n若加 --apply，会往上面 ${memoryFiles.length} 个记忆文件写「记忆系统在运行」说明块`)
    console.log('（只认标记、只追加/原位替换、块外不动、首次落笔留 .bak）。')
  }
  if (!wired) {
    console.log(`\n若加 --wire-presets，会往 ${PROFILE_PATCH} 追加一条内联声明，`)
    console.log('把「字典段 + memory_write / memory_recall」在 profile 平面全局注册给所有智能体。')
    console.log('新版 bundle patch 已自带这条接线；只有老安装产物才需要这个兼容开关。')
  }
  console.log('\n⚠ 改完必须重启 DSH 才生效：宿主半与补丁层都只在进程启动时装载。')
  process.exit(fail.length === 0 ? 0 : 1)
}

// ── apply ───────────────────────────────────────────────

if (fail.length > 0) {
  console.log(report.join('\n'))
  console.error(`\n拒绝安装：${fail.length} 项校验未过`)
  process.exit(1)
}

// 0. （--dest）把本体拷到持久目录，再从那儿发链接
if (BODY_DIR !== resolve(PACKAGE_DIR)) {
  mkdirSync(BODY_DIR, { recursive: true })
  const there = join(BODY_DIR, 'package.json')
  if (existsSync(there)) {
    const name = JSON.parse(readFileSync(there, 'utf8')).name
    if (name !== EXPECTED_NAME) {
      console.error(`拒绝安装：${BODY_DIR} 里已有一个包（${name}），不是空目录——换一个 --dest，或先自己清掉`)
      process.exit(1)
    }
  }
  // filter 收到的是逐层的源/目标路径：源路径就长在 PACKAGE_DIR 下面，切出来只看名字
  cpSync(PACKAGE_DIR, BODY_DIR, {
    recursive: true,
    force: true,
    filter: (src) => !destSkip(relative(PACKAGE_DIR, src).split(/[\\/]/)[0]),
  })
  console.log(`✓ 本体已拷到 ${BODY_DIR}（不带 .git / node_modules / privhub / store）`)
} else if (DEST) {
  console.log(`· --dest 就是源码目录本身，不拷`)
}

// 1. node_modules 链接（Windows 用 junction，无需提权）
mkdirSync(join(PROFILE_DIR, 'node_modules'), { recursive: true })
let existed = false
try { existed = lstatSync(LINK_PATH).isDirectory() || lstatSync(LINK_PATH).isSymbolicLink() } catch { existed = false }
if (!existed) { symlinkSync(BODY_DIR, LINK_PATH, 'junction'); console.log(`已链接 ${LINK_PATH} -> ${BODY_DIR}`) }
else if (isOurLink(LINK_PATH) && real(LINK_PATH) !== real(BODY_DIR)) {
  // 指着别处（我们自己的另一份）：重指到本次要用的本体。否则「重装一次」看着成功，
  // 链接还指着老地方——比如那个随会话被清理的下载目录，人以为迁完了其实没有。
  unlinkSync(LINK_PATH)
  symlinkSync(BODY_DIR, LINK_PATH, 'junction')
  console.log(`已重指 ${LINK_PATH} -> ${BODY_DIR}`)
} else {
  console.log(`已存在，跳过：${LINK_PATH}`)
}

// 1b. 本包自己的依赖锚点：junction 模块按真实路径解析，裸 import 需要能走到 profile 的 hoist 目录
const HOIST_DIR = existsSync(join(PROFILE_DIR, '..', 'node_modules'))
  ? join(PROFILE_DIR, '..', 'node_modules')
  : join(PROFILE_DIR, 'node_modules')
const SELF_MODULES = join(BODY_DIR, 'node_modules')
let selfExisted = false
try { selfExisted = lstatSync(SELF_MODULES).isDirectory() || lstatSync(SELF_MODULES).isSymbolicLink() } catch { selfExisted = false }
if (selfExisted) console.log(`依赖锚点已存在：${SELF_MODULES}`)
else { symlinkSync(HOIST_DIR, SELF_MODULES, 'junction'); console.log(`依赖锚点：${SELF_MODULES} -> ${HOIST_DIR}`) }

// 2. profile 清单：依赖（link:）+ bundle 层（先备份原清单）
if (existsSync(PROFILE_MANIFEST)) {
  const bak = `${PROFILE_MANIFEST}.bak-tag-memory-${Date.now()}`
  copyFileSync(PROFILE_MANIFEST, bak)
  console.log(`已备份 profile 清单 → ${bak}`)
}
const after = structuredClone(before)
after.dependencies = { ...(after.dependencies ?? {}), [PACKAGE_NAME]: `link:${BODY_DIR}` }
after.dependencies = Object.fromEntries(Object.entries(after.dependencies).sort(([a], [b]) => a.localeCompare(b)))
const bundles = [...(after.dsh?.profile?.bundles ?? [])]
if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } }
writeFileSync(PROFILE_MANIFEST, JSON.stringify(after, null, 2) + '\n')
console.log(`已更新 ${PROFILE_MANIFEST}`)

// 3. 记忆文件：探测 + 写入说明块
const noticeText = renderNotice()
let wrote = 0
for (const f of memoryFiles) {
  try {
    const r = upsertNotice(f.path, noticeText, { migrateLegacyDict: true })
    if (r.changed) { wrote++; console.log(`✓ 记忆块 ${r.action === 'replaced' ? '原位替换' : '追加'} → ${f.agent}/${f.file}${r.backup ? `（备份 ${r.backup}）` : ''}`) }
    else console.log(`· 记忆块已在位 → ${f.agent}/${f.file}`)
  } catch (e) {
    console.error(`✗ 记忆块写入失败 ${f.agent}/${f.file}：${String(e?.message ?? e)}`)
  }
}
if (memoryFiles.length === 0) console.log(`· 没有记忆文件可写（${PRESET_ROOT}）`)

// 4. （可选）接线：把智能体半挂进 profile 补丁
//
// 为什么是这里、而不是各智能体的 `agent.cordis.yml`：
//   0.2.0 起 preset 是 **profile 补丁里的内联声明行**（`dsh-agent-preset`），
//   `<DSH_HOME>/.agent-presets/*/agent.cordis.yml` 已不被任何代码读取——写进去等于没写。
// 为什么挂全局、而不是逐个 preset：
//   `dsh-tools` 与 `dsh-system-prompt` 在 0.2.0 都装在 **profile 平面**（`dsh-base`），
//   全局注册
//   对所有智能体可见（局部注册按名字遮蔽全局，反之不成立）。挂一行，人人有份，
//   也不必去改别人已经写好的 preset 声明。

/** 往 <profile>/cordis.patch.yml 追加一段内联声明；先备份、写完解析校验、失败不留痕。 */
function wire() {
  if (existsSync(BUNDLE_PATCH) && readFileSync(BUNDLE_PATCH, 'utf8').includes(WIRE_MARK)) {
    console.log(`· 智能体半已由 bundle patch 全局接线，无需改 ${PROFILE_PATCH}`)
    return
  }
  if (!existsSync(PROFILE_PATCH)) {
    console.error(`✗ 接线跳过：没有 ${PROFILE_PATCH}`)
    return
  }
  const text = readFileSync(PROFILE_PATCH, 'utf8')
  if (text.includes(WIRE_MARK)) {
    console.log(`· 智能体半已接线 → ${PROFILE_PATCH}`)
    return
  }
  const BAK = `${PROFILE_PATCH}.bak-tag-memory-${Date.now()}`
  copyFileSync(PROFILE_PATCH, BAK)
  let next
  try {
    next = appendDeclaration(text)
  } catch (e) {
    rmSync(BAK, { force: true }) // 一字未动就别留孤儿 .bak
    console.error(`✗ 接线未落盘（原文件未改）：${String(e?.message ?? e)}`)
    return
  }
  writeFileSync(PROFILE_PATCH, next, 'utf8')
  wired = true
  console.log(`✓ 智能体半已接线 → ${PROFILE_PATCH}（备份 ${BAK}）`)
}

if (wirePresets) wire()

// 5. （可选）--seed：给**空库**播初始记忆
//
// 为什么是「装机时写」而不是「出厂预置一份填好的 CSV」：
//   ① `时间` 得是装机当天，写死一个日期很怪；
//   ② 第三条是**本机硬信息**（库在哪、备份地址），出厂根本不知道；
//   ③ 最要紧的一条——**只在 0 条时写**：重复安装、升级插件都不会塞回这些种子，
//      不会出现「更新一次，库里多两条我没用过的记忆」。
//
// 写不进去**不算安装失败**（库不在、字典读不了、某条没过校验都只提示）：插件该装的照装，种子的账另算。
async function seed() {
  if (!existsSync(SEED_FILE)) {
    console.log('· 初始记忆跳过：包里没有 seed/memory.seed.json')
    return
  }
  // 引擎从**插件内**取，数据从**数据目录**取——两边不再混在一起。
  const corePath = join(ENGINE_DIR, 'core.mjs')
  const engineSchema = join(ENGINE_DIR, 'tags.schema.json')
  if (!existsSync(corePath) || !existsSync(engineSchema)) {
    console.log(`· 初始记忆跳过：插件内置引擎不全（${ENGINE_DIR}）——重装本包`)
    return
  }
  // 数据目录还没有库时，先按内置模板起一份（与插件首次启动同一条路）。
  // 但**老位置还有一本时不建空库**——建了就等于让用户以为老记忆不见了。
  const LEGACY_CSV_FOR_SEED = join(DSH_HOME, 'skills', 'marsma101-tag-memory', 'store', 'memory.csv')
  if (!existsSync(DATA_CSV) && existsSync(LEGACY_CSV_FOR_SEED)) {
    console.log(`· 初始记忆跳过：检测到旧库（${LEGACY_CSV_FOR_SEED}），而数据目录 ${DATA_DIR} 还是空的。`)
    console.log('  插件不会自动搬库：请把旧库整个拷到数据目录，或用 --data-dir 指过去，再跑 --seed。')
    return
  }
  if (!existsSync(DATA_CSV)) {
    try {
      mkdirSync(join(DATA_DIR, 'store'), { recursive: true })
      mkdirSync(join(DATA_DIR, 'references'), { recursive: true })
      for (const f of ['memory.csv', 'index.md', 'backup.json']) {
        const src = join(ENGINE_DIR, 'templates', f)
        const dst = join(DATA_DIR, 'store', f)
        if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst)
      }
      const dstSchema = join(DATA_DIR, 'references', 'tags.schema.json')
      if (!existsSync(dstSchema)) copyFileSync(engineSchema, dstSchema)
      console.log(`· 数据目录还没有库，已按内置模板建出：${DATA_CSV}`)
    } catch (e) {
      console.log(`· 初始记忆跳过：建不出库（${String(e?.message ?? e)}）`)
      return
    }
  }
  const csv = DATA_CSV
  const lockPath = join(DATA_DIR, 'store', '.append.lock')
  const schemaPath = join(DATA_DIR, 'references', 'tags.schema.json')
  let core, schema, seedDoc
  try {
    core = await import(pathToFileURL(corePath).href)
    // 盘上那份字典优先（恢复备份会换它）；没有就用引擎里的样张。
    schema = JSON.parse(readFileSync(existsSync(schemaPath) ? schemaPath : engineSchema, 'utf8'))
    seedDoc = JSON.parse(readFileSync(SEED_FILE, 'utf8'))
  } catch (e) {
    console.log(`· 初始记忆跳过：读不了引擎/字典（${String(e?.message ?? e)}）`)
    return
  }
  let rows
  try { rows = core.readTable(readFileSync(csv, 'utf8')).rows } catch (e) {
    console.log(`· 初始记忆跳过：库文件读不出来（${String(e?.message ?? e)}）`)
    return
  }
  if (rows.length > 0) {
    console.log(`· 初始记忆跳过：库里已经有 ${rows.length} 条——一条都不写（重复安装不会塞回种子）`)
    return
  }

  // 第三条：本机硬信息，按实情生成（出厂文件里没有它）。
  let backupDir = ''
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_DIR, 'store', 'backup.json'), 'utf8'))
    if (typeof cfg?.backupDir === 'string') backupDir = cfg.backupDir
  } catch { /* 没配就是没配 */ }
  const localEntry = {
    内容: `这台机器的标签记忆库在 ${DATA_DIR}；备份地址${backupDir === '' ? '还没设置' : `是 ${backupDir}`}。`,
    环境: '本机',
    原因: '换机器 / 换目录时，「库到底在哪」是最先要问清楚的一件事',
    类型: '固定',
    稳定性: '易变',
    距离: '按需',
    项目: '通用',
    依据: '推断',
    关键词: '本机,记忆库',
  }
  const entries = [...(Array.isArray(seedDoc.entries) ? seedDoc.entries : []), localEntry]
  let wrote = 0
  for (const row of entries) {
    try {
      const id = core.appendEntry({ schema, csvPath: csv, lockPath, row })
      wrote++
      console.log(`✓ 初始记忆 +${id}`)
    } catch (e) {
      console.log(`✗ 初始记忆没写进去：${String(e?.message ?? e)}`)
    }
  }
  console.log(wrote === 0 ? '· 初始记忆：一条也没写' : `初始记忆写入 ${wrote} 条（以后库里已有条目时不会再写）`)
}

if (seedMemories) await seed()

// ── 解析自检 ────────────────────────────────────────────

const requireFromProfile = createRequire(PROFILE_MANIFEST)
const resolved = requireFromProfile
  .resolve?.paths(PACKAGE_NAME)
  ?.map((p) => join(p, PACKAGE_NAME))
  .find((p) => existsSync(join(p, 'package.json')))
console.log(resolved === undefined
  ? 'RESOLVE FAILED — 加载器会找不到本包'
  : `加载器解析到：${resolved}`)
console.log(resolved === undefined ? 'INSTALL INCOMPLETE' : `INSTALL OK（记忆块写入 ${wrote} 个）`)
if (resolved !== undefined) {
  console.log('\n⚠ 改动只在重启 DSH 后生效：宿主半与补丁层都只在进程启动时装载。')
  if (!wired) console.log('  （智能体半还没接线，见上面那条 WARN；新版 bundle patch 会随官方安装自动接线。）')
}
