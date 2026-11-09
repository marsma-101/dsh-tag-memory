/**
 * index.js — 宿主入口（Host plugin）
 *
 * 一个插件，一份引擎，三个入口。本文件是**宿主入口**：
 *   · 数据目录解析（4 级优先级）
 *   · store/memory.csv 落盘、records/*.jsonl 台账追加
 *   · 宿主方法（**一个操作、两个调用者**：UI 与工具共用同一实现）
 *   · 会话身份投影（ctx.sessionProjections，不是内存 map）
 *   · 定时任务（setInterval + .unref()）
 *   · 客户端调用入口（Client-callable Remote，不是自建 HTTP）
 *
 * 边界（《接口契约》§一）：
 *   ✅ 调 engine、管 ctx、落盘调度、锁、身份投影、定时
 *   ❌ 不实现业务规则——校验在 write.mjs、打分/闸门/隔离在 read.mjs、取号在 core.mjs
 *   ❌ 不自己写 CSV 解析——只调 core.mjs
 *   ❌ 不自建 HTTP 前缀、不自做鉴权（走官方 Client-callable Remote 入口）
 *
 * ════════════════════════════════════════════════════════════════════
 *  宿主方法契约（client-dev 按这段写 $mount spec；preset-dev 按这段调）
 * ════════════════════════════════════════════════════════════════════
 *
 * 服务名：`dtmHost`（`ctx.get('dtmHost')`）
 * Remote namespace：`tagMemory`（`ctx.remote.tagMemory.<method>()`）
 *
 * ── 工具侧 + UI 侧共用（同一实现，不许分开写）──────────────────────
 *
 * retagEntry({ 编号, patch, basis, who?, before? }) → {
 *     ok, 编号, before, after, changed, backupHint? }
 *   patch 只允许 6 个键：形态 / 项目 / 智能体 / 自由标签 / 稳定性 / 状态
 *   其余键（主要内容 / 编号 / 时距）一律拒：{ ok:false, code:'FIELD_NOT_EDITABLE' }
 *   basis 必填（《流程_整理》§七：没有依据的改动不允许做）
 *   who 为 null 时台账记 “（用户手动）”
 *
 * ── 工具侧（preset-dev）──────────────────────────────────────────
 *
 * bindIdentity(agent, { 智能体, 项目 }) → { 智能体, 项目 }
 * identityOf(agent) → { 智能体, 项目 } | null
 * identityOfSync(agent) → { 智能体, 项目 } | null     （注入渲染用，绝不抛错）
 * writeEntry(agent, { 主要内容, 形态, 项目, 智能体, 自由标签 }) → { ok, id, 编号, 项目 } |
 *                                                     { ok:false, blocked:'UNBOUND_IDENTITY' }
 * recall(agent, { 项目, 智能体, 形态, 自由标签 }) → {
 *     hits, near, total, filtered, passed, vetoed, echo, empty, blocked, browseMode }
 * supersedeEntry(agent, { 旧编号, 主要内容, 形态, 项目, 智能体, 自由标签, basis }) → {
 *     ok, 编号, 旧编号, backupPath, changed }
 * archiveEntry(agent, { 编号, basis }) → { ok, 编号, backupPath, changed }
 * listEntries({ 形态, 项目, 智能体, 状态, 自由标签, limit, offset }) → {
 *     items, rows, total }        // rows 是 items 的别名（preset 用 rows）
 * readRecords({ kind, limit, onlyFailed }) → { items, errors }
 * exportLibrary({ path }) → { ok, path, count, bytes }
 * mergeLibrary({ path, dryRun }) → { ok, changed, added, conflicts, backupPath }
 *
 * ── UI 侧（client-dev）───────────────────────────────────────────
 *
 * getOverview() → { total, active, superseded, archived, dataDir, dataDirSource }
 * getFacets()   → { 项目:[], 智能体:[], 形态:[], 状态:[], 稳定性:[] }
 * getSettings() → { dataDir, dataDirSource, dataDirLocked, dataDirLockedHint,
 *                   backupAuto, lastBackupAt, tidyAuto, tidyFrequency,
 *                   dictText, libraryCount, schemaVersion }
 * migrateDataDir({ target }) → { ok, from, to, moved } |
 *                              { ok:false, code:'DATA_DIR_LOCKED', details:{source,where} }
 * backupNow()   → { ok, path, bytes, records }
 * restore({ from }) → { ok, records, backupPathBefore }
 * listBackups() → { backups: [{name,path,bytes,mtime}] }
 *
 * ⚠️ 返回值 JSON 安全硬约束（Remote 的 encodeRuntimeResult 会递归检查）：
 *    可选字段一律给 `null` 而不是 `undefined`；数组一律 `[]` 而不是 `undefined`。
 *    `undefined` 会让宿主侧 encode 直接抛错。
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import {
  resolveDataDir,
  layoutOf,
  withFileLock,
  readLibraryCsv,
  appendRecordCsv,
  replaceRecordCsv,
  writeLibraryCsv,
  appendJsonl,
  readJsonl,
  localIsoString,
} from './lib/engine/core.mjs';

import { buildNewRecord, buildWriteLog } from './lib/engine/write.mjs';
import { recall as engineRecall, buildReadLog } from './lib/engine/read.mjs';
import { applyTick } from './lib/engine/tick.mjs';
import { backupLibrary, listBackups as engineListBackups, restoreBackup } from './lib/engine/backup.mjs';
import { planTidy } from './lib/engine/tidy.mjs';
import { isBackupDue, isTidyDue } from './lib/engine/schedule.mjs';
import { canMigrate, verifyMigration } from './lib/engine/migrate.mjs';
import {
  loadSchema,
  loadScoring,
  loadTagEquivalence,
  loadTagDictText,
} from './lib/engine/dict.mjs';

/** 宿主服务名（preset/tools.js 里的 HOST_SERVICE 必须与之一致）。 */
export const SERVICE_NAME = 'dtmHost';

/** Remote 线协议命名空间（client-dev 按这个挂）。 */
export const REMOTE_NAMESPACE = 'tagMemory';

/* ------------------------------------------------------------------ *
 * Remote 方法表：唯一数据源
 *
 * ⚠️ 这个表有两个消费者，必须同步：
 *   ① createHostService —— 把方法镜像到 HostServiceProto（gateway 要求方法在原型链上）
 *   ② registerRemote    —— 生成 marker 符号描述符（gateway 只从这里发现端点）
 *
 * 原来两处各写一份，改了一处另一处不生效。
 * 实测踩过（2026-11-06）：新增 exportLibrary / listExportTargets 后端点一直 404，
 * 因为只改了镜像层、没改 marker 层 —— 而只有 marker 层决定端点能不能被调到。
 *
 * 参数名必须与 client.js 的 spec 逐字一致；且 gateway 用 Function.toString() 解析，
 * 只认纯标识符（不允许解构 / 默认值 / rest）。
 * ------------------------------------------------------------------ */
export const REMOTE_SIGNATURES = Object.freeze({
  getOverview: [],
  getFacets: [],
  getSettings: [],
  backupNow: [],
  listBackups: [],
  listExportTargets: [],
  listEntries: ['query'],
  retagEntry: ['request'],
  migrateDataDir: ['request'],
  restore: ['request'],
  mergeLibrary: ['request'],
  runTidy: ['request'],
  exportLibrary: ['request'],
});

/** Remote 方法名列表（顺序稳定，供两个消费者共用）。 */
export const REMOTE_METHOD_NAMES = Object.freeze(Object.keys(REMOTE_SIGNATURES));

/** 允许用户手动改的 6 个字段（《功能说明》§10.3）。 */
const EDITABLE_FIELDS = ['形态', '项目', '智能体', '自由标签', '稳定性', '状态'];

/** 绝不可改的 3 个字段——出现即拒，且要点名（不信任前端）。 */
const READONLY_FIELDS = ['编号', '主要内容', '时距'];

/** 包根目录（index.js 就在包根）。 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** records 台账三种 kind → 文件名。 */
const RECORD_FILES = { write: 'write.jsonl', read: 'read.jsonl', tidy: 'tidy.jsonl' };

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 取字符串，缺省给空串（绝不返回 undefined）。 */
const str = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());

/** 取字符串或 null（可选字段用，保证 JSON 安全）。 */
const strOrNull = (v) => {
  const s = str(v);
  return s === '' ? null : s;
};

/** 数组兜底。 */
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * engine 的错误数组 → 统一失败结果。
 * 第一条的 message 原样保留（`TAG_CONTAINS_PIPE` 必须点名到具体标签，任何一层都不许改写）。
 */
function fail(errors, code) {
  const list = arr(errors);
  return {
    ok: false,
    code: code ?? list[0]?.code ?? 'UNKNOWN',
    errors: list,
    message: list[0]?.message ?? '未知失败',
  };
}

/**
 * 构造一个“非 engine 来源”的失败结果（宿主自己判出来的：缺编号、缺 basis、字段不可改…）。
 *
 * ⚠️ **必须带 `errors:[{code, field, message}]`**：preset 的 `callHost` 在
 * `ok:false` 时走 `failFromErrors(result.errors, ...)`，只给 message 会被渲染成
 * “参数不合法”——把明确的业务原因误报成“参数写错了”，模型会去改本来正确的参数。
 * 这个坑我对三种情况都踩过（未绑定 / 缺 basis / 缺编号），统一走这个函数。
 */
function reject(code, message, field = null) {
  return {
    ok: false,
    code,
    errors: [{ code, field, message }],
    message,
  };
}

/* ------------------------------------------------------------------ *
 * apply —— 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const service = createHostService(ctx, config);
  ctx.provide(SERVICE_NAME, service);
  registerIdentityProjection(ctx);
  registerTimer(ctx, service, config);

  // Remote 通道（UI 调宿主）。失败 **不能影响工具链路** —— 吞掉并记日志，
  // 由 client 侧显示「未接线」而不是整插件挂掉。
  //
  // ⚠️ 不能同步调 registerRemote！cordis 的 reflect.get(name, strict=true) 要求
  // impl.fiber.state === 2（ACTIVE）才返回服务；apply() 执行时本插件 fiber 还在
  // 加载中，ctx.get('typert') 拿到 undefined，注册被静默跳过 ——
  // 表现就是「代码在、端点不存在」，客户端 $mount 成功但请求 404。
  //
  // 正确做法：ctx.inject 声明依赖 typert，框架等该服务就绪后再跑回调。
  ctx.inject(['typert'], (typertCtx) => {
    registerRemote(typertCtx, service).catch((err) => {
      ctx.logger?.warn?.(
        '[dsh-tag-memory] Remote 注册失败（UI 将不可用，工具不受影响）：',
        err?.message ?? err,
      );
    });
  });

  return () => {
    try {
      service._dispose();
    } catch {
      /* 卸载期忽略 */
    }
  };
}

/* ------------------------------------------------------------------ *
 * 宿主服务（所有方法都在这；UI 与工具**共用同一实现**）
 * ------------------------------------------------------------------ */

