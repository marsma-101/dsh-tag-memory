/**
 * write.mjs — 写入校验 + 造行（不落盘）
 *
 * 依据：《流程_写入》§二/§三/§五、《标签字典》，裁决见《接口契约》§三。
 *
 * 边界：
 *   - 只返回「该写什么」，**不写文件**（落盘归 host，CSV 归 core.mjs）
 *   - 不查重、不做取代/归档（那是整理的活）
 *   - 取值域/上限全部来自入参 schema，不硬编码
 *   - 时钟可注入（qa C6）
 */

import { nextId, localIsoString } from './core.mjs';

/**
 * 模型**允许**给的字段。
 *
 * 2026-11-08 起 `稳定性` 归模型判（照 v0.3.7）：它的语义是「该不该核对」——
 * 「这条会不会变」只有写下它的模型知道，程序无从推断。曾经把它设为程序字段、
 * 一律强制 `观察`，后果是 `tidy.mjs` 的稳定性状态机**没有输入可用**：
 *   · 状态机设计的起点是「观察」，但所有条目起点都是观察 → 升格判据失效
 *   · 「规矩」这类明确不会变的条目也躺在 `观察` 里，每次都要模型重新核对
 * 现在模型给值就采纳（必须合法），不给则由程序预填 `观察`（起点，不是兜底——
 * 状态机会按 feedback 自己走：连续 ok≥3 升稳定，出现 wrong 降易变）。
 *
 * 其余 3 个（编号/时距/状态）仍是程序字段：模型传了静默丢弃（qa D13）。
 */
export const MODEL_FIELDS = ['主要内容', '形态', '项目', '智能体', '自由标签', '稳定性'];

/** 程序字段——传了就丢，绝不采纳模型给的值。 */
export const PROGRAM_FIELDS = ['编号', '时距', '状态'];

const PIPE = '|';

/**
 * 标签规范化：转字符串、trim、滤空、去重保序。
 * 不做"偷偷替换 |"——那会静默改变模型原意（《流程_写入》§5.1）。
 */
