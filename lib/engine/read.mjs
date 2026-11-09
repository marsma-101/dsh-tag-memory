/**
 * read.mjs — 召回：标签归一 / 隔离硬筛 / 打分 / 三道闸门 / Top-K
 *
 * 依据：《流程_读取》全篇、《架构说明》§九/§十一、《接口契约》§三。
 *
 * 边界：只算，不落盘。返回「该写什么记录」（buildReadLog）+ 「该给谁 +1」（tickTargets）。
 *
 * ===================== 三道闸门·顺序不可逆 =====================
 *   ① 硬筛（状态=生效 AND 项目∈{通用,引入,当前} AND 智能体∈{通用,引入,当前}）
 *   ② 命中否决（条目侧 e_ratio > entryRatio；query 侧 q_ratio >= queryFloor）
 *   ③ 及格线（总分 >= passLine，出厂 40）
 * 顺序反了就会出现「先按分数捞、再否决」——那等于先污染再清理，规格明令禁止。
 *
 * ============ 两个取舍（Lead 2026-11-05 裁决，别改） ============
 * 1) 浏览模式（query 标签为空）**跳过命中否决，但不跳过及格线**。
 *    浏览「技能」时形态命中 50 >= 40，必然过线，不存在"被及格线滤掉"的问题。
 * 2) 已存条目「形态」为空时，浏览任何具体形态都返回不到（0 分被滤）——**这是设计本意，不是缺陷**。
 *    §4.3 说的"该形态下全部生效条目"不包括形态为空的条目。
 *    形态为空是**数据质量问题，由整理环节补形态修复**，读取环节不做特殊照顾。
 *
 * ============ e_ratio 的 0/0（裁决：定为 0 → 被否决） ============
 * 条目标签为空、query 非空时 |hit|/0 无定义，本实现取 e_ratio = 0 → 不满足「> entryRatio」→ 否决。
 * **副作用（有意接受）**：某条标签被写空后，除浏览模式外永远召不回。
 * 理由：标签是召回主信号，标签空了本就失去召回资格。
 * 上游另有写入侧拦截：自由标签为空数组直接拒写（write.mjs TAGS_EMPTY），双保险。
 */

/* ------------------------------------------------------------------ *
 * 一、标签等价归一（双向）
 * ------------------------------------------------------------------ */

import { localIsoString } from './core.mjs';

/**
 * 从等价表构建归一索引。
 * 等价关系天然是传递的，所以用并查集：[(发版,上线,deploy),(部署,deploy)] 会把三组连成一类。
 * canonical 取该类里**首次出现**的那个写法，保证结果稳定可复现。
 *
 * @returns {{ canonicalOf: (tag:string)=>string, groups: string[][] }}
 */
export function buildEquivalenceIndex(equivalence) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    // 路径压缩
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur);
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 保持"首次出现者"为根：roots 先注册的优先
    parent.set(rb, ra);
  };

  const groups = Array.isArray(equivalence?.groups) ? equivalence.groups : [];
  for (const group of groups) {
    const members = Array.from(group ?? [], (m) => String(m).trim()).filter((m) => m !== '');
    if (members.length === 0) continue;
    for (const m of members) if (!parent.has(m)) parent.set(m, m);
    for (let i = 1; i < members.length; i++) union(members[0], members[i]);
  }

  const canonicalOf = (tag) => {
    const t = String(tag ?? '').trim();
    if (t === '') return '';
    if (!parent.has(t)) return t;
    return find(t);
  };

  return { canonicalOf, groups };
}

/**
 * 归一 + 去重（保序）。
 * 打分、交集、占比**全部在归一后的数组上算**——与 CSV 存成什么样无关（《架构说明》§8.2）。
 */
