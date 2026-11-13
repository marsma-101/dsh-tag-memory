/**
 * tool-defs.js — 10 个 dtm_* 工具的**唯一权威定义表**（纯数据，不依赖 Cordis）
 *
 * 依据：《功能说明》§十二（工具语义）、§十三（触发时机）、《标签字典》工具入口表、
 *       《接口契约》§五（preset 两条）与 §七（错误码族）、Lead 2026-11-05 六条裁决。
 *
 * 设计要点：
 *   - **一张表**同时喂两处：① `ctx.tools.register` 的 name/description/parameters
 *     ② 每轮注入的工具入口行（`when`）。两处同源 → 注入永远不可能漏工具（qa L1）。
 *   - 取值域（6 形态 / 3 稳定性 / 3 状态 / 通用·引入）**不写死**，由 `buildToolDefs(domain)`
 *     从 engine 的 `templates/schema.json` 传入（契约 Q2 / qa D15 同款纪律）。
 *   - 参数名两套：**域字段用中文**（与 CSV 表头、tidy.jsonl、engine 出参零映射，契约 Q4）；
 *     **操作参数用英文小写**（`basis`/`kind`/`limit`/`path`，对齐 tidy.jsonl 审计列与官方风格）。
 *   - 这里只有"定义"，没有任何业务逻辑；execute 的接线在 `tools.js`。
 *
 * ── §4.2 自由标签说明表（2026-11-11）─────────────────────────────
 *   说明表的机器可读源是 `lib/engine/templates/free-tag-rules.json`。
 *   **走工具 description 通道，不进 section**：section 每轮在 system prompt 里，
 *   内容一变就毁掉整段 KV cache 前缀（实测约 3786 字节，预算 6000，早期 5998 注释已 stale）。
 *   工具 description 在模型填 `自由标签` 时必被看到，且不受该预算约束。加这段不新增第 11 个工具。
 *   读表失败时用内置兜底，**绝不抛错**（本模块被测试直接 import，且 buildToolDefs
 *   契约要求「无 schema 时也能工作」）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectVisible, renderTagNetwork } from '../lib/engine/vocab.mjs';

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'engine', 'templates');

/** 官方 6 形态的判据（prose，无法进 schema.json，故由 preset 持有） */
export const SHAPE_HINTS = {
  技能: '单件事怎么做',
  流程: '多件事次序',
  规则: '必须/禁止',
  偏好: '喜欢/倾向',
  事实: '客观陈述',
  模板: '可复用格式/清单',
};

/* ------------------------------------------------------------------ *
 * §4.2 自由标签说明表：同步读 + mtime 缓存（与 preset/index.js schemaFor 同款）
 * ------------------------------------------------------------------ */

let tagRulesCache = { mtimeMs: -1, value: null };