export function normalizeTags(rawTags) {
  const list = Array.isArray(rawTags) ? rawTags : rawTags === undefined || rawTags === null ? [] : [rawTags];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const t = String(item ?? '').trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 写入校验（纯校验，不造编号）。
 *
 * 规则（《流程_写入》§五）：
 *   主要内容 非空            → 否则 CONTENT_EMPTY
 *   形态 非空且是 6 值之一    → 否则 SHAPE_EMPTY / SHAPE_INVALID
 *   项目 非空且 ≤40 字        → 否则 PROJECT_EMPTY / NAME_TOO_LONG
 *   智能体 非空且 ≤40 字      → 否则 AGENT_EMPTY / NAME_TOO_LONG
 *   自由标签 ≤20 个           → 否则 TOO_MANY_TAGS
 *   自由标签 任一含 |         → 否则 TAG_CONTAINS_PIPE（detail.tag = 违规标签原文）
 *   自由标签 去重滤空后为空   → 否则 TAGS_EMPTY（加严：空标签 e_ratio 恒 0，必被否决→废条）
 *   标签含空串/重复           → 程序去重滤空，**不报错**
 *
 * 注意：**形态为空是拒写**（查询侧形态必填、写入侧也是必填），
 * 但**已存条目**的形态为空由读取侧宽容处理（《流程_读取》§五）——两者不矛盾。
 *
 * @returns {{ok:boolean, errors:Array, normalized:object, ignored:string[]}}
 */
export function validateWriteInput(input, schema) {
  const errors = [];
  const src = input ?? {};

  // 模型硬塞了程序字段 → 记进 ignored 供排查，但不产生错误
  const ignored = PROGRAM_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(src, f));

  const content = String(src['主要内容'] ?? '');
  const shape = String(src['形态'] ?? '').trim();
  const project = String(src['项目'] ?? '').trim();
  const agent = String(src['智能体'] ?? '').trim();
  const tags = normalizeTags(src['自由标签']);
  // 稳定性：模型可判（照 v0.3.7）。给了就必须合法；不给走状态机起点「观察」。
  const stability = String(src['稳定性'] ?? '').trim();

  // --- 主要内容 ---
  if (content.trim() === '') {
    errors.push({
      code: 'CONTENT_EMPTY',
      field: '主要内容',
      message: '主要内容 不能为空：要记的那件事本身必须写出来。',
    });
  }

  // --- 形态 ---
  if (shape === '') {
    errors.push({
      code: 'SHAPE_EMPTY',
      field: '形态',
      message: `形态 必填，必须是这 6 个之一：${schema.shapes.join(' / ')}。`,
      detail: { allowed: schema.shapes },
    });
  } else if (!schema.shapes.includes(shape)) {
    errors.push({
      code: 'SHAPE_INVALID',
      field: '形态',
      message: `形态 值非法：「${shape}」。合法值只有：${schema.shapes.join(' / ')}。`,
      detail: { value: shape, allowed: schema.shapes },
    });
  }

  // --- 项目 ---
  if (project === '') {
    errors.push({
      code: 'PROJECT_EMPTY',
      field: '项目',
      message:
        '项目 不能为空：填当前项目名（会话工作目录名）、或 通用（所有项目都该知道）、' +
        '或 引入（外部搬来、归属未知）。程序不会替你补默认值——归属错了就串味。' +
        '不知道属于哪个项目时先问用户；标准见《标签字典》「字段标准」一节。',
      detail: { allowed: [...schema.universal] },
    });
  } else if (project.length > schema.limits.projectNameMax) {
    errors.push({
      code: 'NAME_TOO_LONG',
      field: '项目',
      message: `项目 超过 ${schema.limits.projectNameMax} 字上限（实际 ${project.length} 字），请缩短。`,
      detail: { value: project, length: project.length, max: schema.limits.projectNameMax },
    });
  }

  // --- 智能体 ---
  if (agent === '') {
    errors.push({
      code: 'AGENT_EMPTY',
      field: '智能体',
      message:
        '智能体 不能为空：填当前身份名、或 通用（所有身份都该知道）、或 引入（外部搬来、归属未知）。' +
        '程序不会替你补默认值——归属错了就串味。' +
        '未绑定身份时先调 dtm_bind；不知道用什么名字就问用户。标准见《标签字典》「字段标准」一节。',
      detail: { allowed: [...schema.universal] },
    });
  } else if (agent.length > schema.limits.agentNameMax) {
    errors.push({
      code: 'NAME_TOO_LONG',
      field: '智能体',
      message: `智能体 超过 ${schema.limits.agentNameMax} 字上限（实际 ${agent.length} 字），请缩短。`,
      detail: { value: agent, length: agent.length, max: schema.limits.agentNameMax },
    });
  }

  // --- 自由标签：| 保留符（先查，这是最要命的一条）---
  const pipeHits = tags.filter((t) => t.includes(PIPE));
  if (pipeHits.length > 0) {
    for (const bad of pipeHits) {
      errors.push({
        code: 'TAG_CONTAINS_PIPE',
        field: '自由标签',
        message: `自由标签「${bad}」含保留字符 |（用于分隔多个标签），请改写该标签后重试。`,
        detail: { tag: bad, char: PIPE },
      });
    }
  }

  // --- 自由标签：数量 ---
  if (tags.length > schema.limits.tagsMax) {
    errors.push({
      code: 'TOO_MANY_TAGS',
      field: '自由标签',
      message:
        `自由标签 有 ${tags.length} 个，超过上限 ${schema.limits.tagsMax} 个。` +
        '太多了说明这条该拆成多条，或者这条职责太杂。',
      detail: { count: tags.length, max: schema.limits.tagsMax },
    });
  }

  // --- 自由标签：空（加严规则，Lead 2026-11-05 裁决）---
  // e_ratio = |hit| / |条目标签|，标签为空时恒为 0 → 必被否决 → 除浏览外永远召不回 → 废条。
  // 写入时拦住比让它占位好。
  if (tags.length === 0) {
    errors.push({
      code: 'TAGS_EMPTY',
      field: '自由标签',
      message: '自由标签不能为空：至少给 1 个能描述这条记忆的实词，否则以后召不回来。',
      detail: { min: 1 },
    });
  }

  // --- 稳定性（模型可判，照 v0.3.7）---
  // 语义是「该不该核对」——「这条会不会变」只有写下它的模型知道。
  // 给了就必须合法；不给不算错误（走状态机起点 `观察`，见 buildNewRecord 注释）。
  if (stability !== '' && !schema.stabilities.includes(stability)) {
    errors.push({
      code: 'STABILITY_INVALID',
      field: '稳定性',
      message:
        `稳定性 值非法：「${stability}」。合法值只有：${schema.stabilities.join(' / ')}。` +
        '判据是「没意外会不会变」：不会变→`稳定`；拿不准→`观察`；会变（版本/端口/临时状态）→`易变`。',
      detail: { value: stability, allowed: schema.stabilities },
    });
  }

  const normalized = {
    主要内容: content,
    形态: shape,
    项目: project,
    智能体: agent,
    自由标签: tags,
    稳定性: stability,
  };

  return { ok: errors.length === 0, errors, normalized, ignored };
}

