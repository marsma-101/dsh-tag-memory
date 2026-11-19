/**
 * read.mjs — 召回：标签归一 / 隔离硬筛 / 打分 / 三道闸门 / Top-K
 *
 * 依据：《流程_读取》全篇、《架构说明》§九/§十一、《接口契约》§三。
 *
 * 边界：只算，不落盘。返回「该写什么记录」（buildReadLog）+ 「该给谁 +1」（tickTargets）。
 *
 * ===================== 三道闸门·顺序不可逆 =====================
 *   ① 硬筛（状态=生效 AND 项目∈{通用,引入,当前} AND 智能体∈{通用,引入,当前}）
 *   ② 命中否决（|命中| >= minHit  AND  查询覆盖率 q_ratio >= queryFloor）
 *   ③ 及格线（总分 >= passLine，出厂 45）
 * 顺序反了就会出现「先按分数捞、再否决」——那等于先污染再清理，规格明令禁止。
 *
 * ============ 2026-11-16 判据重构（重要，别改回去）============
 * 旧闸门②是「条目侧 e_ratio = |命中|/|条目标签数| > entryRatio」。
 * 实测证明这个式子有**结构性死锁**：分母是写入侧自由决定的量，给定查询词数 k，
 * e_ratio 上限是 min(k,n)/n，所以 n >= k/entryRatio 的条目数学上永远召不回
 * （1 词查询要求条目标签 ≤3 个，而写入规则建议 6~8 个）。
 * 实测：生产库 1 词查询下 103/120 条永远召不回。
 *
 * 新闸门②的**分母只有查询词数**，没有条目标签数：
 *   · minHit    —— 命中标签的绝对数（与条目长度无关）
 *   · queryFloor —— |命中| / |查询标签|（分母是模型可控的查询词数）
 * `e_ratio` 仍由 computeHit 计算，但**只用于诊断输出，不参与任何判决**。
 *
 * ============ 两个取舍 ============
 * 1) 浏览模式（query 标签为空）**同时跳过命中否决与及格线**（2026-11-16 改）。
 *    旧版「跳过否决但不跳及格线」依赖「形态分 50 >= 及格线 40」这个巧合；
 *    权重重构后形态分 30 < 45，照旧做法会让 6 个形态全部返回空（实测确认）。
 *    浏览没有查询词，算不出相关性，及格线无从谈起——只做硬筛 + 形态 + topK。
 * 2) 已存条目「形态」为空时，浏览任何具体形态都返回不到——**这是设计本意，不是缺陷**。
 *    §4.3 说的"该形态下全部生效条目"不包括形态为空的条目。
 *    形态为空是**数据质量问题，由整理环节补形态修复**，读取环节不做特殊照顾。
 *
 * ============ 空标签条目的处置 ============
 * 条目标签为空、query 非空时 |hit| = 0 → 不满足 minHit → 否决。
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

/**
 * 归属可见性（**不含状态过滤**）——读取/整理面的隔离谓词（2026-11-12，容器审查 P1-18）。
 *
 * 与 checkIsolation 的区别：checkIsolation 还要求 状态=生效（召回只看得见的活条）；
 * 而 review/retag/archive/supersede 需要能操作 已归档/被取代 的条（整理就是要处理它们），
 * 所以这里**只判归属、不判状态**。归属口径与 checkIsolation 完全一致：
 *   项目 ∈ {通用, 引入, 当前} AND 智能体 ∈ {通用, 引入, 当前}，空值按通用。
 *
 * @returns {boolean} 该条对当前 项目/智能体 是否可见
 */
export function ownershipVisible(record, { project, agent } = {}, schema) {
  const universals = Array.isArray(schema?.universal) ? schema.universal : ['通用', '引入'];
  const curProject = String(project ?? '').trim();
  const curAgent = String(agent ?? '').trim();
  const effProject = String(record?.['项目'] ?? '').trim() || '通用';
  const effAgent = String(record?.['智能体'] ?? '').trim() || '通用';
  const projectOk = effProject === '通用' || universals.includes(effProject) || effProject === curProject;
  const agentOk = effAgent === '通用' || universals.includes(effAgent) || effAgent === curAgent;
  return projectOk && agentOk;
}

