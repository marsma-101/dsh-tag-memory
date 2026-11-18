/**
 * parse-source.mjs — 外来记忆文件的格式嗅探与解析（纯逻辑层）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 旧的 dtm_merge 只能读「本插件九列 CSV」，别的智能体的 memory.md、
 * JSON 导出、纯文本清单一个都合不了。而用户要求「不论什么格式／什么软件／
 * 什么智能体的记忆文件，都要以记忆内容为主题」。
 *
 * 本文件只做**格式识别 + 拆成候选条目**，不做任何语义判断：
 *   · 这条在讲什么        → 模型
 *   · 该算什么形态        → 模型
 *   · 该打什么自由标签    → 模型
 * 程序只负责把「一段文本」变成「一组带来源元信息的候选」。
 *
 * ── 边界（硬约束）────────────────────────────────────────────────
 *   ✅ 纯逻辑：**不做 IO**。调用方（宿主方法）读好文本与文件名传进来。
 *      → 零框架依赖、可脱离宿主单测、不会因沙箱路径失败。
 *   ✅ 不吞异常：入参不对就抛，别把「读错了」伪装成「库里没有」。
 *   ✅ 不做 SQLite / 数据库直读：那要引入依赖，违反插件零运行时依赖约束。
 *      需要合并数据库时先导出成 CSV/JSON。
 *
 * 依据：《整理合并-复制提示词方案-2026-11-16.md》§3.2
 */

import { parseCsv, rowsToRecords } from './core.mjs';

/** 支持的格式标识 */
export const SOURCE_FORMATS = Object.freeze(['csv', 'markdown', 'json', 'text']);

/** 九列表头（判定「本插件 CSV」用）。从 schema 传进来更准，这里给兜底。 */
const DEFAULT_COLUMNS = ['编号', '主要内容', '形态', '项目', '智能体', '自由标签', '稳定性', '时距', '状态'];

/** JSON 里常见的「内容」键，按优先级排。 */
const CONTENT_KEYS = ['主要内容', 'content', 'text', 'memory', 'body', 'note', '笔记', '内容', 'summary', 'message'];

/** JSON 里常见的「标签」键。 */
const TAG_KEYS = ['自由标签', 'tags', 'labels', 'keywords', '标签'];

/** JSON 里常见的「归属」键。 */
const PROJECT_KEYS = ['项目', 'project', 'repo', 'workspace'];
const AGENT_KEYS = ['智能体', 'agent', 'identity', 'assistant', 'who'];
const SHAPE_KEYS = ['形态', 'shape', 'type', 'kind', 'category'];

/**
 * 嗅探格式。
 *
 * 判定顺序刻意是「表头 → 扩展名 → 首字符 → 兜底」：
 *   表头最可靠（CSV 也可能叫 .txt）；扩展名次之；
 *   首字符 { / [ 判 JSON 不可靠（Markdown 里也可能有），所以放在扩展名之后。
 *
 * @param {object} args
 * @param {string} args.text    文件全文
 * @param {string} [args.filename] 文件名（含扩展名，用于判 .md）
 * @param {string[]} [args.columns] 本插件九列表头
 * @returns {'csv'|'markdown'|'json'|'text'}
 */
export function sniffFormat({ text, filename = '', columns = DEFAULT_COLUMNS } = {}) {
  const t = String(text ?? '');
  const name = String(filename ?? '').toLowerCase();

  // ① 九列表头 → 本插件 CSV
  const firstLine = t.split(/\r?\n/)[0] ?? '';
  if (looksLikeOurHeader(firstLine, columns)) return 'csv';

  // ② 扩展名
  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.mdx')) return 'markdown';
  if (name.endsWith('.json') || name.endsWith('.jsonl')) return 'json';
  if (name.endsWith('.csv')) return 'csv';

  // ③ 首字符是 { 或 [ → 试着当 JSON（解析失败在 parse 阶段会退化为 text）
  const trimmed = t.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      /* 不是合法 JSON，继续往下走 */
    }
  }

  // ④ Markdown 特征：有 # 标题 或 - 列表
  if (/^#{1,6}\s/m.test(t) && /^[-*]\s/m.test(t)) return 'markdown';

  return 'text';
}