/**
 * 造一条待写入的新记录。
 *
 * 程序填 3 个字段：编号 / 时距=1 / 状态=生效。
 * `稳定性` 由模型判（照 v0.3.7）：给了且合法就采纳，没给则预填 `观察`。
 *
 * ⚠️ 预填 `观察` **不是兜底**：`观察` 是状态机的设计起点（《流程_整理》§5.4），
 * 之后由 feedback 自己演进（连续 ok≥3 → 稳定；出现 wrong → 易变）。
 * 与「兜底」的区别：兜底是拿一个值把缺失掩盖掉，这里是状态机本来就要有个起点。
 * 所以这里**不报 STABILITY_EMPTY**——缺它不是错误，是「还没验证过」的如实表达。
 *
 * @param {{
 *   input: object,
 *   existingIds: string[],
 *   schema: object,
 *   now?: Date,          // 可注入时钟（qa C6）
 * }} args
 * @returns {{ok:boolean, record:object|null, errors:Array, ignored:string[]}}
 */
export function buildNewRecord({ input, existingIds = [], schema, now = new Date() } = {}) {
  const { ok, errors, normalized, ignored } = validateWriteInput(input, schema);
  if (!ok) return { ok: false, record: null, errors, ignored };

  // 编号规则只有一份实现，在 core.mjs。host 在锁内调用本函数，
  // existingIds 传锁内读到的整库编号 → 并发写不会撞号（《接口契约》Q5）。
  //
  // 注意：即便模型硬塞了 `编号`，也**不采纳**（程序字段一律丢弃，qa D13），
  // 编号永远由程序扫表取号，否则会与已有编号撞车。
  const id = nextId(existingIds, now);

  const record = {
    编号: id,
    主要内容: normalized['主要内容'],
    形态: normalized['形态'],
    项目: normalized['项目'],
    智能体: normalized['智能体'],
    自由标签: normalized['自由标签'],
    // 模型给了合法值就采纳；没给用状态机起点 `观察`
    稳定性: normalized['稳定性'] || '观察',
    时距: 1,
    状态: '生效',
  };

  return { ok: true, record, errors: [], ignored };
}

/* nextId 从 core.mjs 引入会形成 write→core 的依赖；这是允许的（单向）。
 * 这里用静态 import 更清晰，见文件底部 import。 */

/**
 * 构造 records/write.jsonl 的一条记录（"该写什么"，由 host 落盘）。
 *
 * 字段见《流程_写入》§六。成功/失败都记——失败说明"模型想记但没记成"，
 * 是整理阶段定位字典问题/程序误伤的素材。
 *
 * @param {{
 *   input: object,
 *   identity: { who?: string },
 *   result: { ok:boolean, record?:object|null, errors?:Array },
 *   schema: object,
 *   now?: Date,
 *   config?: { writeLogTagLimit?: number },
 * }} args
 */
export function buildWriteLog({
  input,
  identity = {},
  result = {},
  schema,
  now = new Date(),
  config = {},
} = {}) {
  const tagLimit = Number.isFinite(config.writeLogTagLimit) ? config.writeLogTagLimit : 10;
  const src = input ?? {};
  const tags = normalizeTags(src['自由标签']);

  const log = {
    ts: localIsoString(now),
    who: String(identity.who ?? ''),
    summary: String(src['主要内容'] ?? '').slice(0, 30),
    形态: String(src['形态'] ?? '').trim(),
    项目: String(src['项目'] ?? '').trim(),
    智能体: String(src['智能体'] ?? '').trim(),
    tags: tags.slice(0, tagLimit).join(','),
    ok: Boolean(result.ok),
  };

  if (result.ok) {
    log.id = result.record?.['编号'] ?? '';
  } else {
    const first = (result.errors ?? [])[0];
    log.reason = first ? first.message : '未知失败';
    // 便于整理统计"哪类错误最常拦人"
    if (first) log.code = first.code;
  }

  return log;
}

