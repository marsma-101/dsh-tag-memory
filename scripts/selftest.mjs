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
 *
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
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

const sandbox = mkdtempSync(join(tmpdir(), 'tagmem-selftest-'))

// ── 造沙箱技能：把真技能的 schema 与 core 复制过去，库换成自造小库 ──
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const DSH_HOME = process.env.DSH_HOME?.trim() || join(HOME, '.dsh')
const realSkill = process.env.DSH_TAG_MEMORY_SKILL_DIR?.trim() || join(DSH_HOME, 'skills', 'marsma101-tag-memory')

const sandboxSkill = join(sandbox, 'skill')
mkdirSync(join(sandboxSkill, 'references'), { recursive: true })
mkdirSync(join(sandboxSkill, 'scripts', 'lib'), { recursive: true })
mkdirSync(join(sandboxSkill, 'store'), { recursive: true })
copyFileSync(join(realSkill, 'references', 'tags.schema.json'), join(sandboxSkill, 'references', 'tags.schema.json'))
copyFileSync(join(realSkill, 'scripts', 'lib', 'core.mjs'), join(sandboxSkill, 'scripts', 'lib', 'core.mjs'))
copyFileSync(join(realSkill, 'scripts', 'lib', 'backup.mjs'), join(sandboxSkill, 'scripts', 'lib', 'backup.mjs'))

// 表头照真库首行（保持列顺序一致）；数据自造两条（含一条 已归档 供默认排除用）
const header = readFileSync(join(realSkill, 'store', 'memory.csv'), 'utf8').split('\n')[0]
const seed = [
  'M-20260101-001,自检件A,2026-01-01,selftest 沙箱,验证用,备注,稳定,语义,常驻,selftest,通用,生效,,,推断',
  'M-20260101-002,自检件B（已归档，不该被默认读到）,2026-01-01,selftest 沙箱,验证默认排除,,稳定,语义,深藏,selftest,通用,已归档,,,推断',
].join('\n')
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
    内容: '自检件C', 环境: 'selftest 沙箱', 原因: '验证 appendEntry',
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
  const fakeCtx = { logger: {}, on: () => () => {}, webServer: { register: (r) => routes.push(r) } }
  const dispose = indexMod.apply(fakeCtx, { presetRoot, notice: true })
  ok('index 挂上 /tag-memory-api（prefix）', routes.length === 1 && routes[0].path === '/tag-memory-api' && routes[0].kind === 'prefix')
  const call = async (op, method = 'GET', query = '') => {
    const res = mkRes()
    await routes[0].handler({ url: `/tag-memory-api${op}${query}`, method }, res)
    return { status: res.statusCode, json: JSON.parse(res.body) }
  }
  const ov = await call('/overview')
  ok('index /overview ready 且含维度计数', ov.status === 200 && ov.json.ready === true && !!ov.json.byDimension?.距离, Object.keys(ov.json.byDimension ?? {}).join(','))
  ok('index /overview 记忆文件列 3 个', ov.json.notice?.files?.length === 3, String(ov.json.notice?.files?.length))
  const en = await call('/entries', 'GET', '?cond=' + encodeURIComponent('{"角色":"selftest"}'))
  ok('index /entries 命中 2（A/C；B 已归档排除）', en.json.total === 2, String(en.json.total))
  const enD = await call('/entries', 'GET', '?cond=' + encodeURIComponent('{"角色":"assistant"}'))
  ok('index /entries 含 memory_write 落库项（角色=preset 目录名）', enD.json.total === 1, String(enD.json.total))
  const en2 = await call('/entries', 'GET', '?q=' + encodeURIComponent('自检件A'))
  ok('index /entries 关键词搜到 A（1 条）', en2.json.total === 1, String(en2.json.total))
  // P1：排序 / 分页 / 含已归档
  ok('index /overview 给出 状态 全集', Array.isArray(ov.json.statusValues) && ov.json.statusValues.join(',') === '生效,被取代,已归档', JSON.stringify(ov.json.statusValues))
  const own = '?cond=' + encodeURIComponent('{"角色":"selftest"}')
  const sAsc = await call('/entries', 'GET', `${own}&sort=id_asc`)
  const sDesc = await call('/entries', 'GET', `${own}&sort=id_desc`)
  ok('index /entries sort=id_asc 最早在前', sAsc.json.hits[0]?.id?.endsWith('-001') === true, sAsc.json.hits.map((h) => h.id).join(','))
  ok('index /entries 升/降序头条目相反', sAsc.json.hits[0].id !== sDesc.json.hits[0].id, `${sAsc.json.hits[0].id} vs ${sDesc.json.hits[0].id}`)
  const tDesc = await call('/entries', 'GET', `${own}&sort=time_desc`)
  ok('index /entries sort=time_desc 最新在前', tDesc.json.hits[0].时间 >= tDesc.json.hits[1].时间, tDesc.json.hits.map((h) => h.时间).join(','))
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
  const bk1 = await post('/backup', { label: '自检' })
  ok('index POST /backup 四项校验（字节/sha/记录数/BOM）全过',
    bk1.json.ok === true && bk1.json.result.checks.length === 4 && bk1.json.result.checks.every((c) => c.ok))
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

  const rst = await post('/restore', { stamp: stampA })
  ok('index POST /restore 整体替换成那一版（多出来的那条没了）',
    rst.json.ok === true && rst.json.entryCount === beforeBackup && countRows() === beforeBackup, JSON.stringify({ want: beforeBackup, got: rst.json.entryCount, file: countRows(), res: rst.json }))
  ok('index POST /restore 先把「恢复前那一版」留了档', typeof rst.json.preBackup === 'string' && rst.json.preBackup !== '')
  ok('index POST /restore 恢复前的那一版档里，条数是弄脏后的数',
    readFileSync(join(bkDir, `memory-${rst.json.preBackup}.csv`), 'utf8') !== '' &&
    core.readTable(readFileSync(join(bkDir, `memory-${rst.json.preBackup}.csv`), 'utf8')).rows.length === dirtyCount)

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

    // 目录选择走宿主：注册时把 pickDir / listDir 注入给组件（两个入口都要）。
    const faceMain = bySlot.main?.opts?.inject?.()
    const faceSet = bySlot['settings.section']?.opts?.inject?.()
    ok('main / settings.section 都注入 pickDir + listDir',
      typeof faceMain?.pickDir === 'function' && typeof faceMain?.listDir === 'function' &&
      typeof faceSet?.pickDir === 'function' && typeof faceSet?.listDir === 'function')
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

    const cards = render('settings.section', [ROW])
    ok('设置页默认仍是卡片（没有 table）', !cards.tags.includes('table') && cards.classes.includes('tm-item'))

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

  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  ok('package.json 导出 ./client 且声明 dsh.client', pkg.exports['./client'] === './client.js' && pkg.dsh?.client?.platform === 'web')
} catch (e) {
  fail++
  results.push(`FAIL  未捕获异常 — ${String(e?.stack ?? e)}`)
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(results.join('\n'))
console.log(`\n${fail === 0 ? 'SELFTEST OK' : `SELFTEST FAILED (${fail})`}   pass=${pass} fail=${fail} skip=${skip}`)
process.exit(fail === 0 ? 0 : 1)