/** 首行是否含本插件的九列表头（顺序无关，缺一不可）。 */
function looksLikeOurHeader(line, columns) {
  if (typeof line !== 'string' || line === '') return false;
  // ⚠️ parseCsv(单行) 会把它当 header，rows 为空 —— 不能取 rows[0]。
  // 表头判定要用 header 本身。
  let cells;
  try {
    cells = parseCsv(line).header ?? [];
  } catch {
    cells = line.replace(/^\uFEFF/, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  }
  const set = new Set(cells.map((c) => String(c).trim()));
  return columns.every((c) => set.has(c));
}

/**
 * 把任意来源文本解析成「候选条目」。
 *
 * 统一输出形状（模型看到的都是这个）：
 *   { seq, raw, meta }
 *   · seq  1-based 序号，用于模型产出回填
 *   · raw  候选的**原始内容**（未加工，主题就是它）
 *   · meta { 项目, 智能体, 形态, 自由标签, 编号 } —— 来源里能拿到的原值，拿不到就空
 *
 * @param {object} args
 * @param {string} args.text
 * @param {string} [args.filename]
 * @param {object} [args.schema]  本插件 schema（解析自家 CSV 时用）
 * @param {'csv'|'markdown'|'json'|'text'} [args.format] 不传则自动嗅探
 * @returns {{
 *   format: string, candidates: Array, parsed: number,
 *   warnings: string[], exact: boolean
 * }}
 *   · exact=false 表示「按兜底方式切块，可能不准」——提示词里必须如实告知
 */
export function parseSource({ text, filename = '', schema, format } = {}) {
  const t = String(text ?? '');
  if (typeof text !== 'string') {
    throw new TypeError(`parseSource: text 必须是字符串，实际收到 ${typeof text}。`);
  }

  const fmt = format && SOURCE_FORMATS.includes(format) ? format : sniffFormat({ text: t, filename });
  const warnings = [];
  let candidates = [];
  let exact = true;

  switch (fmt) {
    case 'csv':
      candidates = parseOurCsv(t, schema);
      break;
    case 'markdown': {
      const md = parseMarkdown(t);
      candidates = md.candidates;
      if (!md.hasHeadings) {
        // 有 .md 扩展名但没一个真标题 → 整篇当一条，并如实标记「切分不精确」。
        // 只判 candidates.length===0 是错的：无标题时「前言」分支也会产出 1 条。
        exact = false;
        warnings.push(
          'Markdown 里没找到任何标题，已把整篇当作一条候选。切分可能不准，请自行核对是否需要拆分。',
        );
      }
      break;
    }
    case 'json':
      candidates = parseJson(t);
      break;
    case 'text':
    default:
      candidates = parsePlainText(t);
      exact = false;
      warnings.push(
        '未能识别为已知格式（CSV / Markdown / JSON），已按空行切块。' +
          '切分可能不准，请逐条核对；若原文是数据库导出，建议先转成 CSV/JSON 再合并。',
      );
      break;
  }

  // 统一编号 + 丢弃空内容（空块不是记忆）
  const cleaned = [];
  for (const c of candidates) {
    const raw = String(c?.raw ?? '').trim();
    if (raw === '') continue;
    cleaned.push({ seq: cleaned.length + 1, raw, meta: normalizeMeta(c?.meta) });
  }

  return {
    format: fmt,
    candidates: cleaned,
    parsed: cleaned.length,
    warnings,
    exact,
  };
}

function emptyMeta() {
  return { 编号: '', 项目: '', 智能体: '', 形态: '', 自由标签: [] };
}

function normalizeMeta(m) {
  const x = m && typeof m === 'object' ? m : {};
  const tags = Array.isArray(x['自由标签'])
    ? x['自由标签'].map((v) => String(v ?? '').trim()).filter(Boolean)
    : [];
  return {
    编号: String(x['编号'] ?? '').trim(),
    项目: String(x['项目'] ?? '').trim(),
    智能体: String(x['智能体'] ?? '').trim(),
    形态: String(x['形态'] ?? '').trim(),
    自由标签: tags,
  };
}

/* ------------------------------------------------------------------ *
 * 各格式解析
 * ------------------------------------------------------------------ */

/** 本插件九列 CSV：复用 core 的 rowsToRecords，保留归属原值（用户要求）。 */
function parseOurCsv(text, schema) {
  const sch = schema ?? { columns: DEFAULT_COLUMNS };
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch {
    return [];
  }
  let records;
  try {
    records = rowsToRecords(parsed, sch).records;
  } catch {
    return [];
  }
  const out = [];
  for (const rec of records ?? []) {
    const content = String(rec?.['主要内容'] ?? '').trim();
    if (content === '') continue;
    out.push({
      raw: content,
      meta: {
        编号: String(rec?.['编号'] ?? '').trim(),
        项目: String(rec?.['项目'] ?? '').trim(),
        智能体: String(rec?.['智能体'] ?? '').trim(),
        形态: String(rec?.['形态'] ?? '').trim(),
        自由标签: Array.isArray(rec?.['自由标签']) ? rec['自由标签'] : [],
      },
    });
  }
  return out;
}

/**
 * Markdown：按 `#`/`##` 标题切块，每块一条。
 *
 * 关键细节：**代码块（```）内不切** —— 代码里的 `# comment` 或 `#` 标题
 * 不是记忆条目。这是真实会踩的坑（Python/shell 注释大量以 # 开头）。
 */
function parseMarkdown(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let cur = null;
  let inFence = false;

  const push = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    if (body !== '') blocks.push({ title: cur.title, raw: body, meta: emptyMeta() });
    cur = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (cur) cur.lines.push(line);
      continue;
    }
    if (!inFence) {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) {
        push(); // 遇到新标题，收上一块
        cur = { title: m[2].trim(), lines: [] };
        continue;
      }
    }
    if (cur) cur.lines.push(line);
    else if (line.trim() !== '') {
      // 标题之前的前言内容：单独开一块（不丢内容）
      cur = { title: '（前言）', lines: [line] };
    }
  }
  push();

  // 有没有真标题：决定 exact（无标题 = 兜底切分，必须如实告知）
  const hasHeadings = blocks.some((b) => b.title !== '（前言）');

  // 标题本身是重要主题，拼进 raw 让模型看得见「这块讲什么」
  return {
    hasHeadings,
    candidates: blocks.map((b) => ({
      raw: b.title === '（前言）' ? b.raw : `【${b.title}】\n${b.raw}`,
      meta: emptyMeta(),
    })),
  };
}