function createHostService(ctx, config) {
  /** 缓存：schema / scoring / equivalence（dict.mjs 自带 mtime 热更新）。 */
  let cfgCache = null;
  /** 定时任务句柄。 */
  let timer = null;
  /** 上次备份时间（settings 里展示）。 */
  let lastBackupAt = null;

  /**
   * 解析数据目录 —— 5 级优先级
   * （①config ②env ③设置页 ④$DSH_HOME/tag-memory ⑤插件包内）。
   * 返回 { layout, source, locked, lockedHint, warning }。
   */
  async function resolveLayout() {
    const settingsDir = await readSettingsDir();
    const resolved = resolveDataDir({
      configDir: config?.dataDir,
      envDir: process.env.DSH_TAG_MEMORY_DATA_DIR,
      settingsDir,
      dshHomeDir: currentDshHome(),
      packageDir: PACKAGE_DIR,
    });
    const locked = resolved.source === 'config' || resolved.source === 'env';
    const source = resolved.source;
    if (source === 'package') warnPackageFallbackOnce(resolved.dir);
    return {
      layout: layoutOf(resolved.dir),
      source,
      locked,
      lockedHint: locked ? lockedHintOf(source) : null,
      warning: packageFallbackWarning(source, resolved.dir),
    };
  }

  /**
   * DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`（与 @deepseek-ai/dsh-home-paths 一致）。
   *
   * ⚠️ 刻意**不 import** `@deepseek-ai/dsh-home-paths`：engine 零框架依赖是硬约束，
   * 而这段逻辑只有 3 行。行为对齐官方口径即可（空/纯空白视为未设置）。
   */
  function currentDshHome() {
    const fromEnv = str(process.env.DSH_HOME);
    if (fromEnv !== '') return path.resolve(fromEnv);
    try {
      return path.join(os.homedir(), '.dsh');
    } catch {
      return null; // 拿不到 HOME → 让 resolveDataDir 落到 ⑤ 包内 + 告警
    }
  }

  /** ⑤ 包内兜底的告警文案（UI 与日志共用同一句话，避免两处不一致）。 */
  function packageFallbackWarning(source, dir) {
    if (source !== 'package') return null;
    return (
      `数据目录落在插件包内（${dir}）——**pnpm 重装或升级插件会整个删除这个目录，数据会丢**。` +
      '请把 cordis.patch.yml 里本插件的 config.dataDir 指到包外（例如 $DSH_HOME/tag-memory）。'
    );
  }

  /**
   * ⑤ 包内兜底只在**进程内打一次**日志。
   *
   * 为什么只打一次：`resolveLayout()` 几乎每个方法都调（20+ 处），
   * 每次调用都 warn 会把日志刷爆，反而让人忽略这条最重要的告警。
   */
  let packageFallbackWarned = false;
  function warnPackageFallbackOnce(dir) {
    if (packageFallbackWarned) return;
    packageFallbackWarned = true;
    ctx.logger?.warn?.(
      '[dsh-tag-memory] ⚠️ 数据目录落在插件包内（%s）：pnpm 重装/升级会整个删除该目录，数据会丢。' +
        '请把 cordis.patch.yml 的 config.dataDir 指到包外（例如 $DSH_HOME/tag-memory）。',
      dir,
    );
  }

  /** 锁定时告诉用户**改哪一行**（《功能说明》§10.5 明确要求）。 */
  function lockedHintOf(source) {
    if (source === 'config') {
      return '数据目录被 profile 配置锁定：改 cordis.patch.yml 里本插件那一行的 config.dataDir 才会生效（设置页搬家不起作用）。';
    }
    return '数据目录被环境变量 DSH_TAG_MEMORY_DATA_DIR 锁定：清掉这个环境变量之后，设置页搬家才会生效。';
  }

  /**
   * 身份兜底缓存（进程内，WeakMap keyed by agent 对象）。
   *
   * 为什么需要：正常路径下身份由 session 投影从既有事件（`tool/call` / `command/run`）
   * fold 出来，resume/fork 都能重建。但投影**只对真正走过会话事件流的调用**有效；
   * 宿主方法被直接调用（或工具调用尚未在投影中体现）时投影恒为空，
   * 会导致 `identityOf` 永远 null、**所有写入被拒**。
   * 装进真容器后实测到过这个缺陷（bindIdentity 返回 ok，但 writeEntry 报 UNBOUND_IDENTITY）。
   *
   * 用 WeakMap：不污染会话日志、agent 回收即失效；投影有值时**投影优先**。
   */
  const identityFallback = new WeakMap();

  /**
   * 确保数据目录骨架存在（store / records / backup）。
   *
   * ⚠️ 必须在 `withFileLock` **之前**调用：锁是 `open(lockPath,'wx')`，
   * 而 lockPath 在 `store/` 下——目录不存在会直接 ENOENT（全新安装时必然发生）。
   * `appendRecordCsv` 自己会 mkdir，但那是在锁内、已经太晚。
   */
  async function ensureDirs(layout) {
    await fsp.mkdir(layout.storeDir, { recursive: true });
    await fsp.mkdir(layout.recordsDir, { recursive: true });
  }

  /** 设置页选的库位置：<包根>/config/data-dir.json。读不到就当没选。 */
  async function readSettingsDir() {
    const file = path.join(PACKAGE_DIR, 'config', 'data-dir.json');
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const obj = JSON.parse(raw);
      return typeof obj?.dataDir === 'string' ? obj.dataDir : null;
    } catch {
      return null;
    }
  }

  /** 写设置页的库位置。 */
  async function writeSettingsDir(target) {
    const dir = path.join(PACKAGE_DIR, 'config');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'data-dir.json'), `${JSON.stringify({ dataDir: target }, null, 2)}\n`, 'utf8');
  }

  /** 取三份配置（有缓存，templates 改了会自动重读）。 */
  async function loadConfigs() {
    if (cfgCache) return cfgCache;
    const baseDir = path.join(PACKAGE_DIR, 'lib', 'engine', 'templates');
    const schema = await loadSchema({ baseDir, overrides: config?.schema });
    const scoring = await loadScoring({ baseDir, overrides: config?.scoring });
    const equivalence = await loadTagEquivalence({ baseDir, overrides: config?.equivalence });
    cfgCache = { schema, scoring, equivalence, baseDir };
    return cfgCache;
  }

  /** 追加一条台账（调用方已决定写什么）。 */
  async function appendRecord(kind, obj) {
    const name = RECORD_FILES[kind];
    if (!name) return reject('RECORD_KIND_INVALID', `未知台账类型：${kind}`);
    const { layout } = await resolveLayout();
    const file = path.join(layout.recordsDir, name);
    await appendJsonl(file, obj);
    return { ok: true, kind, path: file };
  }

  /** 写一条 tidy 台账（整理动作 / 用户手动改）。 */
  async function writeTidyLog({ who, action, target, before, after, basis }) {
    return appendRecord('tidy', {
      ts: localIsoString(new Date()),
      who: who ?? '（用户手动）',
      action,
      target,
      before: before ?? null,
      after: after ?? null,
      basis: basis ?? null,
    });
  }

  /* ---------------- 身份 ---------------- */

  /**
   * 绑定身份。
   *
   * ⚠️ **不 append 任何自造的 session 事件**——`practices.md:21` 明确禁止新 event type
   * （`Session.append()` 无法设置 `ignorable: true`，会话会拒绝重开）。
   *
   * 身份的两条来源：
   *   1. **投影优先**（正路）：工具侧的 `tool/call`(name='dtm_bind') 与
   *      UI 侧的 `command/run`(name='dtm-bind') 都是**既有**事件，投影从中 fold 出身份，
   *      resume/fork 可重建。工具/命令调用时事件已经进日志，所以正常路径不需要这里写任何东西。
   *   2. **进程内兜底**（本函数的职责）：当调用方**不是**经由 tool/command 进来时
   *      （例如宿主方法被直接调用、或工具调用尚未在投影里体现），投影读不到身份。
   *      这时必须有一条进程内的绑定记录，否则 `identityOf` 恒为 null，
   *      **所有写入都会被拒**——这是装进真容器后实测到的缺陷
   *      （`bindIdentity` 返回 ok:true，但紧接着 `writeEntry` 报 UNBOUND_IDENTITY）。
   *
   * 兜底用 WeakMap keyed by agent 对象：不污染会话日志、进程退出即失效，
   * 与"session log 是唯一真相源"不冲突——它只是投影不可用时的**同进程缓存**。
   * 一旦投影能读到身份，投影值优先（见 identityOfSync）。
   */
  function bindIdentity(agent, { 智能体, 项目 } = {}) {
    const who = str(智能体);
    if (who === '') {
      return {
        ok: false,
        code: 'AGENT_EMPTY',
        message: '智能体 不能为空：不知道“我是谁”就不读写记忆。先问用户这次会话以什么名字负责。',
      };
    }
    // 项目由程序取工作目录名（2026-11-08 硬性裁定），模型传的 `项目` 一律忽略。
    // 保留形参只是为了兼容旧调用方，值不采纳。
    const programProject = projectOfSync(agent) || str(项目);
    // 进程内兜底：key 是 agent 对象本身；没有 agent 时不缓存（无从归属）。
    if (agent && typeof agent === 'object') {
      identityFallback.set(agent, { 智能体: who, 项目: programProject });
    }
    return { ok: true, 智能体: who, 项目: programProject };
  }

  /**
   * 读当前会话身份（同步）。
   *
   * 用 `ctx.sessionProjections.stateOf()` 读投影状态——**不是内存 map**，
   * 所以 resume / fork 后仍然正确（《架构说明》§十）。
   */
  function identityOfSync(agent) {
    try {
      // ⚠️ **进程内绑定优先，投影兜底**（2026-11-08 修正，此前顺序相反）。
      //
      // 为什么必须这个顺序：`bindIdentity` 不 append 自造事件（`practices.md:21`
      // 禁止新 event type），所以它只写进程内 WeakMap。而投影是从**既有事件**
      // （`tool/call`、`command/run`）fold 出来的。
      //
      // 旧顺序（投影优先）在真实容器里会出一个死结：会话里已经 fold 出一个身份
      // （比如上一次 `dtm_bind` 留下的 `qa-agent`），用户这次调 `dtm_bind` 换一个
      // 名字，WeakMap 写了新值，但 `identityOfSync` 先读投影、拿到旧值，
      // **新绑定被静默丢弃**——表现为"绑了没生效，写进去还是旧身份"。
      // F1b 测试就是这么发现的。
      //
      // 反过来（WeakMap 优先）是对的：WeakMap 里的值就是本次会话**最近一次
      // 显式 `dtm_bind`** 的结果，语义上比投影里的历史值更新。
      // 投影仍然重要——它让 resume/fork 后身份能重建（此时 WeakMap 已随进程消失，
      // 自然落到投影分支）。
      if (agent && typeof agent === 'object') {
        const cached = identityFallback.get(agent);
        if (cached && cached.智能体) return { ...cached };
      }
      // 投影：resume / fork 后重建身份的正路
      const session = agent?.session;
      if (session) {
        const projections = ctx.get?.('sessionProjections');
        if (projections && typeof projections.stateOf === 'function') {
          const state = projections.stateOf(session, IDENTITY_KEY);
          if (state && state.智能体) {
            return { 智能体: state.智能体, 项目: state.项目 ?? '' };
          }
        }
      }
      return null;
    } catch {
      return null; // 注入渲染用，绝不能抛
    }
  }

  function identityOf(agent) {
    return identityOfSync(agent);
  }

  /**
   * 读当前会话的工作目录名（同步），用作 `项目` 的**程序值**。
   *
   * 为什么项目要由程序定（2026-11-08 硬性裁定）：
   *   「这条属于谁的活儿」= 会话在哪个目录下干活，这是**环境事实**，
   *   不是模型的判断。让模型填，它会拿「主题」当项目（"插件开发" 不是项目，
   *   `dsh-tag-memory` 才是），而且同一次会话里能填出好几个不同的值，
   *   归属一乱，召回就永远对不上。
   *
   * 取的是 `ctx.workingDirectory.get(session)`——Host 的权威来源，
   * 与模型看到的 WORKING_DIRECTORY 段同源。取不到返回 ''，由调用方报
   * `PROJECT_EMPTY`（不猜、不兜底）。
   *
   * @param {object} agent
   * @returns {string} 目录名（basename），拿不到则 ''
   */
  function projectOfSync(agent) {
    try {
      const session = agent?.session;
      if (!session) return '';
      const wd = ctx.get?.('workingDirectory');
      if (!wd || typeof wd.get !== 'function') return '';
      const dir = String(wd.get(session) ?? '').trim();
      if (dir === '') return '';
      // 取最后一段：`/opt/dsh` → `dsh`，`G:\proj\dsh-tag-memory` → `dsh-tag-memory`
      // 两种分隔符都要处理（容器是 POSIX，本机是 Windows）
      const parts = dir.split(/[\\/]+/).filter(Boolean);
      const base = parts.length > 0 ? parts[parts.length - 1] : '';
      return base === '' ? '' : base;
    } catch {
      return ''; // 注入渲染用，绝不能抛
    }
  }

  /**
   * 未绑定 → 统一返回这个（调用方据此拒写 / 返空）。
   *
   * ⚠️ 必须同时带 `errors:[...]`：preset 的 `callHost` 在 `ok:false` 时走
   * `failFromErrors(result.errors, ...)`，只给 message 不给 errors 会被渲染成
   * “参数不合法”——把「没绑身份」误报成「参数写错了」，模型会去改本来正确的参数。
   */
  function unboundResult() {
    const message = '未绑定身份：先调 dtm_bind 绑定本次会话的身份，才能读写记忆。';
    return {
      ok: false,
      blocked: 'UNBOUND_IDENTITY',
      code: 'UNBOUND_IDENTITY',
      message,
      errors: [{ code: 'UNBOUND_IDENTITY', field: null, message }],
    };
  }

  /* ---------------- 写 ---------------- */

  /**
   * 追加一条记忆。
   *
   * **取号必须在锁内**（《接口契约》Q5）：并发写会撞号，编号是唯一标识，
   * 撞了追不回来。所以「读表 → 取号 → 追加」全程持锁。
   */
  async function writeEntry(agent, input = {}) {
    // 铁律：未绑定 → 拒写，即使显式传 通用/引入 也不放行（《功能说明》§4.3）
    const identity = identityOfSync(agent);
    if (!identity) {
      // 未绑定也算「模型想记但没记成」，照样落台账——
      // 否则整理阶段看不到「因为没绑身份而丢掉的记忆」（《流程_写入》§六 为什么记失败）。
      try {
        const { schema } = await loadConfigs();
        await appendRecord(
          'write',
          buildWriteLog({
            input,
            identity: { who: '' },
            result: { ok: false, errors: [{ code: 'UNBOUND_IDENTITY', message: unboundResult().message }] },
            schema,
            now: new Date(),
            config: { writeLogTagLimit: config?.writeLogTagLimit },
          }),
        );
      } catch {
        /* 台账写不进去也不能盖住真正的「未绑定」结论 */
      }
      return unboundResult();
    }

    const { layout } = await resolveLayout();
    const { schema, scoring } = await loadConfigs();
    await ensureDirs(layout);

    // ⚠️ 归属（`项目`/`智能体`）是**程序值**，不是模型的判断（2026-11-08 硬性裁定）。
    //
    // 程序定这两个字段，理由：
    //   · `项目` = 会话工作目录名，是**环境事实**。让模型填，它会拿「主题」当项目
    //     （"插件开发" 不是项目，`dsh-tag-memory` 才是），同一次会话还能填出几个
    //     不同的值——归属一乱，召回就永远对不上。
    //   · `智能体` = 本次会话绑定的身份，绑一次就该全库一致，每次写都让模型重填
    //     既啰嗦又容易漂（实测就漂过：同一个会话写出过 `萧潇` 和 `萧潇 `）。
    //
    // 模型给的值一律**丢弃**（不报错、不采纳）——它不是越权，是这活儿本就不该它干。
    // 程序取不到值时报 `PROJECT_EMPTY` / `UNBOUND_IDENTITY`，让模型去补**环境**
    // （问用户身份、确认工作目录），而不是让它猜一个字符串塞进来。
    const programProject = projectOfSync(agent);
    const effectiveInput = {
      ...input,
      项目: programProject,
      智能体: identity.智能体,
    };

    let built;
    const lockResult = await withFileLock(layout.lockFile, async () => {
      const { records } = await readLibraryCsv(layout.libraryCsv, schema);
      const existingIds = records.map((r) => r['编号']);
      built = buildNewRecord({ input: effectiveInput, existingIds, schema, now: new Date() });
      if (!built.ok) return { ok: false, errors: built.errors };
      await appendRecordCsv(layout.libraryCsv, built.record, schema);
      return { ok: true };
    });

    // 台账：成功与失败都记（失败是整理阶段定位“字典问题 vs 程序误伤”的素材）
    const log = buildWriteLog({
      input: effectiveInput,
      identity: { who: identity.智能体 },
      result: built?.ok ? { ok: true, record: built.record } : { ok: false, errors: built?.errors },
      schema,
      now: new Date(),
      config: { writeLogTagLimit: config?.writeLogTagLimit },
    });
    await appendRecord('write', log);

    if (!lockResult.ok) return fail(lockResult.errors);
    if (!built?.ok) return fail(built.errors);

    return {
      ok: true,
      id: built.record['编号'],
      编号: built.record['编号'],
      项目: built.record['项目'],
      智能体: built.record['智能体'],
      // 让 preset 的 formatWriteResult 拿到 who
      who: identity.智能体,
      topK: Number(scoring?.topK ?? 5),
    };
  }

  /* ---------------- 读 ---------------- */

  /**
   * 召回。闸门顺序在 engine 里写死（硬筛 → 命中否决 → 及格线），这里不重排。
   *
   * 未绑定时**先于一切**返回空（不进锁、不读库）——即使模型显式传 通用/引入。
   */
  async function recall(agent, query = {}) {
    const identity = identityOfSync(agent);
    if (!identity) {
      const blocked = unboundResult();
      const rejected = {
        ok: false,
        blocked: 'UNBOUND_IDENTITY',
        hits: [],
        near: [],
        total: 0,
        filtered: 0,
        vetoed: 0,
        passed: 0,
        echo: { 项目: str(query['项目']), 智能体: str(query['智能体']), 形态: str(query['形态']), 自由标签: arr(query['自由标签']) },
        empty: null,
        browseMode: false,
        message: blocked.message,
      };
      // 未绑定也算「模型想查但没查成」，照样落台账——
      // 与 writeEntry 的未绑定分支对称（那边 L508 起）。少了这条，
      // read.jsonl 就只剩「查成功」和「已绑定但字段缺失」两种，
      // 整理阶段看不到「因为没绑身份而丢掉的召回」，模型也无从据此纠正。
      try {
        const { schema } = await loadConfigs();
        await appendRecord(
          'read',
          buildReadLog({
            query: { 项目: str(query['项目']), 智能体: str(query['智能体']), 形态: str(query['形态']), 自由标签: arr(query['自由标签']) },
            result: { ok: false, blocked: 'UNBOUND_IDENTITY', errors: [{ code: 'UNBOUND_IDENTITY', message: blocked.message }] },
            identity: { who: '' },
            now: new Date(),
            schema,
          }),
        );
      } catch {
        /* 台账写不进去也不能盖住真正的「未绑定」结论 */
      }
      return rejected;
    }

    const { layout } = await resolveLayout();
    const { schema, scoring, equivalence } = await loadConfigs();
    await ensureDirs(layout);

    let result;
    await withFileLock(layout.lockFile, async () => {
      const { records } = await readLibraryCsv(layout.libraryCsv, schema);

      // ⚠️ 归属同样由**程序**填（2026-11-08 硬性裁定，与 writeEntry 同一口径）。
      // 查什么项目、以谁的身份查，是环境事实，不是模型的判断——模型只决定
      // 「按什么形态、什么标签查」。让模型填 `项目` 的后果实测过：
      // 它会填成主题词，查出来的东西和库里存的归属对不上，召回恒为空。
      const effectiveQuery = {
        ...query,
        项目: projectOfSync(agent),
        智能体: identity.智能体,
      };
      result = engineRecall({
        records,
        query: effectiveQuery,
        identity: { bound: true, who: identity.智能体 },
        schema,
        config: scoring,
        equivalence,
      });

      // 命中条目时距 +1，其余一律不动（《流程_读取》§六）
      const ids = arr(result.hits).map((h) => h['编号']);
      if (ids.length > 0) {
        const tick = applyTick(records, ids, { cap: Number(scoring?.tickCap ?? 10) });
        if (tick.changed.length > 0) await writeLibraryCsv(layout.libraryCsv, tick.records, schema);
      }
    });

    await appendRecord('read', buildReadLog({ query: result.echo ?? query, result, identity: { who: identity.智能体 }, now: new Date() }));

    return {
      ok: result.ok !== false,
      blocked: strOrNull(result.blocked),
      hits: arr(result.hits),
      near: arr(result.near),
      total: Number(result.total ?? 0),
      filtered: Number(result.filtered ?? 0),
      vetoed: Number(result.vetoed ?? 0),
      passed: Number(result.passed ?? 0),
      echo: result.echo ?? { 项目: '', 智能体: '', 形态: '', 自由标签: [] },
      empty: strOrNull(result.empty),
      browseMode: result.browseMode === true,
      errors: arr(result.errors),
      message: strOrNull(result.message),
    };
  }

  /* ---------------- 列表 / 概况 / 候选 ---------------- */

  /**
   * 列出条目（只读）。
   * **不记 read.jsonl、不动时距**——它不是召回，只是看一眼（《功能说明》§十二 dtm_review）。
   */
  async function listEntries(filter = {}) {
    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    const { records, errors } = await readLibraryCsv(layout.libraryCsv, schema);

    // ⚠️ 库读不进来时**必须报出来**，不能静默返回空列表。
    // 真实场景：旧版 8 列库（缺「自由标签」）会得到 HEADER_MISSING；
    // 若这里吞掉 errors 只返回 total:0，用户看到的是"我的记忆全没了"，
    // 而真相是"格式不兼容，一行都没读进来"——两者处置完全不同。
    const fatal = arr(errors).filter((e) => e.code === 'HEADER_MISSING');
    if (fatal.length > 0) {
      return {
        ...fail(fatal, 'LIBRARY_FORMAT_MISMATCH'),
        items: [],
        rows: [],
        total: 0,
        offset: 0,
        limit: 0,
        libraryIncompatible: true,
      };
    }

    const shape = str(filter['形态']);
    const project = str(filter['项目']);
    const agentName = str(filter['智能体']);
    const status = str(filter['状态']);
    const tags = arr(filter['自由标签']).map(str).filter((t) => t !== '');

    const matched = records.filter((r) => {
      if (shape !== '' && str(r['形态']) !== shape) return false;
      if (project !== '' && str(r['项目']) !== project) return false;
      if (agentName !== '' && str(r['智能体']) !== agentName) return false;
      if (status !== '' && str(r['状态']) !== status) return false;
      if (tags.length > 0) {
        const own = arr(r['自由标签']);
        if (!tags.some((t) => own.includes(t))) return false;
      }
      return true;
    });

    // 新的排前面（2026-11-08 用户反馈：界面里越早的越靠前，反直觉）。
    //
    // CSV 是追加写的，`records` 的天然顺序 = 从旧到新。界面直接用它，
    // 结果是"最新的沉在最后一页"——想找刚记的那条得翻到底。
    //
    // 按 `编号` 倒序：编号格式 `M-YYYYMMDD-NNN`，日期与当日序号都单调递增，
    // 所以字符串倒序 == 时间倒序。**不解析日期**——编号里已经带了顺序信息，
    // 再解析一遍日期只会多一个出错的地方（跨日、补录、手工改号都会让它失准）。
    // 用 localeCompare 而非裸比较：编号是纯 ASCII 数字，两者等价，但前者
    // 在将来编号格式变动时不会因为编码差异给出意外结果。
    matched.sort((a, b) => str(b['编号']).localeCompare(str(a['编号'])));

    const offset = Number.isFinite(filter.offset) ? Math.max(0, Math.trunc(filter.offset)) : 0;
    const limit = Number.isFinite(filter.limit) ? Math.max(0, Math.trunc(filter.limit)) : 50;
    const page = matched.slice(offset, offset + limit);

    // items 是远端契约；rows 是 preset 侧的字段名。指向同一数组，两边都不用改。
    // 非致命的问题（单行损坏）照常返回数据，但附带 errors 让 UI 能提示。
    return {
      ok: true,
      items: page,
      rows: page,
      total: matched.length,
      offset,
      limit,
      errors: arr(errors),
    };
  }

  /** 库概况（只读）。 */
  async function getOverview() {
    const { layout, source } = await resolveLayout();
    const { schema } = await loadConfigs();
    const { records, errors } = await readLibraryCsv(layout.libraryCsv, schema);

    // 与 listEntries 同理：库读不进来时必须让 UI 知道，
    // 否则概况显示 total:0 会被误解成"记忆丢了"。
    const fatal = arr(errors).filter((e) => e.code === 'HEADER_MISSING');
    if (fatal.length > 0) {
      return {
        ...fail(fatal, 'LIBRARY_FORMAT_MISMATCH'),
        total: 0,
        active: 0,
        superseded: 0,
        archived: 0,
        dataDir: layout.dataDir,
        dataDirSource: source,
        libraryIncompatible: true,
      };
    }

    const count = (s) => records.filter((r) => str(r['状态']) === s).length;

    // `byStatus` 是给 UI 用的**自描述**结构：状态名 + 条数，顺序取自字典
    // （`schema.statuses`）。这样前端不需要知道有哪几个状态、也不需要维护
    // 「状态名 → 字段名」的映射表——加一个状态只改字典，界面自动跟上。
    //
    // 保留 active/superseded/archived 三个具名字段是为了兼容既有调用方
    // （契约里已声明），但它们不该是 UI 的唯一来源。
    const statuses = arr(schema.statuses).filter((s) => str(s) !== '');
    const byStatus = statuses.map((s) => ({ 状态: str(s), 数量: count(str(s)) }));

    return {
      ok: true,
      total: records.length,
      active: count('生效'),
      superseded: count('被取代'),
      archived: count('已归档'),
      byStatus,
      dataDir: layout.dataDir,
      dataDirSource: source,
      libraryIncompatible: false,
    };
  }

  /**
   * 现存的 项目 / 智能体 / 形态 / 状态 / 稳定性 去重值。
   *
   * UI 改 `项目`/`智能体` 时用它做候选下拉，**减少打错字导致隔离失效**
   * （《功能说明》§10.3 明确要求）。
   */
  async function getFacets() {
    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    const { records } = await readLibraryCsv(layout.libraryCsv, schema);

    const uniq = (field) => {
      const set = new Set();
      for (const r of records) {
        const v = str(r[field]);
        if (v !== '') set.add(v);
      }
      return Array.from(set).sort();
    };

    return {
      ok: true,
      项目: uniq('项目'),
      智能体: uniq('智能体'),
      形态: uniq('形态'),
      状态: uniq('状态'),
      稳定性: uniq('稳定性'),
      // 字典里的合法值（即便库里还没有，编辑时也该能选）
      allowedShapes: arr(schema.shapes),
      allowedStabilities: arr(schema.stabilities),
      allowedStatuses: arr(schema.statuses),
    };
  }

  /* ---------------- 改条目（UI 与 dtm_retag 共用这一个） ---------------- */

  /**
   * 改某条的标签 / 状态。
   *
   * **这是「一个操作、两个调用者」的落点**：UI 的编辑面板与 `dtm_retag`
   * 调的都是这一个函数，所以结果必然一致（qa 的 O3 就验这条）。
   *
   * 只允许改 6 个字段；`编号`/`主要内容`/`时距` 出现即拒——**不信任前端**，
   * 「程序强制」意味着唯一实现里必须自己拦。
   *
   * ⚠️ **两种调用形状都要支持**（2026-11-08 修，此前只支持双参）：
   *   · 工具侧：`retagEntry(agent, payload)` —— 有会话，身份从 agent 取
   *   · UI 侧：  `retagEntry(payload)`        —— 远程端点只有 1 个参数
   *     （`REMOTE_SIGNATURES.retagEntry = ['request']`），没有 agent
   *
   * 之前只声明双参，远程端点把 `request` 传进 `agent` 位、payload 位收到
   * `undefined`，于是恒报 `ID_REQUIRED`——**界面上点保存看起来成功了，
   * 其实什么都没改**（用户反馈的"改完保存刷新后没变化"就是这个）。
   *
   * 判别方式：看第一个实参**是不是 payload**（有 `编号`/`id`/`patch` 任一键
   * 且没有 `.session`），是则整体右移一位。用形状判别而不是 arity，
   * 因为远程包装器是用 `new Function` 生成的、`length` 不可靠。
   */
  async function retagEntry(agentOrPayload, payloadArg) {
    let agent = agentOrPayload;
    let payload = payloadArg;

    // UI 单参调用：第一个实参本身就是 payload
    const looksLikePayload =
      agentOrPayload &&
      typeof agentOrPayload === 'object' &&
      !agentOrPayload.session &&
      ('编号' in agentOrPayload || 'id' in agentOrPayload || 'patch' in agentOrPayload);

    if (looksLikePayload) {
      agent = null;
      payload = agentOrPayload;
    }

    const { 编号, id, patch, basis, who, before } = payload ?? {};
    const targetId = str(编号) || str(id);
    if (targetId === '') {
      return reject('ID_REQUIRED', '必须给出要改的条目 编号。', '编号');
    }
    const basisText = str(basis);
    if (basisText === '') {
      return reject(
        'BASIS_REQUIRED',
        '缺 basis：改标签必须给出依据（哪条读写记录支持这次改动），没有依据的改动不允许做。',
        'basis',
      );
    }

    // 字段白名单：先拒只读字段（点名），再拒未知字段
    const patchObj = patch && typeof patch === 'object' ? patch : {};
    const keys = Object.keys(patchObj);
    const readonlyHit = keys.filter((k) => READONLY_FIELDS.includes(k));
    if (readonlyHit.length > 0) {
      return {
        ok: false,
        code: 'FIELD_NOT_EDITABLE',
        message:
          `以下字段不可修改：${readonlyHit.join('、')}。` +
          '主要内容是一手材料、编号是唯一标识、时距是程序计数器——改了就不是原始记录。',
        errors: readonlyHit.map((f) => ({ code: 'FIELD_NOT_EDITABLE', field: f, message: `${f} 不可修改。` })),
      };
    }
    const unknown = keys.filter((k) => !EDITABLE_FIELDS.includes(k));
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'FIELD_NOT_EDITABLE',
        message: `不认识的字段：${unknown.join('、')}。只允许改 ${EDITABLE_FIELDS.join('/')}。`,
      };
    }
    if (keys.length === 0) {
      return reject('PATCH_EMPTY', 'patch 是空的：没有任何字段要改。', 'patch');
    }

    // 身份：工具侧必须有绑定；UI 侧（agent 为 null）允许，但台账记“用户手动”
    const identity = agent ? identityOfSync(agent) : null;
    if (agent && !identity) return unboundResult();

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    await ensureDirs(layout);

    // 改库前必须备份（《流程_整理》§〇 无开关）
    const backup = await backupLibrary({ libraryCsv: layout.libraryCsv, backupDir: layout.backupDir, schema, suffix: '-retag' });
    if (!backup.ok) return { ...fail(backup.errors, 'BACKUP_FAILED'), backupErrors: backup.errors };
    lastBackupAt = localIsoString(new Date());

    let outcome;
    await withFileLock(layout.lockFile, async () => {
      const { records, errors } = await readLibraryCsv(layout.libraryCsv, schema);
      if (errors.some((e) => e.code === 'HEADER_MISSING')) {
        outcome = { ok: false, errors: [{ code: 'HEADER_MISSING', message: '记忆库缺表头，拒绝改动。' }] };
        return;
      }
      const idx = records.findIndex((r) => str(r['编号']) === targetId);
      if (idx < 0) {
        outcome = { ok: false, errors: [{ code: 'ID_NOT_FOUND', message: `库里没有编号 ${targetId} 的条目。` }] };
        return;
      }

      const oldRecord = records[idx];
      const nextRecord = { ...oldRecord };

      // 逐字段校验（取值域来自 schema，形态/稳定性/状态必须合法）
      for (const [field, rawValue] of Object.entries(patchObj)) {
        if (field === '自由标签') {
          const normalized = arr(rawValue).map(str).filter((t) => t !== '');
          const pipeHit = normalized.filter((t) => t.includes('|'));
          if (pipeHit.length > 0) {
            outcome = {
              ok: false,
              errors: pipeHit.map((bad) => ({
                code: 'TAG_CONTAINS_PIPE',
                field: '自由标签',
                message: `自由标签「${bad}」含保留字符 |（用于分隔多个标签），请改写该标签后重试。`,
                detail: { tag: bad },
              })),
            };
            return;
          }
          if (normalized.length === 0) {
            outcome = { ok: false, errors: [{ code: 'TAGS_EMPTY', field: '自由标签', message: '自由标签不能为空：至少留 1 个，否则以后召不回来。' }] };
            return;
          }
          if (normalized.length > schema.limits.tagsMax) {
            outcome = { ok: false, errors: [{ code: 'TOO_MANY_TAGS', field: '自由标签', message: `自由标签有 ${normalized.length} 个，超过上限 ${schema.limits.tagsMax} 个。` }] };
            return;
          }
          nextRecord['自由标签'] = normalized;
          continue;
        }

        const value = str(rawValue);
        if (value === '') {
          outcome = { ok: false, errors: [{ code: 'FIELD_EMPTY', field, message: `${field} 不能改成空值。` }] };
          return;
        }
        if (field === '形态' && !arr(schema.shapes).includes(value)) {
          outcome = { ok: false, errors: [{ code: 'SHAPE_INVALID', field, message: `形态「${value}」不是合法值，合法值：${arr(schema.shapes).join('/')}。` }] };
          return;
        }
        if (field === '稳定性' && !arr(schema.stabilities).includes(value)) {
          outcome = { ok: false, errors: [{ code: 'STABILITY_INVALID', field, message: `稳定性「${value}」不是合法值，合法值：${arr(schema.stabilities).join('/')}。` }] };
          return;
        }
        if (field === '状态' && !arr(schema.statuses).includes(value)) {
          outcome = { ok: false, errors: [{ code: 'STATUS_INVALID', field, message: `状态「${value}」不是合法值，合法值：${arr(schema.statuses).join('/')}。` }] };
          return;
        }
        if (field === '项目' && value.length > schema.limits.projectNameMax) {
          outcome = { ok: false, errors: [{ code: 'NAME_TOO_LONG', field, message: `项目 超过 ${schema.limits.projectNameMax} 字上限。` }] };
          return;
        }
        if (field === '智能体' && value.length > schema.limits.agentNameMax) {
          outcome = { ok: false, errors: [{ code: 'NAME_TOO_LONG', field, message: `智能体 超过 ${schema.limits.agentNameMax} 字上限。` }] };
          return;
        }
        nextRecord[field] = value;
      }

      await replaceRecordCsv(layout.libraryCsv, nextRecord, schema);

      const changed = {};
      for (const field of EDITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patchObj, field)) changed[field] = nextRecord[field];
      }
      outcome = { ok: true, before: oldRecord, after: nextRecord, changed };
    });

    if (!outcome?.ok) return fail(outcome?.errors, outcome?.errors?.[0]?.code);

    // 台账：action=user_edit（UI）或 retag（工具）；都记 who 与改动前后值
    const isUserEdit = !agent;
    const whoText = isUserEdit ? '（用户手动）' : identity.智能体;
    await writeTidyLog({
      who: whoText,
      action: isUserEdit ? 'user_edit' : 'retag',
      target: targetId,
      before: before ?? pickEditable(outcome.before),
      after: pickEditable(outcome.after),
      basis: basisText,
    });

    return {
      ok: true,
      编号: targetId,
      id: targetId,
      changed: outcome.changed,
      before: pickEditable(outcome.before),
      after: pickEditable(outcome.after),
      backupPath: backup.path ?? null,
    };
  }

  /** 从整条记录里摘出可改的 6 个字段（台账用，避免把主要内容抄进 tidy.jsonl）。 */
  function pickEditable(record) {
    const out = {};
    for (const f of EDITABLE_FIELDS) out[f] = record?.[f] ?? null;
    return out;
  }

  /* ---------------- 取代 / 归档 ---------------- */

  /**
   * ⚠️ 归属说明（Lead 2026-11-05 裁定，**请勿搬去 engine**）
   *
   * 《架构说明》§4.1 曾把 `tidy.mjs` / `schedule.mjs` / `migrate.mjs` 列在 `lib/engine/` 下，
   * 但实际实现里这三块**留在宿主**。原因：
   *
   *   1. 它们与 engine 的纯逻辑**没有共享状态**——engine 的 core/read/write/tick/backup
   *      都是"接参数返结果"的纯函数，而这三块分别是"备份+锁+改行+台账"（tidy）、
   *      "定时器生命周期"（schedule）、"搬目录+写设置"（migrate），
   *      全是 **I/O 编排 + ctx 生命周期**，天然属于宿主职责（《接口契约》§一）。
   *   2. 若强行抽进 engine，engine 就要引入 `backupLibrary` 的调用链与台账写入，
   *      破坏"engine 不写日志文件、只返回该写什么"的契约。
   *   3. 放宿主**不产生两套实现**：这些动作只有 UI 与工具两个入口，
   *      而两个入口都调本文档里的同一个函数（一个操作、两个调用者）。
   *
   * 引擎侧仍需保留的是**纯判定**：哪些字段可改、取值域是否合法（来自 `templates/schema.json`），
   * 本文件通过 `loadConfigs()` 读它，**不硬编码**。
   */

  /** 用一条新记忆顶替旧条：写新条 + 旧条标 `被取代`。属整理动作。 */
  async function supersedeEntry(agent, input = {}) {
    const identity = identityOfSync(agent);
    if (!identity) return unboundResult();

    const oldId = str(input['旧编号']);
    const basis = str(input.basis);
    if (oldId === '') return reject('OLD_ID_REQUIRED', '必须给出 旧编号。', '旧编号');
    if (basis === '') return reject('BASIS_REQUIRED', '缺 basis：取代也必须给出依据。', 'basis');

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    await ensureDirs(layout);

    const backup = await backupLibrary({ libraryCsv: layout.libraryCsv, backupDir: layout.backupDir, schema, suffix: '-supersede' });
    if (!backup.ok) return { ...fail(backup.errors, 'BACKUP_FAILED'), backupErrors: backup.errors };
    lastBackupAt = localIsoString(new Date());

    let outcome;
    await withFileLock(layout.lockFile, async () => {
      const { records } = await readLibraryCsv(layout.libraryCsv, schema);
      const idx = records.findIndex((r) => str(r['编号']) === oldId);
      if (idx < 0) {
        outcome = { ok: false, errors: [{ code: 'ID_NOT_FOUND', message: `库里没有编号 ${oldId} 的条目。` }] };
        return;
      }

      const existingIds = records.map((r) => r['编号']);

      // ⚠️ 不补默认值（2026-11-08 裁决）：新条必须**显式**给 `项目`/`智能体`。
      // 不沿用旧条的归属——新条可能真的换项目了（旧条在 A 项目、新做法在 B 项目），
      // 沿用旧条等于程序替模型决定了归属，错了看不出来。
      // 也不回退到绑定身份：那会让「模型漏填」再次被掩盖。
      const built = buildNewRecord({
        input,
        existingIds,
        schema,
        now: new Date(),
      });
      if (!built.ok) {
        outcome = { ok: false, errors: built.errors };
        return;
      }

      // 旧条标被取代（行不删）
      const oldRecord = { ...records[idx], 状态: '被取代' };
      await replaceRecordCsv(layout.libraryCsv, oldRecord, schema);
      // 新条追加
      await appendRecordCsv(layout.libraryCsv, built.record, schema);

      outcome = { ok: true, old: oldRecord, newRecord: built.record };
    });

    if (!outcome?.ok) return fail(outcome?.errors, outcome?.errors?.[0]?.code);

    await writeTidyLog({ who: identity.智能体, action: 'retag', target: oldId, before: pickEditable(outcome.old), after: pickEditable(outcome.newRecord), basis });

    return {
      ok: true,
      编号: outcome.newRecord['编号'],
      id: outcome.newRecord['编号'],
      旧编号: oldId,
      backupPath: backup.path ?? null,
      changed: { 状态: '被取代 → 新条已写' },
    };
  }

  /** 归档：标 `已归档`，行不删。属整理动作。 */
  async function archiveEntry(agent, { 编号, id, basis } = {}) {
    const identity = identityOfSync(agent);
    if (!identity) return unboundResult();

    const targetId = str(编号) || str(id);
    const basisText = str(basis);
    if (targetId === '') return reject('ID_REQUIRED', '必须给出 编号。', '编号');
    if (basisText === '') return reject('BASIS_REQUIRED', '缺 basis：归档也必须给出依据。', 'basis');

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    await ensureDirs(layout);

    let outcome;
    await withFileLock(layout.lockFile, async () => {
      const { records } = await readLibraryCsv(layout.libraryCsv, schema);
      const idx = records.findIndex((r) => str(r['编号']) === targetId);
      if (idx < 0) {
        outcome = { ok: false, errors: [{ code: 'ID_NOT_FOUND', field: '编号', message: `库里没有编号 ${targetId} 的条目。` }] };
        return;
      }
      const before = records[idx];

      // 状态互斥（《流程_整理》§三 L153-154）：
      //   被取代 = 被新条顶掉了；已归档 = 没有新的顶替，只是不需要了。
      //   两者叠在一条上会让按状态筛选时同时落两个篮子，且语义矛盾。
      //   实测到过（2026-11-06）：M-005 已被顶替后又被归档成功。
      if (str(before['状态']) === '被取代') {
        outcome = {
          ok: false,
          code: 'ALREADY_SUPERSEDED',
          message:
            `条目 ${targetId} 已被新条取代，不需要再归档。` +
            '《流程_整理》§三：被取代（有新条顶替）与已归档（无新条顶替）互斥。',
          errors: [{ code: 'ALREADY_SUPERSEDED', field: '状态', message: '已被取代的条目不需要再归档。' }],
        };
        return;
      }
      // 已归档 的幂等（不报错，直接返回现状）
      if (str(before['状态']) === '已归档') {
        outcome = { ok: true, already: true, before, after: before };
        return;
      }

      // ---- 到这里才确定真的要改库，此时才备份 ----
      // （2026-11-06 修：备份原来在锁外、判断之前，导致被拒的归档也白留一份备份）
      const backup = await backupLibrary({
        libraryCsv: layout.libraryCsv,
        backupDir: layout.backupDir,
        schema,
        suffix: '-archive',
      });
      if (!backup.ok) {
        outcome = { ok: false, errors: backup.errors, code: 'BACKUP_FAILED' };
        return;
      }
      outcome = { ok: true, before, after: { ...before, 状态: '已归档' }, backupPath: backup.path };
      await replaceRecordCsv(layout.libraryCsv, outcome.after, schema);
    });

    if (!outcome?.ok) return fail(outcome?.errors, outcome?.errors?.[0]?.code ?? outcome?.code);
    if (outcome.backupPath) lastBackupAt = localIsoString(new Date());
    return {
      ok: true,
      编号: targetId,
      before: outcome.before,
      after: outcome.after,
      changed: outcome.already ? {} : { 状态: '已归档' },
      backupPath: outcome.backupPath ?? null,
    };
  }

  /* ---------------- 台账查询 ---------------- */

  async function readRecords({ kind, limit, onlyFailed } = {}) {
    const { layout } = await resolveLayout();
    const kinds = kind ? [str(kind)] : Object.keys(RECORD_FILES);
    const cap = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 50;

    const items = [];
    const errors = [];
    for (const k of kinds) {
      const name = RECORD_FILES[k];
      if (!name) {
        errors.push({ code: 'RECORD_KIND_INVALID', message: `未知台账类型：${k}，合法值：${Object.keys(RECORD_FILES).join('/')}。` });
        continue;
      }
      const parsed = await readJsonl(path.join(layout.recordsDir, name));
      errors.push(...arr(parsed.errors));
      for (const it of parsed.items) {
        items.push({ ...it, kind: k });
      }
    }

    let filtered = items;
    if (onlyFailed === true) filtered = filtered.filter((it) => it.ok === false);
    // 新的在前
    filtered = filtered.slice().reverse().slice(0, cap);

    return { ok: true, items: filtered, total: items.length, errors };
  }

  /* ---------------- 导出 / 备份 / 恢复 / 合并 / 搬家 ---------------- */

  /**
   * ⚠️ 归属说明（Lead 2026-11-05 裁定，**请勿搬去 engine**）
   *
   * 本节的 `mergeLibrary` / `migrateDataDir` 对应《架构说明》§4.1 里的
   * `backup.mjs` / `migrate.mjs`。其中：
   *
   *   · **备份/校验在 engine**（`lib/engine/backup.mjs`：`backupLibrary` /
   *     `listBackups` / `restoreBackup`）——纯"复制+校验+列目录"，无编排，归 engine 正确。
   *   · **合并 / 搬家留在宿主**——它们要串联「备份 → 锁内改库 → 写台账 → 更新设置」，
   *     是典型的 I/O 编排，且 `migrateDataDir` 还要读 `resolveLayout()` 的优先级结论
   *     来决定"能不能搬"（①② 锁定时必须拒绝并说明改哪一行）。
   *     这两件事 engine 都不该知道（engine 不知 ctx、不知 profile 配置来源）。
   *
   * 判定标准：**纯判定与纯复制归 engine；跨步骤编排与 ctx 相关的归宿主。**
   * 这条标准同时解释了为什么 `tidy` / `schedule` / `migrate` 三块没进 engine。
   */

  /**
   * 导出记忆库（库本体就是 CSV，直接可读可交接）。
   * **与 UI 导出按钮共用同一实现**（《功能说明》§十二 dtm_export）。
   */
  /**
   * 列出当前环境下**可写**的导出/备份目标目录。
   *
   * 为什么不能让用户自由填路径：插件运行在沙箱/容器里，
   * 宿主机路径（如 G:\…）在那一侧根本不存在，写了也是 ENOENT。
   * 所以这里只回报「实测能写」的目录，界面只能从这些里选 ——
   * 宁可少给选项，也不给一个点下去必失败的路径。
   */
  async function listExportTargets() {
    const { layout } = await resolveLayout();
    const candidates = [
      { id: 'backup', label: '备份目录（默认）', dir: layout.backupDir },
      { id: 'data', label: '数据目录根', dir: layout.dataDir || path.dirname(layout.libraryCsv) },
      { id: 'records', label: '台账目录', dir: layout.recordsDir },
    ];

    const targets = [];
    for (const c of candidates) {
      if (!c.dir) continue;
      // 实测写权限：能 mkdir 且能写临时文件才算可用
      let writable = false;
      try {
        await fsp.mkdir(c.dir, { recursive: true });
        const probe = path.join(c.dir, '.dsh-write-probe');
        await fsp.writeFile(probe, 'ok', 'utf8');
        await fsp.unlink(probe);
        writable = true;
      } catch {
        writable = false;
      }
      targets.push({ id: c.id, label: c.label, dir: c.dir, writable });
    }

    return {
      ok: true,
      targets,
      // 给界面一个默认值，免得用户每次都要先选
      defaultId: (targets.find((x) => x.writable) || {}).id || 'backup',
    };
  }
  async function exportLibrary({ path: target } = {}) {
    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    const { records } = await readLibraryCsv(layout.libraryCsv, schema);

    const dest = str(target) || path.join(layout.backupDir, `export-${stamp()}.csv`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    let bytes = 0;
    try {
      const raw = await fsp.readFile(layout.libraryCsv);
      await fsp.writeFile(dest, raw);
      bytes = raw.length;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // 库还不存在：导出一个只有表头的空库，别报错
        const header = `${arr(schema.columns).join(',')}\r\n`;
        await fsp.writeFile(dest, header, 'utf8');
        bytes = Buffer.byteLength(header, 'utf8');
      } else {
        return reject('EXPORT_FAILED', `导出失败：${err?.message ?? err}`);
      }
    }

    return { ok: true, path: dest, count: records.length, bytes };
  }

  /** 立刻做一次备份（+ 校验）。 */
  async function backupNow() {
    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    const result = await backupLibrary({ libraryCsv: layout.libraryCsv, backupDir: layout.backupDir, schema });
    if (!result.ok) {
      // 空库（文件还不存在）不算故障：给个明确说明而不是错误码堆栈
      const missing = arr(result.errors).some((e) => e.code === 'BACKUP_SOURCE_MISSING');
      return {
        ok: false,
        code: missing ? 'LIBRARY_EMPTY' : 'BACKUP_FAILED',
        message: missing ? '记忆库还是空的，没有可备份的内容。' : arr(result.errors)[0]?.message ?? '备份失败。',
        errors: arr(result.errors),
      };
    }
    lastBackupAt = localIsoString(new Date());
    return { ok: true, path: result.path, bytes: result.bytes, records: result.records };
  }

  async function listBackups() {
    const { layout } = await resolveLayout();
    const result = await engineListBackups({ backupDir: layout.backupDir });
    return { ok: true, backups: arr(result.backups) };
  }

  /**
   * 执行整理（UI 与工具共用；一个操作两个调用者）。
   *
   * 编排职责（《流程_整理》§〇）：
   *   备份 → 校验 → 锁内读库 + 读台账 → 纯逻辑算 changes → 锁内写回 → 写 tidy 台账
   *
   * 纯逻辑在 lib/engine/tidy.mjs（planTidy），这里只做 I/O 编排。
   *
   * @param {object} opts
   * @param {boolean} opts.dryRun    只算不写（UI 预览用）
   * @param {object[]} opts.promoteCandidates  模型判定的"同一簇"候选（升通用用）
   * @param {string} opts.who        整理者身份
   */
  async function runTidy({ dryRun = false, promoteCandidates = [], who = '' } = {}) {
    const { layout, source } = await resolveLayout();
    const { schema, scoring } = await loadConfigs();
    await ensureDirs(layout);

    // ---- 〇、整理前必须备份（无开关，不可跳过）----
    let backupPath = null;
    if (!dryRun) {
      const bak = await backupLibrary({
        libraryCsv: layout.libraryCsv,
        backupDir: layout.backupDir,
        schema,
      });
      backupPath = bak.path ?? null;
      if (!bak.ok) {
        const missing = arr(bak.errors).some((e) => e.code === 'BACKUP_SOURCE_MISSING');
        return {
          ok: false,
          code: missing ? 'LIBRARY_EMPTY' : 'BACKUP_FAILED',
          message: missing
            ? '记忆库还是空的，没有可整理的内容。'
            : '整理前备份失败，已中止（不允许在无备份的情况下改库）。',
          errors: arr(bak.errors),
        };
      }
    }

    // ---- 一、读库 + 读台账 ----
    let records = [];
    let readLogs = [];
    let writeLogs = [];

    await withFileLock(layout.lockFile, async () => {
      const lib = await readLibraryCsv(layout.libraryCsv, schema);
      records = arr(lib.records);
      // ⚠️ readJsonl 返回的是 { items, errors }，不是数组（core.mjs:626）
      // 直接当数组用会导致台账永远读成空 —— 整理就永远不会改任何东西。
      const rl = await readJsonl(layout.recordsDir + '/read.jsonl');
      const wl = await readJsonl(layout.recordsDir + '/write.jsonl');
      readLogs = arr(rl && rl.items);
      writeLogs = arr(wl && wl.items);
    });

    // ---- 二、纯逻辑算"该改什么" ----
    const plan = planTidy({
      records,
      readLogs,
      writeLogs,
      promoteCandidates,
      config: {
        stableOkThreshold: Number(scoring?.stableOkThreshold ?? 3),
        // 升格还必须「用过一段时间」：时距（被召回次数）≥ 门槛才允许升稳定。
        // 只召回 1 次就升稳定 = 把「没被检验过」当成「检验通过」。
        stableMinTick: Number(scoring?.stableMinTick ?? 3),
        promoteMinDistinct: Number(scoring?.promoteMinDistinct ?? 4),
        inductionMinOccasions: Number(scoring?.inductionMinOccasions ?? 3),
      },
    });

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        changes: plan.changes,
        proposals: plan.proposals,
        report: plan.report,
        backupPath,
      };
    }

    // ---- 三、锁内写回 + 记台账 ----
    const applied = [];
    await withFileLock(layout.lockFile, async () => {
      const lib = await readLibraryCsv(layout.libraryCsv, schema);
      const rows = arr(lib.records);
      const byId = new Map(rows.map((r, i) => [r['编号'], { r, i }]));

      for (const ch of plan.changes) {
        const hit = byId.get(ch['编号']);
        if (!hit) continue;
        const before = hit.r[ch.field];
        if (String(before) === String(ch.after)) continue;   // 已经是目标值
        hit.r[ch.field] = ch.after;
        applied.push({ ...ch, before });
      }

      if (applied.length > 0) {
        await writeLibraryCsv(layout.libraryCsv, rows, schema);
      }
    });

    // 台账：每条改动记一笔（《流程_整理》§七）
    for (const ch of applied) {
      await writeTidyLog({
        who: who || '整理',
        action: ch.field === '稳定性' ? 'stability' : 'retag',
        target: ch['编号'],
        before: ch.before,
        after: ch.after,
        basis: ch.basis,
      });
    }

    return {
      ok: true,
      dryRun: false,
      changes: applied,
      proposals: plan.proposals,
      report: plan.report,
      backupPath,
      applied: applied.length,
    };
  }

  /** 从备份恢复。破坏性操作：**先把当前库再备份一次**再覆盖。 */
  async function restore({ from } = {}) {
    const src = str(from);
    if (src === '') return reject('SOURCE_REQUIRED', '必须给出要恢复的备份文件路径。', 'from');

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();

    // 恢复本身会覆盖库：先留一个回滚点
    const safety = await backupLibrary({ libraryCsv: layout.libraryCsv, backupDir: layout.backupDir, schema, suffix: '-before-restore' });

    const result = await restoreBackup({ backupCsv: src, libraryCsv: layout.libraryCsv, schema });
    if (!result.ok) return { ...fail(result.errors, 'RESTORE_FAILED'), backupPathBefore: safety.ok ? safety.path : null };

    return {
      ok: true,
      records: result.records,
      backupPathBefore: safety.ok ? safety.path : null,
    };
  }

  /**
   * 合并另一份记忆库。
   * 冲突原则：编号唯一，同号保留较新（按编号里的日期+序号判定）。
   */
  async function mergeLibrary({ path: otherPath, dryRun } = {}) {
    const src = str(otherPath);
    if (src === '') return reject('PATH_REQUIRED', '必须给出要合并的库文件路径。', 'path');

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();

    // ⚠️ 必须先确认源文件**真的存在**。
    // readLibraryCsv 对不存在的文件返回空记录（当空库），不抛错 ——
    // 于是合并一个不存在的路径会得到 ok:true（“对方是空库”），还白白生成一份备份。
    // 实测到过（2026-11-06）。这是教训7「把读不到伪装成没有」的又一例。
    try {
      const st = await fsp.stat(src);
      if (!st.isFile()) {
        return reject('MERGE_SOURCE_NOT_FILE', `路径不是文件：${src}。`, 'path');
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return reject(
          'MERGE_SOURCE_NOT_FOUND',
          `要合并的文件不存在：${src}。` +
            '请确认路径（插件运行在沙箱/容器里，宿主机路径在这侧不存在）。',
          'path',
        );
      }
      return reject('MERGE_SOURCE_UNREADABLE', `读不了要合并的文件：${err?.message ?? err}`, 'path');
    }

    let incoming;
    try {
      incoming = await readLibraryCsv(src, schema);
    } catch (err) {
      return reject('MERGE_SOURCE_UNREADABLE', `读不了要合并的文件：${err?.message ?? err}`);
    }
    if (incoming.errors.some((e) => e.code === 'HEADER_MISSING')) {
      return reject('MERGE_SOURCE_INVALID', '这份文件不是合法的记忆库（表头缺失），已拒绝合并。');
    }

    const { records } = await readLibraryCsv(layout.libraryCsv, schema);
    const byId = new Map(records.map((r) => [str(r['编号']), r]));

    let added = 0;
    let changed = 0;
    let conflicts = 0;
    for (const rec of incoming.records) {
      const id = str(rec['编号']);
      if (id === '') continue;
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, rec);
        added += 1;
        continue;
      }

      // 同号冲突：保留「较新」的那条（《流程_整理》§二 L90）。
      //
      // ⚠️ 实测缺陷（2026-11-06）：原来这里调
      //   idNewerThan(rec['编号'], existing['编号'])
      // 但进到这个分支说明两条编号**完全相同**，
      // 比较同一字符串恒为 false ——「保留较新」是死代码，
      // 合并方的版本永远被静默丢弃（changed 恒为 0）。
      //
      // 编号相同就无法用编号判新旧，只能看条目自身的状态。按优先级：
      //   ① 时距大的更新（时距=被召回次数，用得多说明更贴合当下）
      //   ② 时距相同看稳定性：稳定 > 观察 > 易变
      //   ③ 都一样则保留当前库的（幂等，不折腾）
      conflicts += 1;
      if (recordNewerThan(rec, existing)) {
        byId.set(id, rec);
        changed += 1;
      }
    }

    const merged = Array.from(byId.values());

    if (dryRun === true) {
      return { ok: true, changed, added, conflicts, backupPath: null, dryRun: true, total: merged.length };
    }

    await ensureDirs(layout);
    const backup = await backupLibrary({ libraryCsv: layout.libraryCsv, backupDir: layout.backupDir, schema, suffix: '-merge' });

    await withFileLock(layout.lockFile, async () => {
      await writeLibraryCsv(layout.libraryCsv, merged, schema);
    });
    lastBackupAt = localIsoString(new Date());

    await writeTidyLog({
      who: '（合并）',
      action: 'merge',
      target: src,
      before: { count: records.length },
      after: { count: merged.length, added, changed, conflicts },
      basis: src,
    });

    return {
      ok: true,
      changed,
      added,
      conflicts,
      backupPath: backup.ok ? backup.path : null,
      total: merged.length,
    };
  }

  /** 编号 M-YYYYMMDD-NNN 的“较新”判定：先比日期，再比序号。 */
  /**
   * 同编号冲突时判断「哪条更新」。
   *
   * 编号相同就没法用编号判新旧 —— 只能看条目状态。优先级：
   *   时距（被召回次数）大 > 稳定性高 > 都不动（保留当前库）
   *
   * @returns {boolean} true 表示 incoming 应当覆盖 existing
   */
  function recordNewerThan(incoming, existing) {
    const tickA = Number(incoming?.['时距']);
    const tickB = Number(existing?.['时距']);
    const a = Number.isFinite(tickA) ? tickA : 0;
    const b = Number.isFinite(tickB) ? tickB : 0;
    if (a !== b) return a > b;

    const rank = { '稳定': 2, '观察': 1, '易变': 0 };
    const ra = rank[String(incoming?.['稳定性'] ?? '')] ?? -1;
    const rb = rank[String(existing?.['稳定性'] ?? '')] ?? -1;
    return ra > rb;
  }

  function idNewerThan(a, b) {
    const pa = parseIdParts(a);
    const pb = parseIdParts(b);
    if (!pa || !pb) return false;
    if (pa.date !== pb.date) return pa.date > pb.date;
    return pa.seq > pb.seq;
  }

  function parseIdParts(id) {
    const m = /^M-(\d{8})-(\d+)$/.exec(str(id));
    if (!m) return null;
    return { date: m[1], seq: Number(m[2]) };
  }

  /** 搬家：把数据目录搬到新位置。①② 优先级锁定时拒绝并说明改哪一行。 */
  async function migrateDataDir({ target } = {}) {
    const dest = str(target);
    if (dest === '') return reject('TARGET_REQUIRED', '必须给出目标目录。', 'target');

    const { layout, source, locked, lockedHint } = await resolveLayout();
    if (locked) {
      return {
        ok: false,
        code: 'DATA_DIR_LOCKED',
        message: lockedHint,
        details: {
          source,
          where: source === 'config' ? 'cordis.patch.yml 的 config.dataDir' : '环境变量 DSH_TAG_MEMORY_DATA_DIR',
        },
      };
    }
    if (path.resolve(dest) === path.resolve(layout.dataDir)) {
      return reject('TARGET_SAME', '目标目录就是当前目录，不需要搬。', 'target');
    }

    const from = layout.dataDir;
    let moved = false;
    try {
      await fsp.mkdir(dest, { recursive: true });
      // 逐个子项搬（store / records / backup / settings.json），失败就报，不静默
      const entries = await fsp.readdir(from, { withFileTypes: true }).catch(() => []);
      for (const ent of entries) {
        const srcPath = path.join(from, ent.name);
        const dstPath = path.join(dest, ent.name);
        await fsp.cp(srcPath, dstPath, { recursive: true, force: true });
      }
      moved = true;
    } catch (err) {
      return reject('MIGRATE_FAILED', `搬家失败：${err?.message ?? err}`);
    }

    // 记录选择（④包内 时才允许设置页生效；③设置页 也是可写的）
    await writeSettingsDir(dest);

    return { ok: true, from, to: dest, moved };
  }

  /* ---------------- 设置 ---------------- */

  async function getSettings() {
    const { layout, source, locked, lockedHint, warning } = await resolveLayout();
    const { schema } = await loadConfigs();
    const { records } = await readLibraryCsv(layout.libraryCsv, schema);

    let dictText = null;
    try {
      const loaded = await loadTagDictText({ dictPath: path.join(PACKAGE_DIR, '标签字典.md') });
      dictText = loaded?.text ?? null;
    } catch {
      dictText = null; // 字典缺失不该让设置页崩
    }

    return {
      ok: true,
      dataDir: layout.dataDir,
      dataDirSource: source,
      dataDirLocked: locked,
      dataDirLockedHint: lockedHint,
      // ⑤ 包内兜底时的显著告警（null = 没问题）。UI 据此标红；
      // 目前 client.js 只认 'package'，这里保持字符串/ null 的简单契约。
      warning: warning ?? null,
      backupAuto: config?.backupAuto === true,
      lastBackupAt,
      tidyAuto: config?.tidyAuto === true,
      tidyFrequency: strOrNull(config?.tidyFrequency),
      dictText,
      libraryCount: records.length,
      schemaVersion: Number(schema?.version ?? 1),
    };
  }

  /* ---------------- 定时任务 ---------------- */

  /**
   * ⚠️ 归属说明（Lead 2026-11-05 裁定，**请勿搬去 engine**）
   *
   * 《架构说明》§4.1 列过 `lib/engine/schedule.mjs`，但定时任务**必须**留在宿主：
   *
   *   · `setInterval` 是进程级副作用，engine 的契约是"纯逻辑、能脱离框架单测"
   *     （《接口契约》§一），一个持有 timer 的文件无法脱离进程测试。
   *   · 定时器要在插件卸载时清掉（`ctx.effect` 的 dispose），这是 **ctx 生命周期**，
   *     engine 不知道 ctx 存在。
   *   · 定时器触发的动作（`backupNow()`）本身又要走编排，而编排归宿主。
   *
   * engine 侧真正该有的"定时"是 `tick.mjs` 的 `createTickQueue()`——那是**纯队列**
   * （只管 pending 集合与去重，不持有 timer），由宿主喂给它 flush 回调。已经拆开了。
   *
   * 定时任务：`setInterval` + `.unref()`（官方硬规矩：不阻塞进程退出）。
   *
   * 目前做的事：按 `config.autoBackupIntervalHours` 定期备份。
   * 自动整理（tidy）依赖模型参与，只在配置开启时由工具链触发，定时器不代劳。
   */
  function startTimer() {
    const backupHours = Number(config?.autoBackupIntervalHours);

    // ---- 定时任务 1：自动备份 ----
    // setInterval + .unref()：官方硬规矩，不阻塞进程退出。
    if (Number.isFinite(backupHours) && backupHours > 0) {
      const everyMs = Math.max(60_000, backupHours * 3600_000);
      let lastAt = null;
      timer = setInterval(() => {
        // 用 schedule.mjs 的纯判定决定该不该跑（而不是无脑每隔 N 小时跑一次）
        const due = isBackupDue({ intervalMs: everyMs, lastAt, now: Date.now() });
        if (!due.due) return;
        backupNow()
          .then((r) => { if (r && r.ok) lastAt = Date.now(); })
          .catch(() => {});
      }, Math.min(everyMs, 3600_000));
      if (typeof timer.unref === 'function') timer.unref();
    }

    // ---- 定时任务 2：整理提醒 ----
    // ⚠️ 整理**必须由模型参与判断**（《流程_整理》引言），定时器不能代替模型改库。
    // 所以这里只做"该整理了"的判定并在日志里提示，不自动执行 runTidy。
    // 真正的整理由用户/模型在对话里触发（dtm_retag / runTidy）。
    const tidyHours = Number(config?.autoTidyIntervalHours);
    if (Number.isFinite(tidyHours) && tidyHours > 0) {
      const everyMs = Math.max(60_000, tidyHours * 3600_000);
      let lastTidyAt = null;
      tidyTimer = setInterval(() => {
        const due = isTidyDue({ intervalMs: everyMs, lastAt: lastTidyAt, now: Date.now() });
        if (due.due) {
          ctx.logger?.info?.('[dsh-tag-memory] 建议整理：' + due.reason);
        }
      }, Math.min(everyMs, 3600_000));
      if (typeof tidyTimer.unref === 'function') tidyTimer.unref();
    }
  }

  function dispose() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (tidyTimer) {
      clearInterval(tidyTimer);
      tidyTimer = null;
    }
    cfgCache = null;
  }

  const serviceObj = {
    // 身份 / 归属
    bindIdentity,
    identityOf,
    identityOfSync,
    projectOfSync,
    // 写 / 读
    writeEntry,
    recall,
    appendRecord,
    // 列表 / 概况
    listEntries,
    getOverview,
    getFacets,
    // 改条目（UI 与工具共用）
    retagEntry,
    supersedeEntry,
    archiveEntry,
    // 台账
    readRecords,
    // 导入导出 / 备份
    exportLibrary,
    listExportTargets,
    backupNow,
    listBackups,
    restore,
    mergeLibrary,
    migrateDataDir,
    getSettings,
    runTidy,
    // 生命周期
    _startTimer: startTimer,
    _dispose: dispose,
    _resolveLayout: resolveLayout,
    _loadConfigs: loadConfigs,
  };

  // ⚠️ Remote 端点登记要求 service 是「class 实例」形态：
  // dsh-typert-protocol 的 remoteMethods() 只从 Object.getPrototypeOf(service) 读
  // 符号键描述符；普通对象字面量的 prototype 是 Object.prototype，永远读不到，
  // 结果就是客户端 $mount 成功、请求却 404。
  // 这里给一个专属原型（不改任何方法实现），让 gateway 能发现端点。
  // ⚠️ 方法必须同时出现在 prototype 上！
  // gateway 的 methodParameterNames() 只从 Object.getPrototypeOf(service) 的
  // 原型链上找方法实现（OwnPropertyDescriptor），找不到就抛
  //   Remote marker has no prototype method \"xxx\"
  // 所以不能只让 marker 存在于 prototype、方法却留在实例上。
  // 这里把 10 个 Remote 方法镜像到 proto（不改实例上的实现，二者指向同一函数）。
  // gateway 用 Function.prototype.toString() 解析方法源码来提取参数名，
  // 要求「唯一标识符参数，不许解构 / 默认值 / rest」——
  // 而我们的实现大量用 `fn(x = {})` 和 `fn({ a, b } = {})`，直接镜像会报：
  //   SRC method "xxx" must use unique identifier parameters without destructuring...
  // 所以在 proto 上放一层**纯标识符签名**的薄包装，内部转调真实实现。
  // 使用模块级 REMOTE_SIGNATURES（单一数据源，与 registerRemote 共用）
  for (const name of Object.keys(REMOTE_SIGNATURES)) {
    const impl = serviceObj[name];
    if (typeof impl !== 'function') continue;
    const params = REMOTE_SIGNATURES[name];
    // 用 Function 构造器生成「纯标识符参数」的函数，
    // 这样 toString() 得到的形如 function (query) { ... }，满足 gateway 的解析要求。
    const wrapper = params.length === 0
      ? new Function('impl', 'return function ' + name + '() { return impl.apply(this, arguments) }')(impl)
      : new Function(
          'impl',
          'return function ' + name + '(' + params.join(', ') + ') { return impl.apply(this, arguments) }',
        )(impl);
    Object.defineProperty(HostServiceProto, name, {
      configurable: true,
      writable: true,
      value: wrapper,
    });
  }
  return Object.setPrototypeOf(serviceObj, HostServiceProto);
}

