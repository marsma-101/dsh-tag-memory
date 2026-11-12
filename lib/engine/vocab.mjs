/**
 * vocab.mjs — 标签词表：频次统计 + 分档 + 触发词筛选（纯逻辑，无 IO）
 *
 * ── 为什么需要它（2026-11-11，用户提出）──────────────────────────
 * 真实事故：模型查 ["改源码","生产环境"] 撞空，而库里那条的标签是
 * 「源码 | 生产端」。两个词都没对上，精确交集为 0 → 被 entryRatio 否决。
 * 模型不是「不想查」，是**不知道该用什么词去查**。
 *
 * 所以要有两张东西：
 *   ① **词表**（给模型看）：库里到底有哪些标签，各出现几次。
 *   ② **触发词**（给程序用）：用户消息里出现这些词时，自动送一次相关记忆。
 *
 * ── 频次为什么必须由程序算、不走模型 ──────────────────────────────
 * 实测实库 329 个唯一标签里 **299 个（91%）只出现 1 次**。频次能直接把标签分成：
 *   · 泛词（高频）：dsh(26) / 推断(16) / 原话(14) —— 人人都带，查询价值低
 *   · 精准词（低频）：假查空(1) / 改动落点(1) —— 一说就中，价值高
 * 词表不标频次 = 把噪声当路标。而频次是**纯统计**，每次写入/整理重算即可，
 * 不需要模型判断，也不会漂移。
 *
 * ── 边界 ───────────────────────────────────────────────────────────
 *   · 纯函数：不读文件、不碰配置、不写日志。调用方把 records/config 传进来。
 *   · 不吞异常：入参不对就抛，别静默返回空表（那会把「算错了」伪装成「库里没有」）。
 */

/**
 * 内置的「不该进词表」判定：这些标签对查询没有指引作用。
 *
 * 为什么要排除（不是随手列的）：
 *   · 纯数字（`3190`、`0`）—— 是正文里的数字被误当标签，不是概念
 *   · 来源标记（`原话`/`推断`/`转述`）—— 描述「这条怎么来的」，不描述「这条讲什么」，
 *     查询时几乎不可能拿它当检索词；留着只会放大 e_ratio 分母
 *   · 单字 —— 绝大多数是切词残渣，且做子串匹配时误触发率极高
 *
 * 这份名单可在 free-tag-rules.json 的 vocab.exclude 里覆盖（见 resolveExclusions）。
 */
export const DEFAULT_EXCLUDES = ['原话', '推断', '转述', '转引', '补充'];

/**
 * 合并排除名单：内置 + 配置覆盖。
 * 配置里传 `exclude` 会**追加**而不是替换——内置那几条是判据，不该被一次配置失误清空。
 *
 * @param {object} [config]
 * @returns {Set<string>}
 */
export function resolveExclusions(config) {
  const extra = Array.isArray(config?.exclude) ? config.exclude : [];
  const set = new Set(DEFAULT_EXCLUDES);
  for (const x of extra) {
    const t = String(x ?? '').trim();
    if (t) set.add(t);
  }
  return set;
}

/**
 * 一个标签是否「值得进词表 / 能当触发词」。
 *
 * ⚠️ 判据是**实测出来的**，不是想当然（2026-11-11 首次跑真实库踩到的坑）：
 *   首版只排除「纯数字 + 来源标记 + 单字」，结果精准词档里混进
 *   `0xc0000142`（十六进制错误码）、`v3.5.0`（版本号）、`5%`（带符号数字）、
 *   `UNABLE_TO_VERIFY_LEAF_SIGNATURE`（整条报错）。
 *   这些对「下次该用什么词查」毫无指引作用——它们是**正文碎片**，不是概念。
 *
 * @param {string} tag
 * @param {object} [opts]
 * @param {Set<string>} [opts.excludes]
 * @param {number} [opts.minLen]  最短字数，默认 2（单字一律排除）
 * @param {number} [opts.maxLen]  最长字数，默认 20（超过的是整句/整条报错，不是标签）
 * @returns {boolean}
 */