export function normalizeTags(tags, equivalenceIndex) {
  const canonicalOf = equivalenceIndex?.canonicalOf ?? ((t) => String(t ?? '').trim());
  const out = [];
  const seen = new Set();
  for (const raw of Array.from(tags ?? [])) {
    const c = canonicalOf(raw);
    if (c === '' || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * 计算交集与两侧占比。
 *
 * 分母用**归一后的去重标签数**，保证 hit <= 分母，ratio 恒在 [0,1]；
 * 若用原始标签数当分母，两个同义标签归一成一个时会出现 hit > |条目标签| 的荒谬值。
 *
 * @returns {{hit:string[], q_ratio:number, e_ratio:number, queryNorm:string[], entryNorm:string[]}}
 */
export function computeHit(queryTags, entryTags, equivalenceIndex) {
  const q = normalizeTags(queryTags, equivalenceIndex);
  const e = normalizeTags(entryTags, equivalenceIndex);

  // 任一侧为空 → 无交集。0/0 按 0 处理（不产生 NaN），见文件头「0/0」裁决。
  if (q.length === 0 || e.length === 0) {
    return { hit: [], q_ratio: 0, e_ratio: 0, queryNorm: q, entryNorm: e };
  }

  const qSet = new Set(q);
  const hit = [];
  for (const t of e) if (qSet.has(t)) hit.push(t);

  return {
    hit,
    q_ratio: hit.length / q.length,
    e_ratio: hit.length / e.length,
    queryNorm: q,
    entryNorm: e,
  };
}

/* ------------------------------------------------------------------ *
 * 二、第一道闸门：隔离硬筛
 * ------------------------------------------------------------------ */

/**
 * 隔离硬筛（《架构说明》§九）。两道是「与」关系，都得过。
 *
 *   条目 项目 ∈ {通用, 引入, 当前项目}
 *   AND 条目 智能体 ∈ {通用, 引入, 当前智能体}
 *   AND 状态 = 生效
 *
 * 边界口径：
 *   - 当前项目 = 通用 时，按字面只能看 通用 + 引入（qa Q7）。通用是白名单值，不是通配符。
 *   - 条目的 项目/智能体 为空 ''：理论上不该出现（写入必填），真出现按 通用 处理
 *     （《流程_读取》§五），**并标记**——不能当黑名单滤掉，否则空值条目静默消失。
 *
 * @returns {{pass:boolean, blankProject:boolean, blankAgent:boolean}}
 */
export function checkIsolation(record, { project, agent }, schema) {
  const universals = Array.isArray(schema?.universal) ? schema.universal : ['通用', '引入'];
  const active = schema?.statusActive ?? '生效';

  const curProject = String(project ?? '').trim();
  const curAgent = String(agent ?? '').trim();

  if (String(record?.['状态'] ?? '').trim() !== active) {
    return { pass: false, blankProject: false, blankAgent: false };
  }

  const rawProject = String(record?.['项目'] ?? '').trim();
  const rawAgent = String(record?.['智能体'] ?? '').trim();
  const blankProject = rawProject === '';
  const blankAgent = rawAgent === '';

  // 空值按 通用 处理，但只是"可见"，不是不匹配
  const effProject = blankProject ? '通用' : rawProject;
  const effAgent = blankAgent ? '通用' : rawAgent;

  const projectOk = effProject === '通用' || universals.includes(effProject) || effProject === curProject;
  const agentOk = effAgent === '通用' || universals.includes(effAgent) || effAgent === curAgent;

  return { pass: projectOk && agentOk, blankProject, blankAgent };
}

/* ------------------------------------------------------------------ *
 * 三、第二项：打分
 * ------------------------------------------------------------------ */

/**
 * 时距微加权：min(log2(时距) × multiplier, tickMaxScore)。
 *
 * **这里有两个不同的 10，别混**（《接口契约》疑点 1）：
 *   - weights.tickMaxScore = 10 → **打分权重上限**（本函数用）
 *   - scoring.tickCap = 10      → **时距字段值上限**（tick.mjs 累加封顶用）
 *
 * 时距 <= 0 或非数 → 0 分（log2(0) 是 -Infinity，必须挡住）。
 * 时距 = 1（写入初值）→ log2(1) = 0 → 0 分，正确：新条目不该靠时距加分。
 */
export function tickScoreOf(tick, config) {
  const n = Number(tick);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const multiplier = Number(config?.tickScore?.multiplier ?? 2);
  const cap = Number(config?.weights?.tickMaxScore ?? 10);
  return Math.min(Math.log2(n) * multiplier, cap);
}

/**
 * 单条打分（只在已过硬筛的条目上调用）。
 *
 *   总分 = 形态分 + 标签分 + 时距分（满分 100）
 *   形态命中      weights.shapeHit (50) else 0
 *   标签交集      q_ratio × weights.tagMax (40)，按 query 命中占比线性；hit 为空则 0
 *   时距微加权    min(log2(时距)×2, weights.tickMaxScore)
 */
export function scoreRecord(record, query, config, equivalenceIndex) {
  const weights = config?.weights ?? {};
  const shapeHit = String(record?.['形态'] ?? '').trim() === String(query?.['形态'] ?? '').trim();
  const shapeScore = shapeHit ? Number(weights.shapeHit ?? 50) : 0;

  const { hit, q_ratio, e_ratio, queryNorm, entryNorm } = computeHit(
    query?.['自由标签'],
    record?.['自由标签'],
    equivalenceIndex,
  );
  const tagScore = hit.length === 0 ? 0 : q_ratio * Number(weights.tagMax ?? 40);
  const tickPart = tickScoreOf(record?.['时距'], config);

  return {
    score: shapeScore + tagScore + tickPart,
    breakdown: { shape: shapeScore, tag: tagScore, tick: tickPart },
    shapeHit,
    hit,
    q_ratio,
    e_ratio,
    queryNorm,
    entryNorm,
  };
}

/* ------------------------------------------------------------------ *
 * 四、三段闸门 + Top-K（主入口）
 * ------------------------------------------------------------------ */

/**
 * 召回主入口。纯函数：records 由调用方从 core.readLibraryCsv 读好后传入。
 *
 * @param {{
 *   records: object[],
 *   query: { 项目:string, 智能体:string, 形态:string, 自由标签?:string[] },
 *   identity?: { bound:boolean, who?:string },   // 第 0 步身份检查
 *   schema: object,
 *   config: object,
 *   equivalence?: object,
 * }} args
 */
export function recall(input) {
  /* --- 入参校验（问题 5）：传错形状立刻报错，不许静默返回空 --- */
  //
  // 真实事故：调用方按位置传 `recall(records, query, cfg)`，
  // 而本函数收的是单个配置对象。解构后全部落到默认值，
  // 于是"记录为空"→ 一条都查不到，看起来像"库里没有"。
  // 这正是教训 7「把读不到伪装成没有」的入参版本。
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    const got = Array.isArray(input) ? 'array' : typeof input;
    throw new TypeError(
      `recall 的参数必须是一个对象 { records, query, identity, schema, config, equivalence }，实际收到 ${got}。` +
        `如果按位置传参（如 recall(records, query, cfg)）会静默查不到任何东西——请改用对象形式。`,
    );
  }
  const { records = [], query = {}, identity, schema, config, equivalence } = input;

  // records 必须是数组；传成别的（如 CSV 文本）要报错，不能当空库
  if (!Array.isArray(records)) {
    throw new TypeError(`recall 的 records 必须是数组，实际收到 ${typeof records}。`);
  }
  // query 必须是对象
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError(`recall 的 query 必须是对象，实际收到 ${Array.isArray(query) ? 'array' : typeof query}。`);
  }

  const eqIndex = buildEquivalenceIndex(equivalence);
  const cfg = config ?? {};
  const passLine = Number(cfg.passLine ?? 40);
  const topK = Number(cfg.topK ?? 5);
  const nearLimit = Number(cfg.nearLimit ?? 3);
  const entryRatio = Number(cfg?.veto?.entryRatio ?? 0.5);
  const queryFloor = Number(cfg?.veto?.queryFloor ?? 0.15);

  const echo = {
    项目: String(query?.['项目'] ?? '').trim(),
    智能体: String(query?.['智能体'] ?? '').trim(),
    形态: String(query?.['形态'] ?? '').trim(),
    自由标签: Array.isArray(query?.['自由标签']) ? query['自由标签'] : [],
  };

  const errors = [];

  /* --- 第 0 步：会话身份检查（先于一切） --- */
  // 未绑定 → 直接返回空，不走到"智能体必填→拒查"。
  // 铁律：不知道"我是谁"就连跨身份可见的记忆也不读（《功能说明》§4.3）。
  // 不因模型显式传 通用/引入 而放行。
  if (identity && identity.bound === false) {
    return {
      ok: false,
      blocked: 'UNBOUND_IDENTITY',
      echo,
      total: records.length,
      filtered: 0,
      vetoed: 0,
      passed: 0,
      hits: [],
      near: [],
      empty: null,
      tickTargets: [],
      errors: [],
      message: '未绑定身份：先调 dtm_bind 绑定本次会话的身份，才能读写记忆。',
    };
  }

  /* --- 输入必填校验：形态必填 --- */
  if (echo['形态'] === '') {
    errors.push({
      code: 'SHAPE_EMPTY',
      field: '形态',
      message: `形态 必填，必须是这 6 个之一：${(schema?.shapes ?? []).join(' / ')}。不给则拒查。`,
      detail: { allowed: schema?.shapes ?? [] },
    });
  } else if (Array.isArray(schema?.shapes) && !schema.shapes.includes(echo['形态'])) {
    errors.push({
      code: 'SHAPE_INVALID',
      field: '形态',
      message: `形态 值非法：「${echo['形态']}」。合法值只有：${schema.shapes.join(' / ')}。`,
      detail: { value: echo['形态'], allowed: schema.shapes },
    });
  }

  if (echo['项目'] === '') {
    errors.push({
      code: 'PROJECT_EMPTY',
      field: '项目',
      message:
        '项目 必填。合法值：会话工作目录名（原样照抄）/ 通用（所有项目都该知道）/ 引入（外部搬来、归属未知）。' +
        '程序不会替你补默认值——归属猜错了，查出来的条目就串到别的项目去了。' +
        '不知道这条属于哪个项目时，先问用户；标准见《标签字典》「字段标准」一节。',
    });
  }
  if (echo['智能体'] === '') {
    errors.push({
      code: 'AGENT_EMPTY',
      field: '智能体',
      message:
        '智能体 必填。合法值：当前绑定身份名 / 通用（所有身份都该知道）/ 引入（外部搬来、归属未知）。' +
        '程序不会替你补默认值。未绑定身份时先调 dtm_bind；不知道用什么名字就问用户。' +
        '标准见《标签字典》「字段标准」一节。',
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      blocked: errors[0].code,
      echo,
      total: records.length,
      filtered: 0,
      vetoed: 0,
      passed: 0,
      hits: [],
      near: [],
      empty: null,
      tickTargets: [],
      errors,
    };
  }

  const queryTags = normalizeTags(echo['自由标签'], eqIndex);
  // 浏览模式：query 标签为空。**跳过命中否决**（但照常走及格线）。
  const browseMode = queryTags.length === 0;
  echo['自由标签归一'] = queryTags;

  /* --- 闸门 ①：硬筛 --- */
  const screened = [];
  for (const record of records) {
    const iso = checkIsolation(record, { project: echo['项目'], agent: echo['智能体'] }, schema);
    if (!iso.pass) continue;
    screened.push({ record, blankProject: iso.blankProject, blankAgent: iso.blankAgent });
  }
  const filtered = screened.length;

  /* --- 闸门 ②：命中否决（先于分数）+ 打分 --- */
  const scored = [];
  let maxQ = 0;
  for (const { record, blankProject, blankAgent } of screened) {
    const s = scoreRecord(record, { 形态: echo['形态'], 自由标签: echo['自由标签'] }, cfg, eqIndex);
    if (!browseMode && s.q_ratio > maxQ) maxQ = s.q_ratio;

    let vetoed = false;
    let vetoReason = null;

    if (!browseMode) {
      // 条目侧：e_ratio 严格大于阈值才通过（= 0.5 不过，qa F3）
      if (!(s.e_ratio > entryRatio)) {
        vetoed = true;
        vetoReason = 'ENTRY_RATIO';
      } else if (!(s.q_ratio >= queryFloor)) {
        // query 侧：宽松门槛，>= 判定（0.15 过、0.14 不过，qa F5）
        vetoed = true;
        vetoReason = 'QUERY_FLOOR';
      }
    }

    scored.push({ record, s, vetoed, vetoReason, blankProject, blankAgent });
  }

  // query 侧"整体判为描述方向偏"：所有候选的 q_ratio 都低于门槛 → 假查空
  const queryOffDirection = !browseMode && filtered > 0 && maxQ < queryFloor;

  /* --- 闸门 ③：及格线 --- */
  const passedAll = scored.filter((x) => !x.vetoed && x.s.score >= passLine);
  const vetoedCount = scored.filter((x) => x.vetoed).length;

  // 排序：分数降序；同分 编号 新的在前（《流程_读取》§4.3，保证顺序可复现）
  const byScoreThenId = (a, b) => {
    if (b.s.score !== a.s.score) return b.s.score - a.s.score;
    return String(b.record['编号'] ?? '').localeCompare(String(a.record['编号'] ?? ''));
  };

  const hits = passedAll.slice().sort(byScoreThenId).slice(0, Math.max(1, topK)).map((x) => ({
    编号: x.record['编号'],
    主要内容: String(x.record['主要内容'] ?? ''),
    摘要: String(x.record['主要内容'] ?? '').slice(0, 60),
    形态: x.record['形态'],
    项目: x.record['项目'],
    智能体: x.record['智能体'],
    自由标签: x.record['自由标签'],
    时距: x.record['时距'],
    score: round2(x.s.score),
    explain: {
      shapeHit: x.s.shapeHit,
      tags: x.s.hit,
      q_ratio: round4(x.s.q_ratio),
      e_ratio: round4(x.s.e_ratio),
      tick: round2(x.s.breakdown.tick),
      breakdown: {
        shape: x.s.breakdown.shape,
        tag: round2(x.s.breakdown.tag),
        tick: round2(x.s.breakdown.tick),
      },
    },
    // 空值条目要标出来（《流程_读取》§五：空值不是黑名单，但要让模型知道）
    blankFields: [...(x.blankProject ? ['项目'] : []), ...(x.blankAgent ? ['智能体'] : [])],
  }));

  /* --- near：擦边条目，最多 nearLimit 条 --- */
  // 判真假查空的关键物证：放宽一个维度就能命中的，说明可能是程序/说明的问题，不是库里没有。
  const near = scored
    .filter((x) => !hits.some((h) => h['编号'] === x.record['编号']))
    .sort(byScoreThenId)
    .slice(0, Math.max(0, nearLimit))
    .map((x) => ({
      编号: x.record['编号'],
      score: round2(x.s.score),
      e_ratio: round4(x.s.e_ratio),
      q_ratio: round4(x.s.q_ratio),
      reason: x.vetoed
        ? x.vetoReason
        : x.s.score < passLine
          ? 'BELOW_PASS_LINE'
          : 'OTHER',
    }));

  /* --- 空值类型：真查空 / 假查空 --- */
  let empty = null;
  if (hits.length === 0) {
    empty = near.length > 0 ? 'false_but_near' : 'true';
  }

  /* --- 命中条目的时距 +1（只返回目标，不在这里改记录） --- */
  const tickTargets = hits.map((h) => h['编号']);

  return {
    ok: true,
    blocked: queryOffDirection && hits.length === 0 ? 'QUERY_OFF_DIRECTION' : null,
    echo,
    browseMode,
    total: records.length,
    filtered,
    vetoed: vetoedCount,
    passed: passedAll.length,
    hits,
    near,
    empty,
    tickTargets,
    errors: [],
  };
}

/* ------------------------------------------------------------------ *
 * 五、read.jsonl 记录（"该写什么"，由 host 落盘）
 * ------------------------------------------------------------------ */

/**
 * 构造 records/read.jsonl 的一条记录（《流程_读取》§七）。
 *
 * ⚠️ `feedback` 是**占位参数**：其落盘形态（原地更新原行 / 另起 action=feedback 行 /
 * 只记入 tidy.jsonl）**待"整理与记录"专项一次拍板**，本实现**不选**任何一种，
 * 只固定写 `[]`。这是主子的明确定位（《接口契约》§三 疑点 4）。
 *
 * feedback 是稳定性状态机的唯一数据源，verdict 取值 ok / wrong / unused。
 */
export function buildReadLog({ query, result, identity = {}, now = new Date() } = {}) {
  const localIso = localIsoString(now);
  const r = result ?? {};

  const log = {
    ts: localIso,
    who: String(identity.who ?? ''),
    cond: {
      项目: String(query?.['项目'] ?? ''),
      智能体: String(query?.['智能体'] ?? ''),
      形态: String(query?.['形态'] ?? ''),
      标签: Array.isArray(query?.['自由标签']) ? query['自由标签'] : [],
    },
    total: Number(r.total ?? 0),
    filtered: Number(r.filtered ?? 0),
    passed: Number(r.passed ?? 0),
    near: (r.near ?? []).map((n) => `${n['编号']} 分=${n.score} e_ratio=${n.e_ratio}`),
    hits: (r.hits ?? []).map((h) => h['编号']),
    feedback: [], // 占位：落盘形态待定稿，见函数注释
  };

  // 被拒的召回必须留下原因码。少了这条，台账只能看出「查空了」，
  // 分不清「库里真没有」和「参数不合规被前置闸门挡下」——
  // 而这两者对模型下一步该怎么做是完全相反的动作：
  // 前者按无返回继续，后者要补参数重试。
  if (r.ok === false || r.blocked) {
    log.ok = false;
    if (r.blocked) log.blocked = String(r.blocked);
    log.errors = (Array.isArray(r.errors) ? r.errors : []).map((e) => ({
      code: String(e?.code ?? ''),
      message: String(e?.message ?? ''),
    }));
  }

  return log;
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

