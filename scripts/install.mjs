/**
 * 把 dsh-tag-memory 装进一个 DSH profile，离线完成。
 *
 *   node scripts/install.mjs                       # 只读校验（profile: web），并预览会写哪些记忆文件
 *   node scripts/install.mjs --apply               # 真正安装
 *   node scripts/install.mjs --profile <name>      # 换个 profile
 *   node scripts/install.mjs --apply --wire-presets  # 顺带把 /preset 行接进各智能体的 agent.cordis.yml
 *   node scripts/install.mjs --dsh-home <path>     # 换个 DSH_HOME（装到别的 DSH 时用）
 *
 * 写入（仅 apply）：
 *   1. <DSH_HOME>/profiles/<profile>/node_modules/dsh-tag-memory  （junction → 本仓库）
 *   2. <DSH_HOME>/profiles/<profile>/package.json                 （依赖 + bundle 条目）
 *   3. <DSH_HOME>/.agent-presets/<智能体>/MEMORY.md               （探测到才写；写的是受控说明块）
 *   4. （--wire-presets）<preset>/agent.cordis.yml                （接 /preset 行；先备份、装完校验）
 *
 * 它**不碰** profile 的 cordis.patch.yml：本包自带 bundle patch，加载器把它当一层应用。
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
  readdirSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MEMORY_FILE_NAMES, detectMemoryFiles, renderNotice, upsertNotice } from '../lib/notice.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')

const argv = process.argv.slice(2)
const mode = argv.includes('--apply') ? 'apply' : 'check'
const wirePresets = argv.includes('--wire-presets')
const getFlag = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PROFILE_NAME = getFlag('--profile', 'web')

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const DSH_HOME = getFlag('--dsh-home', process.env.DSH_HOME?.trim() || join(HOME, '.dsh'))
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME)
const PROFILE_MANIFEST = join(PROFILE_DIR, 'package.json')
const PRESET_ROOT = join(DSH_HOME, '.agent-presets')

const EXPECTED_NAME = 'dsh-tag-memory'
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name
const LINK_PATH = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME)

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
const clientText = typeof clientPath === 'string' && existsSync(join(PACKAGE_DIR, clientPath))
  ? readFileSync(join(PACKAGE_DIR, clientPath), 'utf8')
  : ''
check('client uses the module-loader contract', clientText.includes('window.__ModuleLoader__.load'))
check('client registers settings.section', clientText.includes("'settings.section'"))

const entryText = readFileSync(join(PACKAGE_DIR, manifest.main ?? 'index.js'), 'utf8')
check('host entry exports apply()', /export\s+function\s+apply\s*\(/.test(entryText))
check('host entry runs notice self-heal', /selfHeal/.test(entryText))
check('host entry cleans up its listener', /return\s*\(\)\s*=>/.test(entryText))
check('host entry serves the settings API', /webServer\.register\(/.test(entryText) && /\/tag-memory-api/.test(entryText))

const presetText = typeof presetPath === 'string' && existsSync(join(PACKAGE_DIR, presetPath))
  ? readFileSync(join(PACKAGE_DIR, presetPath), 'utf8')
  : ''
check('preset entry exports apply()', /export\s+function\s+apply\s*\(/.test(presetText))
check('preset registers a function-valued section', /systemPrompt\.section\(\{/.test(presetText) && /text:\s*\(\)\s*=>/.test(presetText))
check('preset registers memory_write + memory_recall', /'memory_write'/.test(presetText) && /'memory_recall'/.test(presetText))

// ── bundle patch ────────────────────────────────────────

const yamlPath = join(PROFILE_DIR, 'package.json')
let yaml = null
try {
  yaml = createRequire(yamlPath)('js-yaml')
} catch { /* 校验降级为文本检查 */ }
if (yaml) {
  const patch = yaml.load(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'))
  const rows = Array.isArray(patch) ? patch.flatMap((l) => l?.insert ?? []) : []
  check('bundle patch is one plain insert', Array.isArray(patch) && patch.length === 1 && rows.length === 1)
  check('bundle patch row names the package', rows[0]?.name === PACKAGE_NAME && rows[0]?.id === 'tag-memory', JSON.stringify(rows[0]))
} else {
  report.push('SKIP  bundle patch yaml parse (js-yaml unavailable)')
}

// ── 目标 profile ────────────────────────────────────────

check('profile manifest exists', existsSync(PROFILE_MANIFEST), PROFILE_MANIFEST)
const before = existsSync(PROFILE_MANIFEST) ? JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8')) : {}
const depSpec = before.dependencies?.[PACKAGE_NAME]
check('profile dependency spec', depSpec === undefined || depSpec.startsWith('link:'), String(depSpec))

// ── 记忆文件探测（check 模式下预览，apply 模式下写入）───

const memoryFiles = detectMemoryFiles(PRESET_ROOT, { names: DEFAULT_MEMORY_FILE_NAMES })
if (memoryFiles.length === 0) {
  report.push(`PASS  记忆文件探测：${PRESET_ROOT} 下没有 ${DEFAULT_MEMORY_FILE_NAMES.join('/')}（没有就不管）`)
} else {
  report.push(`PASS  记忆文件探测：命中 ${memoryFiles.length} 个 → ${memoryFiles.map((f) => f.agent + '/' + f.file).join('、')}`)
}

// ── 技能侧齐不齐 ────────────────────────────────────────
// 插件的读写/备份/恢复/合并逻辑**整个托在技能里**（一份逻辑）。技能要是太旧——比如少了
// scripts/lib/backup.mjs——插件装上了，「备份 / 恢复 / 合并」那排按钮也只会显示「不可用」。
// 这正是流程B 踩过的坑：技能是早先拷过去的，插件已更新到 M1.9，技能还停在没有 backup.mjs 的版本。
const SKILL_DIR = process.env.DSH_TAG_MEMORY_SKILL_DIR?.trim() || join(DSH_HOME, 'skills', 'marsma101-tag-memory')
const SKILL_MUST_HAVE = [
  'scripts/lib/core.mjs',
  'scripts/lib/backup.mjs',
  'references/tags.schema.json',
  'store/memory.csv',
]
const skillMissing = SKILL_MUST_HAVE.filter((f) => !existsSync(join(SKILL_DIR, f)))
check(`技能侧文件齐（${SKILL_DIR}）`, skillMissing.length === 0,
  skillMissing.length === 0 ? '' : `缺 ${skillMissing.join('、')} —— 缺 backup.mjs 的话备份/恢复/合并会显示「不可用」`)
if (skillMissing.includes('scripts/lib/backup.mjs')) {
  report.push('      修法：把插件仓库同版本的 scripts/lib/backup.mjs 拷进技能的 scripts/lib/ 下')
}

// ── check 模式收尾 ──────────────────────────────────────

if (mode === 'check') {
  console.log(report.join('\n'))
  console.log(`\n${fail.length === 0 ? 'CHECK OK' : `CHECK FAILED (${fail.length})`}`)
  if (memoryFiles.length > 0) {
    console.log(`\n若加 --apply，会往上面 ${memoryFiles.length} 个记忆文件写「记忆系统在运行」说明块`)
    console.log('（只认标记、只追加/原位替换、块外不动、首次落笔留 .bak）。')
  }
  process.exit(fail.length === 0 ? 0 : 1)
}

// ── apply ───────────────────────────────────────────────

if (fail.length > 0) {
  console.log(report.join('\n'))
  console.error(`\n拒绝安装：${fail.length} 项校验未过`)
  process.exit(1)
}

// 1. node_modules 链接（Windows 用 junction，无需提权）
mkdirSync(join(PROFILE_DIR, 'node_modules'), { recursive: true })
let existed = false
try { existed = lstatSync(LINK_PATH).isDirectory() || lstatSync(LINK_PATH).isSymbolicLink() } catch { existed = false }
if (existed) console.log(`已存在，跳过：${LINK_PATH}`)
else { symlinkSync(PACKAGE_DIR, LINK_PATH, 'junction'); console.log(`已链接 ${LINK_PATH} -> ${PACKAGE_DIR}`) }

// 1b. 本包自己的依赖锚点：junction 模块按真实路径解析，裸 import 需要能走到 profile 的 hoist 目录
const HOIST_DIR = existsSync(join(PROFILE_DIR, '..', 'node_modules'))
  ? join(PROFILE_DIR, '..', 'node_modules')
  : join(PROFILE_DIR, 'node_modules')
const SELF_MODULES = join(PACKAGE_DIR, 'node_modules')
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
after.dependencies = { ...(after.dependencies ?? {}), [PACKAGE_NAME]: `link:${PACKAGE_DIR}` }
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

// 4. （可选）接线：把 /preset 行加进各智能体的 agent.cordis.yml
if (wirePresets) {
  const PRESET_ROW = [
    '',
    '# ── 记忆：标签记忆（dsh-tag-memory）──────────────────────────────',
    '# 字典每轮由插件注入；memory_write / memory_recall 两个工具。',
    '# 数据在技能 marsma101-tag-memory 的 store/memory.csv。回滚：删掉下面三行。',
    '- id: tag-memory',
    "  name: 'dsh-tag-memory/preset'",
    '  config:',
    '    dir: !!js "process.getBuiltinModule(\'node:url\').fileURLToPath(new URL(\'.\', baseUrl))"',
    '',
  ].join('\n')
  for (const dir of presetDirs()) {
    const yml = join(dir, 'agent.cordis.yml')
    if (!existsSync(yml)) continue
    const text = readFileSync(yml, 'utf8')
    if (text.includes('dsh-tag-memory/preset')) { console.log(`· preset 已接线 → ${dir}`); continue }
    const bak = `${yml}.bak-tag-memory-${Date.now()}`
    copyFileSync(yml, bak)
    const next = text.replace(/\s*$/, '') + '\n' + PRESET_ROW
    if (yaml) {
      try {
        yaml.load(next)
      } catch (e) {
        console.error(`✗ 接线会让 YAML 非法，已回滚 ${yml}：${e.message}`)
        continue
      }
    }
    writeFileSync(yml, next, 'utf8')
    console.log(`✓ preset 已接线 → ${dir}（备份 ${bak}）`)
  }
}

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

/** 枚举 <DSH_HOME>/.agent-presets 下的目录（智能体档案目录，不要求含记忆文件）。 */
function presetDirs() {
  if (!existsSync(PRESET_ROOT)) return []
  return readdirSync(PRESET_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PRESET_ROOT, e.name))
}