/** 读不到返回 null，由 renderTagRules 用内置兜底，绝不抛错。 */
export function freeTagRulesFor() {
  try {
    const file = path.join(TEMPLATE_DIR, 'free-tag-rules.json');
    const stat = fs.statSync(file);
    if (stat.mtimeMs === tagRulesCache.mtimeMs) return tagRulesCache.value;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    tagRulesCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}

/** 仅测试用：清缓存，便于验证「改表即生效」。 */
export function clearTagRulesCache() {
  tagRulesCache = { mtimeMs: -1, value: null };
}

/* ------------------------------------------------------------------ *
 * 标签共现网络（用户裁定 2026-11-11：这才是 wiki 的正确形态）
 *
 * 形态：每行一条记忆的全部标签（`a|b|c`），同行标签天然相连，
 *       跨记忆的同名标签再形成新连接——这份文本本身就是那张网。
 *
 * 三个来源决定（都是用户明确的）：
 *   1. **不带编号**——编号只是存储用的，模型要的是内容和关系，不需要回指。
 *   2. **按视角隔离**——只含 `(项目∈{当前,通用}) AND (智能体∈{当前,通用})`。
 *      实测 92% 的标签只属于单一项目，不隔离会把大量无关词灌进来。
 *   3. **全量给**——不加频次截断。用户测算：约 1400 tokens，
 *      而「读错了重读」或「想不起来再问一遍」的代价远高于此。
 *
 * 注入时机（用户明确）：**不每轮注入**。模型调 dtm_write / dtm_recall 时
 * 随工具一起给。体积 1400 tokens 在工具描述里完全可接受。
 * ------------------------------------------------------------------ */

let networkCache = { key: '', text: '' };

/**
 * 从库文件生成标签网络文本。库不存在 / 解析失败 / 空库 → 返回 ''。
 *
 * @param {string} [libraryCsv]    库 CSV 绝对路径（调用方传入，本模块不猜数据目录）
 * @param {object} [view]          `{ project, agent }` 当前视角
 * @param {object} [rules]         free-tag-rules.json（用其 network 段）
 * @returns {string}
 */
export function renderNetworkFromLibrary(libraryCsv, view = {}, rules = freeTagRulesFor()) {
  if (!libraryCsv) return '';
  try {
    const stat = fs.statSync(libraryCsv);
    const project = String(view?.project ?? '');
    const agent = String(view?.agent ?? '');
    const key = `${libraryCsv}|${stat.mtimeMs}|${stat.size}|${project}|${agent}`;
    if (networkCache.key === key) return networkCache.text;

    const rows = parseCsvLite(fs.readFileSync(libraryCsv, 'utf8'));
    if (rows.length < 2) {
      networkCache = { key, text: '' };
      return '';
    }
    const header = rows[0];
    const iStatus = header.indexOf('状态');
    const iTags = header.indexOf('自由标签');
    if (iStatus < 0 || iTags < 0) {
      networkCache = { key, text: '' };
      return '';
    }

    // 行 → 记录对象（中文键），再交给 engine 的纯函数做隔离与渲染。
    // 2026-11-12 P1-12：原来这里内联重写了一遍过滤/拼接，与 vocab.mjs 的
    // selectVisible/renderTagNetwork 是两份逻辑（会漂移）。现在单一真源在 engine。
    const records = rows.slice(1).map((r) => {
      const obj = {};
      header.forEach((col, i) => { obj[col] = r[i] ?? ''; });
      return obj;
    });
    const active = String(rules?.network?.statusActive ?? '生效');
    const visible = selectVisible(records, { project, agent, statusActive: active });
    const text = renderTagNetwork(visible);
    networkCache = { key, text };
    return text;
  } catch {
    return '';
  }
}

/** 仅测试用：清网络缓存 */
export function clearNetworkCache() {
  networkCache = { key: '', text: '' };
}

/** 兜底文案：与 free-tag-rules.json 的要点一致，表读不到时也能给出规范。 */
const FALLBACK_WRITE =
  '第一个词优先放类别值（规矩/决策/交代/踩坑/纠正/流程/原话/推断 等），再接内容概括词；' +
  '从「作用/注意事项/内容关键词」三方向拆短实词，一个标签一个概念；' +
  '**不打纯数字**（3190/0）、转述句、与内容无关的泛词（原话/推断 作类别首词合法，别当内容词重复打）；' +
  '优先复用 wiki 已有的词，确实没有再造新词；不含 |（会被拒写）；1~20 个，超过 6~8 个就该收。';
const FALLBACK_READ = '一次给 1~3 个短实词，优先内容关键词/作用；查空别反复换说法。';


/**
 * 极简 CSV 解析（只用于读词表，不承担完整校验）。
 *
 * 为什么不复用 core.mjs：那边是 **async ESM**，而 buildToolDefs 是同步函数。
 * 为一个统计字段引入异步会把整个工具注册链路改成 async，代价远大于收益。
 * 这里只需正确处理引号与换行，够用。
 */
function parseCsvLite(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * 把说明表压成极短一段（写侧 / 读侧各一），供参数 description 前置。
 *
 * ⚠️ 压缩纪律（2026-11-11）：**只合并重复表述，不删防误用信息**。
 * 取值区间、`|` 拒写、「别打什么」这些一旦删掉，模型会写出废标签 →
 * 被拒 → 重试，浪费的 token 远多于省下的。所以这里宁可句子紧，不省要点。
 */
export function renderTagRules(side, rules = freeTagRulesFor()) {
  const r = rules?.[side];
  if (!r || typeof r !== 'object') {
    return side === 'write' ? FALLBACK_WRITE : FALLBACK_READ;
  }
  const parts = [];
  // 写侧：directions 形如「作用：它帮解决什么」——取**概念名**（冒号前），
  // 概念名才是模型组织标签时要对的词；冒号后的解释留在文档里。
  if (Array.isArray(r.directions) && r.directions.length > 0) {
    const dirs = r.directions
      .map((x) => String(x).split('：')[0].trim())
      .filter(Boolean)
      .join('/');
    parts.push(`从「${dirs}」三方向拆短实词，一个标签一个概念`);
  } else if (Array.isArray(r.do) && r.do.length > 0) {
    parts.push(r.do.join('；'));
  }
  if (Array.isArray(r.dont) && r.dont.length > 0) {
    // ⚠️ 不要做「去掉统一前缀」的正则清洗：`dont` 条目动词各不相同（不打…／不写 |／
    // 不堆成一句话），统一替换会把「不写 |」改成「写 |」——语义直接反转。
    // 宁可多几个字，也不能压出错的规则（省下的字节远小于一次误用的代价）。
    const items = r.dont.map((x) => String(x).trim()).filter(Boolean);
    parts.push(items.join('；'));
  }
  if (r.limit) parts.push(String(r.limit));
  if (r.classTag) parts.push(r.classTag);
  // 读侧：howMany / withShape / onEmpty 三段本就互不重复，照压
  if (r.howMany) parts.push(r.howMany);
  if (r.withShape) parts.push(r.withShape);
  if (r.onEmpty) parts.push(r.onEmpty);
  return parts.join('；');
}

/**
 * 10 个工具（顺序即注入顺序，也是 qa K2 的逐个点名顺序）。
 *
 * 每条字段：
 *   name        工具名（dtm_ 前缀）
 *   when        **注入用的一行**："什么时候调"（这是被批准的精简文案）
 *   description **给模型的工具描述**（可比 when 略详，但不得重复 when 已有的信息）
 *   target      执行落点：'engine' 直调引擎，'host' 走宿主方法（一个操作两个调用者）
 *   params      参数构造器（依赖 domain，故为函数）
 */
const DEFS = [
  /* ---------------- 1. dtm_bind ---------------- */
  {
    name: 'dtm_bind',
    when: '每次会话第一次读写记忆前，先问身份再绑定',
    description:
      '绑定本次会话的身份。**第一次读写记忆之前必须先问用户「这次会话我以什么名字负责」，'
      + '拿到回答立刻调本工具。**未绑定时写入被拒（`UNBOUND_IDENTITY`）、召回返空。' +
      '一次会话绑一次即可。',
    params: () => ({
      智能体: {
        type: 'string',
        required: true,
        description:
          '本次会话的身份名，**必须是用户明确告诉你的名字**。' +
          '问不到就继续问，不要自己起名；必须与之前用过的名字完全一致（改了就对不上旧记忆）。',
      },
      // 注意：**没有 `项目` 参数**（2026-11-08 硬性裁定）。
      // 项目由程序按会话工作目录自动填，模型无权决定。
    }),
  },

  /* ---------------- 2. dtm_write ---------------- */
  {
    name: 'dtm_write',
    // 判据不写在这里：入口表只回答「调哪个」，写不写由「什么情况该写」那节判。
    // 两处都写判据会导致模型看到两份措辞不同的标准。
    when: '判定值得长期留下时（见「什么情况该写」）',
    description:
      '追加一条记忆到库。只在值得长期留下时调。' +
      '只追加、不改旧条；不查重，所以不要先调 dtm_recall 确认再写，直接写。',
    // ctx 提供 networkText（现有标签网络），让模型写新条时能照着已有词填。
    params: (d, ctx) => ({
      主要内容: {
        type: 'string',
        required: true,
        description: '要记的那件事本身。一条只记一件事；不设字数上限，能整合就整合。',
      },
      形态: {
        type: 'string',
        required: true,
        enum: d.shapes,
        description:
          '6 选 1。' +
          '形态判错最难被召回：按「将来怎么找它」判，写时慎重。',
      },
      // 注意：**没有 `项目` / `智能体` 参数**（2026-11-08 硬性裁定）。
      // 归属由程序填：项目=会话工作目录名，智能体=绑定身份。这是环境事实，不是模型的判断。
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          // §4.2 说明表压缩版：保留全部**防误用**信息（三方向、不该打什么、
          // 数量区间、`|` 拒写），只去掉与后半句重复的措辞。
          // 完整说明在 标签字典.md 与 free-tag-rules.json；被拒时返回值还会再给一遍。
          //
          // 2026-11-11：末尾追加**标签共现网络**（用户裁定：写和读都直接给 wiki）。
          // 模型看一眼现有的网就知道新记忆该填什么词——不用背词表，也不用解释每个词。
          `${renderTagRules('write')} 召回主信号；程序做交集匹配，同义词由等价表归一。`
          + (ctx?.networkText ? `\n\n现有标签网络（每行一条记忆的标签，同行即相关；首词通常是类别）：\n${ctx.networkText}` : ''),
      },
      // 注意：**没有 `稳定性` 参数**（2026-11-08 硬性裁定）。
      // 首次落库恒为「观察」——此刻是模型单方面写下的，没经过系统性验证，
      // 自称「稳定」不算数。稳定性只由使用过程（时距累积 + feedback）经状态机事后演进。
      // 想改某条的稳定性用 `dtm_retag`（整理动作，须带依据）。
    }),
  },

  /* ---------------- 3. dtm_recall ---------------- */
  {
    name: 'dtm_recall',
    when: '提到「之前/上次/定过」、要做可能做过的事、说你漏了什么',
    description:
      '按标签召回记忆，返回候选 + 每条为什么被命中。' +
      '想浏览某形态的全部条目时，自由标签留空即可。',
    params: (d, ctx) => ({
      // 注意：**没有 `项目` / `智能体` 参数**（2026-11-08 硬性裁定）。
      // 查哪个项目、以谁的身份查，由程序填（工作目录名 + 绑定身份）。
      // 让模型填 `项目` 的后果实测过：它会填成主题词，和库里存的归属对不上，
      // 召回恒为空——看起来像「库坏了」，其实是查询条件错了。
      形态: {
        type: 'string',
        required: true,
        enum: d.shapes,
        description: '必填，这次想找哪类东西。不给则拒查。',
      },
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        description:
          // 读取侧：保留「给几个词 / 怎么配合形态 / 查空怎么办 / 留空=浏览」四条防误用信息，
          // 去掉与它们重复的「≤20 个离散标签」「同义词由程序归一」等复述。
          //
          // 2026-11-11：末尾追加**标签共现网络**。这是本次事故的正解——
          // 真实事故：查「改源码」撞空，而库里那条打的是「源码|生产端」。
          // 不是不想查，是不知道该用什么词。网络让模型一眼看到：
          // 「规矩|源码|生产端|同步|边界|改动落点」是一组，于是知道该用「源码」。
          // 库读不到时 networkText 为空串，描述自动退回原样，不影响工具可用。
          `${renderTagRules('read')} 直接给数组，不要给自然语言。留空=浏览该形态全部。`
          + (ctx?.networkText ? `\n\n现有标签网络（每行一条记忆的标签，同行即相关；按它挑词）：\n${ctx.networkText}` : ''),
      },
    }),
  },

  /* ---------------- 4. dtm_supersede ---------------- */
  {
    name: 'dtm_supersede',
    when: '被更好的一条顶替（写新条 + 旧条标「被取代」）',
    description:
      '用一条新记忆顶替旧条：写新条，旧条标为「被取代」。两条都留在库里，行不删。' +
      '只是想改旧条的标签、内容不变时用 dtm_retag，不要用这个。',
    params: (d) => ({
      旧编号: {
        type: 'string',
        required: true,
        description: '被顶替条目的编号，形如 M-20261105-003。',
      },
      主要内容: {
        type: 'string',
        required: true,
        description: '新的那件事本身（在旧条基础上修正后的完整表述）。',
      },
      形态: {
        type: 'string',
        required: true,
        enum: d.shapes,
        description: `新条的形态，6 选 1。`,
      },
      // 注意：**没有 项目/智能体 参数**（2026-11-12 P1-9，与 write/recall 同裁定）。
      // 新条归属由程序沿用旧条——顶替是同一条记忆的新版本，不是搬家。
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '新条的自由标签，1~20 个离散词，不能含 |。',
      },
      basis: {
        type: 'string',
        description: '依据：为什么要顶替（哪条读写记录 / 用户哪句话）。省略时记为 user_request。',
      },
    }),
  },

  /* ---------------- 5. dtm_archive ---------------- */
  {
    name: 'dtm_archive',
    when: '不用了但没新条顶替（标「已归档」）',
    description:
      '让一条记忆退场：标记为「已归档」，行不删、以后翻得回来。' +
      '有新的条顶替它时用 dtm_supersede，不要用这个。',
    params: () => ({
      编号: { type: 'string', required: true, description: '要退场的条目编号。' },
      basis: {
        type: 'string',
        description: '依据：为什么不再需要（哪条读写记录 / 用户哪句话）。省略时记为 user_request。',
      },
    }),
  },

  /* ---------------- 6. dtm_retag ---------------- */
  {
    name: 'dtm_retag',
    when: '改某条的 形态/自由标签/稳定性/状态（须带依据）',
    description:
      '改某条记忆的标签字段。属整理动作：**必须给依据**，没有依据不许改。' +
      '编号、主要内容、时距不可改——那是唯一标识、一手材料和程序计数器。' +
      '项目/智能体也不可由模型改（归属是环境事实，2026-11-12）。' +
      '**只传要改的字段；省略的字段 = 不改**（不是清空）。',
    params: (d) => ({
      编号: { type: 'string', required: true, description: '要改的条目编号。' },
      basis: {
        type: 'string',
        required: true,
        description:
          '依据：哪条读写记录支持这次改动（如 read.jsonl#2026-11-03T22:11）。' +
          '没有依据就不许改标签——这是硬要求，缺了会被拒。',
      },
      形态: { type: 'string', enum: d.shapes, description: '新形态。' },
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        description: '新的完整标签数组（整体替换，不是增量）；传空数组=想清空，会被拒绝。',
      },
      稳定性: { type: 'string', enum: d.stabilities, description: '新稳定性。' },
    }),
  },

  /* ---------------- 7. dtm_review ---------------- */
  {
    name: 'dtm_review',
    when: '复查一批条目 / 整理时通览候选（只读为主）',
    description:
      '只读地通览一批条目，整理时用来找候选。不改任何条目、不计时距、不写读取台账。' +
      '所有筛选条件省略=不限。',
    params: (d) => ({
      形态: { type: 'string', enum: d.shapes, description: '只看这个形态。' },
      // 注意：**没有 项目/智能体 参数**（2026-11-12 P1-18）。
      // 工具通道由宿主按当前归属隔离，模型不能借 review 读别的项目/身份的记忆。
      状态: {
        type: 'string',
        enum: d.statuses,
        description: '只看这个状态（含 被取代/已归档，整理时可看清全貌）。',
      },
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        description: '只列出含这些标签中任意一个的条目。',
      },
      limit: { type: 'integer', description: '最多返回多少条，默认 20。' },
      offset: { type: 'integer', description: '跳过前多少条，默认 0。' },
    }),
  },

  /* ---------------- 8. dtm_records ---------------- */
  {
    name: 'dtm_records',
    when: '查读写/整理的台账记录',
    description: '查 records/{write,read,tidy}.jsonl 台账，用于追根因与审计。只读。',
    params: (d) => ({
      kind: {
        type: 'string',
        required: true,
        enum: ['write', 'read', 'tidy'],
        description: '查哪本台账：write=写入、read=读取、tidy=整理。',
      },
      limit: { type: 'integer', description: '最近多少条，默认 20。' },
      onlyFailed: {
        type: 'boolean',
        description: '只列失败记录（write 的 ok=false 等）。默认 false。',
      },
    }),
  },

  /* ---------------- 9. dtm_export ---------------- */
  {
    name: 'dtm_export',
    when: '导出记忆（库本体就是 CSV）',
    description:
      '把记忆库导出成 CSV。库本体就是 CSV，导出的就是原文件，可直接看或交接。与 UI 导出是同一能力。',
    params: () => ({
      path: {
        type: 'string',
        description:
          '目标文件路径。省略=备份目录下的带时间戳文件名。' +
          '只能写在数据目录/备份目录/台账目录内（越界报 PATH_NOT_ALLOWED）；不覆盖既有文件（报 EXPORT_TARGET_EXISTS）。',
      },
    }),
  },

  /* ---------------- 10. dtm_merge ---------------- */
  {
    name: 'dtm_merge',
    when: '合并两份记忆库（搬家/导入导出）',
    description:
      '把另一份记忆库合并进当前库：编号唯一，同号保留较新的，行只追加。合并前自动备份。',
    params: () => ({
      path: {
        type: 'string',
        required: true,
        description:
          '要合并进来的 CSV 文件路径。必须在数据目录/备份目录/台账目录内（越界报 PATH_NOT_ALLOWED）。' +
          '跨库交接先用 dtm_export 导出到数据目录，再 merge 该文件。',
      },
      dryRun: {
        type: 'boolean',
        description: '只报告将要发生的变更，不落盘。默认 false。',
      },
    }),
  },
];

