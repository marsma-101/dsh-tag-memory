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
 * @param {string}   opts.sinceTs       只统计该时间戳之后的召回（开窗，默认 ''=全量）。
 *                                      2026-11-12 P1-1：wrong 若按全历史累计永远 >0，
 *                                      「易变→观察」自愈分支永远不可达，一次 near 终身易变。
 *                                      整理方传入「上次整理以来」的窗口即可让自愈生效。
 * @returns {Map<string, {ok:number, wrong:number, unused:number, lastTs:string}]}
 *          编号 → 累计反馈
 */
export function foldFeedback(readLogs, opts = {}) {
  const out = new Map();
  const logs = Array.isArray(readLogs) ? readLogs : [];
  const sinceTs = String(opts.sinceTs ?? '');

  for (const entry of logs) {
    if (!entry || !Array.isArray(entry.hits)) continue;
    const ts = entry.ts || '';
    // 开窗：只统计 sinceTs 之后的召回（字符串比较，ISO 时间戳单调）
    if (sinceTs !== '' && ts <= sinceTs) continue;
    const fb = Array.isArray(entry.feedback) ? entry.feedback : [];

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

    // near 里出现却没被命中：**无显式信号时记 unused，不记 wrong**（2026-11-12 P1-1）。
    // 旧实现把 near 一律当 wrong，于是「标签打得多→常落 near→被降易变」，
    // 规范的多标签条目反而受罚，且 wrong 历史累计永远 >0 让自愈不可达。
    // near 只是「擦边、没够上门槛」，不是「被验证为错」——只有显式 feedback.verdict=wrong
    // 才是降级信号。这里若该条有显式 wrong 反馈才记 wrong，否则记 unused。
    const near = Array.isArray(entry.near) ? entry.near : [];
    for (const n of near) {
      const id = typeof n === 'string' ? n : n && n['编号'];
      if (!id || hitIds.includes(id)) continue; // 命中过的不按 near 算
      const slot = out.get(id) || { ok: 0, wrong: 0, unused: 0, lastTs: '' };
      const record = fb.find((f) => f && f.id === id);
      if (record && record.verdict === 'wrong') slot.wrong += 1;
      else slot.unused += 1;
      if (ts > slot.lastTs) slot.lastTs = ts;
      out.set(id, slot);
    }
  }

  return out;
}

/**
 * 稳定性状态机（《流程_整理》§5.4）。
 *
 * **升格的第一前提是「用过一段时间」，不是「一次都没错」。**
 * 时距（被召回次数）就是「用了多久」的量化：只被召回 1 次就说它稳定，
 * 那是把「没被检验过」当成「检验通过」——所以升格必须同时满足时距门槛。
 *
 * 观察 → 稳定：`时距 >= stableMinTick` **且** 连续 ok ≥ okThreshold 且无 wrong
 * 任意 → 易变：wrong > 0（降格不看时距——错了就是错了，越早降越好）
 * 易变 → 观察：本轮无 wrong（安静了就给一次自愈机会）
 *
 * ⚠️ 时距只卡升格，不卡降格。降格要快（防污染），升格要慢（防误升）。
 *
 * @param {object} record    当前条目
 * @param {object} stats     foldFeedback 的结果
 * @param {object} config    { stableOkThreshold, stableMinTick }
 * @returns {{next: string, reason: string}|null}  null = 不需要改
 */
