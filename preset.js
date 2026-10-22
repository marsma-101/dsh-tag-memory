// preset.js —— 每个智能体的那一半：字典注入 + 两个工具
//
// 挂载方式（加进 profile 补丁那一层；`install.mjs --wire-presets` 会把这一段写好）：
//   - insert:
//       - id: tag-memory-preset
//         name: 'dsh-tag-memory/preset'
//         config:
//           agent: '某某'        # 写进 `角色` 列；不填则依次取 preset 目录名、智能体 id
//           dataDir: '…'        # 数据目录（记忆库放哪）；不填则取环境变量 DSH_TAG_MEMORY_DATA_DIR、再取 <DSH_HOME>/tag-memory
//                                # （旧字段名 libraryDir 仍认，等价）
//           snapshot:            # 每轮注入「记忆快照」的预算。提示词是硬成本，值都可调
//             enabled: true      # 关掉就退回「只注入字典」
//             maxPinned: 6       #   常驻条目最多放几条全文
//             maxBodyChars: 4000 #   全部全文条目的字数上限（常驻优先占）
//             maxIndexLines: 40  #   索引行上限
//
// 挂在 **profile 平面**（与 `dsh-tools` / `dsh-system-prompt` 平级）＝ 该 profile 下所有智能体
// 都有字典段与那两个工具；挂在某个 preset 的 plugins 里＝只有那一个智能体有。
//
// 贡献两样，都绑定到**这一个**智能体：
//   1. systemPrompt.section —— 「标签字典 + 记忆快照」段，**函数值，每轮重读**。这是两段式架构里
//      「第一段：模型读字典、自己判断」的落地；快照部分带上「这个项目现在能用上的条目」，
//      让记忆**不用去查就在眼前**。
//   2. 两个工具 —— 两段式架构里「第二段：程序执行」：
//        memory_write  收字典名字段 → 四道门槛(模型侧) + 字典校验 + 文件锁取号 + 追加一行
//        memory_recall 收结构化条件（与/或/非/留白/多值/区间）→ 执行筛选 → 先报总数，再取前 3
//
// 读写逻辑**不在这里**，全部 import 自插件内置的 `lib/engine/core.mjs`（一份逻辑，不分叉）。
// 引擎随插件走（`lib/engine/`），数据在独立的数据目录里——插件升级不碰库。

import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CSV_PATH,
  DATA_DIR,
  LOCK_PATH,
  cwdOf,
  getCore,
  loadSchema,
  projectName,
  ready,
  resolveAgentId,
  setDataDir,
} from './lib/store.mjs'
import { PresetConfig } from './lib/config.mjs'

export const name = 'tag-memory-preset'
/** Preset 行配置 schema：加载期校验 + 设置页表单描述。 */
export const Config = PresetConfig

/** `systemPrompt` 供字典段，`tools` 供两个工具。 */
export const inject = ['systemPrompt', 'tools']

/** 记忆库没就位时，给模型一句可执行的提示，而不是空段。 */
function degradedNotice() {
  return [
    '## 记忆库未就绪',
    `> 记忆库目录（找的是 \`${DATA_DIR}\`）里没有 \`store/memory.csv\`，插件没能自动建出来。`,
    '> 记忆写入 / 召回不可用；可用 config 的 `dataDir`（或环境变量 `DSH_TAG_MEMORY_DATA_DIR`）指定位置，',
    '> 或检查那个目录是否可写——首次启动会用插件自带的模板建库。',
  ].join('\n')
}

function dictText() {
  if (!ready()) return degradedNotice()
  try {
    return getCore().renderDict(loadSchema())
  } catch (e) {
    return `## 记忆：字典渲染失败\n> ${String(e?.message ?? e)}`
  }
}

