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
 */

/** 官方 6 形态的判据（prose，无法进 schema.json，故由 preset 持有） */
export const SHAPE_HINTS = {
  技能: '单件事怎么做',
  流程: '多件事次序',
  规则: '必须/禁止',
  偏好: '喜欢/倾向',
  事实: '客观陈述',
  模板: '可复用格式/清单',
};

/** `通用` / `引入` 的语义（《功能说明》§9.2：两者可见性同、语义不同，不许混用） */
export const UNIVERSAL_HINT =
  '`通用`=所有项目/身份都该知道（一个判断结论）；`引入`=外面搬来的、来源没写归属。' +
  '不知道归属填 `引入`，别填 `通用`。';

/** 工具分类：写入只追加、读取只读、改库全归整理（《功能说明》§十二 末句） */
export const TOOL_CATEGORY = {
  dtm_bind: 'write',
  dtm_write: 'write',
  dtm_recall: 'read',
  dtm_supersede: 'tidy',
  dtm_archive: 'tidy',
  dtm_retag: 'tidy',
  dtm_review: 'read',
  dtm_records: 'read',
  dtm_export: 'tidy',
  dtm_merge: 'tidy',
};

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
    when: '未绑定身份时，绑定「我是谁」',
    description:
      '绑定本次会话的身份。用户自报身份、或回答了你的身份提问后调一次即可。' +
      '未绑定时写入会被拒、召回返回空，所以这是读写记忆的前置条件。',
    target: 'host',
    hostMethod: 'bindIdentity',
    params: () => ({
      智能体: {
        type: 'string',
        required: true,
        description:
          '本次会话的身份名。必须与之前用过的名字完全一致——改了就对不上旧记忆。' +
          '不知道用什么名字时，先问用户。',
      },
      项目: {
        type: 'string',
        required: true,
        description:
          '当前项目名=本次会话的工作目录名，原样照抄，别改写/缩写/翻译。' +
          '跨项目通用才填「通用」；外面搬来、来源没写归属填「引入」。' +
          '拿不准就问用户，别猜——程序不会替你补这个值。',
      },
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
    target: 'engine',
    engineFn: 'writeMemory',
    params: (d) => ({
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
          `这条是哪种东西，6 选 1：${d.shapes.map((s) => `${s}=${SHAPE_HINTS[s] ?? ''}`).join('；')}。` +
          '形态判错最难被召回，写时慎重。',
      },
      项目: {
        type: 'string',
        required: true,
        description:
          '这条属于哪个项目。' + UNIVERSAL_HINT +
          ' 注意项目≠主题分类："这条讲什么"不是项目，"这条属于谁的活儿"才是。' +
          '拿不准就问用户，别猜——程序不会替你补这个值。',
      },
      智能体: {
        type: 'string',
        required: true,
        description: '这条属于哪个身份（通常是当前绑定身份名）。' + UNIVERSAL_HINT,
      },
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          '召回主信号，1~20 个离散词。从三个方向拆：作用（它帮解决什么）、'
          + '注意事项（容易踩的坑/约束）、内容关键词（正文里会出现的实词）。'
          + '短词优于长句，一个标签一个概念。不能含 |（竖线，库文件里用于分隔多个标签）。',
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
    target: 'engine',
    engineFn: 'recallMemory',
    params: (d) => ({
      项目: {
        type: 'string',
        required: true,
        description: '硬筛：只看这个项目可见的条目。照当前项目填，别猜。',
      },
      智能体: {
        type: 'string',
        required: true,
        description: '硬筛：只看这个身份可见的条目。照当前绑定身份填。',
      },
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
          '≤20 个离散标签，直接给数组，不要给自然语言。程序做交集匹配，同义词由程序归一。'
          + '留空=浏览该形态下全部生效条目。',
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
    target: 'host',
    hostMethod: 'supersedeEntry',
    params: (d) => ({
      旧编号: {
        type: 'string',
        required: true,
        description: '被顶替条目的编号，形如 M-20261105-003。',
      },
      主要内容: {
        type: 'string',
        required: true,
        description: '新的那件事本身（通常是在旧条基础上修正后的完整表述）。',
      },
      形态: {
        type: 'string',
        required: true,
        enum: d.shapes,
        description: `新条的形态，6 选 1：${d.shapes.join(' / ')}。`,
      },
      项目: { type: 'string', description: '新条属于哪个项目。省略=旧条的项目。' },
      智能体: { type: 'string', description: '新条属于哪个身份。省略=旧条的智能体。' },
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
    target: 'host',
    hostMethod: 'archiveEntry',
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
    when: '改某条的 形态/项目/智能体/自由标签/稳定性（须带依据）',
    description:
      '改某条记忆的标签字段。属整理动作：**必须给依据**，没有依据不许改。' +
      '编号、主要内容、时距不可改——那是唯一标识、一手材料和程序计数器。',
    target: 'host',
    hostMethod: 'retagEntry',
    params: (d) => ({
      编号: { type: 'string', required: true, description: '要改的条目编号。' },
      basis: {
        type: 'string',
        required: true,
        description:
          '依据：哪条读写记录支持这次改动（如 read.jsonl#2026-11-03T22:11）。' +
          '没有依据就不许改标签——这是硬要求，缺了会被拒。',
      },
      形态: { type: 'string', enum: d.shapes, description: '新形态。**省略=不改**（不需要传原值）。' },
      项目: { type: 'string', description: '新项目。**省略=不改**（不需要传原值）。' },
      智能体: { type: 'string', description: '新智能体。**省略=不改**（不需要传原值）。' },
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        description: '新的完整标签数组（不是增量，会整体替换）。**省略=不改**（不需要传原值）；传空数组 = 想清空，会被拒绝。',
      },
      稳定性: { type: 'string', enum: d.stabilities, description: '新稳定性。**省略=不改**（不需要传原值）。' },
    }),
  },

  /* ---------------- 7. dtm_review ---------------- */
  {
    name: 'dtm_review',
    when: '复查一批条目 / 整理时通览候选（只读为主）',
    description:
      '只读地通览一批条目，整理时用来找候选。不改任何条目、不计时距、不写读取台账。',
    target: 'engine',
    engineFn: 'listMemory',
    params: (d) => ({
      形态: { type: 'string', enum: d.shapes, description: '只看这个形态。省略=不限。' },
      项目: { type: 'string', description: '只看这个项目。省略=不限。' },
      智能体: { type: 'string', description: '只看这个身份。省略=不限。' },
      状态: {
        type: 'string',
        enum: d.statuses,
        description: `只看这个状态。省略=不限（含 被取代/已归档，整理时能看清全貌）。`,
      },
      自由标签: {
        type: 'array',
        items: { type: 'string' },
        description: '只列出含这些标签中任意一个的条目。省略=不按标签过滤。',
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
    target: 'engine',
    engineFn: 'readRecords',
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
      '把记忆库导出成 CSV 文件。库本体就是 CSV，导出的就是原文件，可直接给人看或交接。' +
      '与 UI 里的导出是同一个能力。',
    target: 'host',
    hostMethod: 'exportLibrary',
    params: () => ({
      path: {
        type: 'string',
        description: '目标文件路径。省略=数据目录 export/ 下的带时间戳文件名。',
      },
    }),
  },

  /* ---------------- 10. dtm_merge ---------------- */
  {
    name: 'dtm_merge',
    when: '合并两份记忆库（搬家/导入导出）',
    description:
      '把另一份记忆库合并进当前库：编号唯一，同号保留较新的，行只追加。合并前自动备份。',
    target: 'host',
    hostMethod: 'mergeLibrary',
    params: () => ({
      path: { type: 'string', required: true, description: '要合并进来的 CSV 文件路径。' },
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
 * @param {{shapes:string[], stabilities:string[], statuses:string[]}} domain
 *        来自 engine 的 `templates/schema.json`（经 Config 覆盖后的最终值）
 * @returns {Array<{name,when,description,target,engineFn?,hostMethod?,parameters}>}
 */
export function buildToolDefs(domain) {
  const d = {
    shapes: Array.isArray(domain?.shapes) && domain.shapes.length > 0 ? domain.shapes : Object.keys(SHAPE_HINTS),
    stabilities: Array.isArray(domain?.stabilities) ? domain.stabilities : ['观察', '稳定', '易变'],
    statuses: Array.isArray(domain?.statuses) ? domain.statuses : ['生效', '被取代', '已归档'],
  };

  return DEFS.map((def) => ({
    name: def.name,
    when: def.when,
    description: def.description,
    target: def.target,
    engineFn: def.engineFn,
    hostMethod: def.hostMethod,
    category: TOOL_CATEGORY[def.name],
    parameters: def.params(d),
  }));
}