export function nextStability(record, stats, config = {}) {
  const cur = record['稳定性'] || '观察';
  const threshold = Number(config.stableOkThreshold ?? 3);
  // 时距门槛：默认 3。被召回 ≥3 次才算「用过一段时间」，
  // 一次命中就升稳定会把「运气好」当成「已验证」。
  const minTick = Number(config.stableMinTick ?? 3);
  const tick = Number(record['时距'] ?? 0) || 0;

  if (!stats) return null;

  const { ok = 0, wrong = 0 } = stats;

  // 有 wrong → 降易变（已易变则不动）。降格不看时距：错了就该立刻降。
  if (wrong > 0) {
    if (cur === '易变') return null;
    return { next: '易变', reason: `feedback=wrong 累计 ${wrong} 次` };
  }

  // 无 wrong 且 ok 足够 且 **时距够** → 升稳定
  if (ok >= threshold) {
    if (cur === '稳定') return null;
    if (tick < minTick) {
      // 反馈够了但还没用够久 → 不升，留在观察继续积累时距。
      // 这不是"拒绝"，是"还不够"，所以不产生 change（返回 null）。
      return null;
    }
    return {
      next: '稳定',
      reason: `时距 ${tick}（门槛 ${minTick}）+ 连续 ok ${ok} 次（阈值 ${threshold}），无 wrong`,
    };
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

  // ⚠️ 即使成功写入很少也要返回结构（eligible=false），
  // 不能直接 return []：调用方需要区分「没有数据」和「有数据但不够格」，
  // 否则报告里永远看不到"差几个场合"这种可行动信息。
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
      needed: minOccasions,
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

  // ---- 4) 拆库拆表判定（《流程_整理》§5.5）----
  // 只提议不自动拆：拆库是不可逆的结构变更，必须人确认。
  const split = planSplit(records, input.splitConfig || {});
  if (split.shouldSplit) {
    proposals.push({
      kind: 'split',
      说明: split.reason,
      建议: split.suggestion,
      metrics: split.metrics,
    });
  }

  // ---- 5) 报告 ----
  const report = {
    条目总数: records.length,
    read记录数: readLogs.length,
    write记录数: writeLogs.length,
    feedback覆盖条目数: feedback.size,
    changes: changes.length,
    proposals: proposals.length,
    需要拆库: split.shouldSplit,
  };

  return { changes, proposals, report };
}

/**
 * 拆库拆表判定（《流程_整理》§5.5）。
 *
 * 三个触发条件（任一满足即建议拆）：
 *   ① 条目数超过条目阈值（默认 2000）
 *   ② 单个项目的条目数占比过高（默认 >60%）—— 说明该项目的记忆已经压倒性多
 *   ③ 自由标签重复度过高（默认 >85%）—— 说明标签区分度丧失
 *
 * ⚠️ 只给建议，不自动执行。拆库是不可逆的结构变更，必须人确认。
 *
 * @param {object[]} records
 * @param {object}   cfg     { maxEntries, projectDominance, tagDuplication }
 * @returns {{shouldSplit:boolean, reason:string, suggestion:string, metrics:object}}
 */
export function planSplit(records, cfg = {}) {
  const list = Array.isArray(records) ? records : [];
  const maxEntries = Number(cfg.maxEntries ?? 2000);
  const projectDominance = Number(cfg.projectDominance ?? 0.6);
  const tagDuplication = Number(cfg.tagDuplication ?? 0.85);

  const metrics = {
    条目数: list.length,
    条目数阈值: maxEntries,
    最大项目占比: 0,
    占比阈值: projectDominance,
    标签重复度: 0,
    重复度阈值: tagDuplication,
  };

  if (list.length === 0) {
    return { shouldSplit: false, reason: '库为空', suggestion: '', metrics };
  }

  // ② 项目集中度
  const byProject = new Map();
  for (const r of list) {
    const p = String(r['项目'] ?? '').trim();
    byProject.set(p, (byProject.get(p) || 0) + 1);
  }
  let maxCount = 0;
  let maxProject = '';
  for (const [p, c] of byProject) {
    if (c > maxCount) {
      maxCount = c;
      maxProject = p;
    }
  }
  metrics.最大项目占比 = Number((maxCount / list.length).toFixed(3));

  // ③ 标签重复度：以「不同标签组合数 / 条目数」衡量区分度。
  // 重复度 = 1 - 区分度。全库标签组合越雷同，重复度越高。
  const combos = new Map();
  for (const r of list) {
    const tags = Array.isArray(r['自由标签']) ? r['自由标签'] : [];
    const key = tags.slice().sort().join('|');
    combos.set(key, (combos.get(key) || 0) + 1);
  }
  const distinctRatio = combos.size / list.length;
  metrics.标签重复度 = Number((1 - distinctRatio).toFixed(3));

  const reasons = [];
  if (list.length >= maxEntries) {
    reasons.push(`条目数 ${list.length} 已达阈值 ${maxEntries}`);
  }
  if (metrics.最大项目占比 >= projectDominance && maxProject) {
    reasons.push(`项目「${maxProject}」占 ${Math.round(metrics.最大项目占比 * 100)}%（阈值 ${Math.round(projectDominance * 100)}%）`);
  }
  if (metrics.标签重复度 >= tagDuplication) {
    reasons.push(`标签重复度 ${Math.round(metrics.标签重复度 * 100)}%（阈值 ${Math.round(tagDuplication * 100)}%）`);
  }

  if (reasons.length === 0) {
    return { shouldSplit: false, reason: '各项指标都在阈值内', suggestion: '', metrics };
  }

  // 建议按主导项目切分（或不指定，交给人的判断）
  const suggestion = maxProject
    ? `建议按「项目」维度切分，把「${maxProject}」单独成库`
    : '建议按「项目」或「自由标签」维度切分';

  return {
    shouldSplit: true,
    reason: reasons.join('；'),
    suggestion,
    metrics,
  };
}

