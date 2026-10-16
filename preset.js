// preset.js —— 每个智能体的那一半：字典注入 + 两个工具
//
// 挂载方式（加进 profile 补丁那一层；`install.mjs --wire-presets` 会把这一段写好）：
//   - insert:
//       - id: tag-memory-preset
//         name: 'dsh-tag-memory/preset'
//         config:
//           agent: '某某'        # 写进 `角色` 列；不填则依次取 preset 目录名、智能体 id
//           libraryDir: '…'      # 记忆库在哪；不填则取环境变量 DSH_TAG_MEMORY_SKILL_DIR、再取默认位置
//
// 挂在 **profile 平面**（与 `dsh-tools` / `dsh-system-prompt` 平级）＝ 该 profile 下所有智能体
// 都有字典段与那两个工具；挂在某个 preset 的 plugins 里＝只有那一个智能体有。
//
// 贡献两样，都绑定到**这一个**智能体：
//   1. systemPrompt.section —— 「标签字典」段，**函数值，每轮重读**。这是两段式架构里
//      「第一段：模型读字典、自己判断」的落地。内容字节恒定（省缓存）。
//   2. 两个工具 —— 两段式架构里「第二段：程序执行」：
//        memory_write  收字典名字段 → 四道门槛(模型侧) + 字典校验 + 文件锁取号 + 追加一行
//        memory_recall 收结构化条件（与/或/非/留白/多值/区间）→ 执行筛选 → 先报总数，再取前 3
//
// 读写逻辑**不在这里**，全部 import 自技能那份 lib/core.mjs（一份逻辑，不分叉）。

import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CSV_PATH,
  LOCK_PATH,
  cwdOf,
  getCore,
  loadSchema,
  projectName,
  ready,
  resolveAgentId,
  setLibraryDir,
  SKILL_DIR,
} from './lib/store.mjs'

export const name = 'tag-memory-preset'

/** `systemPrompt` 供字典段，`tools` 供两个工具。 */
export const inject = ['systemPrompt', 'tools']

/** 记忆库没就位时，给模型一句可执行的提示，而不是空段。 */
function degradedNotice() {
  return [
    '## 记忆库未就绪',
    `> 没找到记忆库目录（找的是 \`${SKILL_DIR}\`）。`,
    '> 记忆写入 / 召回不可用；请把记忆库放到该位置，或用 config 的 `libraryDir`（或环境变量 `DSH_TAG_MEMORY_SKILL_DIR`）指定它的位置。',
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
  // 库目录：配置优先；没配就是原来的推断链（环境变量 → 默认），一个字节都不变。
  setLibraryDir(config.libraryDir)

  const schema = (() => { try { return loadSchema() } catch { return null } })()

  // ① 字典段：函数值 → 每轮重读；内容恒定 → 缓存友好。
  ctx.systemPrompt.section({
    name: 'tag-memory:dict',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: () => dictText(),
  })

  // ② 写
  ctx.tools.register(
    defineTool({
      name: 'memory_write',
      description: [
        '往标签记忆库追加一条记忆（只追加，永不改写已有条目）。',
        '写之前先自己过四道门槛：① 环境写不清就别写；② 只记正向结论（失败只记最终正确的做法）；③ 成功经验/用户要求直接记；④ 不记临时进度、一次性中间结果。',
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
          return `✗ 未写入：${String(e?.message ?? e)}`
        }
      },
    }),
  )

  // ③ 读
  ctx.tools.register(
    defineTool({
      name: 'memory_recall',
      description: [
        '按多维标签召回记忆。先把条件写成 JSON 放进「条件」。',
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
