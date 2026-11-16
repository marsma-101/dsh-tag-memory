/**
 * dict.mjs — 程序侧配置加载（schema / scoring / 等价表）+ 标签字典读取
 *
 * 依据：《流程_整理》§5.1「这些配置放 templates/，改完即生效，不需要重启」。
 *
 * 边界：
 *   - 不硬编码任何取值域或阈值，一律从磁盘读
 *   - **不写死插件安装路径**——engine 不知道装在哪，路径由 host 传入（Lead 裁决 3）
 *   - 热更新靠 mtime 比对：文件改了就重读，没改就用缓存
 *
 * 注入用（"精简版字典 + 身份状态"）放 renderCompactInjection：
 *   阈值推导 / 匹配原理 / 状态机细节**一律不进注入**（《标签字典》注入边界）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * 一、带 mtime 热更新的 JSON 加载器
 * ------------------------------------------------------------------ */

/** 路径 -> { mtimeMs, value } */
const jsonCache = new Map();

/**
 * 读 JSON，按 mtime 判断是否重读。解析失败抛带路径的错，不让它静默变 undefined。
 */
export async function loadJsonFresh(filePath) {
  const st = await fsp.stat(filePath);
  const hit = jsonCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;

  const text = await fsp.readFile(filePath, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const e = new Error(`配置文件不是合法 JSON：${filePath}\n${err.message}`);
    e.code = 'CONFIG_MISSING';
    e.cause = err;
    throw e;
  }
  jsonCache.set(filePath, { mtimeMs: st.mtimeMs, value });
  return value;
}

/** 仅测试用：清缓存 */
export function clearConfigCache() {
  jsonCache.clear();
}

/**
 * templates 目录下的三个默认文件路径。
 * baseDir = `lib/engine/templates` 的实际位置，由 host 传入。
 */
export function templatePaths(baseDir) {
  return {
    schema: path.join(baseDir, 'schema.json'),
    scoring: path.join(baseDir, 'scoring.json'),
    equivalence: path.join(baseDir, 'tag-equivalence.json'),
  };
}

/* ------------------------------------------------------------------ *
 * 二、三个 loader（默认值 ⊕ 入参覆盖）
 * ------------------------------------------------------------------ */

/**
 * 加载 schema（取值域：9 列、6 形态、3 稳定性、3 状态、各项上限）。
 *
 * overrides 来自插件 `Config`（官方：可调值放 Config，用户能跨升级保留自己的补丁）。
 * 覆盖是**深合并**：只改用户提到的那几个键，其余保持出厂值。
 */
export async function loadSchema({ baseDir, overrides } = {}) {
  const { schema } = templatePaths(baseDir);
  const base = await loadJsonFresh(schema);
  return mergeConfig(base, overrides);
}

/**
 * 加载打分参数（可调阈值：权重、及格线、否决阈值、topK、nearLimit、tickCap）。
 *
 * ⚠️ 校验三项"结构不可动"的约束：
 *
 *   ① 三项权重之和必须 = 100（总分口径固定，否则 passLine 失去意义）
 *   ② **任一单项都不能单独越过及格线**（2026-11-16 新增，替代旧的"标签分不得高于形态分"）
 *   ③ 时距分（tickMaxScore）必须是 10 且**不参与调整**（《流程_整理》§5.3）
 *
 * ── 为什么②替代了旧约束 ──────────────────────────────────────
 * 旧约束是「tagMax 不得高于 shapeHit」，前提假设是「形态是主信号」。
 * 但实测（生产库 361 条）发现这个假设直接导致了**职责倒挂**：
 *   形态 50 分 + 及格线 40 → 形态命中就及格 → 标签质量对筛选毫无作用
 *   → 及格线成了死代码（实测：120 条自查询里，被及格线拦下的 0 条）
 *   → 27 条得分 ≥80 的条目被否决闸门单独杀死
 *
 * 新约束「任一单项不得单独及格」才是真正该守的不变式：
 *   - 形态单独不过 → 形态判错不再一票否决，但仍显著降分
 *   - 标签单独不过 → 标签质量真正参与筛选（这是召回的主匹配信号）
 *   - 两者配合才过 → 没有哪一维可以垄断判决权
 *
 * 违反就抛错而不是默默接受——调参调坏了应当当场发现。
 */
