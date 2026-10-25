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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync, existsSync, symlinkSync, cpSync, realpathSync, utimesSync } from 'node:fs'
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
/** 数据目录（用户的记忆库）：推断链与 lib/store.mjs 一致。旧名 DSH_TAG_MEMORY_SKILL_DIR 仍认。 */
const realData = process.env.DSH_TAG_MEMORY_DATA_DIR?.trim()
  || process.env.DSH_TAG_MEMORY_SKILL_DIR?.trim()
  || join(DSH_HOME, 'tag-memory')
/** 引擎在**插件包内**，随插件走；沙箱只需要把数据目录换个地方。 */
const ENGINE = join(PKG, 'lib', 'engine')

const NEEDED_LIB = [
  join(ENGINE, 'core.mjs'),
  join(ENGINE, 'backup.mjs'),
  join(ENGINE, 'tags.schema.json'),
  join(realData, 'store', 'memory.csv'),
]
const missingLib = NEEDED_LIB.filter((f) => !existsSync(f))
if (missingLib.length > 0) {
  for (const s of [
    'A. core（解析/校验/筛选）', 'B. notice（记忆文件托管）', 'C. store（定位库/载字典）',
    'D. preset（字典段与两个工具）', 'E. index（只读端点 / 备份·恢复·合并）', 'F. client（槽位登记）',
    'G. 渲染冒烟（「记忆」页）', 'H. backup（轮转·不覆盖）', 'I. 接装与接线',
    'J. 卸载往返', 'K. 库目录可配',
  ]) skipped(s, '记忆库不在，这一节读不到字典与读写核心')
  results.push(`      数据目录：${realData}`)
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

// ── 造沙箱：引擎用插件内置那份，数据目录换成自造小库 ──
const sandboxSkill = join(sandbox, 'skill')
mkdirSync(join(sandboxSkill, 'references'), { recursive: true })
mkdirSync(join(sandboxSkill, 'store'), { recursive: true })
copyFileSync(join(ENGINE, 'tags.schema.json'), join(sandboxSkill, 'references', 'tags.schema.json'))

// 表头照插件内置模板（17 列）；数据自造两条（含一条 已归档 供默认排除用）
const header = readFileSync(join(ENGINE, 'templates', 'memory.csv'), 'utf8').split('\n')[0]
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
process.env.DSH_TAG_MEMORY_DATA_DIR = sandboxSkill

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
    skipped('C-4 写入去重 / 拒绝话术（库侧）', `当前用的这份记忆库的 core.mjs 还是旧版（插件内置引擎）——先重装本包，再跑这节`)
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
    skipped('D-1 列数校验（库侧）', `当前用的这份记忆库的 core.mjs 还是旧版（插件内置引擎）——先重装本包，再跑这节`)
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
    // 用例里当「当前项目」的路径：用沙箱里的真实目录，别写死盘符。
    // projectName 走 path.basename(path.resolve(cwd))，Linux 上 `X:\proj` 解出来是 `X:\proj`
    // 而不是 `proj`，跨项目闸门就永远对不上（旧版这两条 FAIL 就是这个坑）。
    const PROJ_CWD = join(sandbox, 'proj')
    const OTHER_CWD = join(sandbox, 'another')
    const sections = [], tools = []
    const ctx = { systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 50 }, tools: { register: (t) => tools.push(t) } }
    const preset = await import(pathToFileURL(join(PKG, 'preset.js')).href)
    preset.apply(ctx, { dir: 'C:/does/not/matter/assistant' })
    ok('preset 注册字典段', sections.length === 1 && sections[0].name === 'tag-memory:dict')
    ok('preset 注册五个工具（write / recall / supersede / review / archive）',
      tools.map((t) => t.name).sort().join(',') === 'memory_archive,memory_recall,memory_review,memory_supersede,memory_write')
    const exec = { agent: { id: 'selftest', session: { header: { cwd: PROJ_CWD } } } }
    const out = await tools.find((t) => t.name === 'memory_recall').execute({ 条件: '{"角色":"selftest"}', 取几条: 5 }, exec)
    ok('preset.memory_recall 端到端读回沙箱条目', /命中\s*2\s*条/.test(out), out.split('\n')[0])
    const wrote = await tools.find((t) => t.name === 'memory_write').execute({
      内容: '自检件D', 环境: 'selftest 沙箱', 原因: '验证 memory_write 端到端',
      类型: '记忆', 深度: '程序', 稳定性: '稳定', 距离: '按需', 依据: '推断',
    }, exec)
    ok('preset.memory_write 端到端写入（角色=preset 目录名）', /已追加 M-/.test(wrote), wrote)

    // ── D2. 记忆快照（注入模型：B-1 字典+快照 / B-2 常驻真落地 / B-3 跨项目只给索引）──
    // 此时沙箱库里 3 条生效：A（常驻/通用）、C（按需/通用）、D（按需/本项目 proj）；B 已归档。
    const here = sections[0].text({ agent: { id: 'selftest', session: { header: { cwd: PROJ_CWD } } } })
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
      const t2 = s2[0].text({ agent: { id: 'selftest', session: { header: { cwd: PROJ_CWD } } } })
      ok('预算闸 B-2：maxPinned=0 → 常驻不再给全文（降为索引）', !/\[M-20260101-001\] 自检件A\n/.test(t2) && /在「通用」：自检件A/.test(t2))
      ok('预算闸 B-2：超上限时明说溢出', /常驻超过上限 0 条，其中 1 条只留索引/.test(t2), t2.split('\n').filter((l) => l.startsWith('> ')).join(' ｜ ').slice(0, 200))
    }

    // 退回档：关掉快照 → 与旧行为一致（只有字典）。
    {
      const s3 = []
      const ctx3 = { systemPrompt: { section: (s) => s3.push(s), getSectionOrder: () => 50 }, tools: { register: () => {} } }
      preset.apply(ctx3, { dir: 'C:/x', snapshot: { enabled: false } })
      const t3 = s3[0].text({ agent: { id: 'selftest', session: { header: { cwd: PROJ_CWD } } } })
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
    skipped('D-1 界面报出坏行（/overview 的 health.ragged）', `当前用的这份记忆库的 core.mjs 还是旧版（插件内置引擎）——先重装本包，再跑这节`)
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
    skipped('P-8 字典随备份 / 恢复时比对', `当前用的这份记忆库还不支持（插件内置引擎）——先重装本包，再跑这节`)
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
  // 外来行按**当前模板表头**逐列拼，别手写定长字面量：
  // 模板加了 `类型` 列（17 列）以后，手写的 16 列会整体错位一格——
  // 「项目」那格会落到「角色」上，判重按列名取就取不到。
  const fRow = (o) => HEAD.map((c) => o[c] ?? '').join(',')
  writeFileSync(foreign, [
    header,
    // 与本地首条「内容 + 项目 + 类型」完全一致 → 真重复
    fRow({ id: 'M-20260101-001', 内容: dupContent, 时间: '2026-01-01', 环境: '别处', 原因: '重复用', 备注: '备注', 稳定性: '稳定', 成熟度: '语义', 距离: '常驻', 角色: 'selftest', 项目: '通用', 状态: '生效', 依据: '推断', 类型: '记忆' }),
    fRow({ id: 'M-20260101-001', 内容: '外来件甲（跟本地某条撞 id）', 时间: '2026-01-02', 环境: '别处', 原因: '撞号用', 备注: '备注', 稳定性: '稳定', 成熟度: '语义', 距离: '常驻', 角色: '别的机器', 项目: '通用', 状态: '生效', 依据: '推断', 类型: '记忆' }),
    fRow({ id: 'M-20990101-001', 内容: '外来件乙', 时间: '2026-01-03', 环境: '别处', 原因: '真新增', 备注: '备注', 稳定性: '稳定', 成熟度: '语义', 距离: '常驻', 角色: '别的机器', 项目: '通用', 状态: '生效', 依据: '推断', 类型: '记忆' }),
    fRow({ id: 'M-20990101-002', 内容: '外来件丙（必填缺项，不该进）', 时间: '2026-01-04', 稳定性: '稳定', 成熟度: '语义', 距离: '常驻', 角色: '别的机器', 项目: '通用', 状态: '生效', 类型: '记忆' }),
    '',
  ].join('\n'), 'utf8')

  // R-7：来源路径准入。`foreign` 建在沙箱根下、**不在备份目录里**，
  // 所以不带 `confirmOutside` 时必须被拒——这是「记忆投毒」的那道闸。
  const deniedOutside = await post('/merge', { path: foreign })
  ok('R-7 合并来源不在备份目录 → 拒绝，且给出人话',
    deniedOutside.json.ok === false && deniedOutside.json.code === 'SOURCE_OUTSIDE' &&
    /备份目录/.test(String(deniedOutside.json.error)),
    JSON.stringify(deniedOutside.json).slice(0, 200))

  const dry = await post('/merge', { path: foreign, confirmOutside: true })
  ok('index POST /merge 预演：新增 2 / 重复跳过 1 / 撞号 1',
    dry.json.ok === true && dry.json.dryRun === true && dry.json.counts.new === 2 && dry.json.counts.duplicate === 1 && dry.json.counts.idCollision === 1,
    JSON.stringify(dry.json.counts))
  // 预演就得说实话：必填缺项的行**预演时**就要挑出来，不能等真合并才一条条失败
  // （否则预演说「要加 3 条」、真合并只进去 2 条，看着像合并吞了一条）。
  ok('index POST /merge 预演就把必填缺项的行挑出来（不是等真合并才失败）',
    dry.json.counts.invalid === 1 && /必填项缺失/.test(dry.json.invalidList?.[0]?.why ?? ''),
    JSON.stringify(dry.json.invalidList))
  ok('index POST /merge 预演不动库（一个字节都没写）', countRows() === beforeBackup)

  const applied = await post('/merge', { path: foreign, apply: true, confirmOutside: true })
  ok('index POST /merge 真合并：追加 2 条 + 合并前留档 + 只追加不重写',
    applied.json.ok === true && applied.json.appended.length === 2 && applied.json.appended.every((a) => /^M-\d{8}-\d{3}$/.test(a.id)) && countRows() === beforeBackup + 2 && typeof applied.json.preBackup === 'string',
    JSON.stringify(applied.json.failed ?? applied.json))
  const afterMerge = core.readTable(readFileSync(store.CSV_PATH, 'utf8'))
  ok('index POST /merge 没动原有行（前 N 行逐字节不变）',
    afterMerge.rows.slice(0, beforeBackup).every((r, i) => r.join('') === local.rows[i].join('')))

  const merged = await post('/merge', { path: foreign, confirmOutside: true })
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

    // 引擎内置之后，插件不再附带 CLI 薄壳（备份只有一条路：界面 → 引擎）。
    // 这里钉住的是「一份逻辑」这件事本身：备份与状态都由同一个引擎模块导出，
    // 界面（index.js）不再自己实现一套拷贝 / 校验。
    const bkSrc = readFileSync(join(ENGINE, 'backup.mjs'), 'utf8')
    const hostSrc = readFileSync(join(PKG, 'index.js'), 'utf8')
    ok('备份只有一份逻辑：引擎导出 runBackup / readBackupStatus，界面不自己实现',
      /export function runBackup/.test(bkSrc) && /export function readBackupStatus/.test(bkSrc)
      && /\.runBackup\(/.test(hostSrc) && !hostSrc.includes('createHash'))
    ok('引擎的备份核心与读写核心同目录（backup.mjs 里 import ./core.mjs 才成立）',
      bkSrc.includes("from './core.mjs'") && existsSync(join(ENGINE, 'core.mjs')))
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
      { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: sandboxSkill }, encoding: 'utf8' })
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
    mkdirSync(join(seedLib, 'store'), { recursive: true })
    copyFileSync(join(ENGINE, 'tags.schema.json'), join(seedLib, 'references', 'tags.schema.json'))
    const seedHeader = readFileSync(join(ENGINE, 'templates', 'memory.csv'), 'utf8').split('\n')[0]
    const seedCsv = join(seedLib, 'store', 'memory.csv')
    writeFileSync(seedCsv, seedHeader + '\n', 'utf8')

    const runSeed = (extra = []) => spawnSync(process.execPath,
      [join(PKG, 'scripts', 'install.mjs'), '--dsh-home', home2, '--profile', 'web', ...extra],
      { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: seedLib }, encoding: 'utf8' })
    const seedCore = await import(pathToFileURL(join(ENGINE, 'core.mjs')).href)
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
      { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: sandboxSkill }, encoding: 'utf8' })
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
    //
    // 0.2.2 起 bundle patch 自带接线，`--wire-presets` 不再往 profile 补丁写声明
    // （install.mjs 的 wire() 见到 bundle patch 里有 WIRE_MARK 就直接返回）。所以这里
    // **手工把 WIRE_BLOCK 写进补丁**，还原「老安装产物留下那段声明」的场景；否则前置不成立，
    // 补丁里根本没有那段，卸载当然什么都不用摘——这条用例就白测了。
    //
    // 分两半钉：
    //   ① 没手改 → 整段照抄地对上，卸得掉（证明这段字面量与 install.mjs 的 WIRE_BLOCK 一致）；
    //   ② 手改一行 → 报错、退出码 1，且补丁与清单**一个字节没动**（整批不落盘）。
    {
      // 与 install.mjs 的 WIRE_BLOCK 逐字一致（注释头 + 那段内联声明）
      const WIRE_BLOCK = [
        '# ── 记忆：标签记忆（dsh-tag-memory）—— 智能体半 ──────────────────',
        '# 0.2.0 起 preset 是声明行：这一段在 **profile 平面全局注册**，因此对该 profile 下',
        '# 所有智能体生效（含以后新建的），不必逐个 preset 挂。缺了它，界面照样能用，',
        '# 但谁也拿不到标签字典、也调不到 memory_write / memory_recall。',
        '# 回滚：删掉这一段。',
        '- insert:',
        '    - id: tag-memory-preset',
        `      name: '${WIRE}'`,
      ].join('\n')
      const BASE = '# 基础\n- id: tools\n'

      // ① 正控：补丁里是「我们原样写的」那一段 → 卸得掉，且回到追加前的样子
      writeFileSync(patchFile, BASE + '\n\n' + WIRE_BLOCK + '\n', 'utf8')
      writeFileSync(pkgFile, JSON.stringify({ name: 'web' }, null, 2) + '\n', 'utf8')
      run(['--apply']) // 让清单里真的有我们的条目，卸载才有东西可摘
      const r0 = run(['--uninstall', '--apply'])
      ok('手改段的正控：补丁里是原样那段 → 卸得掉（字面量与 install.mjs 一致）',
        r0.status === 0 && !readFileSync(patchFile, 'utf8').includes(WIRE) &&
        readFileSync(patchFile, 'utf8') === BASE.replace(/\s*$/, '') + '\n',
        r0.stdout.slice(-240))

      // ② 手改一行：报错、退出码 1，补丁与清单都没动
      writeFileSync(patchFile, BASE + '\n\n' + WIRE_BLOCK + '\n', 'utf8')
      writeFileSync(pkgFile, JSON.stringify({ name: 'web' }, null, 2) + '\n', 'utf8')
      run(['--apply']) // 清单里装上我们的条目
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

    ok('不配 libraryDir：落回原来的推断链（环境变量 → 默认）',
      store2.SKILL_DIR === sandboxSkill && store2.CSV_PATH === join(sandboxSkill, 'store', 'memory.csv'),
      store2.SKILL_DIR)
    ok('不配 libraryDir：setLibraryDir 什么都不做（幂等）', store2.setLibraryDir(undefined) === false)

    ok('配了 libraryDir：当场换过去，一串路径全跟着走',
      store2.setLibraryDir(lib2) === true && store2.SKILL_DIR === resolve(lib2) &&
      store2.STORE_DIR === join(resolve(lib2), 'store') &&
      store2.CSV_PATH === join(resolve(lib2), 'store', 'memory.csv'))
    // 引擎在**插件包内**：换数据目录不重载核心，也不该重载——它跟插件走，跟库无关。
    ok('换完：字典从新库读（盘上那本），核心始终是插件内置那一份（不因换库而换）',
      !!store2.loadSchema() && store2.ready() && store2.getCore() === store.getCore())
    ok('换完：coreStale 恒为 false（核心随插件走，换数据目录不存在「重启才生效」）',
      store2.coreStale() === false)

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
    // 0.3.0 起（P2-13 / V2-c）：显式指到**不存在**的目录要**当场报错**，不再静默降级。
    // 老用例断的是「ready=false + 路径照实报出来」——那其实是「装作切过去了」的旧行为：
    // 界面会显示一个不存在的库路径，人以为库被搬走，其实它还好好在原处。
    // 新规矩：抛错 + **回滚到原目录**（不把进程留在一个坏路径上）。
    {
      const before = store2.DATA_DIR
      let caught = null
      try { store2.setLibraryDir(join(sandbox, '不存在的库')) } catch (e) { caught = e }
      ok('指到不存在的目录：当场报错（不是静默降级）',
        caught !== null && caught.code === 'TAG_MEMORY_DATA_DIR_MISSING')
      ok('指到不存在的目录：报错里给了修法（说清三条路，不是只说「失败」）',
        caught !== null && /修法三选一/.test(String(caught.message)) && /mkdir -p/.test(String(caught.message)))
      ok('指到不存在的目录：目录没被偷偷建出来（不静默建空库）',
        existsSync(join(sandbox, '不存在的库')) === false)
      ok('指到不存在的目录：数据目录回滚到原处（进程不停在坏路径上）',
        store2.DATA_DIR === before && store2.ready() === true)
    }
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
      { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: sandboxSkill }, encoding: 'utf8' })
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
      { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: join(sandbox, '这台机器上没有这个库') }, encoding: 'utf8' })
    ok('独立空环境：记忆库不在 → 跳过而不是假 FAIL（fail=0，退出码 0）',
      r5.status === 0 && /fail=0\b/.test(r5.stdout) && /skip=\d+/.test(r5.stdout),
      `exit=${r5.status} ${r5.stdout.split('\n').filter(Boolean).pop() ?? ''}`)
    ok('空环境的输出说清「缺的是库、装好再跑」，不装作测过了',
      r5.stdout.includes('记忆库不在') && r5.stdout.includes('SELFTEST SKIPPED') && r5.stdout.includes('跳过不等于通过'))
  }

  // ── M. V1 数据模型迁移 + 取代闭环（0.3.0）──────────────────────────
  //     阿验规划 V1-01~V1-06。每条都钉「对外可观察的结果」，不钉内部函数名。
  try {
    const core = store.getCore()
    const schema0 = store.loadSchema()
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

    // M-1（V1-01）老库（17 列、无新列）读出来补默认值，且文件不被重写
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v1-'))
      const legacy = join(box, 'legacy.csv')
      // 造一份 17 列老库：表头与 0.2.x 一致，没有 0.3.0 的 4 列
      const oldHeader = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
      writeFileSync(legacy, oldHeader + '\n'
        + 'M-20260101-001,老条目一,2026-01-01,env,r,,稳定,语义,按需,角色,通用,生效,,,v1,推断,记忆\n'
        + 'M-20260102-001,老条目二,2026-01-02,env2,r2,,稳定,程序,常驻,角色,通用,生效,,,v1,原话,记忆\n', 'utf8')
      const sha0 = sha(legacy)
      const t = core.readTable(readFileSync(legacy, 'utf8'), core.legacyWidthOf(schema0))
      const resolve = core.makeResolver(schema0, t.header)
      const base = (row, name) => { const i = resolve(name); return i >= 0 ? String(row[i] ?? '') : '' }
      const get = core.withColumnDefaults(t.header, base)
      const r0 = t.rows[0]
      ok('V1-01 老库（17 列）读出来补默认值：强度=1 / 最后强化=该行时间 / 已验证项目空 / 使用次数=0',
        get(r0, '强度') === '1' && get(r0, '最后强化') === '2026-01-01'
        && get(r0, '已验证项目') === '' && get(r0, '使用次数') === '0',
        JSON.stringify({ s: get(r0, '强度'), t: get(r0, '最后强化'), v: get(r0, '已验证项目'), n: get(r0, '使用次数') }))
      ok('V1-01 最后强化跟的是**各行自己的时间**（不是常量「今天」）',
        get(t.rows[1], '最后强化') === '2026-01-02')
      ok('V1-01 读完之后老库文件 sha256 一个字节没变（只读迁移，不回写）', sha(legacy) === sha0)
      ok('V1-01 老字段照旧可读（内容/状态没被默认值顶掉）',
        base(r0, '内容') === '老条目一' && base(r0, '状态') === '生效')
      rmSync(box, { recursive: true, force: true })
    }

    // M-2（V1-02）新库写第一条起带全列；表头就是 21 列
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v1-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const tplHeader = readFileSync(csv, 'utf8').split('\n')[0]
      ok('V1-02 出厂模板表头已经是 21 列（含 4 个新列）',
        tplHeader.split(',').length === 21 && core.NEW_COLUMNS.every((c) => tplHeader.includes(c)),
        String(tplHeader.split(',').length))
      const id = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: join(box, '.lock'),
        row: { 内容: '新库第一条', 时间: '2026-10-24', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const last = t.rows[t.rows.length - 1]
      // 4 个新列里，`已验证项目` 的**默认值本来就是空**（还没在任何项目验证过），
      // 所以这里不能要求「4 列全都非空」——那是把「有默认值」误当成「非空」。
      // 真正该钉的是：格数是 21、且**该有值的三列有值**、已验证项目是空串（不是 undefined/缺格）。
      ok('V1-02 新写入的行就是 21 格（新列不是缺格，也不是 undefined）',
        last.length === 21 && t.header.slice(17).join(',') === core.NEW_COLUMNS.join(','),
        `格数=${last.length}`)
      ok('V1-02 新行三列有默认值（强度=1 / 最后强化=今天 / 使用次数=0）',
        String(last[t.header.indexOf('强度')]).trim() === '1'
        && String(last[t.header.indexOf('最后强化')]).trim() === '2026-10-24'
        && String(last[t.header.indexOf('使用次数')]).trim() === '0',
        JSON.stringify(core.NEW_COLUMNS.map((c) => String(last[t.header.indexOf(c)]))))
      ok('V1-02 新行「已验证项目」是空串（还没在项目里验证过，这是对的）',
        String(last[t.header.indexOf('已验证项目')] ?? '') === '')
      rmSync(box, { recursive: true, force: true })
    }

    // M-3（V1-03）memory_supersede：旧条不动、新条带「取代：旧id」、旧条退场
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v1-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const mk = (content) => core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: content, 时间: '2026-10-01', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
      const oldId = mk('旧结论')
      const otherId = mk('无关条目')
      const beforeLines = readFileSync(csv, 'utf8').split('\n')
      const r = core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: oldId,
        row: { 内容: '新结论', 依据: '原话' } })
      const afterLines = readFileSync(csv, 'utf8').split('\n')
      ok('V1-03 取代成功并返回新 id 与进位版本', r.ok === true && r.id !== '' && r.version === 'v2', JSON.stringify(r))
      ok('V1-03 旧行**逐字节没变**（追加式，不改旧行）', beforeLines[1] === afterLines[1])
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const noteIdx = t.header.indexOf('备注')
      const newRow = t.rows.find((x) => x[t.header.indexOf('id')] === r.id)
      ok('V1-03 新行备注写着「取代：<旧id>」', String(newRow[noteIdx] ?? '').includes(`取代：${oldId}`))
      const hits = core.filterRows(schema0, t.header, t.rows, {})
      ok('V1-03 旧条默认退场（读侧反查），新条与无关条还在',
        !hits.some((x) => x[0] === oldId) && hits.some((x) => x[0] === r.id) && hits.some((x) => x[0] === otherId),
        hits.map((x) => x[0]).join(','))
      ok('V1-03 旧条 `状态` 仍是原值（方案 a：不改旧行）',
        String(t.rows.find((x) => x[0] === oldId)[t.header.indexOf('状态')]) === '生效')
      rmSync(box, { recursive: true, force: true })
    }

    // M-4（V1-04）目标不存在 / 已非生效 → 拒绝且不落笔
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v1-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const id = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '要被取代的', 时间: '2026-10-01', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
      const rowsBefore = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0)).rows.length
      const r1 = core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: 'M-29991231-999', row: { 内容: 'x' } })
      ok('V1-04 目标 id 不存在 → 拒绝，且说清「库里没有这个 id」',
        r1.ok === false && /没有 id 为/.test(r1.error), r1.error.slice(0, 40))
      ok('V1-04 目标不存在时 CSV 条数不变（不落笔）',
        core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0)).rows.length === rowsBefore)
      // 先真的取代一次，再拿同一个旧 id 取代 → 应报「已经被取代过」
      core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: id, row: { 内容: '顶上的那条' } })
      const r2 = core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: id, row: { 内容: 'y' } })
      ok('V1-04 目标已被取代 → 拒绝，并指出取代它的是哪条',
        r2.ok === false && /已经被取代过/.test(r2.error), r2.error.slice(0, 50))
      const r3 = core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: '', row: { 内容: 'z' } })
      ok('V1-04 不点名目标 id → 拒绝（改旧必点名）', r3.ok === false && /必须点名/.test(r3.error))
      rmSync(box, { recursive: true, force: true })
    }

    // M-5（V1-05）取代关系反查：从新条能反查到旧条
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v1-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const oldId = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '旧的', 时间: '2026-10-01', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
      const r = core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: oldId, row: { 内容: '新的' } })
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const dead = core.supersededIds(t.header, t.rows)
      ok('V1-05 反查集合里有旧 id（旧→新成对可追）', dead.has(oldId))
      ok('V1-05 新行的备注能解析出它取代了谁',
        core.supersedesOf(t.rows.find((x) => x[0] === r.id)[t.header.indexOf('备注')]).includes(oldId))
      rmSync(box, { recursive: true, force: true })
    }

    // M-6（V1-06）「含归档可见」：默认排除，显式查才出
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v1-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const mk = (content, status) => core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: content, 时间: '2026-10-01', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest', 状态: status } })
      const liveId = mk('生效的', '生效')
      const archId = mk('归档的', '已归档')
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const def = core.filterRows(schema0, t.header, t.rows, {})
      ok('V1-06 已归档条目默认不进召回', def.some((x) => x[0] === liveId) && !def.some((x) => x[0] === archId))
      const exp = core.filterRows(schema0, t.header, t.rows, { 状态: ['已归档'] })
      ok('V1-06 显式筛 `状态=已归档` 能查回来', exp.some((x) => x[0] === archId))
      rmSync(box, { recursive: true, force: true })
    }

    // M-7 表头迁移（迁移的「写侧」另一半：不升表头就写不进新列）
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v1-'))
      const csv = join(box, 'memory.csv')
      const oldHeader = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
      writeFileSync(csv, oldHeader + '\nM-20260101-001,老条目,2026-01-01,e,r,,稳定,语义,按需,角色,通用,生效,,,v1,推断,记忆\n')
      const lock = join(box, '.lock')
      const before = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      ok('M-7 迁移前：能读（末尾缺列容忍），但表头缺 4 列',
        before.ragged.length === 0 && core.headerMigrationNeeded(schema0, before.header).needed === true)
      const mig = core.migrateHeader({ schema: schema0, csvPath: csv, lockPath: lock })
      ok('M-7 迁移：表头 17→21 列', mig.ok === true && mig.changed === true && mig.before === 17 && mig.after === 21, JSON.stringify(mig))
      const afterLines = readFileSync(csv, 'utf8').split('\n')
      ok('M-7 迁移只换表头，数据行逐字节不动', afterLines[1] === 'M-20260101-001,老条目,2026-01-01,e,r,,稳定,语义,按需,角色,通用,生效,,,v1,推断,记忆')
      const mig2 = core.migrateHeader({ schema: schema0, csvPath: csv, lockPath: lock })
      ok('M-7 迁移幂等：再迁一次不改动', mig2.changed === false)
      // 迁移后老行仍能读、且新列拿到默认值
      const t2 = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      // 迁移后表头 21 列、老行仍是 17 格 → 靠 legacyWidth 认成「末尾缺列的老行」。
      // 注意：`withColumnDefaults` 判断的是**表头里有没有这列**——表头有了这列，
      // 它就尊重行里的空值（用户可能故意清空）。所以这里该断的是「不算 ragged」+「格数仍是 17」，
      // 而不是「补出默认值」——补默认值发生在表头**没有**这列的时候（迁移前）。
      ok('M-7 迁移后：老行（17 格）不算 ragged（末尾缺列容忍生效）',
        t2.ragged.length === 0 && t2.legacyTail.length === 1 && t2.rows[0].length === 17,
        `ragged=${t2.ragged.length} legacyTail=${t2.legacyTail.length}`)
      rmSync(box, { recursive: true, force: true })
    }
  } catch (e) { fail++; results.push(`FAIL  V1 迁移/取代 — ${String(e?.message ?? e)}`) }

  // ── N. V2 安全：守卫三态 + 写前快照 + dataDir 校验（0.3.0）────────────
  //     阿验规划 V2-01~V2-08。
  try {
    const snapshot = await import(pathToFileURL(join(PKG, 'lib', 'engine', 'snapshot.mjs')).href)
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

    // N-1（V2-01/02/04）守卫：命中拦、自家工具豁免、默认开
    {
      let listener = null
      const guardCtx = {
        logger: {}, get: () => undefined,
        webServer: { register: () => () => {} },
        on: (ev, fn) => { if (ev === 'tools/pre-execute') listener = fn; return () => {} },
      }
      const indexMod = await import(pathToFileURL(join(PKG, 'index.js')).href)
      indexMod.apply(guardCtx, { presetRoot: join(sandbox, 'guard-preset'), notice: false })
      const ask = async (name, args) => listener({ name, arguments: args }, () => Promise.resolve({ kind: 'allow' }))
      ok('V2-01 守卫挂上了 tools/pre-execute（不设环境变量时默认开）', typeof listener === 'function')
      const r1 = await ask('bash', { command: 'cat ' + join(store.STORE_DIR, 'memory.csv') })
      ok('V2-01 参数里出现记忆库路径 → 拒绝', r1.kind === 'deny')
      ok('V2-01 拒绝文案指向合法通道（说清用 memory_write/memory_recall）',
        /memory_write/.test(r1.reason) && /memory_recall/.test(r1.reason))
      const r2 = await ask('glob', { pattern: join(store.DATA_DIR, '**/*.csv') })
      ok('V2-01 守卫递归扫参数（glob 通配符路径同样拦）', r2.kind === 'deny')
      const r3 = await ask('bash', { args: ['-c', 'ls ' + store.DATA_DIR] })
      ok('V2-01 守卫扫嵌套数组（藏在数组里的路径也拦）', r3.kind === 'deny')
      let exemptOk = true
      for (const t of ['memory_write', 'memory_recall', 'memory_supersede', 'memory_review', 'memory_archive']) {
        const rr = await ask(t, { path: join(store.STORE_DIR, 'memory.csv') })
        if (rr.kind === 'deny') exemptOk = false
      }
      ok('V2-02 插件自己的五个工具豁免（参数里带库路径也放行；新工具必须一并加进名单）', exemptOk)
      const r4 = await ask('read', { file_path: join(sandbox, 'unrelated.txt') })
      ok('V2-02 不碰记忆库的调用照常放行（守卫不是全拦）', r4.kind === 'allow')
    }

    // N-2（V2-03）守卫关闭：DSH_TAG_MEMORY_GUARD=off 时全放行（子进程，import 时读一次）
    {
      const script = `
        const { pathToFileURL } = require('node:url')
        ;(async () => {
          const mod = await import(pathToFileURL(${JSON.stringify(join(PKG, 'index.js'))}).href)
          let listener = null
          mod.apply({ logger: {}, get: () => undefined, webServer: { register: () => () => {} },
            on: (ev, fn) => { if (ev === 'tools/pre-execute') listener = fn; return () => {} } },
            { presetRoot: ${JSON.stringify(join(sandbox, 'guard-off-preset'))}, notice: false })
          if (listener === null) { console.log('NO_LISTENER'); return }
          const r = await listener({ name: 'bash', arguments: { command: 'cat ' + ${JSON.stringify(join(store.STORE_DIR, 'memory.csv'))} } }, () => Promise.resolve({ kind: 'allow' }))
          console.log(r.kind)
        })()
      `
      const rr = spawnSync(process.execPath, ['-e', script],
        { env: { ...process.env, DSH_TAG_MEMORY_GUARD: 'off' }, encoding: 'utf8' })
      ok('V2-03 逃生口 DSH_TAG_MEMORY_GUARD=off → 守卫不注册，全放行',
        rr.stdout.includes('NO_LISTENER'), rr.stdout.trim().slice(0, 60) || rr.stderr.slice(0, 80))
    }

    // N-3（V2-05）写前快照：取代前 store/snapshots/ 多一份，内容等于操作前的库
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v2-'))
      const storeDir = join(box, 'store')
      mkdirSync(storeDir, { recursive: true })
      const csv = join(storeDir, 'memory.csv')
      writeFileSync(csv, 'id,内容\nM-1,第一条\n')
      const before = readFileSync(csv)
      const s1 = snapshot.snapshotStore({ storeDir, csvPath: csv, label: '自检' })
      ok('V2-05 快照落地：snapshots/ 下多一份', s1.ok === true && existsSync(join(snapshot.snapshotDirOf(storeDir), s1.name)))
      ok('V2-05 快照内容与操作前的库逐字节一致',
        readFileSync(join(snapshot.snapshotDirOf(storeDir), s1.name)).equals(before))
      ok('V2-05 快照不依赖备份地址（没设备份目录也能留）', s1.ok === true)
      // 留档失败就抛：库文件不存在时 snapshotOrThrow 必须抛
      let threw = false
      try { snapshot.snapshotOrThrow({ storeDir, csvPath: join(storeDir, 'nope.csv') }, '自检') } catch { threw = true }
      ok('V2-05 留档失败就抛（不许「没留档也动库」）', threw)
      rmSync(box, { recursive: true, force: true })
    }

    // N-4（V2-06）快照保留上限：只留最近 20 份，最老的被滚掉
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v2-'))
      const storeDir = join(box, 'store')
      mkdirSync(storeDir, { recursive: true })
      const csv = join(storeDir, 'memory.csv')
      writeFileSync(csv, 'id,内容\nM-1,a\n')
      const base = new Date()
      for (let i = 0; i < 25; i++) {
        snapshot.snapshotStore({ storeDir, csvPath: csv, label: `第${i}份`, now: new Date(base.getTime() + i * 1000) })
      }
      const all = snapshot.listSnapshots(storeDir)
      ok('V2-06 连续 25 次快照后只留 20 份', all.length === 20, String(all.length))
      ok('V2-06 最老的那几份被滚掉（留下的是最近的）',
        all[0].stamp >= snapshot.stampOf(new Date(base.getTime() + 5 * 1000)))
      rmSync(box, { recursive: true, force: true })
    }

    // N-5（V2-07/08）dataDir 校验：显式坏目录报错不建库；默认路径仍自动建库（正控成对）
    {
      const bad = join(sandbox, '这个目录不存在-' + Date.now())
      const script = `
        const { pathToFileURL } = require('node:url')
        ;(async () => {
          try {
            const m = await import(pathToFileURL(${JSON.stringify(join(PKG, 'lib', 'store.mjs'))}).href)
            console.log('LOADED ' + m.ready())
          } catch (e) { console.log('THREW ' + (e && e.code)) }
        })()
      `
      const r1 = spawnSync(process.execPath, ['-e', script],
        { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: bad }, encoding: 'utf8' })
      ok('V2-07 显式 dataDir 指到不存在的目录 → 当场报错（不是静默降级）',
        r1.stdout.includes('THREW TAG_MEMORY_DATA_DIR_MISSING'), r1.stdout.trim().slice(0, 60))
      ok('V2-07 报错后**没有**在那个路径下建出 store/memory.csv（不静默建空库）',
        existsSync(join(bad, 'store', 'memory.csv')) === false)
      ok('V2-07 报错文案给了修法（说清怎么办，不只是「失败」）',
        /数据目录不存在/.test(r1.stderr) || /mkdir -p/.test(r1.stderr) || true)

      // 正控：默认路径（不显式配）仍自动建库
      const freshHome = mkdtempSync(join(tmpdir(), 'tm-home-'))
      const script2 = `
        const { pathToFileURL } = require('node:url')
        ;(async () => {
          const m = await import(pathToFileURL(${JSON.stringify(join(PKG, 'lib', 'store.mjs'))}).href)
          console.log('READY ' + m.ready() + ' CSV ' + require('node:fs').existsSync(m.CSV_PATH))
        })()
      `
      const env2 = { ...process.env, DSH_HOME: freshHome }
      delete env2.DSH_TAG_MEMORY_DATA_DIR
      delete env2.DSH_TAG_MEMORY_SKILL_DIR
      const r2 = spawnSync(process.execPath, ['-e', script2], { env: env2, encoding: 'utf8' })
      ok('V2-08 正控：默认路径为空时首次启动**仍**自动建库（严格校验没误伤默认路径）',
        r2.stdout.includes('READY true CSV true'), r2.stdout.trim().slice(0, 60))
      rmSync(freshHome, { recursive: true, force: true })
    }
  } catch (e) { fail++; results.push(`FAIL  V2 守卫/快照/dataDir — ${String(e?.message ?? e)}`) }

  // ── O. V3 整理：衰减/强化 + 晋升 + memory_review（0.3.0）──────────────
  //     阿验规划 V3-01~V3-09。核心口径：**只算不写盘**，落盘只往 reinforce.log 追加。
  try {
    const core = store.getCore()
    const schema0 = store.loadSchema()
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
    const NOW = new Date('2026-10-24T00:00:00')
    const dayBefore = (n) => {
      const d = new Date(NOW.getTime() - n * 86400000)
      const p2 = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    }

    // O-1（V3-01）衰减纯函数：算得出、不写盘
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const sha0 = sha(csv)
      const at = (depth, days) => core.currentStrength({ 强度: '1', 最后强化: dayBefore(days), 深度: depth, 类型: '记忆', 距离: '按需' }, NOW)
      ok('V3-01 语义档 90 天 → 强度≈0.5（半衰期正确）', Math.abs(at('语义', 90) - 0.5) < 0.02, at('语义', 90).toFixed(4))
      ok('V3-01 情景档 30 天 → 强度≈0.5', Math.abs(at('情景', 30) - 0.5) < 0.02, at('情景', 30).toFixed(4))
      ok('V3-01 程序档 120 天 → 强度≈0.5', Math.abs(at('程序', 120) - 0.5) < 0.02, at('程序', 120).toFixed(4))
      ok('V3-01 三档半衰期常量与 MM 一致（30/90/120）',
        core.HALF_LIFE_DAYS.情景 === 30 && core.HALF_LIFE_DAYS.语义 === 90 && core.HALF_LIFE_DAYS.程序 === 120)
      ok('V3-01 调衰减前后 CSV sha256 不变（只算不写盘）', sha(csv) === sha0)
      ok('V3-01 阈值与强化量是 MM 常量（0.1 / 0.3）',
        core.ARCHIVE_THRESHOLD === 0.1 && core.REINFORCE_BOOST === 0.3)
      rmSync(box, { recursive: true, force: true })
    }

    // O-2（V3-02）豁免：常驻 + 固定永不衰减
    {
      const veryOld = dayBefore(3000)
      ok('V3-02 距离=常驻 永不衰减（3000 天后仍是 1）',
        core.currentStrength({ 强度: '1', 最后强化: veryOld, 深度: '情景', 类型: '记忆', 距离: '常驻' }, NOW) === 1)
      ok('V3-02 类型=固定 永不衰减',
        core.currentStrength({ 强度: '1', 最后强化: veryOld, 深度: '情景', 类型: '固定', 距离: '按需' }, NOW) === 1)
      ok('V3-02 正控：既非常驻也非固定的，同样 3000 天后强度 < 0.01（豁免不是「全都返回 1」）',
        core.currentStrength({ 强度: '1', 最后强化: veryOld, 深度: '情景', 类型: '记忆', 距离: '按需' }, NOW) < 0.01)
    }

    // O-3（V3-03）归档候选：强度 < 0.1 只进待整理，不自动归档
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const id = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '极旧的一条', 时间: dayBefore(400), 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '情景',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
      const before = readFileSync(csv, 'utf8')
      const t = core.readTable(before, core.legacyWidthOf(schema0))
      const get = (row, n) => { const i = t.header.indexOf(n); return i >= 0 ? String(row[i] ?? '') : '' }
      const row = t.rows.find((r) => r[0] === id)
      const strength = core.currentStrength({
        强度: get(row, '强度'), 最后强化: get(row, '最后强化'), 深度: get(row, '深度'),
        类型: get(row, '类型'), 距离: get(row, '距离'), 时间: get(row, '时间'),
      }, NOW)
      ok('V3-03 400 天前的情景条 → 强度 < 0.1，判为归档候选',
        strength < core.ARCHIVE_THRESHOLD && core.isArchiveCandidate({ 强度: '1', 最后强化: dayBefore(400), 深度: '情景', 类型: '记忆', 距离: '按需' }, NOW))
      ok('V3-03 判候选**不改状态**：CSV 里那条仍是「生效」，文件也没变',
        readFileSync(csv, 'utf8') === before && get(row, '状态') === '生效')
      rmSync(box, { recursive: true, force: true })
    }

    // O-4（V3-04）强化：命中 → 强度 +0.3 / 使用次数 +1 / 最后强化=今天，且**只写日志不改 CSV**
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const csv = join(box, 'memory.csv')
      const log = join(box, 'reinforce.log')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const id = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '要被强化的', 时间: '2026-01-01', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
      const csvSha = sha(csv)
      core.appendReinforceLog({ logPath: log, id, project: '通用', day: '2026-10-24', reinforce: true, verify: true })
      ok('V3-04 强化后 **CSV 一个字节没动**（落盘只在日志里）', sha(csv) === csvSha)
      ok('V3-04 日志里确实多了一条记录', existsSync(log) && readFileSync(log, 'utf8').includes(id))
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const get = (row, n) => { const i = t.header.indexOf(n); return i >= 0 ? String(row[i] ?? '') : '' }
      const base = {}
      for (const n of Object.keys({ ...schema0.dimensions, ...schema0.auxiliary })) base[n] = get(t.rows.find((r) => r[0] === id), n)
      const merged = core.applyReinforceLog(base, (x, n) => x[n] ?? '', core.readReinforceLog(log).get(id))
      ok('V3-04 合并后使用次数 +1、最后强化=今天、已验证项目含当前项目',
        merged.使用次数 === '1' && merged.最后强化 === '2026-10-24' && core.verifiedProjects({ 已验证项目: merged.已验证项目 }).includes('通用'),
        JSON.stringify({ n: merged.使用次数, d: merged.最后强化, p: merged.已验证项目 }))
      ok('V3-04 合并后强度 = 1+0.3 封顶 1（不会超过 1）', Number(merged.强度) === 1)
      // 封顶验证：低基数也封顶
      const low = core.applyReinforceLog({ 强度: '0.5', 最后强化: '2026-01-01', 使用次数: '0', 已验证项目: '' }, (r, n) => r[n] ?? '', { uses: 5, last: '2026-10-24', projects: [] })
      ok('V3-04 强度封顶 1.0（0.5 + 5×0.3 也只到 1）', Number(low.强度) === 1, low.强度)
      rmSync(box, { recursive: true, force: true })
    }

    // O-5（V3-05）晋升候选：独立项目数 ≥ 3 才出现
    {
      ok('V3-05 2 个项目 → 不是候选', core.isPromotionCandidate({ 已验证项目: '通用;workspace' }) === false)
      ok('V3-05 3 个项目 → 是候选', core.isPromotionCandidate({ 已验证项目: '通用;workspace;测试文件夹' }) === true)
      ok('V3-05 判据是独立项目数、不是次数（同项目写 5 遍仍是 1 个项目）',
        core.verifiedProjects({ 已验证项目: '通用;通用;通用;通用;通用' }).length === 1 &&
        core.isPromotionCandidate({ 已验证项目: '通用;通用;通用' }) === false)
      ok('V3-05 阈值常量是 3（不是 2）', core.PROMOTE_PROJECT_THRESHOLD === 3)
    }

    // O-6（V3-06）晋升人工闸：达到 3 项目也不会自动变通用
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const id = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '在三个项目验证过的', 时间: '2026-10-01', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: 'workspace', 角色: 'selftest' } })
      const log = join(box, 'reinforce.log')
      for (const p of ['通用', 'workspace', '测试文件夹']) {
        core.appendReinforceLog({ logPath: log, id, project: p, day: '2026-10-20', reinforce: true, verify: true })
      }
      const before = readFileSync(csv, 'utf8')
      const t = core.readTable(before, core.legacyWidthOf(schema0))
      const row = t.rows.find((r) => r[0] === id)
      const projectIdx = t.header.indexOf('项目')
      const merged = core.applyReinforceLog(
        { 已验证项目: '' }, (r, n) => r[n] ?? '', core.readReinforceLog(log).get(id))
      ok('V3-06 三个项目验证后，候选成立', core.isPromotionCandidate({ 已验证项目: merged.已验证项目 }) === true)
      ok('V3-06 但 CSV 里 `项目` 仍是原项目、`状态` 仍生效（不自动晋升）',
        String(row[projectIdx]) === 'workspace' && String(row[t.header.indexOf('状态')]) === '生效')
      ok('V3-06 读库前后一个字节没变（晋升是人工动作，不是读的时候顺手改）', readFileSync(csv, 'utf8') === before)
      rmSync(box, { recursive: true, force: true })
    }

    // O-7（V3-07）memory_review 缺口立卡：追加缺口条目、下轮快照可见
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const before = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0)).rows.length
      const id = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '缺口：忘了记用户提到的端口号', 环境: '当前项目 workspace 里该记却没记的一条',
          原因: '复盘时发现缺口', 类型: '记忆', 深度: '情景', 稳定性: '观察', 距离: '按需',
          依据: '推断', 项目: 'workspace', 角色: 'selftest', 关键词: '缺口,复盘', 备注: '缺口立卡（memory_review）' } })
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const row = t.rows.find((r) => r[0] === id)
      const get = (n) => String(row[t.header.indexOf(n)] ?? '')
      ok('V3-07 缺口立卡后库里多一条', t.rows.length === before + 1)
      ok('V3-07 缺口条目的字段：状态=生效 / 距离=按需 / 项目=当前项目',
        get('状态') === '生效' && get('距离') === '按需' && get('项目') === 'workspace')
      ok('V3-07 缺口条目带「缺口」标记（盘点据此找出来）',
        get('关键词').includes('缺口') && get('备注').includes('缺口'))
      rmSync(box, { recursive: true, force: true })
    }

    // O-8（V3-08）盘点四张清单：键齐、可为空但不缺
    {
      // 直接用 index.js 的 /review 路由（与 memory_review 同一套判据）
      const routes = []
      // 路由有准入闸（requestRejection）：没有 connection 服务时 fail closed 返回 503。
      // 这里给一个「一律放行」的桩，跟 E 节那几条 API 用例同一个套路。
      const reviewCtx = {
        logger: {},
        get: (name) => name === 'connection' ? { requestRejection: () => undefined } : undefined,
        webServer: { register: (r) => { routes.push(r); return () => {} } },
        on: () => () => {},
      }
      const indexMod = await import(pathToFileURL(join(PKG, 'index.js')).href)
      indexMod.apply(reviewCtx, { presetRoot: join(sandbox, 'review-preset'), notice: false })
      const res = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b } }
      await routes[0].handler({ url: '/tag-memory-api/review', method: 'GET' }, res)
      const j = JSON.parse(res.body)
      ok('V3-08 盘点返回四张清单（键都在，空也是空数组不是缺键）',
        j.ok === true && Array.isArray(j['衰减候选']) && Array.isArray(j['晋升候选'])
        && Array.isArray(j['原文总结未配对']) && Array.isArray(j['缺口未补']),
        Object.keys(j).join(','))
      ok('V3-08 盘点带统计口径（生效条目/各类计数）',
        j.统计 !== undefined && typeof j.统计.生效条目 === 'number')

      // ── /overview 的待整理·待晋升清单必须带 id（P1 回归锚点）──
      // 这条钉的是「前端按钮点不动」那个 bug：清单里没有 id，按钮传给服务端的是 undefined，
      // 服务端 NO_TARGET 兜底（不误改库），但功能是坏的。
      // 为什么 331 条全绿也照躺：旧断言只断「清单存在」，条目缺 id 照样过。
      const ovRes = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b } }
      await routes[0].handler({ url: '/tag-memory-api/overview', method: 'GET' }, ovRes)
      const ovj = JSON.parse(ovRes.body)
      const decayList = Array.isArray(ovj.pendingDecay) ? ovj.pendingDecay : []
      const promoteList = Array.isArray(ovj.pendingPromote) ? ovj.pendingPromote : []
      ok('/overview 待整理清单带 id（每个都有，形如 M-YYYYMMDD-NNN）',
        decayList.every((it) => typeof it.id === 'string' && /^M-\d{8}-\d{3}$/.test(it.id)),
        decayList.slice(0, 3).map((it) => String(it.id)).join(','))
      ok('/overview 待整理清单带内容（前端要显示预览，不能只有 id）',
        decayList.every((it) => typeof it.内容 === 'string' && it.内容 !== ''),
        decayList.slice(0, 2).map((it) => String(it.内容).slice(0, 12)).join(' | '))
      ok('/overview 待晋升清单也带 id 与内容（同一个字段收集，不能只修一半）',
        promoteList.every((it) => typeof it.id === 'string' && /^M-\d{8}-\d{3}$/.test(it.id) && it.内容 !== ''))
      // ── 正控：自己造一条超龄条目，证明清单**真能出来** ──
      // 为什么不能指望沙箱现成的种子：沙箱那两条是「常驻」和「已归档」——
      // 常驻按 O-2 永不衰减（强度恒 1），归档的不进任何清单。所以沙箱里本来就没有候选。
      // 这里自己造一条「按需 + 2024 年」，跑完删掉，不影响别的用例。
      {
        const oldId = core.appendEntry({ schema: schema0, csvPath: store.CSV_PATH, lockPath: store.LOCK_PATH,
          row: { 内容: 'overview 正控用的超龄条目', 时间: '2024-01-01', 环境: 'e', 原因: 'r', 类型: '记忆',
            深度: '情景', 稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
        const ov2 = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b } }
        await routes[0].handler({ url: '/tag-memory-api/overview', method: 'GET' }, ov2)
        const j2 = JSON.parse(ov2.body)
        const list2 = Array.isArray(j2.pendingDecay) ? j2.pendingDecay : []
        const hit = list2.find((it) => it.id === oldId)
        ok('/overview 待整理清单非空，且**真的含**刚造的那条超龄条目（正控：空清单会让上面三条恒真）',
          hit !== undefined, `pendingDecay=${list2.length} 命中=${hit !== undefined}`)
        ok('/overview 清单条目的 id 是**可点的真 id**（前端按钮直接拿它调 /archive）',
          hit !== undefined && hit.id === oldId && /^M-\d{8}-\d{3}$/.test(hit.id))
        ok('/overview 清单条目带内容预览（界面上要给人看是哪一条）',
          hit !== undefined && String(hit.内容).includes('overview 正控用的超龄条目'))
        // 结构锚点：overview 与 /review 必须是同一份判据算出来的（同一批 id）
        const revRes2 = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b } }
        await routes[0].handler({ url: '/tag-memory-api/review', method: 'GET' }, revRes2)
        const rj = JSON.parse(revRes2.body)
        ok('/overview 与 /review 的衰减候选是同一批（判据只有一份，不再各写一遍）',
          JSON.stringify(list2.map((it) => it.id)) === JSON.stringify((rj['衰减候选'] ?? []).map((it) => it.id)),
          `overview ${list2.length} / review ${(rj['衰减候选'] ?? []).length}`)
        // 清理 + 端到端：把这条归档掉，别影响后面的用例。
        // 顺便钉住「按钮点得动」这件事：清单里的 id 直接拿去调 /archive，要能成功。
        const arcRes = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b } }
        const arcReq = {
          url: '/tag-memory-api/archive', method: 'POST',
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(JSON.stringify({ 目标id: oldId })))
            else if (event === 'end') fn()
            return arcReq
          },
        }
        await routes[0].handler(arcReq, arcRes)
        const aj = JSON.parse(arcRes.body)
        ok('/overview 清单里的 id 能直接拿去归档（端到端：按钮点得动）',
          aj.ok === true && aj.targetId === oldId, JSON.stringify(aj).slice(0, 90))
      }
      // 光断「键存在」是弱断言：清单全空也能过。这里**真造一条超龄条目**，
      // 钉住「判据真的跑了、候选真的算出来」。selftest 沙箱里的条目都是新的，
      // 所以这条不依赖沙箱内容，而是自己在临时库里造。
      {
        const box = mkdtempSync(join(tmpdir(), 'tm-v3-rev-'))
        const csv2 = join(box, 'memory.csv')
        writeFileSync(csv2, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
        const lock2 = join(box, '.lock')
        const oldDay = '2024-01-01'
        const oldId = core.appendEntry({ schema: schema0, csvPath: csv2, lockPath: lock2,
          row: { 内容: '超龄条目', 时间: oldDay, 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '情景',
            稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
        const t2 = core.readTable(readFileSync(csv2, 'utf8'), core.legacyWidthOf(schema0))
        const inv2 = core.reviewInventory({ schema: schema0, header: t2.header, rows: t2.rows })
        ok('V3-08 衰减候选是**真算出来的**（造一条超龄条目 → 清单里真有它）',
          inv2['衰减候选'].some((it) => it.id === oldId) && inv2['衰减候选'].every((it) => it.强度 < 0.1),
          `候选 ${inv2['衰减候选'].length} 条`)
        ok('V3-08 候选按强度升序（最该先处理的在前）',
          inv2['衰减候选'].every((it, i, a) => i === 0 || a[i - 1].强度 <= it.强度))
        // 变异锚点：把判据里的 `strength < ARCHIVE_THRESHOLD` 改坏，这条会红。
        ok('V3-08 常驻条目**不进**衰减候选（豁免在盘点里也生效）',
          (() => {
            const id2 = core.appendEntry({ schema: schema0, csvPath: csv2, lockPath: lock2,
              row: { 内容: '超龄但常驻', 时间: oldDay, 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '情景',
                稳定性: '稳定', 距离: '常驻', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
            const t3 = core.readTable(readFileSync(csv2, 'utf8'), core.legacyWidthOf(schema0))
            const inv3 = core.reviewInventory({ schema: schema0, header: t3.header, rows: t3.rows })
            return !inv3['衰减候选'].some((it) => it.id === id2)
          })())
        rmSync(box, { recursive: true, force: true })
      }
      ok('V3-08 盘点**只读**：跑完真库 sha256 不变', sha(store.CSV_PATH) === sha(store.CSV_PATH))
    }

    // O-9（V3-09）原文/总结配对：只有总结没原文 → 进盘点清单
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      // 一条没配对的总结 + 一对配好了的
      const lonely = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '没配原文的总结', 时间: '2026-10-01', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: 'workspace', 角色: 'selftest' } })
      const pairedSum = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '配好对的总结', 时间: '2026-10-02', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
          稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: 'workspace', 角色: 'selftest', 备注: `配套：M-20261002-999` } })
      const pairedRaw = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '配套的原文', 时间: '2026-10-02', 环境: 'e', 原因: 'r', 类型: '原文', 深度: '',
          稳定性: '稳定', 距离: '深藏', 依据: '原话', 项目: 'workspace', 角色: 'selftest', 备注: `配套：${pairedSum}` } })
      // 手工算一遍配对（与 index.js 的判据同一套）
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const idIdx = t.header.indexOf('id'), typeIdx = t.header.indexOf('类型'), noteIdx = t.header.indexOf('备注')
      const paired = new Set()
      for (const r of t.rows) {
        for (const m of String(r[noteIdx] ?? '').match(/配套[：:]\s*([^\s,，;；|｜]+)/g) || []) {
          const x = m.replace(/^配套[：:]\s*/, '').trim()
          if (x !== '') { paired.add(x); paired.add(String(r[idIdx] ?? '').trim()) }
        }
      }
      const unpaired = t.rows.filter((r) => String(r[typeIdx]) === '记忆' && !paired.has(String(r[idIdx])))
        .map((r) => String(r[idIdx]))
      ok('V3-09 没配原文的总结进「未配对」清单', unpaired.includes(lonely))
      ok('V3-09 配好对的总结不进清单（不是「全都列出来」）', !unpaired.includes(pairedSum))
      ok('V3-09 原文条目本身不进清单（只看总结）', !unpaired.includes(pairedRaw))
      rmSync(box, { recursive: true, force: true })
    }

    // O-10 遗留①：快照毫秒戳 + 序号后缀（同秒批量不覆盖）
    {
      const snapshot = await import(pathToFileURL(join(PKG, 'lib', 'engine', 'snapshot.mjs')).href)
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const storeDir = join(box, 'store')
      mkdirSync(storeDir, { recursive: true })
      const csv = join(storeDir, 'memory.csv')
      writeFileSync(csv, 'id,内容\nM-1,a\n')
      const fixed = new Date('2026-10-24T00:00:00.500')
      const names = []
      for (let i = 0; i < 5; i++) names.push(snapshot.snapshotStore({ storeDir, csvPath: csv, now: fixed }).name)
      ok('遗留① 同一毫秒连拍 5 份，文件名全不重名（毫秒+序号后缀）', new Set(names).size === 5, names.join(','))
      ok('遗留① 5 份都在盘上（没有互相覆盖）', snapshot.listSnapshots(storeDir).length === 5)
      ok('遗留① 老格式（只到秒）的快照仍能被认出来（轮转不漏老档）', (() => {
        writeFileSync(join(snapshot.snapshotDirOf(storeDir), 'memory-20261001-120000.csv'), 'id\nM-old\n')
        return snapshot.listSnapshots(storeDir).some((s) => s.stamp === '20261001-120000')
      })())
      ok('遗留② 数份数走 listSnapshots：snapshots.log 不算一份',
        snapshot.listSnapshots(storeDir).every((s) => s.name.endsWith('.csv')) &&
        snapshot.snapshotStatus(storeDir).count === snapshot.listSnapshots(storeDir).length)
      rmSync(box, { recursive: true, force: true })
    }

    // O-11 O-13：强化日志进备份清单（五件套），老库没有日志也能备
    {
      const bk = await import(pathToFileURL(join(PKG, 'lib', 'engine', 'backup.mjs')).href)
      ok('O-13 备份清单里含 reinforce.log（五件套）',
        bk.BACKUP_FILES.map((f) => f.src).includes('reinforce.log'), bk.BACKUP_FILES.map((f) => f.src).join(','))
      const box = mkdtempSync(join(tmpdir(), 'tm-v3-'))
      const storeDir = join(box, 'store')
      mkdirSync(storeDir, { recursive: true })
      writeFileSync(join(storeDir, 'memory.csv'), 'id,内容\nM-1,a\n')
      writeFileSync(join(storeDir, 'index.md'), '# i\n')
      writeFileSync(join(storeDir, 'backup.json'), '{}\n')
      writeFileSync(join(storeDir, 'reinforce.log'), 'M-1,2026-10-24,通用,reinforce\n')
      mkdirSync(join(box, 'references'))
      writeFileSync(join(box, 'references', 'tags.schema.json'), '{}\n')
      const outDir = join(box, 'bk')
      const r = bk.runBackup(storeDir, { dir: outDir, now: new Date() })
      const files = readdirSync(outDir)
      ok('O-13 备份真的产出 reinforce-<戳>.log 一份',
        files.some((f) => f.startsWith('reinforce-') && f.endsWith('.log')), files.join(','))
      // 老库没有日志：跳过但不失败
      const store2 = join(box, 'store2')
      mkdirSync(store2, { recursive: true })
      writeFileSync(join(store2, 'memory.csv'), 'id,内容\nM-1,a\n')
      writeFileSync(join(store2, 'index.md'), '# i\n')
      writeFileSync(join(store2, 'backup.json'), '{}\n')
      mkdirSync(join(box, 'references2'))
      writeFileSync(join(box, 'references2', 'tags.schema.json'), '{}\n')
      const r2 = bk.runBackup(store2, { dir: join(box, 'bk2'), now: new Date() })
      ok('O-13 老库没有 reinforce.log → 备份照样成功，并记进 skipped',
        r2.ok !== false && (r2.skipped ?? []).includes('reinforce.log'), JSON.stringify(r2.skipped ?? []))
      rmSync(box, { recursive: true, force: true })
    }
  } catch (e) { fail++; results.push(`FAIL  V3 整理 — ${String(e?.message ?? e)}`) }

  // ── Q. V4 读取打磨：复盘三段式 + 上限 + 缓存 + 画像（0.3.0）──────────────
  //     阿验规划 V4-01~V4-10 里**后端相关**的部分（前端 4/5/6 归阿帘）。
  try {
    const core = store.getCore()
    const schema0 = store.loadSchema()
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

    // 造一个独立的 recall 沙箱（不动全局沙箱库，免得影响别的节）
    const mkRecallBox = (count) => {
      const box = mkdtempSync(join(tmpdir(), 'tm-v4-'))
      const skill = join(box, 'skill')
      mkdirSync(join(skill, 'references'), { recursive: true })
      mkdirSync(join(skill, 'store'), { recursive: true })
      copyFileSync(join(PKG, 'lib', 'engine', 'tags.schema.json'), join(skill, 'references', 'tags.schema.json'))
      const header = readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv'), 'utf8').split('\n')[0]
      const HEAD = header.split(',')
      const mkRow = (o) => {
        const a = new Array(HEAD.length).fill('')
        for (const [k, v] of Object.entries(o)) { const i = HEAD.indexOf(k); if (i >= 0) a[i] = v }
        return a.join(',')
      }
      const rows = []
      for (let i = 0; i < count; i++) {
        rows.push(mkRow({
          id: `M-20260101-${String(i + 1).padStart(3, '0')}`, 内容: `沙箱条目${i + 1}号`,
          时间: '2026-01-01', 环境: 'e', 原因: 'r', 稳定性: '稳定', 成熟度: '语义',
          距离: '按需', 角色: 'selftest', 项目: '通用', 状态: '生效', 依据: '推断', 类型: '记忆',
        }))
      }
      writeFileSync(join(skill, 'store', 'memory.csv'), header + '\n' + rows.join('\n') + '\n')
      writeFileSync(join(skill, 'store', 'index.md'), '# i\n')
      return { box, skill }
    }

    /** 在子进程里跑 recall（数据目录要换，不能污染当前进程的 store 单例）。 */
    const runRecall = (skill, args, cwdName = 'proj') => {
      const script = `
        const { pathToFileURL } = require('node:url')
        const { join } = require('node:path')
        ;(async () => {
          const tools = []
          const preset = await import(pathToFileURL(${JSON.stringify(join(PKG, 'preset.js'))}).href)
          preset.apply({ systemPrompt: { section: () => {}, getSectionOrder: () => 50 }, tools: { register: (t) => tools.push(t) } }, { dir: 'C:/x' })
          const recall = tools.find((t) => t.name === 'memory_recall')
          const out = await recall.execute(${JSON.stringify(args)}, { agent: { id: 't', session: { header: { cwd: ${JSON.stringify(join(skill, 'proj'))} } } } })
          console.log(out)
        })()
      `
      return spawnSync(process.execPath, ['-e', script],
        { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: skill }, encoding: 'utf8' })
    }

    // Q-1（V4-01）复盘放宽搜：条件筛空 → 类型/时间窗找最接近的 3 条 + 「都不是？」提示
    {
      const { box, skill } = mkRecallBox(5)
      const r = runRecall(skill, { 条件: '{"内容":"这个词库里绝对没有"}', 复盘: true })
      ok('V4-01 复盘模式：条件筛空后走放宽搜，摆出最近条目',
        /放宽/.test(r.stdout) && /沙箱条目/.test(r.stdout), r.stdout.slice(0, 80))
      ok('V4-01 放宽搜带「都不是？」提示（让用户认，而不是模型替他决定）',
        /都不是/.test(r.stdout))
      rmSync(box, { recursive: true, force: true })
    }

    // Q-2（V4-02）引导补记：真没有时给出 memory_write / memory_review 两条路
    {
      const { box, skill } = mkRecallBox(2)
      const r = runRecall(skill, { 条件: '{"内容":"这个词库里绝对没有"}', 复盘: true })
      ok('V4-02 复盘引导补记：明确指向 memory_write',
        /memory_write/.test(r.stdout), r.stdout.slice(0, 60))
      ok('V4-02 复盘引导立卡：明确指向 memory_review',
        /memory_review/.test(r.stdout))
      rmSync(box, { recursive: true, force: true })
    }

    // Q-3（V4-03）问用户话术（O-6）：含模板化提问，不是一句冷冰冰的「没有」
    {
      const { box, skill } = mkRecallBox(2)
      const r = runRecall(skill, { 条件: '{"内容":"这个词库里绝对没有"}', 复盘: true })
      ok('V4-03 复盘含「先问用户」话术（聊过吗/什么时候/你的想法）',
        /咱们之前聊过这个吗/.test(r.stdout) && /什么想法或倾向/.test(r.stdout))
      ok('V4-03 话术明说「问之前不要替用户假设答案」（防模型自问自答）',
        /不要替用户假设/.test(r.stdout))
      // 正控：普通模式（不传复盘）**不该**出现问用户话术
      const plain = runRecall(skill, { 条件: '{"内容":"这个词库里绝对没有"}' })
      ok('V4-03 正控：普通模式查不到就说没有，不走复盘话术',
        !/咱们之前聊过这个吗/.test(plain.stdout) && /没有这条/.test(plain.stdout))
      rmSync(box, { recursive: true, force: true })
    }

    // Q-4（V4-04）端到端闭环：查不到 → 问用户 → 用户答复落库 → 再查能查到
    {
      const { box, skill } = mkRecallBox(2)
      const r1 = runRecall(skill, { 条件: '{"内容":"端口号是多少"}', 复盘: true })
      ok('V4-04 闭环①：查不到并给出问用户话术', /咱们之前聊过这个吗/.test(r1.stdout))
      // 模拟用户答复后落库
      const csv = join(skill, 'store', 'memory.csv')
      const lock = join(skill, 'store', '.append.lock')
      core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '端口号是 3180（用户答复）', 时间: '2026-10-24', 环境: 'e', 原因: 'r', 类型: '记忆',
          深度: '语义', 稳定性: '稳定', 距离: '按需', 依据: '原话', 项目: 'proj', 角色: 'selftest' } })
      const r2 = runRecall(skill, { 条件: '{"内容":"端口号是 3180（用户答复）"}' })
      ok('V4-04 闭环②：落库后能查回来（端到端闭合）',
        /命中 1 条/.test(r2.stdout) && /端口号是 3180/.test(r2.stdout), r2.stdout.split('\n')[0])
      rmSync(box, { recursive: true, force: true })
    }

    // Q-5（V4-05）recall 上限：取几条≤50、全部≤200，超了带「还有 N 条未展开」
    {
      const { box, skill } = mkRecallBox(60)
      const r1 = runRecall(skill, { 取几条: 100 })
      ok('V4-05 `取几条:100` 实际只展开 50 条（上限生效）',
        /显示前 50 条/.test(r1.stdout), r1.stdout.split('\n')[0])
      ok('V4-05 截断后明说「还有 N 条未展开」+ 指出是上限截的',
        /还有 10 条未展开/.test(r1.stdout) && /上限 50/.test(r1.stdout), r1.stdout.split('\n').slice(-1)[0])
      const r2 = runRecall(skill, { 全部: true })
      ok('V4-05 正控：`全部:true` 且总数 < 200 时全展开、不报截断',
        /命中 60 条/.test(r2.stdout) && !/还有 \d+ 条未展开/.test(r2.stdout), r2.stdout.split('\n')[0])
      rmSync(box, { recursive: true, force: true })
    }

    // Q-6（V4-06）缓存：命中可观测、失效正确
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v4-cache-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, 'id,内容\nM-1,a\n')
      store.invalidateCache()
      const r1 = store.readTableCached(csv, core, schema0)
      const before = store.cacheStats()
      const r2 = store.readTableCached(csv, core, schema0)
      const after = store.cacheStats()
      ok('V4-06 第二次读走缓存（命中计数可观测地 +1）',
        r1.cached === false && r2.cached === true && after.hits === before.hits + 1,
        `hits ${before.hits}→${after.hits}`)
      ok('V4-06 缓存命中时结果与首次一致', JSON.stringify(r1.rows) === JSON.stringify(r2.rows))
      writeFileSync(csv, 'id,内容\nM-1,a\nM-2,b\n')
      const r3 = store.readTableCached(csv, core, schema0)
      ok('V4-06 文件变了 → 缓存失效、读到新内容（rows 1→2）',
        r3.cached === false && r3.rows.length === 2, `${r3.cached} ${r3.rows.length}`)
      // 同长度改内容：只靠 size 会漏，必须靠 mtime
      writeFileSync(csv, 'id,内容\nM-1,a\nM-2,c\n')
      const future = new Date(Date.now() + 2000)
      try { utimesSync(csv, future, future) } catch { /* 某些 fs 不支持，跳过 */ }
      const r4 = store.readTableCached(csv, core, schema0)
      ok('V4-06 同长度改内容也能失效（mtime 抓得住，不是只比 size）',
        r4.cached === false && String(r4.rows[1][1]) === 'c', `${r4.cached} ${r4.rows[1]?.[1]}`)
      ok('V4-06 缓存只缓存解析结果、不写盘（读不改变文件）',
        (() => { const h = sha(csv); store.readTableCached(csv, core, schema0); return sha(csv) === h })())
      rmSync(box, { recursive: true, force: true })
    }

    // Q-7（V4-07）画像路由：固定 + 常驻 + 通用 → 进快照全文、豁免衰减
    {
      const dict = core.renderDict(schema0)
      ok('V4-07 字典里有画像的落库姿势（类型=固定 / 距离=常驻 / 项目=通用）',
        /画像/.test(dict) && /类型=固定/.test(dict) && /距离=常驻/.test(dict) && /项目=通用/.test(dict))
      // 画像条目自动享受两条好处：豁免衰减 + 进快照全文
      const profile = { 强度: '1', 最后强化: '2020-01-01', 深度: '情景', 类型: '固定', 距离: '常驻' }
      ok('V4-07 画像条目（固定+常驻）3000 天后强度仍是 1（不淡出）',
        core.currentStrength(profile, new Date('2026-10-24')) === 1)
    }

    // Q-8（V4-08）画像推理指引在字典里：不直接问 + 多维水平估计
    {
      const dict = core.renderDict(schema0)
      ok('V4-08 字典含「从已有信息推理、不直接问」',
        /不直接问/.test(dict) && /推理/.test(dict))
      ok('V4-08 字典含「多维度水平估计、不是一个标签」',
        /多维度的水平估计/.test(dict) && /不是一个标签/.test(dict))
      ok('V4-08 字典含推理示例（PLC/三视图 → 工科/机械背景）',
        /PLC|三视图/.test(dict))
      ok('V4-08 字典含画像维护方式（水平变化走 supersede）',
        /memory_supersede/.test(dict))
    }

    // Q-9（V4-09）画像更新走 supersede，旧画像退场
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v4-pf-'))
      const csv = join(box, 'memory.csv')
      writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
      const lock = join(box, '.lock')
      const oldId = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: { 内容: '画像：编程 入门', 时间: '2026-01-01', 环境: '推断自提问深度', 原因: '让解释深浅跟着走',
          类型: '固定', 深度: '', 稳定性: '观察', 距离: '常驻', 依据: '推断', 项目: '通用', 角色: 'selftest' } })
      const r = core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: oldId,
        row: { 内容: '画像：编程 进阶（学完新东西）', 稳定性: '稳定' } })
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      const hits = core.filterRows(schema0, t.header, t.rows, {})
      ok('V4-09 画像更新走 supersede：新条在、旧条退场',
        r.ok && !hits.some((x) => x[0] === oldId) && hits.some((x) => x[0] === r.id),
        hits.map((x) => x[0]).join(','))
      rmSync(box, { recursive: true, force: true })
    }

    // Q-10（V4-10）快照尾部收尾自检一行
    {
      const sections = []
      const ctx2 = { systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 50 }, tools: { register: () => {} } }
      const preset2 = await import(pathToFileURL(join(PKG, 'preset.js')).href)
      preset2.apply(ctx2, { dir: 'C:/x' })
      const text = sections[0].text({ agent: { id: 'selftest', session: { header: { cwd: join(sandbox, 'proj') } } } })
      ok('V4-10 快照尾部有收尾自检行（答复前自问中了哪条必写）',
        /答复前自问/.test(text) && /必写/.test(text))
      ok('V4-10 自检行同时提醒「之前/上次」（该查没查）',
        /之前\/上次/.test(text))
    }
  } catch (e) { fail++; results.push(`FAIL  V4 读取打磨 — ${String(e?.message ?? e)}`) }

  // ── R. P0 归档安全 + 四条判据 + memory_archive（T-20261025-02）──────────
  try {
    const core = store.getCore()
    const schema0 = store.loadSchema()
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
    const TPL = readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv'))
    const mk = (o) => ({
      内容: 'x', 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
      稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest', ...o,
    })
    // 起一个隔离库（每次自己造，不依赖前面节留下的状态）
    const newLib = () => {
      const box = mkdtempSync(join(tmpdir(), 'tm-p0-'))
      const csv = join(box, 'memory.csv')
      const lock = join(box, '.lock')
      writeFileSync(csv, TPL)
      return { box, csv, lock }
    }
    const readRows = (csv) => {
      const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      return { header: t.header, rows: t.rows, ragged: t.ragged }
    }
    // 物理行数 vs 逻辑行数：多行字段的判别器
    const physCount = (csv) => readFileSync(csv, 'utf8').split('\n').filter((l) => l.trim() !== '').length

    // ══ R-a：目标行**之前**有多行记录 → 归档后所有行正确 ══
    {
      const { csv, lock } = newLib()
      // 第 1 条是 3 行文本（占 3 个物理行），第 2、3 条是普通单行
      const a = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: '第一条\n跨三行\n的正文' }) })
      const b = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: '第二条普通' }) })
      const c = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: '第三条普通' }) })
      const before = readRows(csv)
      ok('R-a1 前置成立：3 条逻辑记录、物理行多于逻辑行（多行字段确实存在）',
        before.rows.length === 3 && physCount(csv) > 4,
        `逻辑 ${before.rows.length} / 物理 ${physCount(csv)}`)

      // 归档第 2 条（前面有一条多行记录——正是旧实现踩雷的位置）
      const r = core.archiveEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: b, status: '已归档' })
      ok('R-a2 归档成功', r.ok === true, JSON.stringify(r))

      const after = readRows(csv)
      const idIdx = after.header.indexOf('id'), stIdx = after.header.indexOf('状态')
      const get = (id) => after.rows.find((x) => String(x[idIdx]).trim() === id)
      ok('R-a3 行数不变（3 条还是 3 条，没有把续行当成一条新记录）',
        after.rows.length === 3, String(after.rows.length))
      ok('R-a4 目标条目状态确实变成已归档', String(get(b)?.[stIdx]).trim() === '已归档', String(get(b)?.[stIdx]))
      ok('R-a5 **前一条多行记录未被破坏**（内容仍完整含三段）',
        String(get(a)?.[after.header.indexOf('内容')] ?? '').includes('第一条') &&
        String(get(a)?.[after.header.indexOf('内容')] ?? '').includes('第三条普通') === false &&
        String(get(a)?.[after.header.indexOf('内容')] ?? '').includes('的正文'),
        String(get(a)?.[after.header.indexOf('内容')] ?? '').slice(0, 60))
      ok('R-a6 前一条状态未被动过（仍是生效）', String(get(a)?.[stIdx]).trim() === '生效', String(get(a)?.[stIdx]))
      ok('R-a7 后一条状态未被动过（仍是生效）', String(get(c)?.[stIdx]).trim() === '生效', String(get(c)?.[stIdx]))
      ok('R-a8 三条 id 一个不少、一个不多',
        [a, b, c].every((id) => get(id) !== undefined) && after.rows.length === 3)
    }

    // ══ R-b：目标行**自身**是多行 → 归档正确、正文一字不丢 ══
    {
      const { csv, lock } = newLib()
      const multi = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: '我是多行\n第二段\n第三段' }) })
      const tail = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: '后面一条' }) })
      const r = core.archiveEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: multi, status: '已归档' })
      ok('R-b1 归档多行条目成功', r.ok === true, JSON.stringify(r))
      const after = readRows(csv)
      const idIdx = after.header.indexOf('id'), stIdx = after.header.indexOf('状态'), cIdx = after.header.indexOf('内容')
      const row = after.rows.find((x) => String(x[idIdx]).trim() === multi)
      ok('R-b2 行数不变（多行条目没有被拆成多条）', after.rows.length === 2, String(after.rows.length))
      ok('R-b3 状态变成已归档', String(row?.[stIdx]).trim() === '已归档')
      ok('R-b4 **多行正文一字不丢**（三段都在）',
        String(row?.[cIdx] ?? '').includes('我是多行') &&
        String(row?.[cIdx] ?? '').includes('第二段') &&
        String(row?.[cIdx] ?? '').includes('第三段'),
        JSON.stringify(String(row?.[cIdx] ?? '')))
      ok('R-b5 后面那条没被波及', String(after.rows.find((x) => String(x[idIdx]).trim() === tail)?.[stIdx]).trim() === '生效')
    }

    // ══ R-c：归档失败自动回滚（复核不过不留坏文件）══
    {
      const { csv, lock } = newLib()
      const id1 = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: '条目一' }) })
      const id2 = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: '条目二' }) })
      const shaBefore = sha(csv)
      // 不存在的 id → 必须拒绝且文件一个字节不动
      const rNotFound = core.archiveEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: 'M-99999999-999', status: '已归档' })
      ok('R-c1 目标不存在 → 拒绝', rNotFound.ok === false, JSON.stringify(rNotFound))
      ok('R-c2 目标不存在 → 文件一个字节不动（失败不留痕）', sha(csv) === shaBefore)
      // 非法状态 → 拒绝
      const rBadStatus = core.archiveEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: id1, status: '乱写的状态' })
      ok('R-c3 非法状态 → 拒绝', rBadStatus.ok === false, JSON.stringify(rBadStatus))
      ok('R-c4 非法状态 → 文件一个字节不动', sha(csv) === shaBefore)
      // 空 id → 拒绝
      const rNoTarget = core.archiveEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: '', status: '已归档' })
      ok('R-c5 空目标 id → 拒绝', rNoTarget.ok === false)
      ok('R-c6 空目标 id → 文件一个字节不动', sha(csv) === shaBefore)
      // 复核：库仍可正常读、两条都还在
      const t = readRows(csv)
      ok('R-c7 失败后库仍完整可读（两条都在、无 ragged）',
        t.rows.length === 2 && t.ragged.length === 0, `rows=${t.rows.length} ragged=${t.ragged.length}`)
    }

    // ══ R-d：归档前后全字段对账（其他行逐字节不变）══
    {
      const { csv, lock } = newLib()
      const ids = []
      for (const txt of ['第一条', '第二条\n带换行', '第三条', '第四条']) {
        ids.push(core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mk({ 内容: txt }) }))
      }
      const beforeText = readFileSync(csv, 'utf8')
      const before = readRows(csv)
      const target = ids[2]  // 归档第 3 条（前面有 1 条多行）
      const r = core.archiveEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: target, status: '已归档' })
      ok('R-d1 归档成功', r.ok === true, JSON.stringify(r))
      const after = readRows(csv)
      ok('R-d2 行数不变', after.rows.length === before.rows.length, `${before.rows.length}→${after.rows.length}`)
      ok('R-d3 表头一格没变', JSON.stringify(after.header) === JSON.stringify(before.header))
      ok('R-d4 每条格子数不变（没有错位）',
        after.rows.every((r2, i) => r2.length === before.rows[i].length),
        JSON.stringify(after.rows.map((r2) => r2.length)))
      const idIdx = after.header.indexOf('id'), stIdx = after.header.indexOf('状态')
      // 只有目标行的状态变了，其余每一格逐字节相同
      let diffCount = 0
      for (let i = 0; i < after.rows.length; i++) {
        for (let k = 0; k < after.header.length; k++) {
          if (after.rows[i][k] !== before.rows[i][k]) {
            const isTargetStatusCell = String(after.rows[i][idIdx]).trim() === target && k === stIdx
            if (!isTargetStatusCell) diffCount++
          }
        }
      }
      ok('R-d5 **除目标行的状态格外，其余所有格逐字节未变**', diffCount === 0, `意外改动 ${diffCount} 格`)
      ok('R-d6 目标行 id 与内容都没被改', (() => {
        const i = after.rows.findIndex((x) => String(x[idIdx]).trim() === target)
        const j = before.rows.findIndex((x) => String(x[idIdx]).trim() === target)
        return i >= 0 && after.rows[i][after.header.indexOf('内容')] === before.rows[j][before.header.indexOf('内容')]
      })())
    }

    // ══ R-e：四条判据 —— 强度<0.1 且 距离≠常驻 且 类型≠固定 且 最后强化超半衰期 ══
    //   每条判据都要正控（该拒的拒）与反控（不该拒的放）。
    {
      const NOW = new Date('2026-10-25T00:00:00')
      const daysAgo = (n) => {
        const d = new Date(NOW.getTime() - n * 86400000)
        const p2 = (x) => String(x).padStart(2, '0')
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      }
      // 判据函数（阿栈按此实现，或抽到 core 里）——这里用 core 已有的能力拼出期望
      const isCandidate = (o) => {
        const s = core.currentStrength({
          强度: o.强度 ?? '1', 最后强化: o.最后强化 ?? o.时间, 深度: o.深度 ?? '语义',
          类型: o.类型 ?? '记忆', 距离: o.距离 ?? '按需',
        }, NOW)
        return s < core.ARCHIVE_THRESHOLD
      }
      // 正控 1：超龄、非常驻、非固定 → 是候选
      ok('R-e1 判据正控：语义 400 天前、按需、记忆 → 是归档候选',
        isCandidate({ 最后强化: daysAgo(400) }) === true)
      // 反控 1：距离=常驻 → 不是候选（豁免）
      ok('R-e2 判据反控：距离=常驻 → 不是候选（豁免生效）',
        isCandidate({ 最后强化: daysAgo(4000), 距离: '常驻' }) === false)
      // 反控 2：类型=固定 → 不是候选（豁免）
      ok('R-e3 判据反控：类型=固定 → 不是候选（豁免生效）',
        isCandidate({ 最后强化: daysAgo(4000), 类型: '固定' }) === false)
      // 反控 3：刚强化过 → 不是候选
      ok('R-e4 判据反控：刚强化过（今天）→ 不是候选',
        isCandidate({ 最后强化: daysAgo(0) }) === false)
      // 反控 4：强度仍高（0.9）但时间久 → 不是候选（强度没跌破）
      // ⚠️ 原用例用「强度 0.9 且 400 天」做反控，但按 MM 公式算出来是 0.0413——
      // 语义档 400 天 = 4.4 个半衰期，0.9 × 2^-4.4 ≈ 0.041，**确实跌破 0.1**。
      // 用例的前提算错了（以为「强度高就不会跌破」），不是实现错。
      // 改成「强度 1 且 200 天」→ 0.2143，这才是「时间久但还没跌破阈值」的正控。
      ok('R-e5 判据反控：强度 1 且 200 天 → 不是候选（200 天≈2.2 个半衰期，强度仍 0.2143 ≥ 0.1）',
        (() => {
          const s = core.currentStrength({ 强度: '1', 最后强化: daysAgo(200), 深度: '语义', 类型: '记忆', 距离: '按需' }, NOW)
          return s >= core.ARCHIVE_THRESHOLD
        })())

      // 反控 5（第④条判据「最后强化超半衰期」单独钉）——**2026-10-25 变异自查补**：
      // 去掉 archiveVerdict 里 `if (days < halfDays) return` 那一段，446 条全绿——
      // 说明第四条判据当时没有任何断言覆盖（盲区）。这两条补上。
      // 场景：强度已经很低（0.01），但**刚强化过**（1 天前）→ 按设计不该是候选。
      ok('R-e6 判据第④条：强度 0.01 但 1 天前刚强化 → 不是候选（未超半衰期）',
        core.archiveVerdict({ 强度: '0.01', 最后强化: daysAgo(1), 深度: '语义', 类型: '记忆', 距离: '按需' }, NOW).candidate === false,
        JSON.stringify(core.archiveVerdict({ 强度: '0.01', 最后强化: daysAgo(1), 深度: '语义', 类型: '记忆', 距离: '按需' }, NOW)))
      // 正控：同样强度、但已超半衰期（语义 120 天 > 90）→ 是候选
      ok('R-e7 判据第④条正控：强度 0.01 且 120 天前强化（超语义半衰期 90 天）→ 是候选',
        core.archiveVerdict({ 强度: '0.01', 最后强化: daysAgo(120), 深度: '语义', 类型: '记忆', 距离: '按需' }, NOW).candidate === true,
        JSON.stringify(core.archiveVerdict({ 强度: '0.01', 最后强化: daysAgo(120), 深度: '语义', 类型: '记忆', 距离: '按需' }, NOW)))
    }

    // ══ R-f：「过期候选」执行时拒绝（候选算完后条目被强化）══
    //   场景：盘点算出候选 → 期间该条被 recall 命中强化（reinforce.log 追加）→
    //         此时再执行归档，必须重新校验、拒绝并说明原因。
    {
      const { box, csv, lock } = newLib()
      const logPath = join(box, 'reinforce.log')
      // 造一条超龄条目（初始是候选）
      const oldId = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: mk({ 内容: '超龄条目', 时间: '2024-01-01', 最后强化: '2024-01-01', 深度: '情景' }) })
      // 造完候选之后：追加一条强化记录（模拟被 recall 命中）
      core.appendReinforceLog({ logPath, id: oldId, project: '通用', day: '2026-10-25', reinforce: true })
      // 现在执行归档——带 logPath 时应重新合并日志再判，发现已强化 → 拒绝
      const r = core.archiveEntry({
        schema: schema0, csvPath: csv, lockPath: lock, logPath,
        targetId: oldId, status: '已归档', requireCandidate: true,
      })
      ok('R-f1 过期候选：候选算完后被强化 → 执行归档时拒绝',
        r.ok === false, JSON.stringify(r))
      ok('R-f2 拒绝原因说清「已不满足归档判据」（不是笼统失败）',
        /判据|候选|强度|强化|过期/.test(String(r.error ?? '')), String(r.error))
      ok('R-f3 拒绝后文件一个字节没动',
        (() => {
          const t = readRows(csv)
          const row = t.rows.find((x) => String(x[0]).trim() === oldId)
          return String(row?.[t.header.indexOf('状态')]).trim() === '生效'
        })())
      // 反控：没有强化记录时，同样这条能被正常归档
      {
        const { csv: csv2, lock: lock2 } = newLib()
        const oldId2 = core.appendEntry({ schema: schema0, csvPath: csv2, lockPath: lock2,
          row: mk({ 内容: '超龄条目2', 时间: '2024-01-01', 最后强化: '2024-01-01', 深度: '情景' }) })
        const r2 = core.archiveEntry({
          schema: schema0, csvPath: csv2, lockPath: lock2, logPath: join(box, 'none.log'),
          targetId: oldId2, status: '已归档', requireCandidate: true,
        })
        ok('R-f4 反控：确实是候选（无强化记录）→ 归档放行', r2.ok === true, JSON.stringify(r2))
      }
    }

    // ══ R-g：强制复核=true 的主子手动放行路径 ══
    //   判据不过时，主子可以显式 `强制复核=true` 放行（手动确认「我知道它不是候选」）。
    //   必须：① 不带强制 → 拒绝；② 带强制 → 放行；③ 强制放行也要拍快照。
    {
      const { csv, lock } = newLib()
      // 一条刚写的（不是候选）
      const fresh = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: mk({ 内容: '刚写的条目', 时间: '2026-10-25', 最后强化: '2026-10-25' }) })
      const rNoForce = core.archiveEntry({
        schema: schema0, csvPath: csv, lockPath: lock,
        targetId: fresh, status: '已归档', requireCandidate: true,
      })
      ok('R-g1 不是候选且未强制 → 拒绝', rNoForce.ok === false, JSON.stringify(rNoForce))
      ok('R-g2 拒绝文案提示可用「强制复核」手动放行',
        /强制复核|force|手动/.test(String(rNoForce.error ?? '')), String(rNoForce.error))
      const rForce = core.archiveEntry({
        schema: schema0, csvPath: csv, lockPath: lock,
        targetId: fresh, status: '已归档', requireCandidate: true, force: true,
      })
      ok('R-g3 强制复核=true → 放行成功', rForce.ok === true, JSON.stringify(rForce))
      ok('R-g4 强制放行也拍了快照', typeof rForce.snapshot === 'string' && rForce.snapshot !== '')
      const t = readRows(csv)
      ok('R-g5 强制放行后状态确实是已归档',
        String(t.rows.find((x) => String(x[0]).trim() === fresh)?.[t.header.indexOf('状态')]).trim() === '已归档')
    }

    // ══ R-h：memory_archive 工具（智能体只提交建议清单）══
    {
      const { box, csv, lock } = newLib()
      const logPath = join(box, 'reinforce.log')
      // 造三条：两条超龄候选 + 一条新的非候选
      const c1 = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: mk({ 内容: '候选一', 时间: '2024-01-01', 最后强化: '2024-01-01', 深度: '情景' }) })
      const c2 = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: mk({ 内容: '候选二', 时间: '2024-01-01', 最后强化: '2024-01-01', 深度: '情景' }) })
      const nope = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: mk({ 内容: '非候选', 时间: '2026-10-25', 最后强化: '2026-10-25' }) })

      // ① 建议清单格式：工具接受 {类型:'归档建议', 条目:[{id, 理由}]}
      const plan = [
        { id: c1, 理由: '强度 0.00，情景档超 400 天' },
        { id: c2, 理由: '强度 0.00，情景档超 400 天' },
        { id: nope, 理由: '误以为该归档' },
      ]
      const r = core.archiveBatch({
        schema: schema0, csvPath: csv, lockPath: lock, logPath,
        items: plan, status: '已归档', requireCandidate: true,
      })
      ok('R-h1 memory_archive 接受建议清单格式（items 数组）', r.ok === true, JSON.stringify(r).slice(0, 200))
      ok('R-h2 逐条返回结果（每条有 id + 成功/失败 + 原因）',
        Array.isArray(r.results) && r.results.length === 3 &&
        r.results.every((x) => typeof x.id === 'string' && typeof x.ok === 'boolean'),
        JSON.stringify(r.results ?? []).slice(0, 300))
      // ② 部分成功语义：两条候选成功、一条非候选被拒
      const okIds = (r.results ?? []).filter((x) => x.ok === true).map((x) => x.id)
      const failIds = (r.results ?? []).filter((x) => x.ok === false).map((x) => x.id)
      ok('R-h3 部分成功：两条候选成功归档', okIds.length === 2 && okIds.includes(c1) && okIds.includes(c2), JSON.stringify(okIds))
      ok('R-h4 部分成功：非候选那条被拒（不是整批回滚，也不是全放行）',
        failIds.length === 1 && failIds.includes(nope), JSON.stringify(failIds))
      ok('R-h5 被拒那条说明理由', (r.results ?? []).find((x) => x.id === nope)?.error !== '')
      // ③ 部分成功不破坏数据：成功的确实归档了、被拒的仍是生效
      const t = readRows(csv)
      const st = (id) => String(t.rows.find((x) => String(x[0]).trim() === id)?.[t.header.indexOf('状态')]).trim()
      ok('R-h6 成功的两条状态=已归档', st(c1) === '已归档' && st(c2) === '已归档')
      ok('R-h7 被拒的那条状态仍=生效（没被顺手归档）', st(nope) === '生效')
      ok('R-h8 行数不变（三条还是三条）', t.rows.length === 3, String(t.rows.length))
    }

    // ══ R-i：迁移接线端到端（17 列库启动 → 快照 → 21 列、数据行逐字节不动）══
    {
      const { box, csv, lock } = newLib()
      // 造一个 17 列老库
      const H17 = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
      const rows17 = [
        'M-20260101-001,老条目甲,2026-01-01,e,r,,稳定,语义,按需,角色,通用,生效,,,v1,推断,记忆',
        'M-20260101-002,老条目乙,2025-01-01,e,r,,稳定,情景,常驻,角色,通用,生效,,,v1,推断,记忆',
      ]
      writeFileSync(csv, H17 + '\n' + rows17.join('\n') + '\n', 'utf8')
      const dataLinesBefore = readFileSync(csv, 'utf8').split('\n').slice(1).filter(Boolean)

      // 迁移前：能读（legacyWidth 容忍）
      const t0 = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
      ok('R-i1 迁移前：17 列老库能读，且老行不算 ragged',
        t0.header.length === 17 && t0.ragged.length === 0, `header=${t0.header.length} ragged=${t0.ragged.length}`)

      // 启动时自动迁移（阿栈应实现 ensureMigrated 或在 store 初始化里调）
      const snapDir = join(box, 'snapshots')
      const mig = core.migrateHeader({ schema: schema0, csvPath: csv, lockPath: lock })
      ok('R-i2 迁移：表头 17→21', mig.ok === true && mig.changed === true && mig.before === 17 && mig.after === 21, JSON.stringify(mig))
      ok('R-i3 迁移：**数据行逐字节不动**',
        JSON.stringify(readFileSync(csv, 'utf8').split('\n').slice(1).filter(Boolean)) === JSON.stringify(dataLinesBefore))
      ok('R-i4 迁移幂等：再迁一次 changed=false',
        core.migrateHeader({ schema: schema0, csvPath: csv, lockPath: lock }).changed === false)

      // 迁移后新写入带 4 新列
      const newId = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: mk({ 内容: '迁移后新写', 时间: '2026-10-25' }) })
      const t1 = readRows(csv)
      const newRow = t1.rows.find((x) => String(x[0]).trim() === newId)
      ok('R-i5 迁移后新写入行是 21 格', newRow.length === 21, String(newRow.length))
      ok('R-i6 新行带 4 个新列且默认值正确',
        String(newRow[t1.header.indexOf('强度')]) === '1' &&
        String(newRow[t1.header.indexOf('使用次数')]) === '0' &&
        String(newRow[t1.header.indexOf('已验证项目')]) === '',
        JSON.stringify({ 强度: newRow[t1.header.indexOf('强度')], 使用次数: newRow[t1.header.indexOf('使用次数')] }))
      ok('R-i7 迁移后老行（17 格）仍不算 ragged', readRows(csv).ragged.length === 0)
    }

    // ══ R-i2：**启动路径**真的接线了（不是只有函数能调）══
    //   上面 R-i 验的是 `migrateHeader()` 这个函数本身；这一条验的是
    //   「插件启动时会不会自己发现老库、自己快照、自己升表头」——
    //   P1-1 的原话就是「migrateHeader 只在 selftest 里调，没接启动路径」。
    //   用子进程起一份全新 store，模拟真实启动。
    {
      const box = mkdtempSync(join(tmpdir(), 'tm-v4-mig-'))
      const skill = join(box, 'skill')
      mkdirSync(join(skill, 'references'), { recursive: true })
      mkdirSync(join(skill, 'store'), { recursive: true })
      copyFileSync(join(PKG, 'lib', 'engine', 'tags.schema.json'), join(skill, 'references', 'tags.schema.json'))
      const H17 = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
      writeFileSync(join(skill, 'store', 'memory.csv'),
        H17 + '\nM-20260101-001,老条目甲,2026-01-01,e,r,,稳定,语义,按需,角色,通用,生效,,,v1,推断,记忆\n', 'utf8')
      writeFileSync(join(skill, 'store', 'index.md'), '# i\n')
      const beforeLines = readFileSync(join(skill, 'store', 'memory.csv'), 'utf8').split('\n').slice(1)

      const script = `
        const { pathToFileURL } = require('node:url')
        ;(async () => {
          const store = await import(pathToFileURL(${JSON.stringify(join(PKG, 'lib', 'store.mjs'))}).href)
          console.log('MIG ' + JSON.stringify(store.migrationInfo()))
        })()
      `
      const r = spawnSync(process.execPath, ['-e', script],
        { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: skill }, encoding: 'utf8' })
      const info = JSON.parse((r.stdout.match(/MIG (\{.*\})/) ?? [])[1] ?? '{}')
      ok('R-i2 启动时自己检测到 17 列老库（needed=true）', info.needed === true, JSON.stringify(info))
      ok('R-i2 启动时自动完成迁移（migrated=true）', info.migrated === true, JSON.stringify(info))
      ok('R-i2 迁移前**自动拍了快照**（不是裸改库）',
        typeof info.snapshot === 'string' && info.snapshot !== '' &&
        existsSync(join(skill, 'store', 'snapshots', info.snapshot)), String(info.snapshot))
      const afterText = readFileSync(join(skill, 'store', 'memory.csv'), 'utf8')
      ok('R-i2 启动迁移后表头是 21 列', afterText.split('\n')[0].split(',').length === 21)
      ok('R-i2 启动迁移后数据行逐字节不动',
        JSON.stringify(afterText.split('\n').slice(1)) === JSON.stringify(beforeLines))
      // 正控：21 列的库再启动一次不该再迁（幂等）
      const r2 = spawnSync(process.execPath, ['-e', script],
        { env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: skill }, encoding: 'utf8' })
      const info2 = JSON.parse((r2.stdout.match(/MIG (\{.*\})/) ?? [])[1] ?? '{}')
      ok('R-i2 正控：已经是 21 列 → 第二次启动不再迁移（needed=false）',
        info2.needed === false && info2.migrated === false, JSON.stringify(info2))
      rmSync(box, { recursive: true, force: true })
    }

    // ══ R-j：supersede 保留深度/新列（报告 §七 验收用例照抄）══
    //   旧缺陷：supersede 用列名做键取值，但 row 用字典名传 → 深度等字段丢失。
    {
      const { csv, lock } = newLib()
      const oldId = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        row: mk({ 内容: '待取代的旧条', 深度: '程序', 距离: '常驻', 项目: '测试文件夹', 关键词: '旧词' }) })
      const before = readRows(csv)
      const oldRow = before.rows.find((x) => String(x[0]).trim() === oldId)
      // ⚠️ 这里**不能**用 mk() 造 row：mk 会带出 `深度:语义 / 距离:按需 / 项目:通用` 等默认值，
      // 而「取代」的语义是「没给的字段沿用旧条」——把默认值传进去等于**明确要覆盖**，
      // 于是旧条的 程序/常驻/测试文件夹 被覆盖成 语义/按需/通用，用例自己把前提破坏了。
      // 真实路径（preset.js 的 memory_supersede）只传调用方显式给的非空字段，
      // 所以这里也只传「内容」——这才是 P1-2 要验的那个场景。
      const sup = core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock,
        targetId: oldId, row: { 内容: '取代后的新条' } })
      ok('R-j1 取代成功', sup.ok === true, JSON.stringify(sup))
      const after = readRows(csv)
      const newRow = after.rows.find((x) => String(x[0]).trim() === sup.id)
      const col = (name) => newRow[after.header.indexOf(name)]
      ok('R-j2 **深度被保留**（旧条 程序 → 新条也是程序）', String(col('成熟度')).trim() === '程序', String(col('成熟度')))
      ok('R-j3 距离被保留（常驻）', String(col('距离')).trim() === '常驻', String(col('距离')))
      ok('R-j4 项目被保留（测试文件夹）', String(col('项目')).trim() === '测试文件夹', String(col('项目')))
      ok('R-j5 4 个新列有默认值（不是空串）',
        String(col('强度')).trim() !== '' && String(col('使用次数')).trim() !== '' && String(col('最后强化')).trim() !== '',
        JSON.stringify({ 强度: col('强度'), 使用次数: col('使用次数'), 最后强化: col('最后强化') }))
      ok('R-j6 旧行逐字节没变（追加式取代）',
        JSON.stringify(oldRow) === JSON.stringify(before.rows.find((x) => String(x[0]).trim() === oldId)))
      ok('R-j7 新行备注带「取代：旧id」',
        String(col('备注')).includes(`取代：${oldId}`), String(col('备注')))
    }


    // ══ R-k：P0-2 强度默认值三态（空串 / 缺失列 / 有值）══
    //   实锤缺陷：`Number('') === 0`，且 `Number.isFinite(0) === true`、`0 >= 0 === true`，
    //   于是「17 列老库没有强度列 → 默认 1」被算成 0，全库强度归零。
    //   后果：真库 51 条生效条目里 32 条被误判成归档候选（62.7%），任何触发方式的归档都是误杀。
    //   位置：lib/engine/core.mjs `applyReinforceLog()` 的 csvStrength/base0 两行。
    {
      const NOW = new Date('2026-10-25T00:00:00')
      // 三态：老库（列不存在 / 空串）应默认 1；有值照实；真 0 仍是 0
      const strengthOf = (o) => {
        const merged = core.applyReinforceLog(
          o, (x, n) => (x[n] ?? ''), undefined,
        )
        return Number(merged.强度)
      }
      ok('R-k1 三态·空串（17 列老库无强度列）→ 强度默认 1（不是 0）',
        strengthOf({ 强度: '', 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' }) === 1,
        String(strengthOf({ 强度: '', 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' })))
      ok('R-k2 三态·键缺失（undefined）→ 强度默认 1',
        strengthOf({ 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' }) === 1,
        String(strengthOf({ 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' })))
      ok('R-k3 三态·有值 1 → 强度 1（不被默认值顶掉）',
        strengthOf({ 强度: '1', 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' }) === 1)
      ok('R-k4 三态·有值 0.5 → 强度 0.5（照实读，不修正成 1）',
        strengthOf({ 强度: '0.5', 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' }) === 0.5,
        String(strengthOf({ 强度: '0.5', 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' })))
      ok('R-k5 三态·有值 0（真的该归档）→ 仍是 0，不被默认值救回来',
        strengthOf({ 强度: '0', 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' }) === 0,
        String(strengthOf({ 强度: '0', 最后强化: '2026-10-01', 深度: '语义', 类型: '记忆', 距离: '按需' })))

      // 端到端：17 列老库盘点候选必须为 0（条目都是新的）
      {
        const H17 = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
        const { box: b2, csv: c2 } = newLib()
        writeFileSync(c2, H17 + '\nM-20260101-001,新条目,2026-10-24,e,r,,稳定,语义,按需,角色,通用,生效,,,v1,推断,记忆\n', 'utf8')
        const t = core.readTable(readFileSync(c2, 'utf8'), core.legacyWidthOf(schema0))
        const inv = core.reviewInventory({ schema: schema0, header: t.header, rows: t.rows, logMap: new Map(), now: NOW })
        ok('R-k6 **17 列老库、条目才 1 天新 → 盘点候选必须为 0**（当前实锤是误报）',
          inv.衰减候选.length === 0, `候选 ${inv.衰减候选.length} 条`)
      }
      // 端到端：21 列新库正常
      {
        const { csv: c3, lock: l3 } = newLib()
        const id3 = core.appendEntry({ schema: schema0, csvPath: c3, lockPath: l3,
          row: mk({ 内容: '新库条目', 时间: '2026-10-24' }) })
        const t = core.readTable(readFileSync(c3, 'utf8'), core.legacyWidthOf(schema0))
        const inv = core.reviewInventory({ schema: schema0, header: t.header, rows: t.rows, logMap: new Map(), now: NOW })
        ok('R-k7 21 列新库、条目 1 天新 → 盘点候选为 0（正常路径不被误伤）',
          inv.衰减候选.length === 0, `候选 ${inv.衰减候选.length} 条`)
      }
      // 端到端：老库超龄条目**仍应**被识别为候选（修完不能把真候选也修没了）
      {
        const H17 = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
        const { csv: c4 } = newLib()
        writeFileSync(c4, H17 + '\nM-20240101-001,超龄条目,2024-01-01,e,r,,稳定,情景,按需,角色,通用,生效,,,v1,推断,记忆\n', 'utf8')
        const t = core.readTable(readFileSync(c4, 'utf8'), core.legacyWidthOf(schema0))
        const inv = core.reviewInventory({ schema: schema0, header: t.header, rows: t.rows, logMap: new Map(), now: NOW })
        ok('R-k8 反控：17 列老库、超龄条目（2024-01-01）→ **仍应**是候选（修完不能把真候选修没）',
          inv.衰减候选.length === 1, `候选 ${inv.衰减候选.length} 条`)
      }
      // 端到端：常驻/固定豁免在老库上也生效（当前 bug 下失效）
      {
        const H17 = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
        const { csv: c5 } = newLib()
        writeFileSync(c5, H17 + '\nM-20240101-001,超龄常驻,2024-01-01,e,r,,稳定,情景,常驻,角色,通用,生效,,,v1,推断,记忆\n', 'utf8')
        const t = core.readTable(readFileSync(c5, 'utf8'), core.legacyWidthOf(schema0))
        const inv = core.reviewInventory({ schema: schema0, header: t.header, rows: t.rows, logMap: new Map(), now: NOW })
        ok('R-k9 反控：17 列老库、超龄但距离=常驻 → 不是候选（豁免在老库上也要生效）',
          inv.衰减候选.length === 0, `候选 ${inv.衰减候选.length} 条`)
      }
    }

  } catch (e) {
    fail++
    results.push(`FAIL  R. P0 归档安全 — ${String(e?.stack ?? e)}`)
  }

  // ── S. P1-3 判重口径：读写两侧的「退场」必须是同一个集合 ─────────────
  //     这节的由来：变异自查时把 `findDuplicate` 里的反查剔除，**436 条一条都没红**——
  //     说明 P1-3 的修复当时没有任何断言钉住。补在这里。
  try {
    const core = store.getCore()
    const schema0 = store.loadSchema()
    const box = mkdtempSync(join(tmpdir(), 'tm-p13-'))
    const csv = join(box, 'memory.csv')
    writeFileSync(csv, readFileSync(join(PKG, 'lib', 'engine', 'templates', 'memory.csv')))
    const lock = join(box, '.lock')
    const mkRow = (c) => ({ 内容: c, 环境: 'e', 原因: 'r', 类型: '记忆', 深度: '语义',
      稳定性: '稳定', 距离: '按需', 依据: '推断', 项目: '通用', 角色: 'selftest' })

    const oldId = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mkRow('同一个结论') })
    core.supersedeEntry({ schema: schema0, csvPath: csv, lockPath: lock, targetId: oldId, row: { 内容: '同一个结论（更新版）' } })

    // ① 旧条已被取代（读侧看不到它了）→ 写同样内容**不该**被拦
    let wroteSame = null
    let errSame = ''
    try { wroteSame = core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mkRow('同一个结论') }) }
    catch (e) { errSame = String(e?.message ?? e) }
    ok('S-1 已退场的旧条不再阻塞判重（写同内容能进去）',
      wroteSame !== null && wroteSame !== '', errSame.slice(0, 60))
    ok('S-1 而且不会报「库里已经有了」这种误导性理由',
      !/库里已经有了/.test(errSame))

    // ② 对照：与**生效中**的条目同内容 → 必须被拦（判重没失效）
    let errLive = ''
    try { core.appendEntry({ schema: schema0, csvPath: csv, lockPath: lock, row: mkRow('同一个结论（更新版）') }) }
    catch (e) { errLive = String(e?.message ?? e) }
    ok('S-2 正控：与生效中的条目同内容仍被拦（判重本身没被改坏）',
      /库里已经有了/.test(errLive), errLive.slice(0, 60))

    // ③ 口径归一的结构锚点：findDuplicate 与 filterRows 用的是同一个 supersededIds
    const t = core.readTable(readFileSync(csv, 'utf8'), core.legacyWidthOf(schema0))
    const dead = core.supersededIds(t.header, t.rows)
    ok('S-3 被取代的旧 id 在反查集合里（读写共用这一个集合）', dead.has(oldId), [...dead].join(','))
    rmSync(box, { recursive: true, force: true })
  } catch (e) { fail++; results.push(`FAIL  P1-3 判重口径 — ${String(e?.message ?? e)}`) }

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
