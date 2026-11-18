/**
 * pick-tidy-candidates.mjs — 挑出「需要整理」的候选条目（纯逻辑层）
 *
 * ── 边界 ──────────────────────────────────────────────────────────
 *   ✅ 只按**规则**挑，不判语义。
 *      「这两条是不是同一件事」是模型的活，程序只按内容相似度报「疑似」。
 *   ✅ 纯逻辑：无 IO、无框架依赖，可单测。
 *   ✅ 只考虑「生效」条目（被取代/已归档的不需要再整理）。
 *
 * ── 四类问题（对应方案 §4.1）────────────────────────────────────
 *   ① empty-tags   空标签：除浏览外永远召不回，最优先
 *   ② noise-tags   标签全是噪声（纯数字/单字/来源标记/超长），形同空标签
 *   ③ empty-shape  形态为空
 *   ④ duplicate    主要内容高度相似 → 只报「疑似组」，不判合并
 *
 * 依据：《整理合并-复制提示词方案-2026-11-16.md》§4.1
 */

import { isUsefulTag, countTags, resolveExclusions } from './vocab.mjs';

/** 问题类型（按严重度排序，先显示最要紧的）。 */
export const ISSUE_TYPES = Object.freeze([
  'empty-tags',
  'noise-tags',
  'empty-shape',
  'duplicate',
]);

const ISSUE_LABELS = Object.freeze({
  'empty-tags': '空标签',
  'noise-tags': '噪声标签',
  'empty-shape': '形态为空',
  duplicate: '疑似重复',
});

/**
 * 挑候选。
 *
 * @param {object} args
 * @param {object[]} args.records      全库记录
 * @param {number} [args.limit=20]     最多返回几条
 * @param {number} [args.duplicateThreshold=0.9]  内容 Jaccard 相似度阈值
 * @param {number} [args.commonTopN=10] 泛词频次表取前几个（喂给模型避开）
 * @param {object} [args.tagRules]     free-tag-rules.json 的 write 段（用于排除名单）
 * @returns {{
 *   candidates: Array<{编号,形态,主要内容,自由标签:string[],问题:string[],摘要:string}>,
 *   stats: { total, active, byIssue:object, duplicateGroups:number, commonWords:Array<[string,number]> },
 *   truncated: boolean
 * }}
 */
