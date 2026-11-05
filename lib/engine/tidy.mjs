/**
 * tidy.mjs — 整理链路的纯逻辑层
 *
 * 边界（《接口契约》§一）：
 *   ✅ 纯判定与纯复制：算"该不该改、改成什么"，返回 changes 列表
 *   ❌ 不写文件、不备份、不加锁 —— 那是宿主（index.js）的编排职责
 *   ❌ 不 import 任何 Cordis 东西
 *
 * 依据：
 *   · 《流程_整理》§5.4 稳定性三态演进（feedback 驱动）
 *   · 《流程_整理》§2.4 升通用强判定（≥4 不同身份/项目 + 语义相似）
 *   · 《流程_整理》§四 归纳（≥3 独立场合）
 *   · 《流程_整理》§三 只许改 6 个标签字段，编号/主要内容/时距 不可改
 */

/** 只允许整理修改的字段（《流程_整理》§三）。 */
export const TIDY_EDITABLE = ['形态', '项目', '智能体', '自由标签', '稳定性', '状态'];

/** 绝不允许修改的字段。 */
export const TIDY_IMMUTABLE = ['编号', '主要内容', '时距'];

/**
 * 从 read.jsonl 的调用序列，反推每条记忆的 feedback 累计。
 *
 * v1 不做实时回填（《流程_整理》§5.4）：整理时读调用序列判定。
 *   命中且被采纳 → ok
 *   命中却未被采纳 / 之后同条件重查未命中 → wrong
 *   命中但没有任何后续动作 → unused
 *
 * @param {object[]} readLogs  read.jsonl 的行（从旧到新）
 * @param {object}   opts
 * @param {number}   opts.okThreshold   连续 ok 多少次算"稳定"（默认 3）
 * @returns {Map<string, {ok:number, wrong:number, unused:number, lastTs:string}]}
 *          编号 → 累计反馈
 */
export function foldFeedback(readLogs, opts = {}) {
  const out = new Map();
  const logs = Array.isArray(readLogs) ? readLogs : [];

  for (const entry of logs) {
    if (!entry || !Array.isArray(entry.hits)) continue;
    const fb = Array.isArray(entry.feedback) ? entry.feedback : [];
    const ts = entry.ts || '';

    // 该次召回实际返回的编号
    const hitIds = entry.hits.map((h) => (typeof h === 'string' ? h : h && h['编号'])).filter(Boolean);

    for (const id of hitIds) {
      const slot = out.get(id) || { ok: 0, wrong: 0, unused: 0, lastTs: '' };
      // 显式 feedback 优先；没有就按"命中即视为被采纳"保守记 ok
      // （v1 的近似：整理环节没有更好的信号源，宁可少降级不可误降级）
      const record = fb.find((f) => f && f.id === id);
      const verdict = record && record.verdict ? record.verdict : 'ok';
      if (verdict === 'ok') slot.ok += 1;
      else if (verdict === 'wrong') slot.wrong += 1;
      else slot.unused += 1;
      if (ts > slot.lastTs) slot.lastTs = ts;
      out.set(id, slot);
    }

    // near 里反复出现却没被采纳 → 疑似 wrong（《流程_整理》§5.4 的反推口径）
    const near = Array.isArray(entry.near) ? entry.near : [];
    for (const n of near) {
      const id = typeof n === 'string' ? n : n && n['编号'];
      if (!id || hitIds.includes(id)) continue; // 命中过的不按 near 算
      const slot = out.get(id) || { ok: 0, wrong: 0, unused: 0, lastTs: '' };
      slot.wrong += 1;
      out.set(id, slot);
    }
  }

  return out;
}

/**
 * 稳定性状态机（《流程_整理》§5.4）。
 *
 * 观察 → 稳定：连续 ok ≥ okThreshold 且无 wrong
 * 任意 → 易变：wrong > 0
 * 易变 → 观察：本轮无 wrong（安静了就给一次自愈机会）
 *
 * @param {object} record    当前条目
 * @param {object} stats     foldFeedback 的结果
 * @param {object} config    { stableOkThreshold }
 * @returns {{next: string, reason: string}|null}  null = 不需要改
 */