/**
 * 归属**可写性**（整理动作 retag / archive / supersede 的守卫谓词，2026-11-19 方案 A）。
 *
 * ── 为什么不是直接复用 ownershipVisible ─────────────────────────
 *   ownershipVisible 回答「这条我看得见吗」（读取面，公共条目人人可见）；
 *   ownershipWritable 回答「这条我能改吗」（整理面，写权限比读权限严）。
 *   两者的差别只有一处：**公共条目（智能体=通用）**。
 *
 * ── 「无主资产」缺陷（2026-11-19 派单任务书 §三）─────────────────
 *   旧守卫用可见性当写权限：公共条目人人可见 → 判定「属于你」→ 放行，
 *   但等一下——旧守卫实际判的是 record.智能体 === curAgent（严格相等），
 *   「通用/通用」条目对任何绑定身份都判 false，报 OWNERSHIP_DENIED。
 *   而能绑定成「通用/通用」的会话**不存在**（身份是用户起的名，
 *   项目按工作目录自动填），于是公共层成了无主资产：
 *   人人可读，无人可修，整理功能对这些条目实际半废（实测 16 候选中 14 条卡死）。
 *
 *   修正（方案 A，主人已批准）：智能体=通用 的公共条目放开给**任何已绑定身份**
 *   做 retag / archive / supersede——公共知识是全体智能体共有的，任何绑定会话
 *   都是它的合法维护者。安全机制全部沿用：自动备份、台账、retag 必填 basis。
 *
 * ── 仍然锁死的（红线，主人明确）──────────────────────────────
 *   · **项目 ≠ 通用** 的条目：跨项目写照样拒（防上下文污染，红线不动）。
 *     即「智能体=通用 但 项目=某项目」的条目仍只归那个项目维护。
 *   · 引入条目（universals 里的非通用值）：沿用旧口径，不放开。
 *   · 身份字段（编号/主要内容/项目/智能体）不可改 —— FIELD_NOT_EDITABLE 层已挡，
 *     与本谓词无关（改的是「谁有权 retag 公共条目」，不是「归属可改」）。
 *
 * @param {object} record         库记录
 * @param {{project?:string, agent?:string}} scope 当前绑定作用域
 * @param {object} schema
 * @returns {boolean} 该条对当前作用域是否**可写**（retag/archive/supersede）
 */
export function ownershipWritable(record, { project, agent } = {}, schema) {
  const universals = Array.isArray(schema?.universal) ? schema.universal : ['通用', '引入'];
  const curProject = String(project ?? '').trim();
  const curAgent = String(agent ?? '').trim();
  const effProject = String(record?.['项目'] ?? '').trim() || '通用';
  const effAgent = String(record?.['智能体'] ?? '').trim() || '通用';

  // 项目面（读写同口径）：公共 or 引入 or 当前项目，否则一律拒——
  // 别的项目的专属记忆，谁都不能借道改。
  const projectOk = effProject === '通用' || universals.includes(effProject) || effProject === curProject;

  // 智能体面（方案 A 放开点）：公共条目（=通用）放开给任何已绑定身份；
  // 引入条目沿用旧口径；专属条目仍只归本人。
  const agentOk = effAgent === '通用' || universals.includes(effAgent) || effAgent === curAgent;

  return projectOk && agentOk;
}

/* ------------------------------------------------------------------ *
 * 三、第二项：打分
 * ------------------------------------------------------------------ */

/**
 * 时距微加权：min(log2(时距) × multiplier, tickMaxScore)。
 *
 * **两个不同的量，别混**（《接口契约》疑点 1）：
 *   - weights.tickMaxScore = 10 → **打分权重上限**（本函数用）
 *   - scoring.tickCap = 32      → **时距字段值上限**（tick.mjs 累加封顶用）
 *
 * 2026-11-16：tickCap 由 10 抬到 32 = 2^(10/2)，使「封顶时恰好能拿满 10 分」。
 * 旧值 10 与 tickMaxScore=10 数学互斥：封顶时时距分 = min(log2(10)×2, 10) = 6.64，
 * 永远拿不到 10，导致「满分 100」实际只有 96.64（而测试 E5 用不可达的 时距=32 断言满分）。
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
 *   形态命中      weights.shapeHit (30) else 0
 *   标签交集      q_ratio × weights.tagMax (60)，按 query 命中占比线性；hit 为空则 0
 *   时距微加权    min(log2(时距)×2, weights.tickMaxScore)
 *
 * 2026-11-16 权重由 50/40 改为 30/60：旧值下形态分单独就越过及格线，
 * 导致标签质量对筛选毫无作用（及格线成死代码）。新值要求两者配合。
 * 这条不变式由 dict.mjs 的 loadScoring 强制校验，调坏了会当场抛错。
 */