export async function loadScoring({ baseDir, overrides } = {}) {
  const { scoring } = templatePaths(baseDir);
  const base = await loadJsonFresh(scoring);
  const merged = mergeConfig(base, overrides);

  const w = merged.weights ?? {};
  const shapeHit = Number(w.shapeHit);
  const tagMax = Number(w.tagMax);
  const tickMaxScore = Number(w.tickMaxScore);
  const passLine = Number(merged.passLine);

  // ① 权重之和 = 100
  const sum = shapeHit + tagMax + tickMaxScore;
  if (sum !== 100) {
    const e = new Error(
      `打分参数非法：三项权重之和必须恰为 100，实际 ${shapeHit}+${tagMax}+${tickMaxScore}=${sum}。` +
        '总分口径固定为 100，及格线才有绝对意义。',
    );
    e.code = 'CONFIG_MISSING';
    throw e;
  }

  // ③ 时距分上限恒为 10（先查，因为②的判据要用到它）
  if (tickMaxScore !== 10) {
    const e = new Error(
      `打分参数非法：时距分上限(tickMaxScore) 必须恒为 10，不允许调整。` +
        '一旦允许它变大，老条目就靠"被召回→加分→更易召回"自我强化（《流程_整理》§5.3）。',
    );
    e.code = 'CONFIG_MISSING';
    throw e;
  }

  // ② 任一单项都不能单独越过及格线
  //    形态分、标签分（在 queryFloor 下限时的实际得分）都不得单独 >= passLine。
  //    时距分本就 ≤10，不可能是"单独及格"的来源，但它参与叠加，所以判据里要一起算。
  const queryFloor = Number(merged.veto?.queryFloor ?? 0);
  const tagAtFloor = tagMax * Math.max(0, Math.min(1, queryFloor));
  const offenders = [];
  if (shapeHit >= passLine) offenders.push(`形态分(${shapeHit}) >= 及格线(${passLine})`);
  if (tagAtFloor >= passLine) offenders.push(`标签分在 queryFloor=${queryFloor} 时(${tagAtFloor.toFixed(1)}) >= 及格线(${passLine})`);
  if (offenders.length > 0) {
    const e = new Error(
      `打分参数非法：任一单项都不得单独越过及格线，但 ${offenders.join('；')}。` +
        '一旦某一维能单独及格，它就会垄断判决权，其余维度对筛选失去作用' +
        '（2026-11-16 实测：旧 50/40 + passLine 40 时，及格线拦下的条目数为 0，成了死代码）。' +
        '调参方向：降低该维权重、提高及格线，或两者同时。',
    );
    e.code = 'CONFIG_MISSING';
    throw e;
  }

  return merged;
}

/**
 * 加载标签等价表（双向归一，不注入模型）。
 */
export async function loadTagEquivalence({ baseDir, overrides } = {}) {
  const { equivalence } = templatePaths(baseDir);
  const base = await loadJsonFresh(equivalence);
  return mergeConfig(base, overrides);
}

/* ------------------------------------------------------------------ *
 * 三、标签字典（Markdown 原文，由 host 传实际路径）
 * ------------------------------------------------------------------ */

const textCache = new Map();

/**
 * 读 `标签字典.md` 原文。
 *
 * **必须从磁盘读**，不能把字典硬编码进 preset——整理环节要能直接改字典生效（Lead 裁决 3）。
 * dictPath 由 host 传入实际路径，engine 不猜插件装在哪。
 *
 * 返回 { text, sections }：sections 是给注入用的粗粒度解析结果。
 */
export async function loadTagDictText({ dictPath } = {}) {
  if (!dictPath) {
    const e = new Error('loadTagDictText: 必须传入 dictPath（engine 不写死插件安装路径）。');
    e.code = 'DICT_MISSING';
    throw e;
  }

  let st;
  try {
    st = await fsp.stat(dictPath);
  } catch (err) {
    const e = new Error(`找不到标签字典：${dictPath}`);
    e.code = 'DICT_MISSING';
    e.cause = err;
    throw e;
  }

  const hit = textCache.get(dictPath);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;

  const text = await fsp.readFile(dictPath, 'utf8');
  const value = { text, sections: extractDictSections(text) };
  textCache.set(dictPath, { mtimeMs: st.mtimeMs, value });
  return value;
}