// ── 记忆快照（紧跟在字典后面，每次装配重读）──────────────
//
// 光有字典＝「桌上放着索引卡」：模型知道有本手册，但得**先想起去查**。快照把「现在能用上的
// 条目」直接摆在眼前，作用等价于「备忘录贴在显示器边上」。
//
// 分档的判据是「能不能直接用」——不是按重要性排，是按**适用边界**排：
//
//   常驻（`距离=常驻`，状态=生效）              → 全文。标了常驻就是「每轮必读」
//   通用 / 本项目（`项目=通用` 或 = 当前工作区名）→ 全文，受字数预算约束
//   其余（别的项目的条目）                       → **只给一行索引**：正文不进上下文
//   深藏（`距离=深藏`）                          → 同上，只给一行（`原文` 条一律是深藏）
//   被取代 / 已归档                              → 不出现
//
// 「别的项目只给一行」是**结构性闸门**，不是提示词劝阻：看得到的东西一定会被顺手用，
// 只给一行索引，等于把它降级成一条线索——想用就得先 `memory_recall` 取正文。
//
// 三档都是硬成本，全部可配（见文件头 `snapshot`）：超了按 `id` 倒序截断，并在段里**明说**
// 截了多少——宁可让模型知道「还有没放进来的」，也不要让它以为库里就这么多。

// 缺省取「保守档」：这是**每轮**都要付的 token 账。以一份约 150 条生效条目的库为例：
//   6 / 4000 / 40 → 约 9.7k 字符（≈6k tokens）；10 / 6000 / 60 → 约 13k 字符（≈8.1k tokens）；
//   5 / 2000 / 20 → 约 6.6k 字符（≈4.1k tokens）。嫌贵就往下调，嫌记不住就往上调。
const SNAPSHOT_DEFAULTS = { enabled: true, maxPinned: 6, maxBodyChars: 4000, maxIndexLines: 40 }

function snapshotConfig(config) {
  const s = (config && typeof config.snapshot === 'object' && config.snapshot) || {}
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : d)
  return {
    enabled: s.enabled !== false,
    maxPinned: num(s.maxPinned, SNAPSHOT_DEFAULTS.maxPinned),
    maxBodyChars: num(s.maxBodyChars, SNAPSHOT_DEFAULTS.maxBodyChars),
    maxIndexLines: num(s.maxIndexLines, SNAPSHOT_DEFAULTS.maxIndexLines),
  }
}

/**
 * 全文一条：首行带 id，续行缩进，末尾一行汇「环境 / 原因 / 依据」。
 *
 * **为什么必须带 `依据`**：这段文字进的是**系统提示词**，属高信任区。`依据=外部`
 * （从网页/文档抄来的）与 `依据=原话`（用户亲口说的）如果长得一模一样，模型就分不出
 * 哪条是用户的意思、哪条是外面捡来的——轻则按外部说法改用户的东西，重则外部文本里
 * 混的指令被当成用户指令执行。字典里「依据决定可信度」的合同，在这里不能断。
 *
 * 只在 `依据 != 原话` 时才标，省字数：原话是默认档，标出来的是「需要多看一眼」的。
 */
function snapshotFull(get, row) {
  const body = String(get(row, '内容') ?? '').split('\n')
  const lines = [`- [${get(row, 'id')}] ${body[0]}`]
  for (const l of body.slice(1)) if (String(l).trim() !== '') lines.push('  ' + l)
  const tail = []
  if (get(row, '环境')) tail.push(`环境：${get(row, '环境')}`)
  if (get(row, '原因')) tail.push(`原因：${get(row, '原因')}`)
  const basis = get(row, '依据')
  if (basis !== '' && basis !== '原话') tail.push(`依据：${basis}（非用户原话，采信前先核对）`)
  if (tail.length) lines.push('  ' + tail.join('｜'))
  return lines.join('\n')
}

/** 索引一行：够知道它存在，不够直接照做。外部来源的额外标一笔（同 snapshotFull 的理由）。 */
function snapshotIndex(get, row) {
  const where = get(row, '项目') || '未注明项目'
  const first = String(get(row, '内容') ?? '').split('\n')[0]
  const basis = get(row, '依据')
  const mark = basis === '外部' ? '〔外部〕' : ''
  return `- [${get(row, 'id')}] 在「${where}」：${mark}${first}`
}

/** 按 id 倒序（新写的在前）——库里 `id` 就带日期与序号，等价于写入次序。 */
const byIdDesc = (a, b) => String(b.id ?? '').localeCompare(String(a.id ?? ''))

/**
 * 渲染记忆快照正文。读不到库、库为空 → 返回空串（只注入字典，不占预算）。
 * `project` 是当前工作区文件夹名；拿不到（没有 cwd）时只有 常驻 / 通用 进全文档。
 */