export function nextStability(record, stats, config = {}) {
  const cur = record['稳定性'] || '观察';
  const threshold = Number(config.stableOkThreshold ?? 3);

  if (!stats) return null;

  const { ok = 0, wrong = 0 } = stats;

  // 有 wrong → 降易变（已易变则不动）
  if (wrong > 0) {
    if (cur === '易变') return null;
    return { next: '易变', reason: `feedback=wrong 累计 ${wrong} 次` };
  }

  // 无 wrong 且 ok 足够 → 升稳定（已稳定则不动）
  if (ok >= threshold) {
    if (cur === '稳定') return null;
    return { next: '稳定', reason: `连续 ok ${ok} 次（阈值 ${threshold}），无 wrong` };
  }

  // 易变且安静 → 升回观察
  if (cur === '易变' && wrong === 0) {
    return { next: '观察', reason: '本轮无 wrong，自愈回观察' };
  }

  return null;
}

/**
 * 升通用判定（《流程_整理》§2.4）。
 *
 * 硬条件（同时满足）：
 *   1. ≥ minDistinct 个**不同**智能体（或项目）各有至少一条
 *   2. 语义相似度 > simThreshold（由模型判读后作为入参传入，程序不自己算语义）
 *   3. 原文重点内容一致（同上，模型判定）
 *
 * ⚠️ 程序只负责"数够不够 4 个"和"改哪个字段"；
 *    "是不是同一件事"由模型判读后通过 candidates 传进来。
 *
 * @param {object[]} candidates  [{ 编号, 主要内容, 项目, 智能体, sameCluster: boolean }]
 * @param {object}   opts        { minDistinct, dimension: '智能体'|'项目', windowDays }
 * @returns {{编号:string, field:string, from:string, to:'通用', basis:string}[]}
 */
export function planPromote(candidates, opts = {}) {
  const minDistinct = Number(opts.minDistinct ?? 4);
  const dimension = opts.dimension === '项目' ? '项目' : '智能体';
  const out = [];

  const list = Array.isArray(candidates) ? candidates : [];
  // 只保留模型判定为同一簇的
  const cluster = list.filter((c) => c && c.sameCluster === true);
  if (cluster.length === 0) return out;

  // 统计该维度上有多少个不同取值
  const distinct = new Set(
    cluster.map((c) => String(c[dimension] ?? '').trim()).filter((v) => v !== ''),
  );
  if (distinct.size < minDistinct) return out;

  // 只升**一个**字段（《流程_整理》§2.4：同时改两个 = 连升两级，不做）
  // 选编号最新的那条作为升格对象，其余靠后续整理归并
  const sorted = cluster.slice().sort((a, b) => String(b['编号']).localeCompare(String(a['编号'])));
  const target = sorted[0];
  const from = String(target[dimension] ?? '');
  if (!from || from === '通用') return out;

  out.push({
    编号: String(target['编号']),
    field: dimension,
    from,
    to: '通用',
    basis: `同一内容被 ${distinct.size} 个不同${dimension}独立写入（≥${minDistinct}），判定为通用`,
  });
  return out;
}

/**
 * 归纳判定（《流程_整理》§四）。
 *
 * 至少 minOccasions 个**独立场合**才谈得上归纳。
 * 独立场合 = 不同会话/整理批次（这里按 write.jsonl 的 ts 日期分组近似）。
 *
 * ⚠️ 归纳**只能由整理触发创建**，写入时不可建。
 *    本函数只给出"够不够格"，真正的归纳条内容由模型写。
 *
 * @param {object[]} writeLogs  write.jsonl 的行
 * @param {object}   opts       { minOccasions, sameClusterOf: (a,b)=>boolean }
 * @returns {{cluster:object[], occasions:number, eligible:boolean}[]}
 */