/* ------------------------------------------------------------------ *
 * 会话身份投影
 * ------------------------------------------------------------------ */

const IDENTITY_KEY = 'dsh-tag-memory/identity';

/**
 * 身份投影：从**既有** session 事件 fold 出“本次会话我是谁”。
 *
 * ⚠️ 刻意不自造事件类型（`practices.md:21`：`Session.append()` 无法设置
 * `ignorable: true`，写了新类型会让会话重开失败）。折叠来源：
 *   · `tool/call`  name='dtm_bind'  → arguments 是 JSON 字符串
 *   · `command/run` name='dtm-bind' → args 是原始输入字符串
 *
 * `apply` 必须**同步**，且对不关心的事件**返回同一引用**（引用不变 = 零下游开销）。
 */
function registerIdentityProjection(ctx) {
  try {
    const projections = ctx.get?.('sessionProjections');
    if (!projections || typeof projections.register !== 'function') return;

    const schema = { parse: (v) => v }; // 运行时只要求有 parse；状态是纯 JSON

    projections.register({
      key: IDENTITY_KEY,
      stateSchema: schema,
      stateVersion: 1,
      init: () => ({ 智能体: '', 项目: '' }),
      apply: (state, event) => {
        const parsed = identityFromEvent(event);
        if (!parsed) return state; // ← 返回同一引用：零下游开销
        if (parsed.智能体 === state.智能体 && parsed.项目 === state.项目) return state;
        return { 智能体: parsed.智能体, 项目: parsed.项目 };
      },
    });
  } catch (err) {
    ctx.logger?.warn?.('[dsh-tag-memory] 身份投影注册失败（身份将始终视为未绑定）：%s', err?.message ?? err);
  }
}