export function scoreRecord(record, query, config, equivalenceIndex) {
  const weights = config?.weights ?? {};
  const shapeHit = String(record?.['形态'] ?? '').trim() === String(query?.['形态'] ?? '').trim();
  const shapeScore = shapeHit ? Number(weights.shapeHit ?? 30) : 0;

  const { hit, q_ratio, e_ratio, queryNorm, entryNorm } = computeHit(
    query?.['自由标签'],
    record?.['自由标签'],
    equivalenceIndex,
  );
  const tagScore = hit.length === 0 ? 0 : q_ratio * Number(weights.tagMax ?? 60);
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
  const passLine = Number(cfg.passLine ?? 45);
  const topK = Number(cfg.topK ?? 5);
  const nearLimit = Number(cfg.nearLimit ?? 3);
  // ── 2026-11-16 判据重构（详见 scoring.json 的 _whyRemoved_entryRatio）──
  // 旧：e_ratio = |命中| / |条目标签数| > entryRatio —— 分母是「写入侧自由决定的量」，
  //     导致 n < k/entryRatio 的条目数学上永远召不回（1 词查询要求条目标签 ≤3 个）。
  // 新：① minHit —— 命中标签的**绝对数**（与条目标签数无关）
  //     ② queryFloor —— 查询侧覆盖率（分母是查询词数，模型可控）
  // 两者都保留兜底值，且兜底必须与出厂一致（旧教训：兜底 0.5 与出厂 0.3 不一致会静默退回）。
  const minHit = Number(cfg?.veto?.minHit ?? 1);
  const queryFloor = Number(cfg?.veto?.queryFloor ?? 0.5);

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
  // 浏览模式：query 标签为空。**跳过命中否决与及格线**（见下方闸门③）。
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
      // ── 2026-11-16 新判据：命中绝对数 + 查询侧覆盖率 ──
      // ① minHit：命中标签的**绝对数**必须达标（>= 判定）。
      //    语义：与查询零交集的条目绝不返回。分母是 0，与条目标签数无关。
      //    注意：queryFloor >= 0.5 时这条在数学上已被覆盖（hit=0 → q_ratio=0 < 0.5），
      //    保留它是为了让「零交集必拒」这条硬规则**不依赖另一个阈值的取值**——
      //    将来有人把 queryFloor 调低，这条仍然守着底线。
      if (!(s.hit.length >= minHit)) {
        vetoed = true;
        vetoReason = 'MIN_HIT';
      } else if (!(s.q_ratio >= queryFloor)) {
        // ② queryFloor：查询侧覆盖率，>= 判定。分母是查询词数（模型可控），不是条目标签数。
        vetoed = true;
        vetoReason = 'QUERY_FLOOR';
      }
    }

    scored.push({ record, s, vetoed, vetoReason, blankProject, blankAgent });
  }

  // query 侧"整体判为描述方向偏"：所有候选的 q_ratio 都低于门槛 → 假查空
  const queryOffDirection = !browseMode && filtered > 0 && maxQ < queryFloor;

  /* --- 闸门 ③：及格线 ---
   *
   * ── 2026-11-16：浏览模式跳过否决与及格线，改为**显式按形态过滤** ──────
   * 浏览的语义是「把这一形态的都给我看看」，不是「找最相关的」。
   * 及格线是用来筛**相关性**的，而浏览没有查询词，算不出相关性分数。
   *
   * 为什么必须跳过（不是可选优化）：权重重构后形态分只有 30，
   * 而及格线是 45 → 浏览模式下所有条目的分数都够不到线，6 个形态全部返回空。
   * 实测确认过这个连带影响。
   *
   * ⚠️ 但跳过及格线会**顺带丢掉形态过滤**——旧版靠「形态不命中 → 0 分 → 不过线」
   * 来实现「浏览技能就只出技能」。所以这里必须显式补回形态判断，
   * 否则浏览「技能」会把「规则」「事实」全带出来（实测踩到：F8a/F8c 当场变红）。
   * 这不是兜底，是把「原本隐含在分数里的约束」改成「显式约束」。
   *
   * 浏览的排序改按时距降序 + 编号降序（确定性，不引入新概念）：
   *   - 时距高 = 被用过多次，优先看
   *   - 编号新 = 最近写的，优先看
   */
  const passedAll = browseMode
    ? scored
        .filter((x) => String(x.record['形态'] ?? '').trim() === echo['形态'])
        .sort((a, b) => {
          const ta = Number(a.record['时距']) || 0;
          const tb = Number(b.record['时距']) || 0;
          if (tb !== ta) return tb - ta;
          return String(b.record['编号'] ?? '').localeCompare(String(a.record['编号'] ?? ''));
        })
    : scored.filter((x) => !x.vetoed && x.s.score >= passLine);
  const vetoedCount = scored.filter((x) => x.vetoed).length;

  // 排序：分数降序；同分 编号 新的在前（《流程_读取》§4.3，保证顺序可复现）
  const byScoreThenId = (a, b) => {
    if (b.s.score !== a.s.score) return b.s.score - a.s.score;
    return String(b.record['编号'] ?? '').localeCompare(String(a.record['编号'] ?? ''));
  };

  /**
   * 命中条目的返回形状。
   *
   * ── 2026-11-11 用户裁定：模型要的是**内容**，不是元数据 ──────────
   * 原话：「模型需要的也不是编号，他就是需要这个记忆内容……连智能体这些都不用给，
   *        你就直接把主要内容给他就行。」
   *
   * 所以这里保持精简：编号（工具间引用需要）+ 主要内容（模型真正要读的）+ 标签
   * （模型判断相关性用）+ score/explain（调试与「为什么命中」用）。
   *
   * ⚠️ `摘要` 删了：它是「主要内容的前 60 字」，而主要内容本身就在同一条里，
   * 纯冗余（标签即摘要，见 M-20261111-021）。少一个会漂移的字段。
   *
   * ⚠️ `项目` / `智能体` **必须保留**，别当作元数据删掉——
   * 它们不是「给模型看的展示字段」，而是**归属正确性的唯一可验证出口**：
   * 模型硬塞 项目/智能体 时必须被程序值覆盖，而 verification 只能从返回值看到结果
   * （`ownership.k.test.mjs` 的 K9b 就是拿 hits[0]['项目'] 断言）。
   * 删了它们，那条安全约束就变成不可验证的。
   *
   * 注：`blankFields` 同样保留——空值条目必须让模型知道（《流程_读取》§五），
   * 它是「这条的归属没填」的告警，不是元数据展示。
   */
  const hits = passedAll.slice().sort(byScoreThenId).slice(0, Math.max(1, topK)).map((x) => ({
    编号: x.record['编号'],
    主要内容: String(x.record['主要内容'] ?? ''),
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
  //
  // ── 2026-11-11 改进（用户裁定）：near 必须带「条目原始标签 + 差几个」──
  // 真实事故：查 ["改源码","生产环境"] 撞空，near 只回了「M-20261111-002 分=50 e_ratio=0」，
  // 没给标签，模型无从判断该换什么词，只能把「擦边」当「没有」。
  //
  // 两个刻意的设计决定：
  //   ① `gap`（还差几个标签才能过闸）只报 **1** 的。
  //      实测：差 1 个平均 8.3 条/次（可读），差 2 个平均 53.0 条/次（噪声远大于信息）。
  //      所以按 gap 分档截断，不是笼统「有 N 条相关」。
  //   ② **只给原料，不给结论**。绝不自动生成「建议补哪个词」——
  //      实测四个毫不相关的查询（源码/npm/生产端/召回）返回的建议一模一样
  //      （记忆库位置/数据目录/CSV），因为「最能解锁的词」由全库分布决定、与查询无关。
  //      程序猜词 = 噪声；把条目自己的标签摆出来让模型判断才对。
  //
  // 注意：`near` 的既有字段（编号/score/e_ratio/q_ratio/reason）语义不变，只**新增**
  // gap / 自由标签 / hitTags 三个字段，避免破坏 read.f 那批既有断言。
  //
  // 排序三档（2026-11-11 二次修正，真实库暴露）：
  //
  // 首版只按「gap===1 优先 + 总分」排，结果真实库里查 ["改源码","生产环境"] 时，
  // near 出来的是 M-20261110-005（标签 不要臆测|防污染|优先级）、M-20261011-063、
  // M-20261110-002 —— **全是与查询毫无关系的条目**，真正想找的 M-20261111-002
  // （源码|生产端|同步|边界|改动落点）反而被挤掉了。
  //
  // 原因是：这类条目标签少 → gap=1 → 优先档；又因形态分 50 保底 → 分数不低。
  // 而 M-20261111-002 有 6 个标签、命中 0 个 → gap=6 → 掉进第二档。
  //
  // 但 near 的意义是「**和这次查询擦边**」，不是「随便挑几条标签少的」。
  // 所以第一判据必须是**命中了几个查询标签**（hit.length > 0 才算擦边），
  // 命中多的排前面；0 命中的只在没有擦边条目时兜底。
  // ── 2026-11-16：gap 的口径跟着判据一起改 ──────────────────────
  // 旧 gap = 「还差几个标签才能过 e_ratio」（分母是条目标签数）。
  // 新 gap = 「还差几个**查询词**才能过 queryFloor」（分母是查询词数，模型可控）。
  //
  // 为什么这个改动是必要的而不是顺手改：gap 的作用是「告诉模型补几个词就能查到」。
  // 旧口径下，模型要补的是**条目标签里有的词**——但它看不见条目标签，无从补起；
  // 新口径下，模型要补的是**自己查询里漏掉的词**，它完全有能力判断
  // （「我查了 npm 和发布，是不是还该加上 registry」）。
  //
  // needHits = ceil(queryFloor × |查询标签|)：过 queryFloor 至少要命中几个查询词。
  // gap = needHits - |已命中|，最小 1（能进 near 就说明还差至少一个）。
  const queryTagCount = queryTags.length;
  const needHits = Math.max(1, Math.ceil(queryFloor * queryTagCount));
  const nearCandidates = scored
    .filter((x) => !hits.some((h) => h['编号'] === x.record['编号']))
    .map((x) => {
      const gap = x.vetoReason === 'QUERY_FLOOR' || x.vetoReason === 'MIN_HIT'
        ? Math.max(1, needHits - x.s.hit.length)
        : null;
      return { x, gap, hitCount: x.s.hit.length };
    });

  /**
   * near 排序：命中数降序 → gap=1 优先 → 分数。
   *
   * ── 2026-11-11 二次修订：**退役了「子串接近度」判据** ──────────
   * 之前用过 `proximityHits`（query 与 entry 标签互含对数）做第一判据，
   * 是为了在「精确命中全为 0」时还能排出相关性。
   *
   * 现在退役它，因为**标签网络接管了这个职责**：
   * 模型调 dtm_recall 时，工具描述里已经给出完整的「记忆→标签」共现网，
   * 它自己就能看出「源码 和 生产端 是一组」，不需要程序在 near 里代猜相关性。
   * 程序猜得再准也不如把原料摆给模型——而且少一层逻辑少一处会错的地方。
   *
   * near 保留的意义因此收窄为：**「这次确实没查到」的证据**，
   * 以及「差 1 个标签就能过闸」的低成本提示（实测平均 8.3 条/次）。
   */
  const byNearRelevance = (a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    const aOne = a.gap === 1 ? 0 : 1;
    const bOne = b.gap === 1 ? 0 : 1;
    if (aOne !== bOne) return aOne - bOne;
    return byScoreThenId(a.x, b.x);
  };

  const near = nearCandidates
    .sort(byNearRelevance)
    .slice(0, Math.max(0, nearLimit))
    .map(({ x, gap }) => ({
      编号: x.record['编号'],
      score: round2(x.s.score),
      e_ratio: round4(x.s.e_ratio),
      q_ratio: round4(x.s.q_ratio),
      reason: x.vetoed
        ? x.vetoReason
        : x.s.score < passLine
          ? 'BELOW_PASS_LINE'
          : 'OTHER',
      // ── 2026-11-16：gap 语义跟着判据改 ──
      // gap=1 表示「再补 1 个查询词（且这个词条目里有）就能过闸」，是唯一低成本可救的一类。
      // 注意这里补的是**查询侧**的词，不是条目标签——模型看得见自己的查询，看不见条目标签，
      // 所以只有「补查询词」是它有能力执行的动作。旧口径的 gap 要求补条目标签，无从执行。
      gap,
      自由标签: x.record['自由标签'],
      // 已经命中的那几个（模型据此能看出「差的是哪一类词」）。
      hitTags: x.s.hit,
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