export function planInduction(writeLogs, opts = {}) {
  const minOccasions = Number(opts.minOccasions ?? 3);
  const logs = Array.isArray(writeLogs) ? writeLogs : [];

  // 只统计成功写入
  const okLogs = logs.filter((l) => l && l.ok === true);
  if (okLogs.length < minOccasions) return [];

  // 按"同一天"作为场合的近似（同一天内多次提及只算 1 个场合）
  const byDay = new Map();
  for (const l of okLogs) {
    const day = String(l.ts || '').slice(0, 10);
    if (!day) continue;
    const arr = byDay.get(day) || [];
    arr.push(l);
    byDay.set(day, arr);
  }

  const occasions = byDay.size;
  return [
    {
      cluster: okLogs,
      occasions,
      eligible: occasions >= minOccasions,
    },
  ];
}

/**
 * 校验整理动作是否越界（《流程_整理》§三：编号/主要内容/时距 不可改）。
 *
 * @param {object} patch  想改的字段
 * @returns {{ok:boolean, violations:string[]}}
 */
export function validateTidyPatch(patch) {
  const violations = [];
  if (!patch || typeof patch !== 'object') return { ok: false, violations: ['patch 不是对象'] };

  for (const key of Object.keys(patch)) {
    if (TIDY_IMMUTABLE.includes(key)) violations.push(`${key} 不可改（一手材料 / 唯一标识 / 程序计数器）`);
    else if (!TIDY_EDITABLE.includes(key)) violations.push(`${key} 不在可整理字段范围内`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 汇总整理计划：把上面各判定合成为一份"要做的事"列表。
 *
 * @returns {{changes: object[], proposals: object[], report: object}}
 *   changes   —— 有依据、可直接执行
 *   proposals —— 无依据或需人判，只提议不改
 */
export function planTidy(input = {}) {
  const {
    records = [],
    readLogs = [],
    writeLogs = [],
    config = {},
  } = input;

  const feedback = foldFeedback(readLogs, config);
  const changes = [];
  const proposals = [];

  // ---- 1) 稳定性 ----
  for (const rec of records) {
    const id = rec['编号'];
    if (!id) continue;
    const stats = feedback.get(id);
    if (!stats) continue;
    const step = nextStability(rec, stats, config);
    if (step) {
      changes.push({
        编号: id,
        field: '稳定性',
        before: rec['稳定性'] || '观察',
        after: step.next,
        basis: `read.jsonl feedback：${step.reason}`,
      });
    }
  }

  // ---- 2) 升通用（需模型先判同一簇；这里只处理已标记的）----
  const promoteCandidates = (input.promoteCandidates || []).map((c) => {
    const rec = records.find((r) => r && r['编号'] === c['编号']);
    return rec ? { ...c, 项目: rec['项目'], 智能体: rec['智能体'], 主要内容: rec['主要内容'] } : null;
  }).filter(Boolean);

  if (promoteCandidates.length > 0) {
    for (const dim of ['智能体', '项目']) {
      const planned = planPromote(promoteCandidates, {
        minDistinct: config.promoteMinDistinct,
        dimension: dim,
      });
      changes.push(...planned);
    }
  }

  // ---- 3) 归纳（只提议，不自动建条）----
  const induction = planInduction(writeLogs, { minOccasions: config.inductionMinOccasions });
  for (const it of induction) {
    if (it.eligible) {
      proposals.push({
        kind: 'induction',
        说明: `${it.occasions} 个独立场合出现同类内容，可考虑归纳为一条`,
        occasions: it.occasions,
      });
    }
  }

  // ---- 4) 报告 ----
  const report = {
    条目总数: records.length,
    read记录数: readLogs.length,
    write记录数: writeLogs.length,
    feedback覆盖条目数: feedback.size,
    changes: changes.length,
    proposals: proposals.length,
  };

  return { changes, proposals, report };
}