/** 从一个 session 事件里解析出身份绑定；不是绑定事件就返回 null。 */
function identityFromEvent(event) {
  const type = event?.type;
  if (type !== 'tool/call' && type !== 'command/run') return null;

  const name = event?.data?.name;
  let payload = null;

  if (type === 'tool/call' && name === 'dtm_bind') {
    const raw = event?.data?.arguments;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (type === 'command/run' && name === 'dtm-bind') {
    const raw = event?.data?.args;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
      payload = JSON.parse(raw);
    } catch {
      // 也接受 "/dtm-bind 罗桥 @项目" 这种裸写法
      const parts = raw.trim().split(/\s+/);
      if (parts.length === 0) return null;
      payload = { 智能体: parts[0], 项目: parts[1] ?? '' };
    }
  } else {
    return null;
  }

  const who = typeof payload?.['智能体'] === 'string' ? payload['智能体'].trim() : '';
  if (who === '') return null;
  const project = typeof payload?.['项目'] === 'string' ? payload['项目'].trim() : '';
  return { 智能体: who, 项目: project };
}

/* ------------------------------------------------------------------ *
 * 定时任务注册
 * ------------------------------------------------------------------ */

function registerTimer(ctx, service, config) {
  try {
    service._startTimer();
    ctx.effect(() => () => service._dispose());
  } catch (err) {
    ctx.logger?.warn?.('[dsh-tag-memory] 定时任务启动失败：%s', err?.message ?? err);
  }
}