export function isUsefulTag(tag, { excludes, minLen = 2, maxLen = 20 } = {}) {
  const t = String(tag ?? '').trim();
  if (t === '') return false;
  if (t.length < minLen) return false;
  if (t.length > maxLen) return false;

  // 纯数字
  if (/^\d+$/.test(t)) return false;
  // 版本号：v3.5.0 / V4 / 1.2.3 —— 查它是想找「哪个版本」的概率极低
  if (/^[vV]?\d+(\.\d+)+$/.test(t)) return false;
  // 单个大写字母 + 数字（V4 / V3）
  if (/^[A-Za-z]\d+$/.test(t)) return false;
  // 十六进制 / 错误码：0xc0000142 / 0x8007
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) return false;
  // 数字+单位/符号：5% / 409 / 30d
  if (/^\d+[%a-zA-Z%‰]*$/.test(t)) return false;
  // 整条报错：全大写+下划线且很长（UNABLE_TO_VERIFY_LEAF_SIGNATURE）
  if (/^[A-Z0-9_]{16,}$/.test(t)) return false;
  // 没有中文也没有字母的（纯符号/纯标点）
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) return false;

  if (excludes && excludes.has(t)) return false;
  return true;
}

/**
 * 统计标签频次（只数「生效」条目，被取代/已归档的标签不该出现在词表里）。
 *
 * @param {object[]} records  库记录
 * @param {object} [opts]
 * @param {Set<string>} [opts.excludes]
 * @param {number} [opts.minLen]
 * @param {string} [opts.statusActive] 默认「生效」
 * @returns {{ counts: Map<string, number>, total: number, unique: number }}
 *          counts 按标签 -> 出现次数（同一条目内重复的标签只算一次）
 */