/** 10 个工具的规范名（qa K1/K2/K3 与注入 L1 共用同一份） */
export const TOOL_NAMES = DEFS.map((d) => d.name);

/**
 * 注入用的工具入口行 `{name, when}`。
 *
 * **与工具定义同源**（都取自 DEFS）——这是"一个 `dtm_*` 入口都不能缺"的结构性保证：
 * 增删工具时注入自动跟着变，不可能出现"注册了但注入里没提"或反之。
 */
export const TOOL_WHENS = DEFS.map((d) => ({ name: d.name, when: d.when }));

/**
 * 构造工具定义（把取值域注入参数 schema）。
 *
 * 只产出 `ctx.tools.register()` 真正会读的四个字段：name / when / description / parameters。
 * 早先还带 `target` / `engineFn` / `hostMethod` / `category`，但**没有任何消费方**，
 * 且 `target` 的值是错的——标 `'engine'` 的四个工具（write/recall/review/records）
 * 实际全部经 `callHost()` 走宿主方法。留着只会误导后来者，故删除。
 *
 * @param {{shapes:string[], stabilities:string[], statuses:string[]}} domain
 *        来自 engine 的 `templates/schema.json`（由 preset 的 `domainFor()` 同步读出）
 * @param {object} [options]
 * @param {string} [options.libraryCsv] 库 CSV 绝对路径。给了就生成**标签共现网络**
 *        并渲染进 `dtm_write` / `dtm_recall` 的 `自由标签` 描述（2026-11-11）。
 *        不给 / 读失败 → 不渲染网络，其余一切照旧。engine 不猜数据目录，
 *        路径必须由 host 传（同 Lead 裁决 3）。
 * @param {{project?:string, agent?:string}} [options.view]
 *        当前视角。网络只含 `(项目∈{当前,通用}) AND (智能体∈{当前,通用})` 的条目
 *        （用户 2026-11-11 明确）。缺省视为空串，此时只有「通用」条目进网络。
 * @returns {Array<{name,when,description,parameters}>}
 */
export function buildToolDefs(domain, { libraryCsv, view } = {}) {
  const d = {
    shapes: Array.isArray(domain?.shapes) && domain.shapes.length > 0 ? domain.shapes : Object.keys(SHAPE_HINTS),
    stabilities: Array.isArray(domain?.stabilities) ? domain.stabilities : ['观察', '稳定', '易变'],
    statuses: Array.isArray(domain?.statuses) ? domain.statuses : ['生效', '被取代', '已归档'],
  };

  // 网络是可选增强：算不出来就空串，绝不因为读库失败让工具注册失败。
  const networkText = renderNetworkFromLibrary(libraryCsv, view);

  return DEFS.map((def) => ({
    name: def.name,
    when: def.when,
    description: def.description,
    parameters: def.params(d, { networkText }),
  }));
}