/** JSON：找数组 → 逐元素取内容键；对象则当单条。 */
function parseJson(text) {
  let data;
  try {
    data = JSON.parse(String(text).trim());
  } catch {
    return [];
  }

  // 常见包装：{ memories: [...] } / { items: [...] } / { data: [...] }
  let list = data;
  if (!Array.isArray(list) && list && typeof list === 'object') {
    for (const k of ['memories', 'items', 'data', 'records', 'entries', 'memories_list', '列表', '记忆']) {
      if (Array.isArray(list[k])) { list = list[k]; break; }
    }
  }
  if (!Array.isArray(list)) list = [data];

  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') {
      out.push({ raw: item, meta: emptyMeta() });
      continue;
    }
    if (typeof item !== 'object') {
      out.push({ raw: String(item), meta: emptyMeta() });
      continue;
    }
    const content = pickFirst(item, CONTENT_KEYS);
    if (content === '') {
      // 没有内容键：把整个对象序列化当原文（不丢信息）
      out.push({ raw: JSON.stringify(item, null, 2), meta: readMeta(item) });
      continue;
    }
    out.push({ raw: content, meta: readMeta(item) });
  }
  return out;
}

/** 从对象里按候选键取第一个非空字符串。 */
function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/** 从 JSON 对象里读归属等元信息（原值，不加工）。 */
function readMeta(obj) {
  return {
    编号: String(obj['编号'] ?? obj.id ?? '').trim(),
    项目: pickFirst(obj, PROJECT_KEYS),
    智能体: pickFirst(obj, AGENT_KEYS),
    形态: pickFirst(obj, SHAPE_KEYS),
    自由标签: readTags(obj),
  };
}

/** 标签可能是数组，也可能是 '|' / ',' 分隔的字符串。 */
function readTags(obj) {
  for (const k of TAG_KEYS) {
    const v = obj[k];
    if (Array.isArray(v)) return v.map((s) => String(s ?? '').trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim() !== '') {
      return v.split(/[|,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/** 纯文本：按空行切块。exact=false，提示词里会明说可能不准。 */
function parsePlainText(text) {
  const chunks = String(text)
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks.map((raw) => ({ raw, meta: emptyMeta() }));
}

/** 把标签数组渲染成人读文本（提示词里展示来源标签用）。 */
export function renderTags(tags) {
  const arr = Array.isArray(tags) ? tags.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
  return arr.length > 0 ? arr.join('、') : '（无）';
}