/** 仅测试用 */
export function clearDictCache() {
  textCache.clear();
}

/**
 * 从字典 Markdown 里抽出可注入的几块。
 *
 * 做法保守：只取 **"工具入口"表格** 与 **"形态"合法值**，其余（判据详解、原理、状态机）
 * 一律不进注入——注入必须精简（《标签字典》注入边界、验收标准"注入必须精简但入口不能缺"）。
 */
export function extractDictSections(text) {
  const src = String(text ?? '');
  const out = { tools: [], shapes: [], stabilities: [], statuses: [] };

  // 工具入口表：形如 | `dtm_bind` | 什么时候调 |
  const toolRe = /^\|\s*`(dtm_[a-z_]+)`\s*\|\s*(.+?)\s*\|/gm;
  let m;
  while ((m = toolRe.exec(src)) !== null) {
    out.tools.push({ name: m[1], when: m[2].trim() });
  }

  // 形如：`技能` `流程` `规则` `偏好` `事实` `模板`
  const shapes = ['技能', '流程', '规则', '偏好', '事实', '模板'];
  const foundShapes = shapes.filter((s) => src.includes(s));
  if (foundShapes.length > 0) out.shapes = foundShapes;

  for (const s of ['观察', '稳定', '易变']) if (src.includes(s)) out.stabilities.push(s);
  for (const s of ['生效', '被取代', '已归档']) if (src.includes(s)) out.statuses.push(s);

  return out;
}

/* ------------------------------------------------------------------ *
 * 四、每轮注入（精简版字典 + 身份状态）
 * ------------------------------------------------------------------ */

/**
 * 渲染每轮注入的文本。
 *
 * 硬约束（《标签字典》注入边界）：
 *   1. 尽量精简 —— 阈值推导、匹配原理、状态机细节一律不放
 *   2. 一个 dtm_* 入口都不能缺
 *   3. 未绑定时必须"问用户"
 *
 * @param {{
 *   dict: { text:string, sections:object },
 *   identity: { bound:boolean, who?:string, project?:string },
 *   tools?: Array<{name:string, when:string}>,
 * }} args
 */
export function renderCompactInjection({ dict, identity = {}, tools } = {}) {
  const sections = dict?.sections ?? {};
  const toolList = Array.isArray(tools) && tools.length > 0 ? tools : sections.tools ?? [];
  const shapes = sections.shapes ?? ['技能', '流程', '规则', '偏好', '事实', '模板'];

  const lines = ['## 长期记忆（dsh-tag-memory）'];

  // 身份状态：未绑定要明确"去问用户"，而不是让模型自己瞎猜
  if (identity.bound === false) {
    lines.push('**身份：未绑定** → 先问用户「这次会话我以什么名字负责」，拿到名字后调 `dtm_bind`。');
    lines.push('未绑定期间：写入会被拒、读取返回空。');
  } else {
    const who = String(identity.who ?? '').trim();
    const project = String(identity.project ?? '').trim();
    const parts = [];
    if (who) parts.push(`身份=${who}`);
    if (project) parts.push(`项目=${project}`);
    lines.push(`**身份：已绑定**（${parts.join('，') || '—'}）`);
  }

  lines.push('');
  lines.push(`形态：${shapes.join(' / ')}`);
  lines.push('自由标签：≤20 个离散实词，不能含 `|`，不能为空；程序做交集匹配。');
  lines.push('');
  lines.push('入口：');
  for (const t of toolList) lines.push(`- \`${t.name}\` — ${t.when}`);
  lines.push('');
  lines.push('写入只追加、读取只读+记时距、改库全归整理；不要直接改库文件。');

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 内部：深合并
 * ------------------------------------------------------------------ */

/**
 * 深合并：overrides 覆盖 base。数组整体替换（不逐项合并），键以下划线开头的是注释键，保留。
 */
function mergeConfig(base, overrides) {
  if (overrides === undefined || overrides === null) return base;
  if (Array.isArray(base) || Array.isArray(overrides)) return overrides;
  if (typeof base !== 'object' || typeof overrides !== 'object') return overrides;

  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = k in base ? mergeConfig(base[k], v) : v;
  }
  return out;
}