/* ------------------------------------------------------------------ *
 * Remote 通道（UI → 宿主）
 *
 * 走**自定义 Remote namespace**（官方通路，非自建 HTTP）：
 *   · Host 侧：服务实例挂 `typertRemote` 绑定 + `ctx.typert.register(invocations)`
 *   · Client 侧：`ctx.remote.$mount(contribution)` 后调 `ctx.remote.tagMemory.*`
 *
 * 同类先例：`settings/*`、`pluginInventory/list`、`pluginManager/*` —— 都无 scope，
 * 进程级、不绑 session，这正是 root-scope 插件页能调宿主的方式。
 *
 * 注意：`dsh-typert-generator` 没装，所以这里手写描述符。官方明确允许
 * （`dsh-typert-loader`：*manual `ctx.typert.register()` … hand-written wire schemas*）。
 *
 * 客户端侧要求 `parameters[].codec.mode === 'strict'`（`requireStrictCodec`），
 * 但客户端**不会调用** `create()`；宿主侧会用 `codec.create().parse(value)`
 * 做边界校验。所以给一个“透传 parser”：真正的校验在业务层（本文件与 engine）。
 * `result` 用 `src-json`，不要求 create/encode，返回形状自由。
 * ------------------------------------------------------------------ */

async function registerRemote(ctx, service) {
  /*
   * ⚠️ 这里是 Remote 端点注册的**唯一正确做法**，踩过四个坑：
   *
   *  ① 不能用 ctx.typert.register({package, face, invocations})
   *     —— 那是 lookup 注册，签名完全不同
   *  ② 服务必须是「class 实例」形态：protocol 的 remoteMethods() 只从
   *     Object.getPrototypeOf(service) 读符号描述符；普通对象字面量的
   *     prototype 是 Object.prototype，永远读不到 → 端点不存在 → 404
   *  ③ 方法必须同时存在于 prototype 链上：gateway 的 methodParameterNames()
   *     用 Object.getOwnPropertyDescriptor 沿原型链找实现，找不到就抛
   *     "Remote marker has no prototype method"
   *  ④ 方法签名必须是**纯标识符**：gateway 用 Function.toString() 解析参数名，
   *     解构 / 默认值 / rest 一律拒绝
   *
   * 满足这四条，gateway 的 collectSrcClaims() 才会把 <namespace>/<method>
   * 登记成合法端点。
   *
   * REMOTE_SIGNATURES 是唯一数据源：参数名在这里定，marker 和包装器都从它派生。
   * client 侧 spec 的参数名必须与这里逐字一致（曾发生 payload/request 漂移，
   * 装上后整个编辑功能不可用，而双方自测都查不出）。
   */
  // 使用模块级 REMOTE_SIGNATURES（单一数据源，与 createHostService 共用）
  const NAMES = Object.keys(REMOTE_SIGNATURES);

  // ---- 1) 绑定：字段必须恰好这三个，service 指向实例本身 ----
  service.typertRemote = Object.freeze({
    service,
    serviceKey: SERVICE_NAME,
    namespace: REMOTE_NAMESPACE,
  });

  // ---- 2) prototype 描述符 + 纯标识符签名包装 ----
  const prototype = Object.getPrototypeOf(service);
  if (!prototype || prototype === Object.prototype) {
    ctx.logger?.warn?.(
      '[dsh-tag-memory] 宿主服务必须是 class 实例（当前是普通对象），Remote 端点无法登记，UI 将不可用。',
    );
    return;
  }

  // 2a) 先放包装器（纯标识符签名，内部转调真实实现）
  for (const name of NAMES) {
    const impl = service[name];
    if (typeof impl !== 'function') continue;
    const params = REMOTE_SIGNATURES[name];
    const wrapper =
      params.length === 0
        ? new Function('impl', 'return function ' + name + '() { return impl.apply(this, arguments) }')(impl)
        : new Function(
            'impl',
            'return function ' + name + '(' + params.join(', ') + ') { return impl.apply(this, arguments) }',
          )(impl);
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value: wrapper,
    });
  }

  // 2b) 再写符号描述符（marker 与包装器一一对应）
  const KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods';
  const existing = Object.getOwnPropertyDescriptor(prototype, KEY);
  const existingMethods =
    existing && existing.value && Array.isArray(existing.value.methods) ? existing.value.methods : [];
  const byMethod = new Map(existingMethods.map((m) => [m.method, m]));
  for (const name of NAMES) {
    byMethod.set(name, Object.freeze({ method: name, invocation: Object.freeze({ kind: 'direct' }) }));
  }
  Object.defineProperty(prototype, KEY, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze([...byMethod.values()]) }),
  });
}

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

/** 时间戳片段（备份/导出文件名用）。 */
/**
 * 宿主服务的专属原型。
 *
 * 只为满足 dsh-typert-protocol 的 Remote 端点发现：它的 remoteMethods() 读的是
 * `Object.getPrototypeOf(service)` 上的符号键描述符。用 Object.prototype 会读不到。
 * 但 gateway 的 methodParameterNames() 只在 prototype 链上找方法实现，所以调用方必须把方法也镜像到 proto（见 createHostService 末尾）。
 */
const HostServiceProto = Object.create(Object.prototype);

function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}