export function countTags(records, { excludes, minLen = 2, statusActive = '生效' } = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError(`countTags: records 必须是数组，实际收到 ${typeof records}。`);
  }
  const counts = new Map();

  for (const r of records) {
    if (String(r?.['状态'] ?? '').trim() !== statusActive) continue;
    const tags = Array.isArray(r?.['自由标签'])
      ? r['自由标签']
      : String(r?.['自由标签'] ?? '').split('|');

    // 同一条目里重复的标签只计一次——否则频次反映的是「有人爱重复打」而不是「词有多常用」
    const seen = new Set();
    for (const raw of tags) {
      const t = String(raw ?? '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      if (!isUsefulTag(t, { excludes, minLen })) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }

  return { counts, total: records.length, unique: counts.size };
}

/**
 * 按频次把标签分成两档：泛词 / 精准词。
 *
 * 为什么是两档而不是三档（用户裁定）：三档的中间档没有明确动作——
 * 模型看到「中频」也不知道该更信还是更不信。两档每档都有**明确动作**：
 *   · 泛词   → 查询时别单独用（太泛，命中一堆）
 *   · 精准词 → 优先用（一说就中）
 *
 * 分界线的选择依据（实测）：实库 91% 的标签只出现 1 次，所以用「固定次数」分档
 * 会把绝大多数都判成精准词、失去区分度。改用**分位数**并按条数截断：
 * 按频次降序，取前 `commonCount` 个（默认 20）作为泛词。
 *
 * @param {Map<string, number>} counts
 * @param {object} [opts]
 * @param {number} [opts.commonCount] 泛词取几个，默认 20
 * @returns {{ common: Array<[string,number]>, precise: Array<[string,number]> }}
 *          两组都按频次降序；precise 内部同频按字面排，保证输出可复现
 */
export function splitByFrequency(counts, { commonCount = 20 } = {}) {
  if (!(counts instanceof Map)) {
    throw new TypeError(`splitByFrequency: counts 必须是 Map，实际收到 ${typeof counts}。`);
  }
  const all = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const n = Math.max(0, Math.min(commonCount, all.length));
  return { common: all.slice(0, n), precise: all.slice(n) };
}

/**
 * 从词表里挑出「触发词」——用户消息里出现它时，自动送一次相关记忆。
 *
 * ── 判据演进（两次被实测打回，记下来免得再走一遍）──────────────
 * 首版「精准词 + >=3 字」→ 挑出 **428 个**，几乎每个标签都中，等于「说什么都触发」。
 * 二版「加长度上限 10 + 排除标点」→ 仍 **410 个**，且样例里混着
 * `官方跨进程驱动两方案`、`思维导图颜色语义表` 这类**句子摘要**——
 * 用户永远不会在消息里原样说出这种句子。
 *
 * 结论：**「从全库自动筛中文触发词」这条路本身不成立**。
 * 原因不在参数，在于程序无法判断一个中文短语「像不像人话」——
 * `安全漏洞` 用户会说，`按内容判`、`报数顺序`、`必读位置` 用户不会说。
 * 这两类在统计特征上完全一样（都是低频精准词），任何阈值都分不开。
 *
 * ── 所以改成：自动筛只负责**英文/字母技术词**，中文触发词交给显式配置 ──
 * 依据是用户举的例子——`privhub`、`npm`、`github` **全是英文技术词**。
 * 英文词的判断是可靠的：含字母、长度 2~24、不含空格。
 * 中文触发词（`上传`、`召回`、`假查空`）由 `always` 显式给出，程序不猜。
 *
 * 这条设计的取舍：**宁可少触发，也不乱触发**。
 * 少触发只是回到「模型自己想起来查」的现状（不倒退）；
 * 乱触发会让每轮上下文塞满无关记忆，且用户无法分辨模型「知道」还是「被塞了」。
 *
 * @param {Map<string, number>} counts
 * @param {object} [opts]
 * @param {number} [opts.commonCount]   泛词个数，默认 20
 * @param {number} [opts.triggerMinLen] 最短字数，默认 2（英文词可能很短，如 npm）
 * @param {number} [opts.triggerMaxLen] 最长字数，默认 24
 * @param {boolean} [opts.autoLatinOnly] 只自动纳入含拉丁字母的词，默认 true
 * @param {string[]} [opts.always]      显式触发词（中文专有/技术词也放这里）
 * @returns {string[]} 去重后的触发词，按长度降序（长子串优先，避免被短词抢）
 */
export function pickTriggerWords(
  counts,
  {
    commonCount = 20,
    triggerMinLen = 2,
    triggerMaxLen = 24,
    autoLatinOnly = true,
    always = [],
  } = {},
) {
  if (!(counts instanceof Map)) {
    throw new TypeError(`pickTriggerWords: counts 必须是 Map，实际收到 ${typeof counts}。`);
  }
  const { common } = splitByFrequency(counts, { commonCount });
  const commonSet = new Set(common.map(([t]) => t));

  const picked = new Set();
  const alwaysList = Array.isArray(always) ? always.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  const alwaysSet = new Set(alwaysList);

  for (const [tag] of counts) {
    // ⚠️ 显式触发词**不受泛词档限制**。首版把 `npm` 当泛词（df=4）排除，
    // 结果「npm 发布报 409」这条最该触发的消息反而不触发。
    // 专有名词的高频是「这个项目天天用」，不是「这个词没信息量」——
    // 两者在频次上分不开，所以显式名单必须能覆盖自动判据。
    if (commonSet.has(tag) && !alwaysSet.has(tag)) continue;
    if (tag.length < triggerMinLen) continue;
    if (tag.length > triggerMaxLen) continue;
    if (/[\s,，。！？、；：（）()「」【】]/.test(tag)) continue; // 正文片段
    // 自动档只收含拉丁字母的：英文技术词的边界可靠，
    // 中文短语「像不像人话」程序判不了（见上方判据演进）。
    if (autoLatinOnly && !/[A-Za-z]/.test(tag) && !alwaysSet.has(tag)) continue;
    picked.add(tag);
  }
  // 显式触发词：中文专有/技术词走这里（上传/召回/假查空…），程序不猜
  for (const t of alwaysList) picked.add(t);

  // 长词优先：匹配时先试长词，避免 `npm` 抢在 `npmignore` 前面
  return [...picked].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a.localeCompare(b);
  });
}