function snapshotText(config, project) {
  const cfg = snapshotConfig(config)
  if (!cfg.enabled || !ready()) return ''

  const core = getCore()
  let schema, header, rows
  try {
    schema = loadSchema()
    const t = core.readTable(readFileSync(CSV_PATH, 'utf8'))
    header = t.header ?? []
    rows = t.rows ?? []
  } catch { return '' }

  const resolve = core.makeResolver(schema, header)
  const get = (row, name) => { const i = resolve(name); return i >= 0 ? String(row[i] ?? '') : '' }

  const live = rows
    .filter((r) => !['被取代', '已归档'].includes(get(r, '状态')))
    .map((r) => ({ row: r, id: get(r, 'id') }))
  if (live.length === 0) return ''

  const isPinned = (e) => get(e.row, '距离') === '常驻'
  const isHere = (e) => {
    const p = get(e.row, '项目')
    return p === '通用' || (project !== '' && p === project)
  }
  const pinned = live.filter(isPinned).sort(byIdDesc)
  const local = live.filter((e) => !isPinned(e) && isHere(e)).sort(byIdDesc)
  const rest = live.filter((e) => !isPinned(e) && !isHere(e)).sort(byIdDesc)

  const pinnedCut = pinned.slice(cfg.maxPinned) // 超过条数上限 → 只留索引
  const degraded = []                            // 字数预算内放不下 → 降级成索引
  let bodyChars = 0

  const renderFull = (list) => {
    const kept = []
    for (const e of list) {
      const text = snapshotFull(get, e.row)
      if (bodyChars + text.length > cfg.maxBodyChars) { degraded.push(e); continue }
      kept.push(text)
      bodyChars += text.length
    }
    return kept
  }

  // 常驻先占预算，剩下的给 本项目 / 通用。
  const pinnedKept = renderFull(pinned.slice(0, cfg.maxPinned))
  const localKept = renderFull(local)
  const fullCount = pinnedKept.length + localKept.length

  const indexAll = rest.concat(degraded, pinnedCut)
  const indexTop = indexAll.slice(0, cfg.maxIndexLines)

  const blocks = []
  if (pinnedKept.length) blocks.push('### 常驻（每轮必读，直接沿用）', '', pinnedKept.join('\n'), '')
  if (localKept.length) {
    blocks.push(`### 本项目 / 通用（相关即可直接用${project ? '；当前项目：' + project : ''}）`, '', localKept.join('\n'), '')
  }
  if (indexTop.length) {
    blocks.push(
      '### 其他项目 / 深藏（**只给索引，正文不在上下文里**）',
      '',
      '这些做法不构成本项目的默认选择——要用先 `memory_recall` 取正文；跨项目沿用前先向用户说明。',
      '',
      indexTop.map((e) => snapshotIndex(get, e.row)).join('\n'),
      '',
    )
  }

  const notes = []
  if (pinnedCut.length) notes.push(`常驻超过上限 ${cfg.maxPinned} 条，其中 ${pinnedCut.length} 条只留索引。`)
  if (degraded.length) notes.push(`全文预算（${cfg.maxBodyChars} 字）放不下 ${degraded.length} 条，已降为索引。`)
  if (indexAll.length > indexTop.length) notes.push(`索引还有 ${indexAll.length - indexTop.length} 条未列出，用 memory_recall 查。`)

  const parts = [
    '## 记忆快照（装配时重读；只放「能直接用」的，其余靠 memory_recall 查）',
    `> 当前项目：${project || '（未识别）'}｜生效 ${live.length} 条：全文 ${fullCount} 条 / 只索引 ${indexAll.length} 条`,
  ]
  if (notes.length) parts.push('', ...notes.map((n) => `> ${n}`))
  if (blocks.length) parts.push('', ...blocks)

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/** 注入给模型的整段：字典 + 记忆快照。快照为空时就是字典本身。 */
function injectText(config, project) {
  const dict = dictText()
  const snap = snapshotText(config, project)
  return snap === '' ? dict : dict + '\n\n---\n\n' + snap
}

// ── 召回结果渲染 ────────────────────────────────────────

function renderHits(core, schema, header, hits, { take, full }) {
  const resolve = core.makeResolver(schema, header)
  const show = (row, col) => { const i = resolve(col); return i >= 0 ? (row[i] || '') : '' }
  const n = hits.length
  const k = Math.min(take, n)
  const out = [`命中 ${n} 条${k < n ? `（显示前 ${k} 条）` : ''}`]
  for (const row of hits.slice(0, k)) {
    const body = (show(row, '内容') || '').split('\n')
    out.push('')
    out.push(`[${show(row, 'id')}] ${body[0]}`)
    if (full) {
      for (const line of body.slice(1)) out.push('   ' + line)
      out.push(`   环境: ${show(row, '环境')}`)
      out.push(`   原因: ${show(row, '原因')}`)
      if (show(row, '备注')) out.push(`   备注: ${show(row, '备注')}`)
      if (show(row, '关键词')) out.push(`   关键词: ${show(row, '关键词')}`)
    }
    out.push(`   类型=${show(row, '类型') || '—'} 深度=${show(row, '深度') || '—'} 稳定性=${show(row, '稳定性') || '—'} 距离=${show(row, '距离') || '—'}`)
    out.push(`   项目=${show(row, '项目') || '—'} 角色=${show(row, '角色') || '—'} 状态=${show(row, '状态') || '—'} 依据=${show(row, '依据') || '—'} 时间=${show(row, '时间')}`)
  }
  if (k < n) out.push(`\n另有 ${n - k} 条命中未展开（要看得加「全部」或提高「取几条」）。`)
  return out.join('\n')
}

/** 全文兜底搜：任一单元格含关键词即命中（排除 被取代/已归档）。 */
function keywordSearch(schema, header, rows, kw) {
  const idx = (c) => header.indexOf(c)
  const statusIdx = idx('状态')
  const needle = kw.toLowerCase()
  return rows.filter((r) => {
    if (statusIdx >= 0) { const s = r[statusIdx] || ''; if (s === '被取代' || s === '已归档') return false }
    return r.some((c) => String(c).toLowerCase().includes(needle))
  })
}

// ── 挂载 ────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  // 数据目录：配置优先（`dataDir`，兼容旧名 `libraryDir`）；没配就是推断链
  // （环境变量 → 旧环境变量 → <DSH_HOME>/tag-memory）。空目录会当场按模板建库。
  //
  // **「没配」不再覆盖已配好的目录**（P0-1）：host 行配了 `dataDir=A`、这一行没配时，
  // 这里 `apply()` 不会再把目录重置回默认（以前会，且不报错）。
  // 两半配了不同的值 → `setDataDir` 当场抛，这里只**记一笔再抛**，绝不吞掉。
  try {
    setDataDir(config.dataDir ?? config.libraryDir, 'preset 行')
  } catch (e) {
    try { ctx.logger?.error?.(`[tag-memory-preset] ${String(e?.message ?? e)}`) } catch { /* logger 不可用则忽略 */ }
    throw e
  }

  const schema = (() => { try { return loadSchema() } catch { return null } })()

  // ① 注入段：字典 + 记忆快照。函数值 → 每轮重读；库不变则字节不变 → 缓存友好。
  //    快照按「当前工作区」切片，所以这里必须接 `context`（拿得到调用方智能体与会话）。
  ctx.systemPrompt.section({
    name: 'tag-memory:dict',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: (context) => injectText(config, projectName(cwdOf(context?.agent))),
  })

  // ② 写
  ctx.tools.register(
    defineTool({
      name: 'memory_write',
      description: [
        '往标签记忆库追加一条记忆（只追加，永不改写已有条目）。',
        '写之前先自己过四道门槛：① 环境写不清就别写；② 只记正向结论（失败只记最终正确的做法）；③ 成功经验/用户要求直接记；④ 不记临时进度、一次性中间结果。',
        '【必须写·立刻写·不必问用户】以下任一发生就当场写，不要等被提醒：'
          + '① 用户确认或否决了一个方案（「就这么办」「不对，应该 X」「可以」「不行」）；'
          + '② 用户在权衡后做了决定；③ 讨论得出明确方向（即使方向是你提的）；'
          + '④ 发现了非显而易见的坑、边界情况、踩过的雷；⑤ 确立了约定/工作流/命名规则/端口号/路径；'
          + '⑥ 用户表达了偏好或约束（喜欢什么、讨厌什么、以后都这样）；⑦ 摸清了某台机器或某个环境的硬信息。',
        '【收尾自检】每完成一件事、准备给出最终答复之前，自问一句：这一轮上面七条有没有中？中了就先写，再答复。',
        `【类型】原文=原话原文；记忆=提炼的结论；固定=本机/外部硬信息（文件在哪、装在哪）。`,
        `【深度】仅当 类型=记忆 时填：情景=具体事件；语义=一般规律；程序=做法。其余情况留白。`,
        `【稳定性】稳定=不会变；观察=拿不准；易变=会变（版本/端口/临时状态）。`,
        `【距离】常驻=每轮优先提请；按需=相关时才读；深藏=基本不读。`,
        `【依据】必填：原话=用户亲口；推断=你归纳/实测；外部=抄来的。`,
        '项目默认填当前工作区文件夹名（跨项目通用才填「通用」）；角色默认填你自己。',
      ].join(' '),
      parameters: {
        内容: { type: 'string', required: true, description: '一句话结论（可多行）。' },
        环境: { type: 'string', required: true, description: '这条在什么条件下成立。写不清就先别记。' },
        原因: { type: 'string', required: true, description: '为什么要记它。' },
        类型: { type: 'string', required: true, description: "'原文' | '记忆' | '固定'" },
        深度: { type: 'string', description: "'情景' | '语义' | '程序'。仅 类型=记忆 时填，否则留空。" },
        稳定性: { type: 'string', description: "'稳定' | '观察' | '易变'" },
        距离: { type: 'string', description: "'常驻' | '按需' | '深藏'" },
        依据: { type: 'string', required: true, description: "'原话' | '推断' | '外部'" },
        项目: { type: 'string', description: '默认=当前工作区文件夹名；跨项目通用填「通用」。' },
        角色: { type: 'string', description: '默认=你自己（写入者）。' },
        关键词: { type: 'string', description: '兜底检索用，逗号分隔。可选。' },
        工具: { type: 'string', description: '涉及的工具名，如 python / git / dsh。可选。' },
        版本: { type: 'string', description: '冲突区分专用，一般留空。' },
        备注: { type: 'string', description: '特殊情况、限制、来源出处。可选。' },
        时间: { type: 'string', description: 'YYYY-MM-DD；默认今天。' },
      },
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
      async execute(args, exec) {
        if (!ready()) return degradedNotice()
        const core = getCore()
        const s = loadSchema()
        const agent = exec?.agent
        const agentId = resolveAgentId(config, agent)
        const proj = String(args.项目 ?? '').trim() || projectName(cwdOf(agent)) || '通用'

        const row = {
          内容: String(args.内容 ?? '').trim(),
          环境: String(args.环境 ?? '').trim(),
          原因: String(args.原因 ?? '').trim(),
          类型: String(args.类型 ?? '').trim(),
          深度: String(args.深度 ?? '').trim(),
          稳定性: String(args.稳定性 ?? '').trim(),
          距离: String(args.距离 ?? '').trim(),
          依据: String(args.依据 ?? '').trim(),
          项目: proj,
          角色: String(args.角色 ?? '').trim() || agentId,
          关键词: String(args.关键词 ?? '').trim(),
          工具: String(args.工具 ?? '').trim(),
          版本: String(args.版本 ?? '').trim(),
          备注: String(args.备注 ?? '').trim(),
          时间: String(args.时间 ?? '').trim(),
        }
        try {
          const id = core.appendEntry({ schema: s, csvPath: CSV_PATH, lockPath: LOCK_PATH, row })
          return `✓ 已追加 ${id}（库：${CSV_PATH}）`
        } catch (e) {
          // **必须抛异常，不能 return 一句「✗ …」**：返回字符串意味着 `isError=false`，
          // 模型与 PTCMode 都会当成「写成功了」——校验没过、去重被拦、拿不到锁，
          // 在调用方看来全都是成功。官方 `docs/cookbook/adding-a-tool.zh.md` 写明
          // 「基础设施故障请抛异常」；工具的 `render` 照样会把这句话呈现给人看。
          throw new Error(`未写入：${String(e?.message ?? e)}`)
        }
      },
    }),
  )

  // ③ 读
  ctx.tools.register(
    defineTool({
      name: 'memory_recall',
      description: [
        '按多维标签召回记忆。**上下文里已经有的不要再来查**——每轮注入的「记忆快照」里能直接看到的，直接用。',
        '这个工具是给「快照里没有的」用的：要展开只给了索引的条目、要按条件跨条筛、要翻本项目之外的历史。',
        '【必须先查再答·不要凭印象】出现下列任一情形，**先查记忆再回答**，不要跳过：'
          + '① 用户说「之前/上次/以前/我们不是定过/你还记得/继续上次」；'
          + '② 要开始做一件可能做过的事（同项目、同类任务）；'
          + '③ 用户提到一个你没有上下文的话题；'
          + '④ 要下判断、给方案、定规矩，而这个判断以前可能定过；'
          + '⑤ 用户纠正你或说「我早就说过」——立刻查，确认是漏读还是没记。',
        '【查的顺序】先看每轮注入的快照（里面能直接看到的直接用）→ 快照没有就调本工具 → 命中不够再用「关键词」兜底。',
        '先把条件写成 JSON 放进「条件」。',
        '【两段式】你只负责按字典把维度定下来、给程序去筛；不要自己心算结果。',
        '【条件语言】默认「与」；支持 {"或":[…]} / {"非":{…}} / {"深度":"留白"} / 多值 {"深度":["语义","程序"]} / 区间 {"时间":{"区间":["2026-10-01","2026-10-13"]}}。',
        '【白名单】某维取值「通用」的条目在任何条件下命中；【黑名单】留白默认不命中，只有显式筛「留白」才中。',
        '默认排除 状态=被取代/已归档（除非条件里显式提到「状态」）。',
        '【先报总数，再取前 3】：本工具已按此返回。命中太少 → 用「关键词」全文兜底搜。',
        '筛完 + 关键词搜完仍无命中 → 直说「记忆库里没有这条并说明筛了哪些维度」，不得拿常驻条目顶替。',
      ].join(' '),
      parameters: {
        条件: { type: 'string', description: '结构化条件（JSON）。空 = 全库（仍排除 被取代/已归档）。' },
        关键词: { type: 'string', description: '全文兜底搜：任一字段含此词即命中。可选。' },
        取几条: { type: 'number', description: '默认 3。' },
        全部: { type: 'boolean', description: 'true = 展开全部命中。' },
        详细: { type: 'boolean', description: 'true = 展开每条的环境/原因/备注等。' },
      },
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
      async execute(args) {
        if (!ready()) return degradedNotice()
        const core = getCore()
        const s = loadSchema()

        let cond = {}
        const raw = String(args.条件 ?? '').trim()
        if (raw !== '') {
          try { cond = JSON.parse(raw) } catch (e) { return `条件不是合法 JSON：${e.message}` }
          if (typeof cond !== 'object' || cond === null || Array.isArray(cond)) {
            return '条件必须是一个 JSON 对象，例如 {"深度":"语义"}。'
          }
        }
        const take = Number.isFinite(args.取几条) && args.取几条 > 0 ? Math.floor(args.取几条) : 3
        const full = args.详细 === true

        let header, hits
        try {
          const r = core.recallEntries({ schema: s, csvPath: CSV_PATH, cond })
          header = r.header; hits = r.hits
        } catch (e) {
          return `读库失败：${String(e?.message ?? e)}`
        }

        let note = ''
        const kw = String(args.关键词 ?? '').trim()

        // 关键词兜底：命中少于取几条时，合并全文搜结果
        if (kw !== '' && hits.length < take) {
          try {
            const { header: h2, rows: all } = core.readTable(readFileSync(CSV_PATH, 'utf8'))
            const extra = keywordSearch(s, h2, all, kw).filter((r) => !hits.some((x) => x[h2.indexOf('id')] === r[h2.indexOf('id')]))
            if (extra.length) {
              hits = hits.concat(extra)
              note = `（结构化条件命中不足，附加关键词「${kw}」全文搜到 ${extra.length} 条）`
            }
          } catch { /* 兜底失败不影响主结果 */ }
        }

        if (hits.length === 0) {
          return '记忆库里没有这条。已按你给的条件筛过；若条件为空，说明库中无有效条目。'
        }
        const body = renderHits(core, s, header, hits, { take: args.全部 === true ? hits.length : take, full })
        return note === '' ? body : note + '\n' + body
      },
    }),
  )
}
