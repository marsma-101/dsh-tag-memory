/**
 * selftest.mjs —— 自检：一条命令验完插件的纯逻辑，**全程沙箱、不碰任何 live 数据**。
 *
 *   node scripts/selftest.mjs
 *
 * 做法：在系统临时目录里复制一份「技能骨架」（schema + core.mjs + 一份自造的小库），
 * 用 DSH_TAG_MEMORY_SKILL_DIR 把插件指过去。之后的读写都落在这份沙箱里，
 * 真库 store/memory.csv 与真档案目录一个字节都不写、也不读改。
 *
 * 覆盖：
 *   A. core  —— 解析/校验/取号；筛选的 与/或/非/区间/留白/多值/白名单/状态默认排除
 *   B. notice —— 探测（大小写不敏感）、追加/替换/幂等、旧字典块接管、块外不动、备份、自愈
 *   C. store —— 定位技能、载字典、取 core、渲染字典
 *   D. preset —— 注册字典段与两个工具；memory_recall 端到端读回沙箱条目
 *   E. index  —— 三个只读端点；E2 备份/恢复/合并（走真路由，跟界面同一条路径）
 *   F. client —— 静态检查 + 槽位登记（真跑一遍 apply）
 *   G. 渲染冒烟 —— 最小 React 桩真渲一遍「记忆」页；含「主位通则」版式断言
 *   H. backup —— 备份核心的边角：不覆盖已有内容、轮转、CLI 是薄壳
 *   I. 接装 —— 真跑一遍 install.mjs：接线产物是合法 YAML、失败不留痕
 *   I2. 初始记忆（--seed）—— 空库播 3 条且条条过校验；库里已有条目就**一条不写**
 *   J. 卸载 —— 装 → 卸 → 逐字节回到原样，记忆库一个字没动
 *   K. 库目录可配（libraryDir）
 *   L. 本体落点（--dest）+ 空环境跳过
 *
 * 没有记忆库的机器上：A…K **整节跳过**（说清缺什么），不报假 FAIL，退出码仍是 0。
 *
 * 退出码：0 = 全过（含「跳过」）；1 = 有 FAIL。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync, existsSync, symlinkSync, cpSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')

let pass = 0, fail = 0, skip = 0
const results = []
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; results.push(`PASS  ${label}`) }
  else { fail++; results.push(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
  return cond
}
const skipped = (label, why) => { skip++; results.push(`SKIP  ${label} — ${why}`) }

// ── 空环境闸：没有记忆库就**跳过**，不报假 FAIL ──────────────
//     这套自检要读记忆库里的字典（tags.schema.json）与读写核心（scripts/lib/core.mjs）。
//     在一台**还没装库**的机器上，这些文件本来就不在——那是「还没装」，不是「装坏了」。
//     以前这里会当场 ENOENT 抛出去，报一条 `FAIL 未捕获异常`，看着像插件坏了。
//     现在：把每一节都标明跳过、说清缺哪几个文件、怎么补，然后**以 0 退出**。
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const DSH_HOME = process.env.DSH_HOME?.trim() || join(HOME, '.dsh')
const realSkill = process.env.DSH_TAG_MEMORY_SKILL_DIR?.trim() || join(DSH_HOME, 'skills', 'marsma101-tag-memory')

const NEEDED_LIB = [
  'references/tags.schema.json',
  'scripts/lib/core.mjs',
  'scripts/lib/backup.mjs',
  'store/memory.csv',
]
const missingLib = NEEDED_LIB.filter((f) => !existsSync(join(realSkill, f)))
if (missingLib.length > 0) {
  for (const s of [
    'A. core（解析/校验/筛选）', 'B. notice（记忆文件托管）', 'C. store（定位库/载字典）',
    'D. preset（字典段与两个工具）', 'E. index（只读端点 / 备份·恢复·合并）', 'F. client（槽位登记）',
    'G. 渲染冒烟（「记忆」页）', 'H. backup（轮转·不覆盖）', 'I. 接装与接线',
    'J. 卸载往返', 'K. 库目录可配',
  ]) skipped(s, '记忆库不在，这一节读不到字典与读写核心')
  results.push(`      记忆库路径：${realSkill}`)
  results.push(`      缺：${missingLib.join('、')}`)
  results.push('      —— 跳过不等于通过：装好记忆库再跑。插件自身的静态项随时可查：node scripts/install.mjs check')
  const pkg0 = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  ok('package.json 导出 ./client 且声明 dsh.client（不看库也查得了）',
    pkg0.exports['./client'] === './client.js' && pkg0.dsh?.client?.platform === 'web')
  ok('package.json 声明 DSH engines 与运行时 peer（官方安装前提）',
    typeof pkg0.engines?.dsh === 'string'
      && typeof pkg0.peerDependencies?.['@deepseek-ai/dsh-tools'] === 'string'
      && typeof pkg0.peerDependencies?.['@deepseek-ai/schemastery'] === 'string')
  ok('package.json 导出 locale/icon 展示元数据',
    pkg0.exports?.['./locale/*.json'] === './locale/*.json' && pkg0.exports?.['./icon'] === './icon.svg')
  console.log(results.join('\n'))
  console.log(`\nSELFTEST SKIPPED（这台机器上还没有记忆库）   pass=${pass} fail=${fail} skip=${skip}`)
  process.exit(0)
}

const sandbox = mkdtempSync(join(tmpdir(), 'tagmem-selftest-'))

// ── 造沙箱技能：把真技能的 schema 与 core 复制过去，库换成自造小库 ──
const sandboxSkill = join(sandbox, 'skill')
mkdirSync(join(sandboxSkill, 'references'), { recursive: true })
mkdirSync(join(sandboxSkill, 'scripts', 'lib'), { recursive: true })
mkdirSync(join(sandboxSkill, 'store'), { recursive: true })
copyFileSync(join(realSkill, 'references', 'tags.schema.json'), join(sandboxSkill, 'references', 'tags.schema.json'))
copyFileSync(join(realSkill, 'scripts', 'lib', 'core.mjs'), join(sandboxSkill, 'scripts', 'lib', 'core.mjs'))
copyFileSync(join(realSkill, 'scripts', 'lib', 'backup.mjs'), join(sandboxSkill, 'scripts', 'lib', 'backup.mjs'))

// 表头照真库首行（保持列顺序一致）；数据自造两条（含一条 已归档 供默认排除用）
const header = readFileSync(join(realSkill, 'store', 'memory.csv'), 'utf8').split('\n')[0]
// 种子行**按列名定位**再照表头顺序拼——原先手写成定长字符串，表头一加列（如 `类型`）
// 就整排错位；行尾少几个空列时，值还会往前挤一格。
const HEAD = header.split(',')
const seedRows = [
  { id: 'M-20260101-001', 内容: '自检件A', 时间: '2026-01-01', 环境: 'selftest 沙箱', 原因: '验证用', 备注: '备注', 稳定性: '稳定', 成熟度: '语义', 距离: '常驻', 角色: 'selftest', 项目: '通用', 状态: '生效', 依据: '推断', 类型: '记忆' },
  { id: 'M-20260101-002', 内容: '自检件B（已归档，不该被默认读到）', 时间: '2026-01-01', 环境: 'selftest 沙箱', 原因: '验证默认排除', 稳定性: '稳定', 成熟度: '语义', 距离: '深藏', 角色: 'selftest', 项目: '通用', 状态: '已归档', 依据: '推断', 类型: '记忆' },
]
const seed = seedRows.map((o) => HEAD.map((c) => o[c] ?? '').join(',')).join('\n')
writeFileSync(join(sandboxSkill, 'store', 'memory.csv'), header + '\n' + seed + '\n', 'utf8')
// 备份要备三件套（memory.csv / index.md / backup.json）；backup.json 由 /backup/dir 生成。
writeFileSync(join(sandboxSkill, 'store', 'index.md'), '# 索引\n\n自检沙箱索引。\n', 'utf8')

// 把插件指向沙箱技能——必须在 import store.mjs 之前设好
process.env.DSH_TAG_MEMORY_SKILL_DIR = sandboxSkill

try {
  // ── A. core ───────────────────────────────────────────
  const store = await import(pathToFileURL(join(PKG, 'lib', 'store.mjs')).href)
  const core = store.getCore()
  const schema = store.loadSchema()
  const csvPath = store.CSV_PATH          // 现在指向沙箱
  const lockPath = store.LOCK_PATH

  ok('store 已指向沙箱技能', csvPath.startsWith(sandbox), csvPath)

  const id1 = core.appendEntry({ schema, csvPath, lockPath, row: {
    内容: '自检件C', 时间: '2026-01-01', 环境: 'selftest 沙箱', 原因: '验证 appendEntry',
    类型: '记忆', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 'selftest', 项目: '通用', 依据: '推断',
  } })
  ok('core.appendEntry 返回 M-YYYYMMDD-NNN', /^M-\d{8}-\d{3}$/.test(id1), id1)

  let threw = false
  try {
    core.appendEntry({ schema, csvPath, lockPath, row: { 内容: 'x', 类型: '记忆', 稳定性: '错值', 距离: '按需', 角色: 't', 项目: '通用', 依据: '推断' } })
  } catch { threw = true }
  ok('core.appendEntry 拦截 缺必填/枚举非法', threw)

  threw = false
  try {
    core.appendEntry({ schema, csvPath, lockPath, row: {
      内容: 'x', 环境: 'y', 原因: 'z', 类型: '固定', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 't', 项目: '通用', 依据: '推断',
    } })
  } catch { threw = true }
  ok('core 拒绝 类型≠记忆 时填深度（激活规则）', threw)

  // ── C-4：拒绝的话要说清「为什么」；同一句话写第二遍要拦住 ──
  //   这两件事都在**库侧的 core.mjs** 里，所以先问一句这份库有没有那两个机制，没有就点名跳过。
  const coreFeatures = core.CORE_FEATURES ?? {}
  if (!coreFeatures.writeDedupe) {
    skipped('C-4 写入去重 / 拒绝话术（库侧）', `当前用的这份记忆库的 core.mjs 还是旧版（${realSkill}）——先在库侧同步，再跑这节`)
  } else {
    // ① 话术：只丢一句「不能为空」，写的人（模型）只会随手填一个值糊过去。
    let why = ''
    try {
      core.appendEntry({ schema, csvPath, lockPath, row: { 内容: 'x', 类型: '记忆', 稳定性: '错值', 距离: '按需', 角色: 't', 项目: '通用', 依据: '推断' } })
    } catch (e) { why = String(e?.message ?? e) }
    ok('C-4 拒绝的话带上「为什么」（不能只说「不能为空」）',
      /必填项缺失/.test(why) && /误用|凭什么/.test(why), why.slice(0, 160))

    // ② 去重：在一份**一次性副本**上试，不动沙箱种子（后面的计数断言都靠它）。
    const ddHdr = core.readTable(readFileSync(csvPath, 'utf8')).header
    const ddBase = {
      内容: '去重甲', 时间: '2026-01-01', 环境: 'selftest 沙箱', 原因: '占位',
      类型: '记忆', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 'selftest', 项目: '通用', 依据: '推断',
    }
    const ddCsv = join(sandbox, 'dedupe-check.csv')
    const ddLock = join(sandbox, 'dedupe-check.lock')
    writeFileSync(ddCsv, ddHdr.join(',') + '\n' + core.buildLine(schema, ddHdr, { ...ddBase, id: 'M-20260101-001' }), 'utf8')

    let dupMsg = ''
    try { core.appendEntry({ schema, csvPath: ddCsv, lockPath: ddLock, row: { ...ddBase } }) } catch (e) { dupMsg = String(e?.message ?? e) }
    ok('C-4 同「内容 + 项目 + 类型」再写一条 → 拦住，并点出库里那一条、指向「被取代」',
      /M-20260101-001/.test(dupMsg) && /被取代/.test(dupMsg), dupMsg.slice(0, 200))
    ok('C-4 被拦住时**不落笔**（库里还是那一条）',
      core.readTable(readFileSync(ddCsv, 'utf8')).rows.length === 1)

    // 同一句话、不同项目＝两码事：同一个做法在两个项目下各自成立，不该拦。
    const ddOk = core.appendEntry({ schema, csvPath: ddCsv, lockPath: ddLock, row: { ...ddBase, 项目: '别的项目' } })
    ok('C-4 内容相同但「项目」不同 → 不算重复',
      /^M-\d{8}-\d{3}$/.test(ddOk) && core.readTable(readFileSync(ddCsv, 'utf8')).rows.length === 2, String(ddOk))

    // 旧的那条已经退场 → 不该再挡新的（「取代」是正路，写第二遍不是）。
    const dd2Csv = join(sandbox, 'dedupe-check2.csv')
    const dd2Lock = join(sandbox, 'dedupe-check2.lock')
    writeFileSync(dd2Csv, ddHdr.join(',') + '\n' + core.buildLine(schema, ddHdr, { ...ddBase, id: 'M-20260101-009', 状态: '被取代' }), 'utf8')
    const ddBack = core.appendEntry({ schema, csvPath: dd2Csv, lockPath: dd2Lock, row: { ...ddBase } })
    ok('C-4 旧条目已是「被取代」→ 不挡新的（取代是正路）', /^M-\d{8}-\d{3}$/.test(ddBack), String(ddBack))
  }

  const t0 = core.readTable(readFileSync(csvPath, 'utf8'))
  const cnt = (cond) => core.filterRows(schema, t0.header, t0.rows, cond).length
  // 种子：A(生效/常驻/语义)、B(已归档，默认排除)、C(新追加/按需/语义)。角色皆为 selftest。
  ok('filter 与：角色=selftest 命中 2（A/C；B 已归档被排除）', cnt({ 角色: 'selftest' }) === 2, String(cnt({ 角色: 'selftest' })))
  ok('filter 默认排除 已归档（自检件B 不在）', core.filterRows(schema, t0.header, t0.rows, { 角色: 'selftest' }).every((r) => !String(r[t0.header.indexOf('内容')]).includes('自检件B')))
  ok('filter 或：距离=常驻 ∪ 角色=selftest ≥2', cnt({ 或: [{ 距离: '常驻' }, { 角色: 'selftest' }] }) >= 2)
  ok('filter 非：排除 selftest → 0', cnt({ 非: { 角色: 'selftest' } }) === 0, String(cnt({ 非: { 角色: 'selftest' } })))
  ok('filter 区间：时间命中 ≥2', cnt({ 时间: { 区间: ['2025-01-01', '2027-12-31'] } }) >= 2)
  ok('filter 多值：深度=[语义,程序] 命中 ≥2', cnt({ 深度: ['语义', '程序'] }) >= 2)
  ok('filter 白名单：某维取「通用」→ 该维不限（任意值都命中）', cnt({ 项目: '随便什么项目' }) >= 2, String(cnt({ 项目: '随便什么项目' })))
  ok('filter 白名单：非通用值仍精确匹配（不存在值 → 0）', cnt({ 项目: '不存在的项目', 距离: '深藏' }) === 0, String(cnt({ 项目: '不存在的项目', 距离: '深藏' })))

  // 追加前先补换行（拿一次性副本试，不动沙箱种子）。
  // 库里最后一行末尾要是没换行（手工编辑、别的工具写坏了都可能），直接 appendFileSync 会把
  // 新条目**粘在上一行尾巴上**——解析出来变成一行 32 列，后一条实际上等于不存在。
  // 2026-10-12 就这么丢过一条：M-20261012-015 被并进 M-20261012-014，两条记忆一直只算一条。
  {
    const glueCsv = join(sandbox, 'glue-check.csv')
    const glueLock = join(sandbox, 'glue-check.lock')
    const hdr = core.readTable(readFileSync(csvPath, 'utf8')).header
    const seed = {
      内容: '粘行甲', 时间: '2026-01-01', 环境: 'selftest 沙箱', 原因: '占位',
      类型: '记忆', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 'selftest', 项目: '通用', 依据: '推断',
    }
    writeFileSync(glueCsv,
      hdr.join(',') + '\n'
      + core.buildLine(schema, hdr, { ...seed, id: 'M-20260101-001' })
      + core.buildLine(schema, hdr, { ...seed, id: 'M-20260101-002', 内容: '粘行乙' }).replace(/\n$/, ''), // 末尾**故意不留换行**
      'utf8')
    ok('构造好了「末尾没换行」的库', !readFileSync(glueCsv, 'utf8').endsWith('\n'))
    const id2 = core.appendEntry({ schema, csvPath: glueCsv, lockPath: glueLock, row: { ...seed, 内容: '粘行丙' } })
    const t2 = core.readTable(readFileSync(glueCsv, 'utf8'))
    ok('末尾没换行时追加，不会把新条目粘到上一行上',
      t2.rows.every((r) => r.length === hdr.length) && t2.rows.length === 3 && t2.rows.some((r) => r[0] === id2),
      `条数 ${t2.rows.length}、列数分布 ${JSON.stringify([...new Set(t2.rows.map((r) => r.length))])}（应为 3 条 / ${hdr.length} 列）`)
  }

  // ── D-1：格子数对不上，别静默错位 ──
  //   列是按下标读的：一行少一格，它后面每一格都往前串一位——界面看着有值、值是错的，
  //   判重拿它比的是错字段。这类错**不报错、不丢行**，所以最难发现，得专门盯。
  //   处置分两头：**读**只点名（界面照实说、备份照读不误），**写**直接拦下。
  if (core.CORE_FEATURES?.raggedGuard !== true) {
    skipped('D-1 列数校验（库侧）', `当前用的这份记忆库的 core.mjs 还是旧版（${realSkill}）——先在库侧同步，再跑这节`)
  } else {
    const hdrR = core.readTable(readFileSync(csvPath, 'utf8')).header
    const seedR = {
      内容: '错位甲', 时间: '2026-01-01', 环境: 'selftest 沙箱', 原因: '占位',
      类型: '记忆', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 'selftest', 项目: '通用', 依据: '推断',
    }
    const ragCsv = join(sandbox, 'ragged-check.csv')
    const ragLock = join(sandbox, 'ragged-check.lock')
    const brokenLine = 'M-20260101-003,少了几格,2026-01-01' // 故意只写 3 格（正常是 hdrR.length 格）
    writeFileSync(ragCsv,
      hdrR.join(',') + '\n'
      + core.buildLine(schema, hdrR, { ...seedR, id: 'M-20260101-001' })
      + core.buildLine(schema, hdrR, { ...seedR, id: 'M-20260101-002', 内容: '错位乙' })
      + brokenLine + '\n',
      'utf8')

    const tR = core.readTable(readFileSync(ragCsv, 'utf8'))
    ok('D-1 读的时候点名：哪一条、差几格（不改行、不抛错——带着这种行的旧备份也读得出来）',
      tR.rows.length === 3 && Array.isArray(tR.ragged) && tR.ragged.length === 1 &&
      tR.ragged[0].id === 'M-20260101-003' && tR.ragged[0].got === 3 && tR.ragged[0].want === hdrR.length,
      `条数 ${tR.rows.length}、ragged=${JSON.stringify(tR.ragged)}`)

    let ragMsg = ''
    try { core.appendEntry({ schema, csvPath: ragCsv, lockPath: ragLock, row: { ...seedR, 内容: '错位丙' } }) }
    catch (e) { ragMsg = String(e?.message ?? e) }
    ok('D-1 库里有错位行时**拒写**：点名哪一条、差几格，并给出去路（含「用备份退回」这条）',
      /M-20260101-003/.test(ragMsg) && /3 格 \/ 应为/.test(ragMsg) && /恢复|备份/.test(ragMsg),
      ragMsg.slice(0, 220))
    ok('D-1 被拦下时**不落笔**（库里还是那 3 条，最后一行一个字节没变）',
      core.readTable(readFileSync(ragCsv, 'utf8')).rows.length === 3 &&
      readFileSync(ragCsv, 'utf8').trimEnd().endsWith(brokenLine))

    // 逃生口：把那行补齐（或拆成两行）之后，写入立刻恢复——不能一坏就把库锁死。
    writeFileSync(ragCsv, readFileSync(ragCsv, 'utf8').replace(brokenLine + '\n',
      core.buildLine(schema, hdrR, { ...seedR, id: 'M-20260101-003', 内容: '补好的丙' })), 'utf8')
    const fixedId = core.appendEntry({ schema, csvPath: ragCsv, lockPath: ragLock, row: { ...seedR, 内容: '错位丁' } })
    const tFixed = core.readTable(readFileSync(ragCsv, 'utf8'))
    ok('D-1 把那一行修回整格后，写入立刻恢复（不是一坏就把库锁死）',
      /^M-\d{8}-\d{3}$/.test(fixedId) && tFixed.rows.length === 4 && tFixed.ragged.length === 0, String(fixedId))
  }

  // ── B. notice ─────────────────────────────────────────
  const notice = await import(pathToFileURL(join(PKG, 'lib', 'notice.mjs')).href)
  const presetRoot = join(sandbox, '.agent-presets')
  const mk = (agent, file, body) => {
    mkdirSync(join(presetRoot, agent), { recursive: true })
    writeFileSync(join(presetRoot, agent, file), body, 'utf8')
    return join(presetRoot, agent, file)
  }

  const fA = mk('agentA', 'MEMORY.md', '# MEMORY\n\n用户正文。\n\n<!-- BEGIN marsma101-tag-memory dict -->\n旧字典\n<!-- END marsma101-tag-memory dict -->\n\n用户结尾。\n')
  mk('agentB', 'memory.md', '# MEMORY\n\n无块。\n')
  mk('agentB', 'NOTES.md', '不该被认领\n')
  mk('agentC', 'MEMORY.md', '# MEMORY\n\n<!-- BEGIN dsh-tag-memory notice -->\n陈旧块\n<!-- END dsh-tag-memory notice -->\n')

  const detected = notice.detectMemoryFiles(presetRoot)
  ok('notice 探测：大小写不敏感（memory.md 也算）', detected.some((f) => f.agent === 'agentB' && f.file === 'memory.md'))
  ok('notice 探测：只认记忆文件名（NOTES.md 不算）', !detected.some((f) => f.file === 'NOTES.md'))
  ok('notice 探测：命中 3 个', detected.length === 3, String(detected.length))

  const text = notice.renderNotice()
  const s1 = notice.selfHeal({ presetRoot, noticeText: text })
  ok('notice 首轮写入 3 个', s1.written === 3, JSON.stringify({ written: s1.written, unchanged: s1.unchanged }))
  const s2 = notice.selfHeal({ presetRoot, noticeText: text })
  ok('notice 二次幂等：0 写入 / 3 未变', s2.written === 0 && s2.unchanged === 3)

  const aText = readFileSync(fA, 'utf8')
  ok('notice 接管旧字典块', !aText.includes('marsma101-tag-memory dict') && aText.includes(notice.NOTICE_BEGIN))
  ok('notice 块外内容原样保留', aText.includes('用户正文。') && aText.includes('用户结尾。'))
  ok('notice 首次落笔留 .bak', readdirSync(join(presetRoot, 'agentA')).some((f) => f.startsWith('MEMORY.md.bak-')))
  ok('notice 块被删后能补回（自愈）', (() => {
    writeFileSync(fA, '# MEMORY\n\n用户把块删了。\n', 'utf8')
    const r = notice.selfHeal({ presetRoot, noticeText: text })
    return r.written >= 1 && readFileSync(fA, 'utf8').includes(notice.NOTICE_BEGIN)
  })())

  // ── C. store ──────────────────────────────────────────
  ok('store.ready() = true', store.ready())
  const dict = core.renderDict(schema)
  ok('store 渲染字典含四维', /类型/.test(dict) && /深度/.test(dict) && /距离/.test(dict))
  ok('renderDictBlock 带标记', core.renderDictBlock(schema).includes(core.DICT_BEGIN) && core.renderDictBlock(schema).includes(core.DICT_END))

  // ── D. preset ─────────────────────────────────────────
  try {
    const sections = [], tools = []
    const ctx = { systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 50 }, tools: { register: (t) => tools.push(t) } }
    const preset = await import(pathToFileURL(join(PKG, 'preset.js')).href)
    preset.apply(ctx, { dir: 'C:/does/not/matter/assistant' })
    ok('preset 注册字典段', sections.length === 1 && sections[0].name === 'tag-memory:dict')
    ok('preset 注册 memory_write + memory_recall', tools.map((t) => t.name).sort().join(',') === 'memory_recall,memory_write')
    const exec = { agent: { id: 'selftest', session: { header: { cwd: 'X:\\proj' } } } }
    const out = await tools.find((t) => t.name === 'memory_recall').execute({ 条件: '{"角色":"selftest"}', 取几条: 5 }, exec)
    ok('preset.memory_recall 端到端读回沙箱条目', /命中\s*2\s*条/.test(out), out.split('\n')[0])
    const wrote = await tools.find((t) => t.name === 'memory_write').execute({
      内容: '自检件D', 环境: 'selftest 沙箱', 原因: '验证 memory_write 端到端',
      类型: '记忆', 深度: '程序', 稳定性: '稳定', 距离: '按需', 依据: '推断',
    }, exec)
    ok('preset.memory_write 端到端写入（角色=preset 目录名）', /已追加 M-/.test(wrote), wrote)

    // ── D2. 记忆快照（注入模型：B-1 字典+快照 / B-2 常驻真落地 / B-3 跨项目只给索引）──
    // 此时沙箱库里 3 条生效：A（常驻/通用）、C（按需/通用）、D（按需/本项目 proj）；B 已归档。
    const here = sections[0].text({ agent: { id: 'selftest', session: { header: { cwd: 'X:\\proj' } } } })
    ok('快照：字典之后还有条目正文（不再是「只有字典」）', /记忆快照/.test(here) && /## 记忆字典/.test(here), here.slice(0, 80))
    ok('快照 B-2：距离=常驻 的条目给全文', /\[M-20260101-001\] 自检件A/.test(here) && /环境：selftest 沙箱/.test(here))
    ok('快照：通用条目给全文', /\[M-\d{8}-\d{3}\] 自检件C/.test(here) && !/在「通用」：自检件C/.test(here))
    ok('快照：本项目条目给全文', /\[M-\d{8}-\d{3}\] 自检件D/.test(here))
    ok('快照：已归档 / 被取代 的条目不出现', !/自检件B/.test(here))
    ok('快照：表头报出「全文 / 只索引」条数', /生效 3 条：全文 3 条 \/ 只索引 0 条/.test(here), here.split('\n')[1])

    const away = sections[0].text({ agent: { id: 'selftest', session: { header: { cwd: 'Y:\\another' } } } })
    ok('跨项目闸门 B-3：别的项目条目只给一行索引', /- \[M-\d{8}-\d{3}\] 在「proj」：自检件D/.test(away), away.split('\n').filter((l) => l.includes('自检件D')).join(' | '))
    ok('跨项目闸门 B-3：索引行的正文不进上下文（环境那一行不给）', !/自检件D[\s\S]{0,60}环境：/.test(away))
    ok('跨项目闸门：通用 / 常驻仍给全文', /\[M-20260101-001\] 自检件A/.test(away) && /\[M-\d{8}-\d{3}\] 自检件C/.test(away))
    ok('快照随 cwd 变（换项目重切片）', here !== away)

    // 预算闸：把常驻上限压到 0 → A 降级成索引，并**明说**截了几条。
    {
      const s2 = []
      const ctx2 = { systemPrompt: { section: (s) => s2.push(s), getSectionOrder: () => 50 }, tools: { register: () => {} } }
      preset.apply(ctx2, { dir: 'C:/x', snapshot: { maxPinned: 0 } })
      const t2 = s2[0].text({ agent: { id: 'selftest', session: { header: { cwd: 'X:\\proj' } } } })
      ok('预算闸 B-2：maxPinned=0 → 常驻不再给全文（降为索引）', !/\[M-20260101-001\] 自检件A\n/.test(t2) && /在「通用」：自检件A/.test(t2))
      ok('预算闸 B-2：超上限时明说溢出', /常驻超过上限 0 条，其中 1 条只留索引/.test(t2), t2.split('\n').filter((l) => l.startsWith('> ')).join(' ｜ ').slice(0, 200))
    }

    // 退回档：关掉快照 → 与旧行为一致（只有字典）。
    {
      const s3 = []
      const ctx3 = { systemPrompt: { section: (s) => s3.push(s), getSectionOrder: () => 50 }, tools: { register: () => {} } }
      preset.apply(ctx3, { dir: 'C:/x', snapshot: { enabled: false } })
      const t3 = s3[0].text({ agent: { id: 'selftest', session: { header: { cwd: 'X:\\proj' } } } })
      ok('预算闸：snapshot.enabled=false → 退回「只注入字典」', /## 记忆字典/.test(t3) && !/记忆快照/.test(t3))
    }
  } catch (e) {
    if (/dsh-tools|Cannot find package/.test(String(e?.message ?? e))) skipped('preset 半（需要 @deepseek-ai/dsh-tools 依赖锚点）', '依赖未解析；装到 profile 后即可测')
    else { fail++; results.push(`FAIL  preset 半 — ${String(e?.message ?? e)}`) }
  }

  // ── E. index 半（宿主 API 路由）───────────────────────
  const mkRes = () => {
    const r = { statusCode: 0, headers: {}, body: '' }
    r.setHeader = (k, v) => { r.headers[k] = v }
    r.end = (b) => { r.body = b }
    return r
  }
  const routes = []
  const indexMod = await import(pathToFileURL(join(PKG, 'index.js')).href)
  ok('index 声明 inject webServer', Array.isArray(indexMod.inject) && indexMod.inject.includes('webServer'))
  // presetRoot 指到沙箱——apply 会立即自愈，绝不能落进真 .agent-presets。
  // 路由现在复用 DSH `connection` 服务的准入判断；测试桩默认放行，另有一条
  // 用例把它切成 401，验证未认证请求确实进不了 API。
  let authRejection
  const fakeCtx = {
    logger: {},
    on: () => () => {},
    webServer: { register: (r) => routes.push(r) },
    get: (name) => name === 'connection'
      ? { requestRejection: () => authRejection }
      : undefined,
  }
  const dispose = indexMod.apply(fakeCtx, { presetRoot, notice: true })
  ok('index 挂上 /tag-memory-api（prefix）', routes.length === 1 && routes[0].path === '/tag-memory-api' && routes[0].kind === 'prefix')
  const call = async (op, method = 'GET', query = '') => {
    const res = mkRes()
    await routes[0].handler({ url: `/tag-memory-api${op}${query}`, method }, res)
    return { status: res.statusCode, json: JSON.parse(res.body) }
  }
  authRejection = 401
  const denied = await call('/overview')
  authRejection = undefined
  ok('index API 未认证时返回 401（不在 WebServer 上裸奔）',
    denied.status === 401 && denied.json.error !== undefined, JSON.stringify(denied))
  const ov = await call('/overview')
  ok('index /overview ready 且含维度计数', ov.status === 200 && ov.json.ready === true && !!ov.json.byDimension?.距离, Object.keys(ov.json.byDimension ?? {}).join(','))
  ok('index /overview 记忆文件列 3 个', ov.json.notice?.files?.length === 3, String(ov.json.notice?.files?.length))

  // 设置页那份「标签字典」只读展示（GET /dict）。字典是**库里的**文件，沙箱已把它整份拷进来，
  // 所以这几条测的是真 shape（四维 / 列映射 / 上限 / 写入路由），不是造的样例。
  {
    const schemaPath = join(sandboxSkill, 'references', 'tags.schema.json')
    const schemaBefore = readFileSync(schemaPath, 'utf8')
    const di = await call('/dict')
    const dim = (n) => (di.json.dimensions ?? []).find((d) => d.name === n)
    ok('index /dict 就绪并报出四个维度（顺序照字典）',
      di.status === 200 && di.json.ready === true &&
      (di.json.dimensions ?? []).map((d) => d.name).join(',') === '类型,深度,稳定性,距离',
      JSON.stringify((di.json.dimensions ?? []).map((d) => d.name)))
    ok('index /dict 每维都带取值 + 说明（取值对象摊成数组）',
      (di.json.dimensions ?? []).every((d) => d.values.length > 0 && d.values.every((v) => v.value !== '')) &&
      (dim('类型')?.values ?? []).some((v) => v.value === '记忆' && String(v.desc).includes('提炼')),
      JSON.stringify(dim('类型')?.values))
    ok('index /dict 报出「列映射 / 上限 / 受谁管」这些真相',
      dim('深度')?.column === '成熟度' && dim('距离')?.cap === 10 &&
      String(dim('深度')?.gate?.when ?? '').includes('类型 = 记忆'),
      JSON.stringify({ column: dim('深度')?.column, cap: dim('距离')?.cap, gate: dim('深度')?.gate }))
    // `角色` / `项目` 那几个的 `values` 是**一句话**（不是枚举）——摊平这层方言是服务端的事，
    // 别让浏览器去猜「这个字符串到底是取值还是说明」。
    ok('index /dict 把「一句话取值」与枚举分开（角色：有 text、无 values）',
      (di.json.auxiliary ?? []).some((a) => a.name === '角色' && a.values.length === 0 && a.text !== '') &&
      (di.json.auxiliary ?? []).some((a) => a.name === '依据' && a.values.length === 3 && a.required === true),
      JSON.stringify((di.json.auxiliary ?? []).map((a) => `${a.name}:${a.values.length}/${a.text === '' ? '-' : 'text'}`)))
    ok('index /dict 带写入路由与召回口径',
      (di.json.writeRoutes?.rules ?? []).length >= 5 && di.json.recall?.takeFirst === 3 && (di.json.recall?.order ?? []).length >= 3,
      JSON.stringify({ routes: di.json.writeRoutes?.rules?.length, takeFirst: di.json.recall?.takeFirst }))
    ok('index /dict 报出来源路径与改动时间，并带「改完没重启」判据（stale）',
      typeof di.json.path === 'string' && di.json.path.endsWith('tags.schema.json') &&
      typeof di.json.mtime === 'string' && di.json.stale === false,
      JSON.stringify({ path: di.json.path, mtime: di.json.mtime, stale: di.json.stale }))
    // 这一版是**只读**：看一遍字典，磁盘上一个字节都不该变。
    ok('index /dict 只读（看完字典文件逐字节没变）', readFileSync(schemaPath, 'utf8') === schemaBefore)
  }

  // D-1 那件事得在**界面上看得见**：`/overview` 照实报出「哪几条格子数对不上」。
  // 这一段要往沙箱库上临时加一行坏行，跑完**逐字节放回去**——后面的计数断言全靠这份库。
  // 库侧没有 `raggedGuard`（老 core）时这里同样**点名跳过**：插件本身是诚实降级（报「没有」而不是
  // 假报一条），但「能查出坏行」这件事只有新库做得到，测不了就说测不了。
  if (core.CORE_FEATURES?.raggedGuard !== true) {
    skipped('D-1 界面报出坏行（/overview 的 health.ragged）', `当前用的这份记忆库的 core.mjs 还是旧版（${realSkill}）——先在库侧同步，再跑这节`)
  } else {
    const csvSnap = readFileSync(store.CSV_PATH, 'utf8')
    let bad
    try {
      writeFileSync(store.CSV_PATH, csvSnap.replace(/\n$/, '') + '\nM-20260101-999,错位行,2026-01-01\n', 'utf8')
      bad = await call('/overview')
    } finally {
      writeFileSync(store.CSV_PATH, csvSnap, 'utf8')
    }
    ok('index /overview 报出「有行格子数对不上」，并点名是哪一条',
      bad.json.health?.ok === false && bad.json.health?.ragged?.length === 1 &&
      bad.json.health.ragged[0].id === 'M-20260101-999' && bad.json.health.ragged[0].want === ov.json.header.length,
      JSON.stringify(bad.json.health))
    const clean = await call('/overview')
    ok('index /overview 库没毛病时 ok=true、ragged 空（而且库已逐字节放回原样）',
      clean.json.health?.ok === true && clean.json.health.ragged.length === 0 &&
      readFileSync(store.CSV_PATH, 'utf8') === csvSnap)
  }

  const en = await call('/entries', 'GET', '?cond=' + encodeURIComponent('{"角色":"selftest"}'))
  ok('index /entries 命中 2（A/C；B 已归档排除）', en.json.total === 2, String(en.json.total))
  const enD = await call('/entries', 'GET', '?cond=' + encodeURIComponent('{"角色":"assistant"}'))
  ok('index /entries 含 memory_write 落库项（角色=preset 目录名）', enD.json.total === 1, String(enD.json.total))
  const en2 = await call('/entries', 'GET', '?q=' + encodeURIComponent('自检件A'))
  ok('index /entries 关键词搜到 A（1 条）', en2.json.total === 1, String(en2.json.total))
  // P1：排序 / 分页 / 含已归档
  ok('index /overview 报出认得的排序档（客户端照它过滤下拉）',
    Array.isArray(ov.json.sorts) && ov.json.sorts.includes('file_desc') && ov.json.sorts.includes('id_desc'), JSON.stringify(ov.json.sorts))
  ok('index /overview 给出 状态 全集', Array.isArray(ov.json.statusValues) && ov.json.statusValues.join(',') === '生效,被取代,已归档', JSON.stringify(ov.json.statusValues))
  const own = '?cond=' + encodeURIComponent('{"角色":"selftest"}')
  const sAsc = await call('/entries', 'GET', `${own}&sort=id_asc`)
  const sDesc = await call('/entries', 'GET', `${own}&sort=id_desc`)
  ok('index /entries sort=id_asc 最早在前', sAsc.json.hits[0]?.id?.endsWith('-001') === true, sAsc.json.hits.map((h) => h.id).join(','))
  ok('index /entries 升/降序头条目相反', sAsc.json.hits[0].id !== sDesc.json.hits[0].id, `${sAsc.json.hits[0].id} vs ${sDesc.json.hits[0].id}`)
  const tDesc = await call('/entries', 'GET', `${own}&sort=time_desc`)
  ok('index /entries sort=time_desc 最新在前', tDesc.json.hits[0].时间 >= tDesc.json.hits[1].时间, tDesc.json.hits.map((h) => h.时间).join(','))
  // A / C 的「时间」并列（同一天写进去的就是这样），这时不许塌回文件原序（＝最老的在前）。
  ok('index /entries sort=time_desc 并列时后写进去的排前面', tDesc.json.hits[0].id === id1, tDesc.json.hits.map((h) => h.id).join(','))
  const fDesc = await call('/entries', 'GET', `${own}&sort=file_desc`)
  const plain = await call('/entries', 'GET', own)
  ok('index /entries sort=file_desc ＝ 文件原序倒过来（最后写进去的排最前）',
    fDesc.json.hits.map((h) => h.id).join(',') === plain.json.hits.map((h) => h.id).reverse().join(','),
    `file_desc=${fDesc.json.hits.map((h) => h.id).join(',')} 原序=${plain.json.hits.map((h) => h.id).join(',')}`)
  const pg0 = await call('/entries', 'GET', `${own}&limit=1&offset=0`)
  const pg1 = await call('/entries', 'GET', `${own}&limit=1&offset=1`)
  ok('index /entries 分页 offset=0：示 1 条且 hasMore', pg0.json.shown === 1 && pg0.json.total === 2 && pg0.json.hasMore === true, JSON.stringify({ shown: pg0.json.shown, total: pg0.json.total, hasMore: pg0.json.hasMore }))
  ok('index /entries 分页 offset=1：取到第 2 条且到底', pg1.json.shown === 1 && pg1.json.hasMore === false && pg1.json.hits[0].id !== pg0.json.hits[0].id)
  const arch = await call('/entries', 'GET', '?cond=' + encodeURIComponent('{"角色":"selftest","状态":["生效","被取代","已归档","留白"]}'))
  ok('index /entries 显式状态全集 → 含已归档（3 条）', arch.json.total === 3, String(arch.json.total))
  // P2：同维多值（数组 = 或）
  const one = await call('/entries', 'GET', '?cond=' + encodeURIComponent('{"深度":["程序"]}'))
  const both = await call('/entries', 'GET', '?cond=' + encodeURIComponent('{"深度":["程序","语义"]}'))
  ok('index /entries 单值数组 cond（深度=程序）', one.json.total === 1, String(one.json.total))
  ok('index /entries 同维多值 = 或（程序 ∪ 语义 = 3）', both.json.total === 3, String(both.json.total))
  const bad = await call('/entries', 'GET', '?cond=notjson')
  ok('index /entries 坏 JSON 报错而非 500', bad.status === 200 && bad.json.error !== undefined && bad.json.hits.length === 0)
  const he = await call('/heal', 'POST')
  ok('index /heal 返回 summary + notice', he.status === 200 && he.json.summary !== undefined && he.json.notice !== undefined)
  // 目录选择自查：两套后端**互斥**、开机定死，「选文件夹为什么弹不出来」先问这里，别猜。
  // fakeCtx 上没有 get，所以必然报 service:false / kind:null——正好是「这台 DSH 没这服务」的样子，
  // 而不是抛。
  const pk = await call('/picker')
  ok('index /picker 报得出目录选择后端（拿不到服务时 kind=null，不抛）',
    pk.status === 200 && pk.json.service === false && pk.json.kind === null)

  // ── E2. 备份 / 恢复 / 合并（走宿主路由，跟界面同一条路径）──
  /** POST 带 JSON 体：handler 里的 readBody 靠 req.on('data'/'end')。 */
  const post = async (op, body) => {
    const res = mkRes()
    const req = {
      url: `/tag-memory-api${op}`,
      method: 'POST',
      on(event, fn) {
        if (event === 'data') fn(Buffer.from(JSON.stringify(body ?? {})))
        else if (event === 'end') fn()
        return req
      },
    }
    await routes[0].handler(req, res)
    return { status: res.statusCode, json: JSON.parse(res.body) }
  }

  /** 沙箱库现在有几条（数据行）。 */
  const countRows = () => core.readTable(readFileSync(store.CSV_PATH, 'utf8')).rows.length

  const bkDir = join(sandbox, 'backups')
  const st0 = await call('/backup')
  ok('index /backup 报「没设地址」，不去猜一个默认目录',
    st0.status === 200 && st0.json.available === true && st0.json.dirSet === false && st0.json.dir === '')

  const noDir = await post('/backup', {})
  ok('index POST /backup 没地址 → code=NO_DIR（界面据此降级成「设置地址」，不是弹提醒）',
    noDir.json.ok === false && noDir.json.code === 'NO_DIR')

  // 目录选择框走**客户端**（DSH 自己的 uiWorkspace.pickDirectory），服务端不掺和。
  // 曾经在服务端 spawn PowerShell 弹，实测框开在别的窗口后面 = 等于弹不出，已撤。
  const indexSrc0 = readFileSync(join(PKG, 'index.js'), 'utf8')
  ok('index 不再自己 spawn 进程弹框（PowerShell 那条路已撤）',
    !indexSrc0.includes('child_process') && !indexSrc0.includes('powershell') &&
    !indexSrc0.includes('FolderBrowserDialog') && !indexSrc0.includes('/pick-dir'))

  const relDir = await post('/backup/dir', { dir: 'relative\\path' })
  ok('index POST /backup/dir 拒相对路径', relDir.json.ok === false && /绝对路径/.test(String(relDir.json.error)))

  const setDir = await post('/backup/dir', { dir: bkDir })
  ok('index POST /backup/dir 建目录 + 落配置 + 回报新状态',
    setDir.json.ok === true && setDir.json.created === true && setDir.json.status.dirSet === true && setDir.json.status.dir === bkDir)

  const beforeBackup = countRows()
  // 校验的**条数**随备份清单长短走（库里加了「字典」那条就多一项），所以不去钉死总数，
  // 钉两件真正要保证的事：每一条都过、并且**逐字节比过**那两个身份文件。
  const bk1 = await post('/backup', { label: '自检' })
  ok('index POST /backup 逐项校验（字节/sha/记录数/BOM）全过',
    bk1.json.ok === true && bk1.json.result.checks.length >= 4 && bk1.json.result.checks.every((c) => c.ok),
    JSON.stringify(bk1.json.result?.checks))
  ok('index POST /backup 水位记到「刚才那一条数」',
    bk1.json.status.lastCount === beforeBackup && bk1.json.status.dirSet === true)
  const stampA = bk1.json.result.stamp

  // 恢复必须**整体替换**：先往库里再加一条，再恢复到刚才那一份，新加的那条应当消失。
  core.appendEntry({ schema, csvPath, lockPath, row: {
    内容: '恢复前多出来的这一条', 环境: 'selftest 沙箱', 原因: '验证整体替换',
    类型: '记忆', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 'selftest', 项目: '通用', 依据: '推断',
  } })
  const dirtyCount = countRows()
  ok('恢复前：库里已经多了一条（和备份对不上）', dirtyCount === beforeBackup + 1, `${beforeBackup} → ${dirtyCount}`)

  // ── P-8：**字典**随库一起备；恢复时比对、换回、并明示 ──
  //   「备」那半在本节测不了——它在**记忆库**的 backup.mjs 里（库侧），沙箱用的就是取来的那一份。
  //   所以先问一句「这份库支不支持」，不支持就**点名跳过**，不假装通过。
  const sandboxSchemaPath = join(sandboxSkill, 'references', 'tags.schema.json')
  const schemaOrig = readFileSync(sandboxSchemaPath, 'utf8')
  let schemaSupportsBackup = false
  try {
    const bkFiles = store.getBackupCore().BACKUP_FILES
    schemaSupportsBackup = Array.isArray(bkFiles) && bkFiles.some((f) => f.src === 'tags.schema.json')
  } catch { schemaSupportsBackup = false }
  if (!schemaSupportsBackup) {
    skipped('P-8 字典随备份 / 恢复时比对', `当前用的这份记忆库还不支持（${realSkill}）——先在库侧同步 backup.mjs，再跑这节`)
  } else {
    ok('P-8 备份目录里出现 schema-<戳>.json（字典跟库一起走）',
      existsSync(join(bkDir, `schema-${stampA}.json`)) &&
      readFileSync(join(bkDir, `schema-${stampA}.json`), 'utf8') === schemaOrig)
    const stA = await call('/backup')
    ok('P-8 备份状态报出「这一份带没带字典」与当前字典版本',
      stA.json.recent?.[0]?.hasSchema === true && typeof stA.json.currentSchemaVersion === 'string' && stA.json.currentSchemaVersion !== '',
      JSON.stringify({ has: stA.json.recent?.[0]?.hasSchema, v: stA.json.currentSchemaVersion }))
    // 改了字典而备份里还是旧的那一份 —— 两套库就是因为这类偏差分叉过一次，状态里得自己说出来。
    writeFileSync(sandboxSchemaPath, schemaOrig.replace(/"version":\s*"[^"]*"/, '"version": "2099-01-01"'), 'utf8')
    const stB = await call('/backup')
    ok('P-8 字典改过而备份还是旧的 → 状态里点名说出来（不是等出事才发现）',
      stB.json.schemaChangedSinceBackup === true && stB.json.due === true &&
      (stB.json.dueReason ?? []).some((r) => String(r).includes('标签字典')),
      JSON.stringify({ changed: stB.json.schemaChangedSinceBackup, due: stB.json.dueReason }))
  }

  const rst = await post('/restore', { stamp: stampA })
  ok('index POST /restore 整体替换成那一版（多出来的那条没了）',
    rst.json.ok === true && rst.json.entryCount === beforeBackup && countRows() === beforeBackup, JSON.stringify({ want: beforeBackup, got: rst.json.entryCount, file: countRows(), res: rst.json }))
  ok('index POST /restore 先把「恢复前那一版」留了档', typeof rst.json.preBackup === 'string' && rst.json.preBackup !== '')
  ok('index POST /restore 恢复前的那一版档里，条数是弄脏后的数',
    readFileSync(join(bkDir, `memory-${rst.json.preBackup}.csv`), 'utf8') !== '' &&
    core.readTable(readFileSync(join(bkDir, `memory-${rst.json.preBackup}.csv`), 'utf8')).rows.length === dirtyCount)

  if (schemaSupportsBackup) {
    // 恢复是**整体替换**：库换回了那一版，说明书也得跟着换回来，不然库和字典就是两代人的东西。
    ok('P-8 恢复时字典一起换回那一版（库和说明书不分家）',
      rst.json.schema?.available === true && rst.json.schema.swapped === true &&
      readFileSync(sandboxSchemaPath, 'utf8') === schemaOrig,
      JSON.stringify(rst.json.schema))
    ok('P-8 恢复结果里说清字典怎么处理了（不静默换）',
      typeof rst.json.schema?.note === 'string' && /换回|一样|没有字典/.test(rst.json.schema.note) &&
      readFileSync(sandboxSchemaPath, 'utf8') === schemaOrig)
    // 「看着成功、其实没生效」的经典坑：字典文件换了，进程里那份缓存还是旧的，
    // 于是界面显示新字典、注入用的还是老字典。这里就用 /dict 的 stale 戳穿它。
    const dictAfter = await call('/dict')
    ok('P-8 换完字典当场生效（进程里的缓存也丢了，不用重启）',
      dictAfter.json.stale === false && dictAfter.json.version === JSON.parse(schemaOrig).version,
      JSON.stringify({ stale: dictAfter.json.stale, version: dictAfter.json.version }))

    // 老备份（还没有「字典随库走」那会儿留的）恢复时不能假装：字典保持不动，并且明说。
    const oldStamp = '20980101-0000'
    writeFileSync(join(bkDir, `memory-${oldStamp}.csv`), readFileSync(join(bkDir, `memory-${stampA}.csv`)))
    writeFileSync(join(bkDir, `index-${oldStamp}.md`), readFileSync(join(bkDir, `index-${stampA}.md`)))
    const oldRst = await post('/restore', { stamp: oldStamp })
    ok('P-8 老备份（没有字典）→ 字典原地不动，并说清「是加字典之前的备份」',
      oldRst.json.ok === true && oldRst.json.schema?.available === false && oldRst.json.schema.swapped === false &&
      /没有字典/.test(String(oldRst.json.schema?.note)) && readFileSync(sandboxSchemaPath, 'utf8') === schemaOrig,
      JSON.stringify(oldRst.json.schema))
  }

  const badStamp = await post('/restore', { stamp: '20990101-0000' })
  ok('index POST /restore 不存在的备份 → 报错不落笔', badStamp.json.ok === false && countRows() === beforeBackup)

  // ── 合并：外来的 memory.csv（一条重复 + 一条撞 id 的新内容 + 一条纯新增）──
  const local = core.readTable(readFileSync(store.CSV_PATH, 'utf8'))
  const contentIdx = local.header.indexOf('内容')
  const dupContent = local.rows[0][contentIdx]
  const foreign = join(sandbox, 'foreign-memory.csv')
  writeFileSync(foreign, [
    header,
    `M-20260101-001,${dupContent},2026-01-01,别处,重复用,备注,稳定,语义,常驻,selftest,通用,生效,,,,推断`,
    'M-20260101-001,外来件甲（跟本地某条撞 id）,2026-01-02,别处,撞号用,备注,稳定,语义,常驻,别的机器,通用,生效,,,,推断',
    'M-20990101-001,外来件乙,2026-01-03,别处,真新增,备注,稳定,语义,常驻,别的机器,通用,生效,,,,推断',
    'M-20990101-002,外来件丙（必填缺项，不该进）,2026-01-04,,,,稳定,语义,常驻,别的机器,通用,生效,,,,',
    '',
  ].join('\n'), 'utf8')

  const dry = await post('/merge', { path: foreign })
  ok('index POST /merge 预演：新增 2 / 重复跳过 1 / 撞号 1',
    dry.json.ok === true && dry.json.dryRun === true && dry.json.counts.new === 2 && dry.json.counts.duplicate === 1 && dry.json.counts.idCollision === 1,
    JSON.stringify(dry.json.counts))
  // 预演就得说实话：必填缺项的行**预演时**就要挑出来，不能等真合并才一条条失败
  // （否则预演说「要加 3 条」、真合并只进去 2 条，看着像合并吞了一条）。
  ok('index POST /merge 预演就把必填缺项的行挑出来（不是等真合并才失败）',
    dry.json.counts.invalid === 1 && /必填项缺失/.test(dry.json.invalidList?.[0]?.why ?? ''),
    JSON.stringify(dry.json.invalidList))
  ok('index POST /merge 预演不动库（一个字节都没写）', countRows() === beforeBackup)

  const applied = await post('/merge', { path: foreign, apply: true })
  ok('index POST /merge 真合并：追加 2 条 + 合并前留档 + 只追加不重写',
    applied.json.ok === true && applied.json.appended.length === 2 && applied.json.appended.every((a) => /^M-\d{8}-\d{3}$/.test(a.id)) && countRows() === beforeBackup + 2 && typeof applied.json.preBackup === 'string',
    JSON.stringify(applied.json.failed ?? applied.json))
  const afterMerge = core.readTable(readFileSync(store.CSV_PATH, 'utf8'))
  ok('index POST /merge 没动原有行（前 N 行逐字节不变）',
    afterMerge.rows.slice(0, beforeBackup).every((r, i) => r.join('') === local.rows[i].join('')))

  const merged = await post('/merge', { path: foreign })
  ok('index POST /merge 再合一次：全成重复，新增 0', merged.json.counts.new === 0 && merged.json.counts.duplicate === 3, JSON.stringify(merged.json.counts))

  dispose()

  // ── F. client 半（静态检查；浏览器模块无法在 node 里跑）──
  const clientSrc = readFileSync(join(PKG, 'client.js'), 'utf8')
  try {
    const vm = await import('node:vm')
    new vm.Script(clientSrc, { filename: 'client.js' })
    ok('client.js 语法可编译', true)
  } catch (e) { fail++; results.push(`FAIL  client.js 语法 — ${String(e?.message ?? e)}`) }
  ok('client.js 用模块加载器契约', clientSrc.includes('window.__ModuleLoader__.load'))
  ok('client.js 注册 settings.section', clientSrc.includes("'settings.section'"))
  ok('client.js 请求带 sort / offset（P1）', clientSrc.includes("params.set('sort'") && clientSrc.includes("params.set('offset'"))
  ok('client.js 有「含已归档」与详情展开（P1）', clientSrc.includes('includeArchived') && clientSrc.includes('DETAIL_FIELDS'))
  ok('client.js 同维多值 + 条件面包屑（P2）', clientSrc.includes('function dimOn') && clientSrc.includes('function renderCrumbs'))
  ok('client.js 勾选与导出（P2）', clientSrc.includes('function rowsToMarkdown') && clientSrc.includes('function rowsToCSV') && clientSrc.includes('function exportSelected'))
  ok('client.js 缺省排序 = id ↓（最新写的在最上面）', clientSrc.includes("? saved.sort : 'id_desc'"), '')
  ok('client.js 视图存档带版本号（改缺省值才顶得动老存档）',
    clientSrc.includes('const STORE_VERSION =') && clientSrc.includes('v: STORE_VERSION') && clientSrc.includes('parsed.v !== STORE_VERSION'), '')
  ok('client.js 排序档含「最近加入」', clientSrc.includes("'file_desc'") && clientSrc.includes('最近加入'), '')
  // 旧宿主（不报 overview.sorts）不许把新档摆出来：file_desc 在旧宿主上不报错，只是当没看见、
  // 照样返回原序——点下去没反应还不吭声，比报错更难查。
  ok('client.js 按宿主能力过滤排序档（旧宿主不摆死选项）',
    clientSrc.includes('Array.isArray(overview.sorts) ? overview.sorts : SORTS_LEGACY') && clientSrc.includes('sortOptions.map'), '')
  ok('client.js 记住视图偏好 + 键盘 / 与 Esc（P3）', clientSrc.includes('STORE_KEY') && clientSrc.includes("event.key === '/'") && clientSrc.includes("event.key === 'Escape'"))
  ok('client.js 单条复制（P3）', clientSrc.includes('function copyOne'))
  // 页面「点一下就刷」的根因：按钮落在 <form> 里且没写 type 时，浏览器按 submit 处理，整页导航。
  // 两条一起钉住：本文件不许有 form，每颗按钮都必须写 type: 'button'。
  ok('client.js 里不许有 <form>（原生提交会把整页刷掉）', !/'form'\s*,/.test(clientSrc))
  {
    const re = /createElement\(\s*'button'\s*,\s*\{([^}]*)\}/g
    const missing = []
    let m
    while ((m = re.exec(clientSrc)) !== null) {
      if (!/type:\s*'button'/.test(m[1])) missing.push(clientSrc.slice(0, m.index).split('\n').length)
    }
    ok('client.js 每颗按钮都写 type:\'button\'', missing.length === 0, `缺 type 的行：${missing.join(', ')}`)
  }

  // F2. 槽位登记：真跑一遍 apply，看它到底注册了哪几个槽。
  //     侧边栏按钮必须是 sidebar.panellist，且 id 与 main 面板的 key 相同。
  try {
    let captured = null
    const vm = await import('node:vm')
    const stub = {}
    const reactStub = {
      createElement: (...a) => ({ a }),
      Fragment: Symbol('Fragment'),
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useCallback: (f) => f,
      useMemo: (f) => f(),
    }
    vm.runInNewContext(clientSrc, { window: { __ModuleLoader__: { load: (m) => { captured = m } } } }, { filename: 'client.js' })
    ok('client.js load 的 id 是插件名', captured !== null && captured.id === 'dsh-tag-memory')
    const mod = captured.factory((name) => (name === 'react' ? reactStub : stub))
    const regs = []
    let cur = null
    const slots = {
      inject: (name, run) => { cur = name; run(); cur = null },
      register: (opts, comp) => { regs.push({ slot: cur, opts, comp }); return () => {} },
    }
    mod.apply({ slots, get: (k) => (k === 'slots' ? slots : undefined) })
    const bySlot = Object.fromEntries(regs.map((r) => [r.slot, r]))
    ok('apply 注册 main / sidebar.panellist / settings.section', regs.length === 3 && bySlot.main !== undefined && bySlot['sidebar.panellist'] !== undefined && bySlot['settings.section'] !== undefined)
    ok('sidebar.panellist 的 id 与 main 的 key 一致', bySlot.main?.opts?.key === bySlot['sidebar.panellist']?.opts?.id && bySlot.main?.opts?.key === 'tag-memory')
    ok('侧边栏按钮排在官方「插件」下面（order 5）且文案为「记忆」', bySlot['sidebar.panellist']?.opts?.order === 5 && bySlot['sidebar.panellist']?.opts?.label?.() === '记忆')
    ok('侧边栏图标与主区面板都是组件', typeof bySlot['sidebar.panellist']?.comp === 'function' && typeof bySlot.main?.comp === 'function')
    ok('主区面板自带滚动容器（shell 的 .centerCol 是 overflow:hidden）',
      /\.tm-panel\s*\{[^}]*height:100%[^}]*overflow:auto/.test(clientSrc))
    ok('主区面板顶部让出窗口顶带变量', /\.tm-panel\s*\{[^}]*--dsh-frame-top-clearance/.test(clientSrc))

    // 目录选择走宿主：注册时把 pickDir / listDir 注入给**主区那个组件**。
    // 设置栏那份是「标签字典」的只读展示，不碰目录选择——用不上的注入等于白担一份依赖。
    const faceMain = bySlot.main?.opts?.inject?.()
    ok('主区面板注入 pickDir + listDir',
      typeof faceMain?.pickDir === 'function' && typeof faceMain?.listDir === 'function')
    ok('设置栏那份是只读字典，不注入目录选择服务',
      bySlot['settings.section']?.opts?.inject === undefined &&
      /function MemoryDictPane\(/.test(clientSrc) && !/function MemorySettingsPane\(/.test(clientSrc))
    ok('目录选择用的是 DSH 自己的门（uiWorkspace.pickDirectory / listDirectory）',
      clientSrc.includes('pickDirectory()') && clientSrc.includes('listDirectory(') && clientSrc.includes("ctx.get?.('uiWorkspace')"))
    // cordis 的属性访问只顺着**本 fiber 的祖先链**找服务，兄弟 fiber 提供的读不到就**抛**
    // （vendor/cordis/src/reflect.ts 的 ReflectService.handler.get）。`uiWorkspace` 是别的插件
    // 在兄弟 fiber 上提供的，所以 `ctx.uiWorkspace ?? ctx.get(...)` 右边永远没机会跑——整句直接炸。
    // `ctx.get` 读的是共享服务表，不看 fiber 位置，也不要求 inject。这条钉死别写回去。
    const clientCode = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    ok('读 uiWorkspace 只走 ctx.get（不许写 ctx.uiWorkspace，那会顺祖先链找、找不到就抛）',
      !/ctx\.uiWorkspace/.test(clientCode) && /ctx\.get\?\.\('uiWorkspace'\)/.test(clientCode))
    ok('client 不自己 spawn 进程弹框（PowerShell / child_process 都已撤）',
      !clientSrc.includes('child_process') && !clientSrc.includes('powershell') && !clientSrc.includes('/pick-dir'))
    ok('系统框弹不出来时有内建目录浏览兜底',
      clientSrc.includes('function renderBrowse') && clientSrc.includes('就选这个目录'))
    // 目录选择的两套后端是**互斥**的：native 只给 pickDirectory、browse 只给 listDirectory。
    // 所以「弹不出系统框」时兜底去列目录，很可能连 listDir 都没有——那时候**必须出声**：
    // 界面上一句人话 + 控制台一份原始错误。点了没反应比报错难受得多。
    ok('弹不出系统框时留下痕迹（界面明说 + 控制台留底，不静默空转）',
      /console\.warn\('\[dsh-tag-memory\] 系统目录选择框没弹出来/.test(clientSrc) &&
      !/hostList === null\)\s*return\b/.test(clientSrc) &&
      /error: '这个入口拿不到目录浏览服务/.test(clientSrc))

    // 备份地址的**唯一落笔点**。原来「选文件夹」只把路径填进输入框，非得再点一颗
    // 「存下并立刻备份」才落笔——选完不点它，地址就丢了，正是「选完就丢」。
    // 现在：选中即存。选文件夹 / 内建浏览的「就选这个目录」/ 手填后保存，全汇到 commitDir。
    const code = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    ok('备份地址只有一个落笔点（commitDir → POST /backup/dir）',
      (code.match(/backup\/dir/g) || []).length === 1 &&
      /function commitDir\(/.test(code) &&
      code.includes('await commitDir(picked.trim())') &&
      code.includes('commitDir(p)') &&
      !/存下并立刻备份/.test(code))

    // 宿主版本比界面旧时（DSH 只在启动装服务端半边，客户端会热更），新加的路由一律回
    // `unknown op "/xxx"`——把协议黑话直接甩给用户，人只会以为是自己填错了。
    // 真踩过：新界面调 POST /backup/dir 存地址，旧宿主没这条路，界面上弹的就是那句黑话。
    ok('服务端旧版（unknown op）翻成人话，并指向「重启一次 DSH」',
      /function humanError\(/.test(code) && code.includes('unknown op') &&
      /humanError\(data\.error, url\)/.test(code) &&
      code.includes('重启一次 DSH'))
  } catch (e) { fail++; results.push(`FAIL  client.js 槽位登记 — ${String(e?.message ?? e)}`) }

  // ── G. client 渲染冒烟：最小 React 桩 + 预置 state，真跑一遍 MemorySection ──
  //     静态检查看不出「表格到底渲没渲出来」，这一节真调组件。
  try {
    const vm = await import('node:vm')
    let api = null
    vm.runInNewContext(clientSrc, {
      window: {
        __ModuleLoader__: { load: (m) => { api = m } },
        localStorage: { getItem: () => null, setItem: () => {} },
        addEventListener() {}, removeEventListener() {},
      },
      document: {
        getElementById: () => null,
        createElement: () => ({ dataset: {}, remove() {}, click() {} }),
        head: { appendChild() {} },
        body: { appendChild() {} },
      },
      navigator: {}, fetch: async () => ({ json: async () => ({}) }),
      console, setTimeout, clearTimeout, URL,
    }, { filename: 'client.js' })

    let hookIndex = 0
    let primed = {}
    const reactStub = {
      Fragment: Symbol('Fragment'),
      useState(init) {
        const i = hookIndex++
        return [Object.prototype.hasOwnProperty.call(primed, i) ? primed[i] : typeof init === 'function' ? init() : init, () => {}]
      },
      useEffect() {},
      useRef: () => ({ current: null }),
      useCallback: (f) => f,
      useMemo: (f) => f(),
      // 函数组件就地调用（没有状态机，但足以把整棵树跑出来）。
      createElement(type, props, ...children) {
        const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
        if (typeof type === 'function') return type({ ...(props ?? {}), children: kids })
        return { type, props: { ...(props ?? {}), children: kids } }
      },
    }

    const mod = api.factory((name) => (name === 'react' ? reactStub : {}))
    const regs = []
    let cur = null
    mod.apply({
      slots: {
        inject: (name, run) => { cur = name; run(); cur = null },
        register: (opts, comp) => { regs.push({ slot: cur, opts, comp }); return () => {} },
      },
      get: () => undefined,
    })
    const bySlot = Object.fromEntries(regs.map((r) => [r.slot, r]))

    const ROW = {
      id: 'M-20260101-001', 内容: `第一行\n第二行 ${'x'.repeat(120)}`, 类型: '', 深度: '熟手',
      稳定性: '常驻', 距离: '3', 角色: 'selftest', 项目: 'dsh', 状态: '生效', 时间: '2026-01-01',
      关键词: 'a,b', 工具: '', 版本: '', 依据: '', 作用: '', 环境: 'win32', 原因: '测试', 备注: '',
    }
    const OVERVIEW = {
      ready: true, skillDir: 'S:/skill', csvPath: 'S:/skill/store/memory.csv',
      // 列名照库的表头来（表头里 `成熟度`，schema 里这个维度叫 `深度`）。
      header: ['id', '内容', '时间', '环境', '原因', '备注', '稳定性', '成熟度', '距离', '角色', '项目', '状态', '关键词', '工具', '版本', '依据'],
      dimensions: [{ name: '深度', column: '成熟度' }, { name: '稳定性', column: '稳定性' }, { name: '类型', column: null }],
      byDimension: { 深度: { 熟手: 2, 生手: 1 }, 稳定性: { 常驻: 3 }, 类型: {} },
      statusValues: ['生效', '被取代', '已归档'],
      // 宿主自报「认哪些排序档」——客户端照它过滤下拉。旧宿主没这一项，见下面那条断言。
      sorts: ['id_desc', 'file_desc', 'time_desc', 'time_asc', 'id_asc'],
      notice: { enabled: true, files: [{ agent: 'a', file: 'MEMORY.md', hasNotice: true }] },
    }

    /**
     * 渲染一次某槽的组件，把整棵树的 tag / className / 文本摊平出来。
     * `extra` 按 useState 的调用序号补预置值（桩是按序号的，加一个 useState 就得挪一次号）。
     */
    function render(slot, items, extra = {}, props = null) {
      hookIndex = 0
      primed = { 0: OVERVIEW, 1: items, 2: items.length, 3: false, 4: false, ...extra }
      const out = { tags: [], text: [], classes: [], selects: [] }
      const walk = (node) => {
        if (node === null || node === undefined || typeof node === 'boolean') return
        if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return }
        if (Array.isArray(node)) { node.forEach(walk); return }
        if (typeof node !== 'object') return
        out.tags.push(node.type)
        if (node.props === undefined) return
        if (node.props.className) out.classes.push(String(node.props.className))
        if (node.type === 'select') out.selects.push(node)
        walk(node.props.children)
      }
      // 真实装配里 apply 总会注入这两个函数（拿不到服务时是「调用会抛」，不是「没这个 prop」），
      // 所以这儿也照实给上——否则「浏览…」那颗按钮会因为 `hostPick === null` 被藏掉，
      // 测出来的版式跟用户看到的不是一回事。要测「一个都没接上」的那种宿主，用第 4 个参数顶掉。
      walk(bySlot[slot].comp(props ?? { pickDir: async () => null, listDir: async () => ({}) }))
      return out
    }

    const table = render('main', [ROW])
    ok('主区默认渲染成表格（tm-tablewrap + table）',
      table.tags.includes('table') && table.classes.some((c) => c.includes('tm-tablewrap')))
    ok('表格里能看到行 id 与取值，长文本被截断', table.text.includes('M-20260101-001') && table.text.includes('生效') && table.text.some((t) => t.endsWith('…')))
    ok('表格每行有「详情 / 复制」两个操作', table.text.includes('详情') && table.text.includes('复制'))
    ok('表头 = 1 勾选列 + 列定义 + 1 操作列', table.tags.filter((t) => t === 'th').length === 12)
    // 列名照库的表头：显示 `成熟度`（不是 schema 里的维度名 `深度`），行值取的是维度那份。
    ok('列名照库的表头（成熟度，不是 深度）', table.text.includes('成熟度') && !table.text.includes('深度'))
    ok('「成熟度」列取到的是维度「深度」的值', table.text.includes('熟手'))
    const dimSelects = table.selects.filter((s) => String(s.props.className).includes('tm-fsel'))
    ok('每个维度一个下拉，未落列的「类型」禁用', dimSelects.length === 3 && dimSelects[2].props.disabled === true)
    ok('下拉里带取值与计数（熟手（2））',
      (Array.isArray(dimSelects[0].props.children) ? dimSelects[0].props.children : []).flat(Infinity)
        .some((o) => String(o.props.children).includes('熟手（2）')))

    // 排序下拉：宿主报什么就摆什么。旧宿主不报 `overview.sorts`——新档在它那儿**不报错**，
    // 只是当没看见、照样返回原序，比报错还难查；所以宁可不摆，也不给一颗点了没反应的。
    const sortTexts = (s) => (Array.isArray(s.props.children) ? s.props.children : []).flat(Infinity).map((o) => String(o.props.children))
    const pickSort = (o) => o.selects.find((s) => sortTexts(s).some((t) => t.includes('id ↓')))
    const sortSel = pickSort(table)
    ok('宿主报全档位时，排序下拉里有「最近加入」', sortTexts(sortSel).some((t) => t.includes('最近加入')), sortTexts(sortSel).join(' | '))
    const legacy = render('main', [ROW], { 0: { ...OVERVIEW, sorts: undefined } })
    const legacySort = pickSort(legacy)
    ok('旧宿主（不报 sorts）只摆老四档，不给死选项',
      sortTexts(legacySort).length === 4 && !sortTexts(legacySort).some((t) => t.includes('最近加入')),
      sortTexts(legacySort).join(' | '))

    // ── 设置栏那一份：**标签字典的只读展示**（不再是主区那些内容的缩小版）──
    //    hook 序号：0 = dict，1 = error（`render` 的预置里 1 是条目数组，得顶掉）。
    const DICT = {
      ready: true, path: 'S:/skill/references/tags.schema.json', mtime: '2026-10-15T09:30:00.000Z',
      version: '2026-10-15', stale: false,
      dimensions: [
        { name: '类型', column: '类型', role: '主开关', question: '这是什么？', when: '写入时必判',
          how: '按是不是原文分', lifts: '', note: '留白＝忽略这一维', values: [{ value: '原文', desc: '原话直接留存' }, { value: '记忆', desc: '提炼的结论' }],
          text: '', required: false, cap: null, gate: null, status: '' },
        { name: '深度', column: '成熟度', role: '维度', question: '能不能当规律用？', when: '仅 类型=记忆 时打',
          how: '', lifts: '', note: '', values: [{ value: '情景', desc: '具体事件' }],
          text: '', required: false, cap: 10, gate: { when: '类型 = 记忆', otherwise: '留白' }, status: '' },
      ],
      auxiliary: [{ name: '角色', column: '角色', question: '谁写入的？', note: '用户直接交代的仍写智能体名',
        how: '', when: '', lifts: '', values: [], text: '智能体名；多设备时 名@机器', required: false, cap: null, gate: null, status: '' }],
      rules: { model: '模型判断：该不该记、每维取什么值', blank: '留白 = 未判', universal: '任何取值下都成立',
        universalValue: '通用', required: ['id', '内容', '环境'], operators: ['与', '或'] },
      writeRoutes: { comment: '', rules: ['规矩 → 写 2 条', '闲聊 → 不记'] },
      recall: { order: ['查映射表一次定完维度', '先报命中总数，再取前 3 条'], takeFirst: 3, reportTotalFirst: true,
        miss: '直说没有这条', timeFilter: '仅指向某一次具体事件时' },
    }
    const dictPane = render('settings.section', [ROW], { 0: DICT, 1: null })
    ok('设置页渲染成字典展示（不是条目表）',
      !dictPane.tags.includes('table') && dictPane.classes.includes('tm-card') && dictPane.text.includes('标签字典 · 只读'))
    ok('设置页摆出维度的取值与它们的说明',
      dictPane.text.includes('类型') && dictPane.text.includes('原话直接留存') && dictPane.text.includes('能不能当规律用？'))
    // 「显示标签的意义规则」是这张卡的正题——列映射、上限、受谁管都得看得见，
    // 不然用户以为字典里这个名字就是 CSV 里的那个列名（`深度` ↔ `成熟度` 真踩过）。
    ok('设置页摆出「落列 / 上限 / 受谁管」这些真相',
      dictPane.text.includes('落列：成熟度') && dictPane.text.includes('上限 10') &&
      dictPane.text.some((t) => String(t).includes('类型 = 记忆 → 否则留白')))
    ok('设置页摆出写入路由与召回口径',
      dictPane.text.some((t) => String(t).includes('写入路由')) && dictPane.text.some((t) => String(t).includes('先报总数，再取前 3 条')))
    ok('设置页摆出来源路径 + 改动时间',
      dictPane.text.some((t) => String(t).includes('tags.schema.json')) && dictPane.text.some((t) => String(t).includes('2026-10-15 09:30')))
    ok('设置页尾注明说「改字典＝改规则，本页不开放」并指回主区',
      dictPane.text.some((t) => String(t).includes('改字典＝改规则')) && dictPane.text.some((t) => String(t).includes('侧边栏')))
    ok('设置页全是只读控件（没有一个 input / select / textarea）',
      !dictPane.tags.includes('input') && !dictPane.tags.includes('select') && !dictPane.tags.includes('textarea'))
    // 「改了文件没重启」是这套东西最怕的「看着成功、其实没生效」——页面必须自己说出来。
    const dictStale = render('settings.section', [ROW], { 0: { ...DICT, stale: true }, 1: null })
    ok('盘上字典改过而宿主还没重启时，页面明说「重启才生效」',
      dictStale.text.some((t) => String(t).includes('重启 DSH 才会生效')))
    ok('读不到字典时给出路径与原因，不是白屏',
      render('settings.section', [ROW], { 0: { ready: false, path: 'S:/skill/references/tags.schema.json', error: '找不到标签字典' }, 1: null })
        .text.some((t) => String(t).includes('找不到标签字典')))

    // ── 主位通则：要看的/要点的在前，说明与状态退到后面并默认收起 ──
    //    hook 序号：…20=bk 21=bkBusy 22=bkNote 23=dirOpen 24=dirValue 25=restoreOpen
    //              26=mergeOpen 27=mergePath 28=mergeReport 29=maintOpen 30=reloadKey
    const STATUS = {
      available: true, dirSet: true, dir: 'D:\\bak\\记忆库', dirExists: true, dirWritable: true,
      dirError: '', freeBytes: 1024 ** 3, lastBackupAt: '2026-10-14T08:42:03+08:00', lastCount: 130,
      currentCount: 134, delta: 4, copies: 3, totalBytes: 4096, due: true, dueReason: ['新增 4 条（阈值 20）'],
      staleDays: 30, promptEveryEntries: 20, keepCopies: 10,
      recent: [{ stamp: '20261014-084203', at: '2026-10-14T08:42:03', count: 130, label: '整理前', complete: true, bytes: 2000 }],
      log: ['2026-10-14T08:42:03  backup 20261014-084203  条目=130  整理前'],
    }
    const withBk = render('main', [ROW], { 20: STATUS, 32: true })
    ok('主位：条目卡（含过滤器）排在维护/托管之前',
      withBk.classes.indexOf('tm-filters') >= 0 && withBk.classes.indexOf('tm-filters') < withBk.classes.indexOf('tm-fold'))
    ok('主位：备份/恢复/合并/设地址 是标题行上的按钮（不占一张卡）',
      withBk.classes.includes('tm-headrow') &&
      ['立即备份', '恢复…', '合并…', '设置备份地址…'].every((t) => withBk.text.includes(t)))
    ok('备份现状那行把地址/上次/条数差/份数都摆出来',
      withBk.text.some((t) => String(t).includes('D:\\bak\\记忆库')) &&
      withBk.text.some((t) => String(t).includes('2026-10-14 08:42')) &&
      withBk.text.some((t) => String(t).includes('+4')) &&
      withBk.text.some((t) => String(t).includes('该备份了')))
    ok('托管明细与备份历史默认收起（次位东西不占主显示区）',
      table.text.some((t) => String(t).includes('维护与状态')) &&
      !table.text.some((t) => String(t).includes('告诉它们这儿有一套标签记忆')) &&
      !table.text.some((t) => String(t).includes('重新自愈')))
    ok('展开后能看到托管明细与「手上的备份」',
      withBk.text.some((t) => String(t).includes('记忆文件托管')) && withBk.text.includes('手上的备份') &&
      withBk.text.includes('20261014-084203'))

    const noDir = render('main', [ROW], { 20: { available: true, dirSet: false, dir: '', lastBackupAt: '', lastCount: null, currentCount: 134, delta: null, copies: 0, totalBytes: 0, due: true, dueReason: ['未设置备份地址'], dirError: '', freeBytes: null, recent: [], log: [] } })
    ok('没设地址：那行明说「未设置」，不假装有个默认目录',
      noDir.text.some((t) => String(t).includes('未设置')) && !noDir.text.some((t) => String(t).includes('D:\\bak')))

    const dirPane = render('main', [ROW], { 20: STATUS, 23: true })
    ok('「设置备份地址」是一块可展开的面板（不是弹提醒）',
      dirPane.classes.includes('tm-pane') && dirPane.text.includes('保存这个地址'))
    // 「选完就丢」的另一半病根：面板原来恒从空框起步，库里存着的地址根本不显示——
    // 重开 / 刷新一看空格子，以为没存上。现在面板顶上就摆着**库里真正存着的那个值**。
    ok('地址面板一打开就摆出「当前地址」（库里存着的那个，不是空框）',
      dirPane.text.includes('当前地址：') && dirPane.text.some((t) => String(t).includes('D:\\bak\\记忆库')))
    ok('保存按钮只管存地址，不再把「备份」捆在同一颗按钮上',
      dirPane.text.includes('保存这个地址') && !dirPane.text.some((t) => String(t).includes('存下并立刻备份')))
    // 之前这块用 <form> + type=submit，空输入一点就触发原生提交把整页刷掉。现在必须是 div。
    ok('地址面板里没有 <form>（原生提交会刷整页，就是那个「点一下页面刷新了」的 bug）',
      !dirPane.tags.includes('form'))
    ok('地址面板里给了「浏览…」（弹系统文件夹选择框）', dirPane.text.some((t) => String(t).includes('浏览…')))
    // 后端是**互斥**的两套（native 只给 pick、browse 只给 list），问清是哪一套再决定这颗按钮干什么：
    // browse 后端上点它开的是**内建目录浏览**，文案也得跟着改，不能还写着「弹系统框」。
    {
      const browseBackend = render('main', [ROW], { 20: STATUS, 23: true, 34: 'browse' })
      ok('后端是 browse 时，「浏览…」改叫「浏览目录…」（点它开的是内建浏览，不是系统框）',
        browseBackend.text.some((t) => String(t).includes('浏览目录…')) &&
        !browseBackend.text.some((t) => String(t).includes('选择框开着…')))
      const nativeBackend = render('main', [ROW], { 20: STATUS, 23: true, 34: 'native' })
      ok('后端是 native 时，按钮仍是「浏览…」（弹系统文件夹选择框）',
        nativeBackend.text.some((t) => String(t).includes('浏览…')))
      // 两条路都没接上（拿不到 uiWorkspace 的宿主）：按钮别摆，输入框留着。
      const noCaps = render('main', [ROW], { 20: STATUS, 23: true }, {})
      ok('两条路都没接上时不给「浏览…」这颗死按钮，但输入框留着（手填照样能用）',
        !noCaps.text.some((t) => String(t).includes('浏览…')) && noCaps.tags.includes('input'))
    }

    // 系统框拿不到时的兜底：内建目录浏览（面包屑 + 子目录 + 「就选这个目录」）。
    const browsePane = render('main', [ROW], {
      20: STATUS,
      23: true,
      26: {
        error: '',
        listing: {
          path: 'D:\\bak', home: 'C:\\Users\\someone',
          crumbs: [{ name: 'D:', path: 'D:\\', hidden: false }, { name: 'bak', path: 'D:\\bak', hidden: false }],
          entries: [{ name: '记忆库', path: 'D:\\bak\\记忆库', hidden: false }],
          truncated: false,
        },
      },
    })
    ok('内建目录浏览：面包屑 + 子目录 + 「就选这个目录」都渲出来了',
      browsePane.classes.includes('tm-browse') && browsePane.text.includes('D:') &&
      browsePane.text.includes('📁 记忆库') && browsePane.text.includes('就选这个目录'))

    const restorePane = render('main', [ROW], { 20: STATUS, 28: true })
    ok('恢复面板列出备份，并写明「整体替换 + 换前先留档」',
      restorePane.text.includes('恢复（整体替换）') && restorePane.text.includes('用这一份') &&
      restorePane.text.some((t) => String(t).includes('整体替换')))

    const mergePane = render('main', [ROW], { 20: STATUS, 29: true })
    ok('合并面板：预演按钮在，报告没出之前不给「确认合并」',
      mergePane.text.some((t) => String(t).includes('先预演（不落笔）')) &&
      !mergePane.text.some((t) => String(t).includes('确认合并')))

    const mergeDone = render('main', [ROW], {
      20: STATUS, 29: true, 30: 'D:\\other\\memory.csv',
      31: {
        ok: true, dryRun: true, source: 'D:\\other\\memory.csv', incomingTotal: 3, localTotal: 134,
        headerMismatch: false, missingColumns: [],
        counts: { new: 2, duplicate: 1, idCollision: 1, invalid: 1, tagDiff: 0 },
        newList: [{ id: 'M-20260101-001', preview: '外来件甲', why: 'id 已被占用', 时间: '2026-01-02' }],
        invalidList: [{ id: 'M-20260101-009', preview: '外来件丙', why: '必填项缺失：环境 / 依据' }],
        tagDiffs: [], appended: [],
      },
    })
    ok('合并预演报告照 §6.4 交代：新增/重复/改号/冲突',
      mergeDone.text.includes('确认合并（新增 2 条）') &&
      mergeDone.text.some((t) => String(t).includes('id 撞号改新号')) &&
      mergeDone.text.some((t) => String(t).includes('外来件甲')))
    // 加不进去的必须**逐条摆出来**（谁、为什么），只给个数字等于没说
    ok('合并预演把「加不进去的」逐条摆出来（条目 + 原因）',
      mergeDone.text.some((t) => String(t).includes('加不进去')) &&
      mergeDone.text.some((t) => String(t).includes('外来件丙')) &&
      mergeDone.text.some((t) => String(t).includes('必填项缺失：环境 / 依据')))
  } catch (e) { fail++; results.push(`FAIL  client 渲染冒烟 — ${String(e?.stack ?? e)}`) }

  // ── H. 备份核心本身（lib/backup.mjs）的边角 ───────────
  //     重点是「备份永远不覆盖已有内容」——恢复的第一步是「先留档」，只到分钟的戳
  //     会跟你要恢复的那一份撞名，把源文件盖掉。这条断言就是钉死这件事。
  {
    const bkc = store.getBackupCore()
    const hDir = join(sandbox, 'h-backups')
    const t0 = new Date(2026, 0, 2, 3, 4, 5)

    ok('backup 状态：没配地址时 due=true 且理由是「未设置备份地址」',
      (() => { const s = bkc.readBackupStatus(join(sandbox, 'h-empty-store')); return s.dirSet === false && s.due === true })(),
      '')

    const h1 = bkc.runBackup(store.STORE_DIR, { dir: hDir, now: t0, label: 'H1' })
    const countAtH1 = h1.entryCount
    core.appendEntry({ schema, csvPath, lockPath, row: {
      内容: 'H 节多出来的一条', 环境: 'selftest 沙箱', 原因: '制造同戳冲突',
      类型: '记忆', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 'selftest', 项目: '通用', 依据: '推断',
    } })
    const h2 = bkc.runBackup(store.STORE_DIR, { dir: hDir, now: t0, label: 'H2' })
    ok('同一秒连备两次、内容又变了 → 自动往后挪一秒，不覆盖前一份',
      h2.shifted === 1 && h2.stamp !== h1.stamp, JSON.stringify({ h1: h1.stamp, h2: h2.stamp, shifted: h2.shifted }))
    ok('前一份备份原封不动（条数还是当时那个）',
      bkc.countEntries(readFileSync(join(hDir, `memory-${h1.stamp}.csv`), 'utf8')) === countAtH1)

    const rDir = join(sandbox, 'r-backups')
    const base = Date.parse('2026-06-01T10:00:00')
    for (let i = 0; i < 4; i++) {
      bkc.runBackup(store.STORE_DIR, { dir: rDir, now: new Date(base + i * 60000), keepCopies: 2 })
    }
    const keptCsv = readdirSync(rDir).filter((f) => /^memory-\d{8}-\d{4,6}\.csv$/.test(f))
    const keptMd = readdirSync(rDir).filter((f) => /^index-\d{8}-\d{4,6}\.md$/.test(f))
    ok('轮转只留 keepCopies 份，且把配套的 index/backup 一起带走',
      keptCsv.length === 2 && keptMd.length === 2, `csv=${keptCsv.length} md=${keptMd.length}`)

    const cliSrc = readFileSync(join(realSkill, 'scripts', 'backup.mjs'), 'utf8')
    ok('CLI 是薄壳：逻辑都从 lib/backup.mjs 来（界面与命令行同一条路径）',
      cliSrc.includes("from './lib/backup.mjs'") && !cliSrc.includes('createHash'))
  }

  // ── I. 装/接线（install.mjs）—— bundle patch 自带两半 ─────────────
  //     新版 cordis.patch.yml 同时插入 Host 半和智能体半，官方安装不再需要
  //     改 profile 补丁。这里钉住：check 能从 bundle 认出接线；--wire-presets
  //     只作为兼容开关，不会重复写 profile；失败不碰任何文件。
  {
    const yamlLib = createRequire(join(PKG, 'package.json'))('js-yaml')
    const WIRE = 'dsh-tag-memory/preset'
    const home = join(sandbox, 'dsh-home')
    const profDir = join(home, 'profiles', 'web')
    const patchFile = join(profDir, 'cordis.patch.yml')
    mkdirSync(join(profDir, 'node_modules'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    symlinkSync(PKG, join(profDir, 'node_modules', 'dsh-tag-memory'), 'junction')
    writeFileSync(join(profDir, 'package.json'),
      JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
    const presetDir = join(home, '.agent-presets', '小助手')
    mkdirSync(presetDir, { recursive: true })
    const ownMemory = '# 我自己写的\n\n这段是用户手写的，一个字节都不许动。\n'
    writeFileSync(join(presetDir, 'MEMORY.md'), ownMemory, 'utf8')

    const install = (extra = []) => spawnSync(process.execPath,
      [join(PKG, 'scripts', 'install.mjs'), '--dsh-home', home, '--profile', 'web', ...extra],
      { env: { ...process.env, DSH_TAG_MEMORY_SKILL_DIR: sandboxSkill }, encoding: 'utf8' })
    const rowsIn = (text) => {
      let v
      try { v = yamlLib.load(text) } catch (e) { return { err: String(e?.message ?? e) } }
      if (!Array.isArray(v)) return { err: '顶层不是数组' }
      return { rows: v.flatMap((e) => (Array.isArray(e?.insert) ? e.insert : [])) }
    }

    // 1) 空补丁模板（`[]`）· bundle 已带智能体半 → check 必须 PASS，不再 WARN
    writeFileSync(patchFile, '# 这个 profile 的补丁\n[]\n', 'utf8')
    {
      const r = install()
      const line = r.stdout.split('\n').find((l) => l.includes('智能体半')) ?? ''
      ok('check 从 bundle patch 认出智能体半已全局接线',
        line.startsWith('PASS') && line.includes('bundle patch'), line)
      ok('check 不再把已接线误报成半装', !r.stdout.includes('WARN  智能体半未接线'))
      ok('check 收尾提醒「须重启 DSH」', r.stdout.includes('须重启 DSH 才生效'))
    }

    // 2) apply：bundle 已接线时 --wire-presets 不重复写 profile
    {
      const before = readFileSync(patchFile, 'utf8')
      const r = install(['--apply', '--wire-presets'])
      const after = readFileSync(patchFile, 'utf8')
      const parsed = rowsIn(after)
      ok('bundle 已含智能体半时，--wire-presets 不改 profile 补丁', after === before)
      ok('apply 明说智能体半由 bundle patch 接线', r.stdout.includes('bundle patch 全局接线'))
      ok('profile 补丁仍是合法 YAML（没有被重复接线破坏）', Array.isArray(parsed.rows), parsed.err ?? r.stderr.trim())
      ok('apply 收尾也提醒「重启 DSH 后才生效」',
        r.stdout.includes('改动只在重启 DSH 后生效') && r.stdout.includes('INSTALL OK'))

      const mem = readFileSync(join(presetDir, 'MEMORY.md'), 'utf8')
      ok('记忆文件托管：说明块写进去了，用户手写的那段原样还在',
        mem.includes('<!-- BEGIN dsh-tag-memory notice -->') && mem.includes('这段是用户手写的，一个字节都不许动。'))
      const stray = []
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name)
          if (e.isDirectory()) walk(p)
          else if (e.name === 'agent.cordis.yml') stray.push(p)
        }
      }
      walk(join(home, '.agent-presets'))
      ok('接线不再产出 .agent-presets/*/agent.cordis.yml（那是 0.2.0 不读的文件）', stray.length === 0, stray.join('、'))
    }

    // 3) 幂等：再跑一次，补丁文件一个字节都不该变
    {
      const before = readFileSync(patchFile, 'utf8')
      install(['--apply', '--wire-presets'])
      ok('重复运行不改 profile 补丁（幂等）', readFileSync(patchFile, 'utf8') === before)
      ok('check 仍报「智能体半已接线」', install().stdout.includes('智能体半已接线'))
    }

    // 4) 非空、注释多的 profile 补丁：bundle 接线时完全不动它
    {
      const RICH = [
        '# ── 基础层 ──',
        '- id: tools',
        '  disabled: false',
        '',
        '# ── 别人家的插件 ──',
        '- insert:',
        '    - id: something-else',
        "      name: 'other-plugin/thing'",
        '',
      ].join('\n')
      writeFileSync(patchFile, RICH, 'utf8')
      install(['--apply', '--wire-presets'])
      ok('非空 profile 补丁在 bundle 接线时一字不动', readFileSync(patchFile, 'utf8') === RICH)
      const top = yamlLib.load(readFileSync(patchFile, 'utf8'))
      ok('原有非 insert 条目（- id: tools）也还在',
        Array.isArray(top) && top.some((e) => e?.id === 'tools' && e?.disabled === false))
    }

    // 5) 兼容开关不碰坏 YAML：bundle 已接线，profile 补丁坏也无需解析
    {
      const BROKEN = '# 坏补丁\n- insert:\n    - id: [没闭合\n'
      writeFileSync(patchFile, BROKEN, 'utf8')
      const r = install(['--apply', '--wire-presets'])
      ok('bundle 已接线时，profile 补丁坏 YAML 也不被改写',
        readFileSync(patchFile, 'utf8') === BROKEN && r.stdout.includes('INSTALL OK'),
        r.stdout.slice(-200))
    }
  }

  // ── I2. 初始记忆（--seed）：只在**空库**上写 ────────────────
  //     两件事必须钉死：① 空库播得下、每条都过校验；② **库里已有条目就一条都不写**——
  //     重复安装 / 升级插件不许塞回种子。「更新一次，库里多两条我没用过的记忆」正是要防的。
  //     另：不带 --seed 时（也就是老用法）库必须**一个字节都不动**。
  {
    const home2 = join(sandbox, 'seed-home')
    const prof2 = join(home2, 'profiles', 'web')
    mkdirSync(join(prof2, 'node_modules'), { recursive: true })
    mkdirSync(join(home2, 'profiles', 'node_modules'), { recursive: true })
    writeFileSync(join(prof2, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
    writeFileSync(join(prof2, 'cordis.patch.yml'), '[]\n', 'utf8')

    // 一份**空库**：表头照真库，0 条数据；字典与核心从沙箱那份拷过来（同一版）。
    const seedLib = join(sandbox, 'seed-skill')
    mkdirSync(join(seedLib, 'references'), { recursive: true })
    mkdirSync(join(seedLib, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(seedLib, 'store'), { recursive: true })
    for (const f of ['references/tags.schema.json', 'scripts/lib/core.mjs', 'scripts/lib/backup.mjs']) {
      copyFileSync(join(sandboxSkill, f), join(seedLib, f))
    }
    const seedHeader = readFileSync(join(realSkill, 'store', 'memory.csv'), 'utf8').split('\n')[0]
    const seedCsv = join(seedLib, 'store', 'memory.csv')
    writeFileSync(seedCsv, seedHeader + '\n', 'utf8')

    const runSeed = (extra = []) => spawnSync(process.execPath,
      [join(PKG, 'scripts', 'install.mjs'), '--dsh-home', home2, '--profile', 'web', ...extra],
      { env: { ...process.env, DSH_TAG_MEMORY_SKILL_DIR: seedLib }, encoding: 'utf8' })
    const seedCore = await import(pathToFileURL(join(seedLib, 'scripts', 'lib', 'core.mjs')).href)
    const seedSchema = JSON.parse(readFileSync(join(seedLib, 'references', 'tags.schema.json'), 'utf8'))
    const rowsNow = () => seedCore.readTable(readFileSync(seedCsv, 'utf8')).rows
    const asDict = (row) => {
      const resolve = seedCore.makeResolver(seedSchema, seedHeader.split(','))
      const o = {}
      for (const name of Object.keys({ ...seedSchema.dimensions, ...seedSchema.auxiliary })) {
        const i = resolve(name)
        if (i >= 0) o[name] = row[i]
      }
      for (const col of ['id', '内容', '时间', '环境', '原因', '备注']) {
        const i = seedHeader.split(',').indexOf(col)
        if (i >= 0) o[col] = row[i]
      }
      return o
    }

    const checkOut = runSeed().stdout
    ok('check 认出「库是空的」，并说清 --seed 会写什么',
      checkOut.includes('记忆库是空的') && checkOut.includes('--seed 会写入 3 条'), checkOut.split('\n').find((l) => l.includes('记忆库是空的')) ?? '')

    // 不带 --seed：就是老用法，库一个字节都不该动（新开关不能带坏老行为）
    const csvBefore = readFileSync(seedCsv, 'utf8')
    const outNoSeed = runSeed(['--apply']).stdout
    ok('不带 --seed 装完，空库**一个字节没动**（老行为没被带坏）',
      readFileSync(seedCsv, 'utf8') === csvBefore && !outNoSeed.includes('初始记忆 +'), outNoSeed.split('\n').filter((l) => l.includes('初始记忆')).join(' '))

    // 带 --seed：空库播 3 条（2 条出厂 + 1 条本机硬信息）
    const outSeed = runSeed(['--apply', '--seed']).stdout
    const seeded = rowsNow()
    ok('--seed 给空库播下 3 条，并逐条报出 id',
      seeded.length === 3 && outSeed.includes('初始记忆写入 3 条') && /M-\d{8}-\d{3}/.test(outSeed), `条数 ${seeded.length}`)
    // 播下去的每一条都得过库自己那套校验——种子不许是「塞进去的例外」
    const bad = seeded.map(asDict).filter((o) => !seedCore.validateRow(seedSchema, o).ok)
    ok('播下去的 3 条**每条都过 validateRow**（种子不是塞进去的例外）',
      bad.length === 0, JSON.stringify(bad).slice(0, 200))
    const dict3 = seeded.map(asDict)
    ok('第 3 条是本机硬信息：`类型=固定`、`深度` 留白、内容里写着这份库的路径',
      dict3[2]?.['类型'] === '固定' && String(dict3[2]?.['深度'] ?? '') === '' &&
      String(dict3[2]?.['内容'] ?? '').includes(seedLib),
      JSON.stringify({ 类型: dict3[2]?.['类型'], 深度: dict3[2]?.['深度'], 内容: String(dict3[2]?.['内容'] ?? '').slice(0, 60) }))
    ok('出厂那 2 条是「通用 + 常驻」的规矩条（不是项目专属）',
      dict3.slice(0, 2).every((o) => o['项目'] === '通用' && o['距离'] === '常驻' && o['类型'] === '记忆'),
      JSON.stringify(dict3.slice(0, 2).map((o) => `${o['项目']}/${o['距离']}/${o['类型']}`)))

    // 幂等：库里已经有条目 → 一条都不写（这条是「升级插件别给我塞记忆」的保证）
    const seededText = readFileSync(seedCsv, 'utf8')
    const outAgain = runSeed(['--apply', '--seed']).stdout
    ok('库里已有条目 → 再跑 --seed **一条都不写**，库文件逐字节没变',
      rowsNow().length === 3 && readFileSync(seedCsv, 'utf8') === seededText && outAgain.includes('条都不写'),
      outAgain.split('\n').find((l) => l.includes('初始记忆跳过')) ?? '')
    ok('这时 check 也照实说「已有条目 → --seed 不会写任何东西」',
      runSeed().stdout.includes('--seed 不会写任何东西'))

    // 出厂文件本身得是「干净」的：不许带本机路径、不许带开发叙述（它是要发出去的）
    const seedDocText = readFileSync(join(PKG, 'seed', 'memory.seed.json'), 'utf8')
    ok('出厂种子文件里不含本机路径 / 盘符 / 开发叙述（发布口径）',
      !/[A-Za-z]:[\\/]/.test(seedDocText) && !/流程[AB]|克劳德|萧潇|DSH_HOME/.test(seedDocText))
  }

  // ── J. 卸载（install.mjs --uninstall）—— 装 → 卸 → 再装，逐字节回到原样 ────
  //     卸载最容易出的事是「摘不干净」或「顺手多删」：留下的半截声明会让下一个装的人
  //     看见一个坏掉的补丁，多删的则是记忆。这里把三样都钉死：受管的文件回到原样、
  //     记忆库一个字没动、被人手改过的段落**宁可不摘也不猜着改**。
  {
    const WIRE = 'dsh-tag-memory/preset'
    const home = join(sandbox, 'un-home')
    const profDir = join(home, 'profiles', 'web')
    const patchFile = join(profDir, 'cordis.patch.yml')
    const pkgFile = join(profDir, 'package.json')
    const memFile = join(home, '.agent-presets', '小助手', 'MEMORY.md')
    mkdirSync(join(profDir, 'node_modules'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    mkdirSync(join(home, '.agent-presets', '小助手'), { recursive: true })
    symlinkSync(PKG, join(profDir, 'node_modules', 'dsh-tag-memory'), 'junction')

    const run = (extra = []) => spawnSync(process.execPath,
      [join(PKG, 'scripts', 'install.mjs'), '--dsh-home', home, '--profile', 'web', ...extra],
      { env: { ...process.env, DSH_TAG_MEMORY_SKILL_DIR: sandboxSkill }, encoding: 'utf8' })
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
    // 记忆库（沙箱那本）动没动：库 + 字典各取一份指纹
    const libSha = () => [sha(csvPath), sha(join(sandboxSkill, 'references', 'tags.schema.json'))]

    const cases = [
      { name: '空补丁模板（`[]`）', patch: '# 这个 profile 的补丁\n[]\n' },
      {
        name: '非空补丁（别的插件 + 注释）',
        patch: '# 基础\n- id: tools\n  disabled: false\n\n# 别人家的\n- insert:\n    - id: other\n      name: "other-plugin/thing"\n',
        pkg: JSON.stringify({ name: 'web', dependencies: { 'other-plugin': 'link:D:/x' }, dsh: { profile: { bundles: ['other-plugin'] } } }, null, 2) + '\n',
      },
    ]

    for (const c of cases) {
      writeFileSync(patchFile, c.patch, 'utf8')
      writeFileSync(pkgFile, c.pkg ?? JSON.stringify({ name: 'web' }, null, 2) + '\n', 'utf8')
      writeFileSync(memFile, '# 我自己写的\n\n用户手写的内容。\n', 'utf8')
      const want = { patch: sha(patchFile), pkg: sha(pkgFile), mem: sha(memFile) }
      const lib0 = libSha()

      const r1 = run(['--apply', '--wire-presets'])
      const inst = r1.stdout.includes('INSTALL OK')
      const r2 = run(['--uninstall', '--apply'])
      ok(`装→卸（${c.name}）：两个命令都成，且受管文件逐字节回到原样`,
        inst && r2.stdout.includes('UNINSTALL OK') &&
        sha(patchFile) === want.patch && sha(pkgFile) === want.pkg && sha(memFile) === want.mem,
        inst ? r2.stdout.slice(-240) + r2.stderr.slice(-240) : r1.stdout.slice(-240) + r1.stderr.slice(-240))
      ok(`装→卸（${c.name}）：链接解掉了`, !existsSync(join(profDir, 'node_modules', 'dsh-tag-memory')))
      ok(`装→卸（${c.name}）：记忆库与字典逐字节未变`,
        libSha()[0] === lib0[0] && libSha()[1] === lib0[1])
      ok(`装→卸（${c.name}）：卸完 check 没有 FAIL`,
        !run().stdout.includes('FAIL'))
    }

    // 被人手改过那一段：报错、且**整批不落盘**（宁可不摘，也不猜着改别人的文件）
    {
      writeFileSync(patchFile, '# 基础\n- id: tools\n', 'utf8')
      writeFileSync(pkgFile, JSON.stringify({ name: 'web' }, null, 2) + '\n', 'utf8')
      run(['--apply', '--wire-presets'])
      const edited = readFileSync(patchFile, 'utf8')
        .replace(`      name: '${WIRE}'`, `      name: '${WIRE}'   # 我手改过`)
      writeFileSync(patchFile, edited, 'utf8')
      const pkgSha = sha(pkgFile)
      const r = run(['--uninstall', '--apply'])
      ok('手改过的段落：摘不掉就明说，且整批不落盘（补丁/清单都没动）',
        r.status === 1 && r.stdout.includes('✗') &&
        readFileSync(patchFile, 'utf8') === edited && sha(pkgFile) === pkgSha,
        r.stdout.slice(-240))
    }
  }

  // ── K. 库目录可配（`libraryDir` / P-6）──────────────────────────────
  //     库路径以前只有环境变量一条通道（换库得改宿主启动环境）。现在配置里就能给。
  //     钉两条：① **不配 = 与本版之前完全一致**（这条最要紧，绝大多数人走的是它）；
  //     ② 配了 = 当场换过去，字典与读写全都走新库。
  {
    const lib2 = join(sandbox, 'lib2')
    cpSync(sandboxSkill, lib2, { recursive: true })

    // 另起一份 store 实例：这一步要动库目录，不能把前面用着的那份搅了
    const store2 = await import(pathToFileURL(join(PKG, 'lib', 'store.mjs')).href + '?p6=' + Date.now())

    ok('不配 libraryDir：落回原来的推断链（环境变量 → 默认），与本版之前一模一样',
      store2.SKILL_DIR === sandboxSkill && store2.CSV_PATH === join(sandboxSkill, 'store', 'memory.csv'),
      store2.SKILL_DIR)
    ok('不配 libraryDir：setLibraryDir 什么都不做（幂等）', store2.setLibraryDir(undefined) === false)

    ok('配了 libraryDir：当场换过去，一串路径全跟着走',
      store2.setLibraryDir(lib2) === true && store2.SKILL_DIR === resolve(lib2) &&
      store2.STORE_DIR === join(resolve(lib2), 'store') &&
      store2.CSV_PATH === join(resolve(lib2), 'store', 'memory.csv'))
    ok('换完：字典从新库读、核心也是从新库加载的（不是手上那份老库的）',
      !!store2.loadSchema() && store2.ready() && store2.getCore() !== store.getCore())

    // 读写确实落在新库上：往新库写一条，新库多一条、老库一条不多
    {
      const before1 = store2.getCore().readTable(readFileSync(store2.CSV_PATH, 'utf8')).rows.length
      const before2 = store.getCore().readTable(readFileSync(csvPath, 'utf8')).rows.length
      store2.getCore().appendEntry({ schema: store2.loadSchema(), csvPath: store2.CSV_PATH, lockPath: store2.LOCK_PATH, row: {
        内容: 'K 节写进新库的一条', 环境: 'selftest 沙箱', 原因: '证明读写走的是新库',
        类型: '记忆', 深度: '语义', 稳定性: '稳定', 距离: '按需', 角色: 'selftest', 项目: '通用', 依据: '推断',
      } })
      ok('读写确实落在新库上：新库 +1 条，老库一条不多',
        store2.getCore().readTable(readFileSync(store2.CSV_PATH, 'utf8')).rows.length === before1 + 1 &&
        store.getCore().readTable(readFileSync(csvPath, 'utf8')).rows.length === before2)
    }

    ok('设成同一个目录：什么都不做', store2.setLibraryDir(lib2) === false)
    ok('指到不存在的目录：ready=false，路径照实报出来（不假装还是好的）',
      store2.setLibraryDir(join(sandbox, '不存在的库')) === true &&
      store2.ready() === false && store2.SKILL_DIR === resolve(join(sandbox, '不存在的库')))
  }

  // ── L. 本体落点（`--dest` / P-7）与空环境跳过（P-2）─────────────────
  //     P-7：链接默认直接指着源码目录。源码要是在**会话下载目录**里，那里被清理＝挂载本体
  //     凭空消失（界面什么都不报，只是「本来有的东西不见了」）。`--dest` 把本体拷到持久目录，
  //     再从那儿发链接；只在本机、不该跟着搬的东西（.git / node_modules / privhub / store / 备份）不拷。
  {
    const home = join(sandbox, 'dest-home')
    const profDir = join(home, 'profiles', 'web')
    const linkPath = join(profDir, 'node_modules', 'dsh-tag-memory')
    const pkgFile = join(profDir, 'package.json')
    const dest = join(sandbox, '本体')
    mkdirSync(join(profDir, 'node_modules'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    mkdirSync(join(home, '.agent-presets', '小助手'), { recursive: true })
    writeFileSync(join(profDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    writeFileSync(pkgFile, JSON.stringify({ name: 'web' }, null, 2) + '\n', 'utf8')

    // 造一份「源码」：照本仓库的样子带上那些**不该跟着搬**的东西
    const src = join(sandbox, '源码')
    cpSync(PKG, src, {
      recursive: true,
      filter: (s) => !/(^|[\\/])(node_modules|\.git|privhub|store)([\\/]|$)/.test(s),
    })
    for (const d of ['.git', 'privhub', 'store']) mkdirSync(join(src, d), { recursive: true })
    writeFileSync(join(src, 'package.json.bak-20260101'), '{"x":1}\n', 'utf8')
    writeFileSync(join(src, 'install.log'), 'log\n', 'utf8')

    const run = (from, extra = []) => spawnSync(process.execPath,
      [join(from, 'scripts', 'install.mjs'), '--dsh-home', home, '--profile', 'web', ...extra],
      { env: { ...process.env, DSH_TAG_MEMORY_SKILL_DIR: sandboxSkill }, encoding: 'utf8' })
    const linkTo = () => { try { return resolve(realpathSync(linkPath)) } catch { return '' } }

    // 1) --dest：本体拷过去，链接指过去
    const r1 = run(src, ['--apply', '--dest', dest])
    ok('--dest：装成功，且明说了本体拷到哪',
      r1.stdout.includes('INSTALL OK') && r1.stdout.includes('本体已拷到'), r1.stdout.slice(-200))
    ok('--dest：本体确实落在 dest（清单与三半都在）',
      existsSync(join(dest, 'package.json')) && existsSync(join(dest, 'index.js')) &&
      existsSync(join(dest, 'preset.js')) && existsSync(join(dest, 'client.js')) &&
      existsSync(join(dest, 'lib')) && existsSync(join(dest, 'scripts')))
    ok('--dest：只在本机的东西没跟着搬（.git / privhub / store / 备份 / 日志）',
      !existsSync(join(dest, '.git')) && !existsSync(join(dest, 'privhub')) &&
      !existsSync(join(dest, 'store')) && !existsSync(join(dest, 'package.json.bak-20260101')) &&
      !existsSync(join(dest, 'install.log')),
      readdirSync(dest).join('、'))
    ok('--dest：profile 的链接指到 dest，不是源码目录', linkTo() === resolve(dest), linkTo())
    ok('--dest：清单里的依赖也记的是 dest（卸载据此认链）',
      JSON.parse(readFileSync(pkgFile, 'utf8')).dependencies['dsh-tag-memory'] === `link:${resolve(dest)}`)
    // dest 得是一份能自己跑起来的副本：拿它自己的 install.mjs 去 check
    const rChk = run(dest, [])
    ok('--dest：dest 是一份能独立跑的副本（用它自己的 install.mjs check 得动）',
      rChk.status === 0 && rChk.stdout.includes('CHECK OK'), rChk.stdout.slice(-200))

    // 2) 从**源码**侧卸载（不带 --dest）：照样认得那条链——靠清单里记的落点
    const r2 = run(src, ['--uninstall', '--apply'])
    ok('--dest 装的那份，从源码侧也能卸掉（认清单里记的落点，不是靠「必须等于源码目录」）',
      r2.stdout.includes('UNINSTALL OK') && !existsSync(linkPath), r2.stdout.slice(-200))

    // 3) 重装接回源码侧：链接该被**重指**过去，而不是「已存在，跳过」
    run(src, ['--apply'])
    ok('--dest 卸完不带走本体（dest 还在，下次还能指过去）', existsSync(join(dest, 'package.json')))
    ok('重装（不给 --dest）把链接重指回源码目录', linkTo() === resolve(src), linkTo())

    // 4) dest 里有别人的包：拒绝，且一个字节不动
    const dest2 = join(sandbox, '别人的')
    mkdirSync(dest2, { recursive: true })
    writeFileSync(join(dest2, 'package.json'), JSON.stringify({ name: '别人的包' }, null, 2) + '\n', 'utf8')
    const foreignBefore = readFileSync(join(dest2, 'package.json'), 'utf8')
    const r4 = run(src, ['--apply', '--dest', dest2])
    ok('--dest 指到一个装着别人的包的目录：拒绝安装，且一个字不动',
      r4.status === 1 && r4.stdout.includes('FAIL') &&
      readFileSync(join(dest2, 'package.json'), 'utf8') === foreignBefore &&
      !existsSync(join(dest2, 'index.js')), r4.stdout.slice(-200))

    // 5) 空环境：没有记忆库 → 整节跳过、fail=0、退出码 0
    const r5 = spawnSync(process.execPath, [join(PKG, 'scripts', 'selftest.mjs')],
      { env: { ...process.env, DSH_TAG_MEMORY_SKILL_DIR: join(sandbox, '这台机器上没有这个库') }, encoding: 'utf8' })
    ok('独立空环境：记忆库不在 → 跳过而不是假 FAIL（fail=0，退出码 0）',
      r5.status === 0 && /fail=0\b/.test(r5.stdout) && /skip=\d+/.test(r5.stdout),
      `exit=${r5.status} ${r5.stdout.split('\n').filter(Boolean).pop() ?? ''}`)
    ok('空环境的输出说清「缺的是库、装好再跑」，不装作测过了',
      r5.stdout.includes('记忆库不在') && r5.stdout.includes('SELFTEST SKIPPED') && r5.stdout.includes('跳过不等于通过'))
  }

  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  ok('package.json 导出 ./client 且声明 dsh.client', pkg.exports['./client'] === './client.js' && pkg.dsh?.client?.platform === 'web')
  ok('client manifest 不注入非客户端 package',
    pkg.dsh?.client?.inject === undefined || !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'))
  ok('bundle patch 同时包含 Host 与智能体半',
    readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8').includes('name: dsh-tag-memory') &&
    readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8').includes("name: dsh-tag-memory/preset"))
  ok('页面样式在 apply 中登记清理（不再只靠组件 useEffect 往 head 塞）',
    readFileSync(join(PKG, 'client.js'), 'utf8').includes('const disposeStyles = ensureStyles()') &&
    readFileSync(join(PKG, 'client.js'), 'utf8').includes('ctx.effect(() => disposeStyles)'))
} catch (e) {
  fail++
  results.push(`FAIL  未捕获异常 — ${String(e?.stack ?? e)}`)
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(results.join('\n'))
console.log(`\n${fail === 0 ? 'SELFTEST OK' : `SELFTEST FAILED (${fail})`}   pass=${pass} fail=${fail} skip=${skip}`)
process.exit(fail === 0 ? 0 : 1)