/**
 * 在一条用户消息里找出命中的触发词。
 *
 * 只做「消息是否包含该词」的判断，不做分词、不做语义——这是**故意的保守**：
 * 分词的误差会变成「该触发没触发」，比多触发一次更难查。
 *
 * @param {string} message
 * @param {string[]} triggers  由 pickTriggerWords 产出（已按长度降序）
 * @param {object} [opts]
 * @param {number} [opts.maxHits] 最多返回几个，默认 5
 * @returns {string[]}
 */
export function matchTriggers(message, triggers, { maxHits = 5 } = {}) {
  const text = String(message ?? '');
  if (text === '' || !Array.isArray(triggers)) return [];

  const hits = [];
  for (const t of triggers) {
    if (hits.length >= maxHits) break;
    if (text.includes(t)) hits.push(t);
  }
  return hits;
}

/**
 * 渲染标签词表（频次分档版）。
 *
 * ⚠️ 2026-11-11 已被 `renderTagNetwork` 取代为主要形态（用户裁定）：
 * 频次分档解决不了「词与词之间什么关系」，而那才是选词时真正需要的信息。
 * 本函数保留是因为它体积小（约 300 tokens），仍适合作降级/摘要用。
 *
 * @param {{counts: Map<string, number>}} vocab
 * @param {object} [opts]
 * @param {number} [opts.commonCount] 泛词个数
 * @param {number} [opts.commonLimit] 泛词最多显示几个，默认 12
 * @param {number} [opts.preciseLimit] 精准词最多显示几个，默认 24
 * @param {string} [opts.separator]   词间分隔符，默认「、」
 * @returns {string} 形如「高频泛词（别单独用）：dsh、推断…；精准词（优先用）：假查空、改动落点…」
 */
export function renderVocab(vocab, { commonCount = 20, commonLimit = 12, preciseLimit = 24, separator = '、' } = {}) {
  const counts = vocab?.counts;
  if (!(counts instanceof Map) || counts.size === 0) return '';

  const { common, precise } = splitByFrequency(counts, { commonCount });
  const fmt = (list, limit) =>
    list.slice(0, limit).map(([t, n]) => `${t}(${n})`).join(separator);

  const parts = [];
  if (common.length > 0) {
    parts.push(`高频泛词（别单独用，会命中太多）：${fmt(common, commonLimit)}`);
  }
  if (precise.length > 0) {
    // 精准词按「频次升序」展示更好用：越少见的越准，先列极精准的
    const asc = precise.slice().sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[0].localeCompare(b[0]);
    });
    parts.push(`精准词（优先用）：${fmt(asc, preciseLimit)}`);
  }
  return parts.join('；');
}

/* ------------------------------------------------------------------ *
 * 标签共现网络（2026-11-11 用户裁定：wiki 的真实形态）
 * ------------------------------------------------------------------ */

/**
 * 从记录里筛出「当前视角可见」的条目。
 *
 * 隔离规则（用户 2026-11-11 明确）：
 *   `(项目 ∈ {当前项目, 通用}) AND (智能体 ∈ {当前智能体, 通用})`
 * 其他项目/智能体的条目**自动隐藏**，不参与 wiki。
 *
 * 为什么必须隔离（实测）：全库 669 个标签里 **616 个（92%）只属于单一项目**。
 * 不隔离会把几百个别的项目的词灌进当前视角，全是噪声。
 *
 * @param {object[]} records
 * @param {{project?: string, agent?: string, statusActive?: string}} view
 * @returns {object[]}
 */
export function selectVisible(records, { project = '', agent = '', statusActive = '生效' } = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError(`selectVisible: records 必须是数组，实际收到 ${typeof records}。`);
  }
  const curProject = String(project ?? '').trim();
  const curAgent = String(agent ?? '').trim();
  const universal = '通用';

  return records.filter((r) => {
    if (String(r?.['状态'] ?? '').trim() !== statusActive) return false;
    const p = String(r?.['项目'] ?? '').trim() || universal;
    const a = String(r?.['智能体'] ?? '').trim() || universal;
    return (p === curProject || p === universal) && (a === curAgent || a === universal);
  });
}