export function pickTidyCandidates({
  records,
  limit = 20,
  duplicateThreshold = 0.9,
  commonTopN = 10,
  tagRules,
} = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError(`pickTidyCandidates: records 必须是数组，实际收到 ${typeof records}。`);
  }

  const active = records.filter((r) => String(r?.['状态'] ?? '').trim() === '生效');
  // 来源标记（原话/推断/转述…）只有在带上排除名单时才会被判为噪声。
  // 用 resolveExclusions 合并「内置名单 + 配置追加」，而不是自己造空 Set ——
  // 空 Set 会让 `原话` 被当成有效标签，噪声条目就漏挑了（实测踩到）。
  const excludes = resolveExclusions(tagRules);

  // 泛词频次（只数生效条目）→ 给模型看「哪些词已被用滥」
  const { counts } = countTags(active, { excludes });
  const commonWords = [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, Math.max(0, Number(commonTopN) || 0));

  // ── 逐条标问题 ──
  const issuesById = new Map();
  const add = (id, issue) => {
    if (!issuesById.has(id)) issuesById.set(id, []);
    const arr = issuesById.get(id);
    if (!arr.includes(issue)) arr.push(issue);
  };

  for (const r of active) {
    const id = String(r?.['编号'] ?? '').trim();
    if (id === '') continue;
    const tags = normalizeTags(r?.['自由标签']);
    const shape = String(r?.['形态'] ?? '').trim();

    if (tags.length === 0) add(id, 'empty-tags');
    else if (tags.every((t) => !isUsefulTag(t, { excludes }))) add(id, 'noise-tags');
    if (shape === '') add(id, 'empty-shape');
  }

  // ── 疑似重复：内容 Jaccard（纯字符串，不判语义）──
  const dupGroups = findDuplicateGroups(active, duplicateThreshold);
  for (const g of dupGroups) {
    for (const id of g.ids) add(id, 'duplicate');
  }

  // ── 组装候选，按「问题数 + 严重度」排序 ──
  const byIssue = {};
  for (const k of ISSUE_TYPES) byIssue[k] = 0;

  const rows = [];
  for (const r of active) {
    const id = String(r?.['编号'] ?? '').trim();
    const issues = issuesById.get(id);
    if (!issues || issues.length === 0) continue;
    for (const it of issues) byIssue[it] += 1;

    const content = String(r?.['主要内容'] ?? '').trim();
    rows.push({
      编号: id,
      形态: String(r?.['形态'] ?? '').trim(),
      自由标签: normalizeTags(r?.['自由标签']),
      问题: issues.slice().sort((a, b) => ISSUE_TYPES.indexOf(a) - ISSUE_TYPES.indexOf(b)),
      问题标签: issues.map((i) => ISSUE_LABELS[i] ?? i).join('、'),
      摘要: summarize(content, 80),
    });
  }

  rows.sort((a, b) => {
    // 问题多的在前；同数量按最严重问题的序号
    if (b['问题'].length !== a['问题'].length) return b['问题'].length - a['问题'].length;
    const wa = ISSUE_TYPES.indexOf(a['问题'][0]);
    const wb = ISSUE_TYPES.indexOf(b['问题'][0]);
    if (wa !== wb) return wa - wb;
    return a['编号'].localeCompare(b['编号']);
  });

  // limit <= 0 表示「不截断」（默认 20）。用显式判断，别让 `|| 0` 把语义吞掉。
  const cap = Number(limit);
  const unlimited = !Number.isFinite(cap) || cap <= 0;
  const truncated = !unlimited && rows.length > cap;
  const candidates = unlimited ? rows : rows.slice(0, cap);

  return {
    candidates,
    stats: {
      total: records.length,
      active: active.length,
      byIssue,
      duplicateGroups: dupGroups.length,
      commonWords,
    },
    truncated,
  };
}

/** 标签可能是数组，也可能是 CSV 里的 '|' 串。 */
function normalizeTags(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split('|');
  return arr.map((t) => String(t ?? '').trim()).filter(Boolean);
}

/** 摘要：取前 n 字，去掉换行和多余空白。 */
function summarize(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

/**
 * 内容相似度分组（Jaccard on 字符 bigram）。
 *
 * 为什么用 bigram 而不是「完全相同」：真实库里两条讲同一件事常常差几个字
 * （标点、末尾补一句）。但**只报组，不判合并**——是不是同一件事由模型读完再定。
 */
export function findDuplicateGroups(records, threshold = 0.9) {
  const items = records
    .map((r) => {
      const id = String(r?.['编号'] ?? '').trim();
      const content = String(r?.['主要内容'] ?? '').trim();
      return id && content ? { id, content, grams: bigrams(content) } : null;
    })
    .filter(Boolean);

  // ⚠️ 必须用**并查集**，不能用「拿第一条逐个比」的链式贪心。
  // 实测反例：A≈B、B≈C，但 A 与 C 字面差得多（相似度略低于阈值）——
  // 链式贪心会把 C 漏掉，只报 2 条一组。并查集把它们正确归成 1 组 3 条。
  const parent = items.map((_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nxt = parent[x];
      parent[x] = r;
      x = nxt;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (jaccard(items[i].grams, items[j].grams) >= threshold) union(i, j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(items[i].id);
  }
  return [...byRoot.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ ids }));
}

function bigrams(s) {
  const set = new Set();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
  if (t.length === 1) set.add(t);
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 人读的问题标签（渲染提示词表格用）。 */
export function issueLabel(issue) {
  return ISSUE_LABELS[issue] ?? issue;
}