/** 取一条记录的标签数组（兼容「数组」与「a|b|c 字符串」两种形态）。 */
function tagsOf(record) {
  const raw = record?.['自由标签'];
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  return String(raw ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 生成**标签共现网络**——wiki 的正确形态。
 *
 * ── 用户澄清的形态（2026-11-11）────────────────────────────────
 * 「wiki 就是所有的自由标签全都在一个表里头，然后这个标签和哪些记忆条目有关，
 *   条目里边有哪些标签，顺着做连线……整体是一张特别复杂的网。
 *   人看着可能费劲，但给智能体看它会很清楚里边的关系。」
 *
 * 所以输出的每一行是「一条记忆的全部标签」，**同一行的标签天然互相连接**，
 * 跨记忆的相同标签又形成新的连接——这份文本本身就是那张网，
 * 不需要额外算邻接表（实测邻接表 7499 tokens，比本形态大 4 倍）。
 *
 * ── 三个刻意的取舍 ─────────────────────────────────────────────
 * 1. **不带编号**（用户明确：编号只是存储用的，模型不需要回指，
 *    它要的是内容）。省下的字节相当可观（1854 → 1394 tokens）。
 * 2. **不带项目/智能体等字段**：视角已经隔离过了，每行再标一遍是重复。
 * 3. **首词即类别**：用户裁定不做占位词——第一个标签天然是概括性最强的类别值。
 *    所以这里不需要过滤或标记「哪一个是类」，原样输出即可。
 *
 * @param {object[]} records  已按视角筛过的记录（调用方负责 selectVisible）
 * @param {object} [opts]
 * @param {string} [opts.separator]      同一行内标签的分隔符，默认 `|`
 * @param {string} [opts.lineSeparator]  行分隔符，默认 `\n`
 * @param {number} [opts.maxLines]       最多多少条记忆，默认 0 = 不限
 * @returns {string} 每行一条记忆的标签串；无内容时返回 ''
 */
export function renderTagNetwork(records, { separator = '|', lineSeparator = '\n', maxLines = 0 } = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError(`renderTagNetwork: records 必须是数组，实际收到 ${typeof records}。`);
  }

  const lines = [];
  for (const r of records) {
    const tags = tagsOf(r);
    // 没有标签的条目对网络没有贡献（连不起来），跳过——
    // 它们仍可被 dtm_review 看到，只是不该占 wiki 的行。
    if (tags.length === 0) continue;
    lines.push(tags.join(separator));
  }

  const limited = maxLines > 0 ? lines.slice(0, maxLines) : lines;
  return limited.join(lineSeparator);
}

/**
 * 统计网络规模，用于诊断/测试（不参与渲染）。
 *
 * @param {string} network  由 renderTagNetwork 产出的文本
 * @param {object} [opts]
 * @param {string} [opts.separator]
 * @param {string} [opts.lineSeparator]
 * @returns {{ lines:number, nodes:number, edges:number, bytes:number }}
 *          edges 按「同一行内两两相连」计，去重（a-b 与 b-a 算一条）
 */
export function networkStats(network, { separator = '|', lineSeparator = '\n' } = {}) {
  const text = String(network ?? '');
  if (text === '') return { lines: 0, nodes: 0, edges: 0, bytes: 0 };

  const lines = text.split(lineSeparator).filter(Boolean);
  const nodes = new Set();
  const edges = new Set();

  for (const line of lines) {
    const tags = [...new Set(line.split(separator).map((x) => x.trim()).filter(Boolean))];
    for (const t of tags) nodes.add(t);
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const key = tags[i] < tags[j] ? `${tags[i]}\u0001${tags[j]}` : `${tags[j]}\u0001${tags[i]}`;
        edges.add(key);
      }
    }
  }

  return {
    lines: lines.length,
    nodes: nodes.size,
    edges: edges.size,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}
