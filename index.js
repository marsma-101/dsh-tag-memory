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
 * mergeLibrary({ path, dryRun }) → { ok, changed, added, conflicts, backupPath, total, fieldAudit? }
 *   fieldAudit = 字段口径体检（§4.3，纯只读；见 内部文档/记忆合并规则.md）：
 *     外来库的项目/身份名种类、空标签、噪声标签、稳定性分布、时距、疑似重复、建议。
 *     只在 dryRun 与正式返回里附带，**不自动改任何字段、不拦合并**。
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
// 同步读（升级检查要读自己的 package.json 版本号；异步在这里没有收益）
import { readFileSync } from 'node:fs';

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
  formatLocalDate,
} from './lib/engine/core.mjs';

// 已有库的只读体检（见 内部文档/已有库检测与处置规则.md）。
// 单独一个模块，是为了从类型上保证它改不了文件——它不 import 任何写接口。
import { diagnoseLibrary, diagnoseMultiple, findLibraries, inspectMergeFields } from './lib/engine/diagnose.mjs';

import { buildNewRecord, buildWriteLog } from './lib/engine/write.mjs';
import { recall as engineRecall, buildReadLog, ownershipVisible } from './lib/engine/read.mjs';
import { applyTick } from './lib/engine/tick.mjs';
import {
  backupLibrary,
  backupStamp,
  listBackups as engineListBackups,
  restoreBackup,
} from './lib/engine/backup.mjs';
import { planTidy } from './lib/engine/tidy.mjs';
import { isBackupDue, isTidyDue } from './lib/engine/schedule.mjs';
import { canMigrate, verifyMigration } from './lib/engine/migrate.mjs';
import { checkForUpdate } from './lib/engine/update-check.mjs';
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
  // 版本更新检查（方案 C）：无参。UI 手动按钮调它；启动时也走同一实现。
  checkUpdate: [],
});

/**
 * Remote 方法名列表。
 *
 * @deprecated 包内**零消费者**——镜像循环（serviceObj → HostServiceProto）
 * 与 `registerRemote` 都直接写 `Object.keys(REMOTE_SIGNATURES)`，
 * 早先那句「供两个消费者共用」的注释与事实不符。
 * 保留导出只因它已在公开包面（删掉对第三方是 breaking change），
 * 新代码请直接用 `REMOTE_SIGNATURES`。
 */
export const REMOTE_METHOD_NAMES = Object.freeze(Object.keys(REMOTE_SIGNATURES));

/** 允许用户手动改的 6 个字段（《功能说明》§10.3）。 */
const EDITABLE_FIELDS = ['形态', '项目', '智能体', '自由标签', '稳定性', '状态'];

/** 绝不可改的 3 个字段——出现即拒，且要点名（不信任前端）。 */
const READONLY_FIELDS = ['编号', '主要内容', '时距'];

/** 包根目录（index.js 就在包根）。 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** npm 包名（升级检查查 registry 用；与 package.json 的 name 必须一致）。 */
const PACKAGE_NAME = 'dsh-tag-memory';

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
 * 从读库错误里挑出「表头不兼容」这一类致命错误。
 *
 * 为什么要单拎出来：`HEADER_MISSING` 意味着**一行都没读进来**，
 * 与"库是空的"是两回事。调用方必须把它转成明确失败而不是空结果，
 * 否则用户看到的是"我的记忆全没了"，而真相是"格式不兼容"。
 *
 * 只统一**判定**，不统一**返回体**——`listEntries` 要 items/rows/offset/limit，
 * `getOverview` 要 total/active/superseded/archived，两者字段集不同，
 * 强行合并会让返回值多出无关字段。
 */
function headerFatal(errors) {
  return arr(errors).filter((e) => e.code === 'HEADER_MISSING');
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
  registerStartup(ctx, service);

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
  /**
   * 最近一次库体检的结论（启动时算一次，之后随读写返回）。
   *
   * 为什么缓存：体检要读整个库文件，不能每次 recall 都读一遍。
   * 但也不能永久缓存——用户在设置页换了数据目录之后要重算，
   * 所以 `_ensureInitialized` 与 `migrateDataDir` 都会刷新它。
   */
  let libraryIssueCache = null;
  /** 定时任务句柄。 */
  let timer = null;
  /** 整理提醒句柄。与 `timer` 分开持有：两者周期独立，各自可能单独关闭。 */
  let tidyTimer = null;
  /** 上次备份时间（settings 里展示）。 */
  let lastBackupAt = null;

  /**
   * 初始记忆库的播种结果（2026-11-11 加，治「装完空库却一声不响」）。
   *
   * 三态：
   *   · `{seeded:true}`                → 已铺上（首次安装的常态）
   *   · `{seeded:false, reason:'exists'}` → 库本来就有，不覆盖（正常）
   *   · `{seeded:false, reason:'no-bundled-seed', message}` → **包里没带种子**
   *     （旧版本包，例如 v1.2.8）。这条必须能从 overview 看到——
   *     否则用户只看到「怎么什么都没有」，分不清「本来没有」和「铺失败」。
   *   · `{seeded:false, reason:'failed', message}` → 权限/磁盘等原因失败
   */
  let seedState = null;

  /**
   * 版本更新检查结果缓存（2026-11-11，方案 C：启动静默查一次 + 手动按钮）。
   *
   * 为什么需要：主子实测「本地停在 1.2.8，npm 都发到 1.4.1 了还毫不知情」——
   * DSH 插件管理器的更新按钮依赖官方 `updateRefusal()` 的一堆内部条件，
   * 我们改不动也预测不了，所以插件自带检查、自带展示。
   *
   * 结构：`{ checkedAt, current, latest, source, hasUpdate, error, attempts }`
   *   · null            → 还没查过
   *   · hasUpdate:false 且 error:null → 已是最新
   *   · hasUpdate:false 且 error 非空 → **检查失败**（要和「已是最新」区分开！）
   *
   * ⚠️ 三不原则：不阻塞启动、不抛错、不自动升级（只提示）。
   */
  let updateState = null;
  /** 当前插件版本（启动时读一次，读不到就空串）。 */
  let currentVersionCache = '';

  /**
   * 读本插件自己的版本号。
   *
   * 为什么不 import package.json：Node 的 JSON import 要带 `with { type: 'json' }`，
   * 而部分运行时对断言语法支持不一；插件目录里 package.json 一定在，同步读最简单。
   */
  function currentVersion() {
    if (currentVersionCache !== '') return currentVersionCache;
    try {
      const raw = readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8');
      const v = JSON.parse(raw)?.version;
      currentVersionCache = typeof v === 'string' ? v.trim() : '';
    } catch {
      currentVersionCache = '';
    }
    return currentVersionCache;
  }

  /**
   * 查一次更新（结果写进 updateState 并返回）。
   *
   * 手动按钮与启动后台任务共用**同一个实现**（一个能力两个调用方），
   * 不在两处各写一份逻辑。
   *
   * @param {{ force?: boolean }} [opts] force=true 时忽略「刚查过」的节流
   */
  async function checkUpdateNow({ force = false } = {}) {
    // 节流：10 分钟内重复点按钮不再发网络请求（按钮点着玩不该刷爆 registry）
    if (!force && updateState && updateState.checkedAt) {
      const age = Date.now() - Date.parse(updateState.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < 10 * 60 * 1000) return updateState;
    }
    const current = currentVersion();
    try {
      updateState = await checkForUpdate({ currentVersion: current, name: PACKAGE_NAME });
    } catch (err) {
      // checkForUpdate 自己不会抛，这里再兜一层：任何意外都变成「检查失败」而不是插件故障
      updateState = {
        checkedAt: new Date().toISOString(),
        current,
        latest: null,
        source: null,
        hasUpdate: false,
        error: String(err?.message ?? err),
        attempts: [],
      };
    }
    if (updateState.hasUpdate) {
      ctx.logger?.info?.(`[dsh-tag-memory] 有新版本可用：${updateState.current} → ${updateState.latest}`);
    }
    return updateState;
  }

  /**
   * Remote 端点 `tagMemory/checkUpdate` 的实现。
   *
   * **必须零参**：gateway 按 `Function.length` 校验实参个数，客户端调无参方法时
   * 不传任何实参；这个方法若声明了参数（哪怕带默认值），length 仍为 0，
   * 但一旦有人给它加了个必填参数就会静默变成「传 0 个报错」。
   * 用零参箭头函数把「强制刷新」语义固定下来，别把 checkUpdateNow 直接挂上去。
   */
  const checkUpdate = () => checkUpdateNow({ force: true });


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
   * 当前**项目名**（=会话工作目录名）的同步取值，供工具注册时过滤标签网络。
   *
   * 为什么是同步：`registerTools` 同步执行，没法 await。工作目录名必须与
   * 落库时 `projectOf` 用的口径**完全一致**（目录名，不是路径），否则网络会漏掉本项目的词。
   *
   * 拿不到（没有服务、抛错、空串）→ 返回 ''，网络退化为「只有通用条目」。
   * 这个退化是安全的：少显示一些词，不会显示错误的词。
   *
   * @returns {string}
   */
  function currentProjectNameSync() {
    try {
      const dir = process.cwd();
      if (typeof dir !== 'string' || dir === '') return '';
      // path.basename 对「中文/空格路径」同样可靠；去掉可能的尾部分隔符
      const base = path.basename(dir.replace(/[\\/]+$/, ''));
      return base === '' ? '' : base;
    } catch {
      return '';
    }
  }

  /**
   * 当前**智能体名**（绑定身份）的同步取值。
   *
   * ⚠️ 拿不到是常态：身份要等 `dtm_bind` 在某个会话里绑过才有，
   * 而工具注册发生在插件加载时——那时可能还没有任何绑定。
   * 拿不到返回 ''，网络退化为「只有通用条目」。**不能瞎猜**：
   * 猜错会让网络显示别人的词，比不显示更糟。
   *
   * @returns {string}
   */
  function currentAgentNameSync() {
    try {
      // 绑定信息按 agent 对象存在内存里；注册时拿不到 agent 对象，
      // 所以这里只能给出「最近一次绑定的名字」这个粗粒度值。
      // 没有绑定过就是 ''。
      const last = typeof lastBoundAgentName === 'string' ? lastBoundAgentName : '';
      return last;
    } catch {
      return '';
    }
  }

  /**
   * 同步取「当前库 CSV 的绝对路径」——只供 preset 注册 dtm_recall 时算标签词表。
   *
   * 为什么不直接复用 `resolveLayout()`：那个是 **async**（要 await 读 settings 文件），
   * 而 preset 的 registerTools 是同步函数。为一行词表把整条工具注册链改异步，
   * 代价远大于收益。
   *
   * 因此这里只走**同步可得的优先级**：
   *   ① config.dataDir   ② 环境变量   ③ 默认 dsh-home
   * 跳过 ③ 设置页（要读文件）。偏差后果：用户若在设置页手动搬过家，词表会按默认位置算，
   * 算不出来时读文件失败 → 自动降级为「不渲染词表」。
   * **这个偏差是有意接受的**：词表缺失只是少个路标，不会给出错误信息。
   *
   * @returns {string} 库 CSV 的绝对路径；算不出来返回 ''
   */
  function libraryCsvPath() {
    try {
      const resolved = resolveDataDir({
        configDir: config?.dataDir,
        envDir: process.env.DSH_TAG_MEMORY_DATA_DIR,
        settingsDir: null, // 同步路径拿不到设置页的值，见上方说明
        dshHomeDir: currentDshHome(),
        packageDir: PACKAGE_DIR,
      });
      const dir = resolved?.dir;
      if (typeof dir !== 'string' || dir === '') return '';
      return layoutOf(dir).libraryCsv;
    } catch {
      return '';
    }
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

  /**
   * ⑤ 包内兜底的告警文案——**唯一来源**。
   *
   * 为什么要有这个函数：这段文案原先在 UI 与日志里各写一遍，
   * 措辞已经漂了（一处 `**粗体**`、一处 `%s` 占位、连"重装/升级"的斜杠都不同），
   * 而注释却写着"共用同一句话"。现在只保留这一份，两边都从这里取。
   *
   * 参数用模板拼而不是 `%s`：UI 侧拿到的必须是最终字符串，
   * 日志侧自己再 `console.warn(text)` 即可，两边永远不会漂。
   */
  function packageFallbackWarning(source, dir) {
    if (source !== 'package') return null;
    return (
      `数据目录落在插件包内（${dir}）——pnpm 重装或升级插件会整个删除这个目录，数据会丢。` +
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
    // 与 UI 同一份文案（见 packageFallbackWarning），只多一个前缀。
    ctx.logger?.warn?.('[dsh-tag-memory] ⚠️ ' + packageFallbackWarning('package', dir));
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
   * 最近一次 `dtm_bind` 绑定的身份名（进程级）。
   *
   * 为什么需要它：`buildToolDefs` 在插件注册时构建工具描述，那一刻**没有 agent 对象**，
   * 拿不到 `identityOfSync(agent)`。而标签网络需要按「当前智能体」过滤。
   * 这是唯一同步可得的线索——它可能落后（用户还没绑过就是空），
   * 但空值只会让网络少显示本智能体的词，**不会显示错的词**，这个退化是安全的。
   */
  let lastBoundAgentName = '';

  /**
   * 确保数据目录骨架存在（store / records / backup）。
   *
   * ⚠️ 必须在 `withFileLock` **之前**调用：锁是 `open(lockPath,'wx')`，
   * 而 lockPath 在 `store/` 下——目录不存在会直接 ENOENT（全新安装时必然发生）。
   * `appendRecordCsv` 自己会 mkdir，但那是在锁内、已经太晚。
   *
   * 顺带把**初始记忆**铺上：包内自带 `data/store/memory.csv`，首次初始化时
   * 复制到数据目录。这样「装完就有 6 条说明」，不依赖任何安装脚本——
   * 从官方插件界面装（走 pnpm add，不跑 scripts/install.mjs）也有。
   * 只在库文件**不存在**时复制；已有库绝不覆盖。
   */
  async function ensureDirs(layout) {
    await fsp.mkdir(layout.storeDir, { recursive: true });
    await fsp.mkdir(layout.recordsDir, { recursive: true });
    await seedInitialLibrary(layout);
  }

  /**
   * 启动时的一次性初始化：解析数据目录 → 体检已有库 → 建骨架 → 铺初始库。
   *
   * 由 `registerStartup` 在插件加载后异步调用（不 await）。之所以要在启动时
   * 做、而不是等第一次读写：用户装完插件第一件事是**打开界面看列表**，
   * 而列表走的是只读路径（不经过 `ensureDirs`），等他真的写第一条记忆时
   * 才铺初始库就太晚了——界面一直是空的，看起来像坏了。
   *
   * ⚠️ 顺序不能反：**必须先体检、后播种**。
   * 先播种的话，`COPYFILE_EXCL` 遇到旧库会 EEXIST 静默跳过，
   * 于是那份 0.3.7 的旧文件永远躺在那儿，一条也读不出来——
   * 用户看到的是「我的记忆全没了」。体检就是为了识别这种局面。
   */
  async function ensureInitialized() {
    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();

    // ① 体检（只读，绝不改文件）
    let issue = null;
    try {
      issue = await diagnoseLibrary(layout.libraryCsv, schema);
    } catch (err) {
      ctx.logger?.warn?.('[dsh-tag-memory] 库体检失败（不影响使用）：', err?.message ?? err);
    }
    libraryIssueCache = issue;

    // ② 建骨架 + 按体检结论决定要不要铺初始库。
    // 注意：`seedInitialLibrary` 自动处理失败时会把 libraryIssueCache 换成
    // AUTOFIX_FAILED，那个结论比体检结果更新，所以 ③ 不能无条件覆盖它。
    await fsp.mkdir(layout.storeDir, { recursive: true });
    await fsp.mkdir(layout.recordsDir, { recursive: true });
    await seedInitialLibrary(layout, issue);

    // ③ 自动处理成功（库已被换成新格式）时，旧的体检结论已过期，清掉。
    //    失败的情况上面已经换成 AUTOFIX_FAILED，保持不动。
    if (libraryIssueCache === issue && issue?.autoFixable === true) {
      libraryIssueCache = null;
    }

    return { ok: true, issue: libraryIssueCache };
  }

  /**
   * 首次初始化：把包内自带的初始库复制到数据目录。
   *
   * 分诊规则（见 内部文档/已有库检测与处置规则.md §3）：
   *   库不存在                    → 铺初始库
   *   库存在、正常                 → 什么都不做（绝不覆盖）
   *   旧格式但**0 行**（无数据可丢） → 备份旧文件 → 铺初始库（自动，可逆）
   *   旧格式**有数据**             → **什么都不做**，只把 issue 报出去问用户
   *   其他问题（缺列/坏行/读不了）  → 什么都不做，只报
   *
   * 为什么只有「0 行旧格式」能自动处理：那份文件里没有任何记忆，
   * 换掉它不丢东西；而一旦有数据，旧格式的列就推不出新格式的形态，
   * 自动转换等于编造用户记忆。
   */
  async function seedInitialLibrary(layout, issue) {
    // config.seed === false 时跳过（测试用）。默认播种：装完即见初始记忆。
    if (config?.seed === false) return;

    // 库已存在且**没有**需要自动处理的结论 → 一律不动。
    if (issue?.exists && issue?.autoFixable !== true) return;

    // P2（2026-11-12）：ensureDirs 每次读写都调本函数。库已存在时直接返回，
    // 不必每次都 copyFile→EEXIST→把 seedState 翻成 {seeded:false,reason:'exists'}
    // （无谓 IO + overview 的 seed 态抖动）。真正的首次播种由 ensureInitialized 负责。
    if (!issue) {
      try {
        await fsp.access(layout.libraryCsv);
        return; // 库已在，跳过
      } catch {
        /* 不存在，继续往下铺 */
      }
    }

    const bundled = path.join(PACKAGE_DIR, 'data', 'store', 'memory.csv');

    // 旧格式空壳：先备份再铺，备份路径要留痕（用户可能想找回原文件）。
    if (issue?.autoFixable === true) {
      try {
        // P2（2026-11-12）：旧实现用日期戳（YYYYMMDD），同日重试会覆盖前一份备份。
        // 改用秒级时间戳 + COPYFILE_EXCL（绝不覆盖既有备份）。
        const stamp = backupStamp(new Date());
        const backupDir = path.join(layout.dataDir, 'backup');
        await fsp.mkdir(backupDir, { recursive: true });
        let backupPath = path.join(backupDir, `memory.legacy-${stamp}.csv`);
        let n = 0;
        for (;;) {
          try {
            await fsp.copyFile(layout.libraryCsv, backupPath, 1); // 1 = COPYFILE_EXCL
            break;
          } catch (e) {
            if (e?.code === 'EEXIST') {
              n += 1;
              backupPath = path.join(backupDir, `memory.legacy-${stamp}-${n}.csv`);
              continue;
            }
            throw e;
          }
        }
        await fsp.rm(layout.libraryCsv, { force: true });
        ctx.logger?.info?.(
          `[dsh-tag-memory] 旧格式空库已备份到 ${backupPath}（原文件 0 条数据，未丢内容），将铺初始记忆库。`,
        );
      } catch (err) {
        // 备份失败 → **绝不能**继续删/覆盖。原文件留着，等用户处理。
        //
        // ⚠️ 这里必须把失败**升级成可见的问题**，不能只写日志。
        // 实测踩过：备份代码里有个未定义的引用（ReferenceError），
        // 被这个 catch 吞掉后表现为「插件什么都没做」——
        // 用户看到旧库还在、一条读不出来，却完全不知道自动处理失败过。
        // 静默失败比报错更难查。
        libraryIssueCache = {
          ok: false,
          exists: true,
          severity: 'blocking',
          code: 'AUTOFIX_FAILED',
          message:
            `发现旧格式空库，尝试备份后换成新格式时失败：${err?.message ?? err}。` +
            '原文件保持不动，你的数据没有受影响。',
          question:
            '自动整理旧格式空库时出错了（原文件没被动过）。要我告诉你文件路径，你手动处理吗？',
          options: [
            { id: 'keep-as-is', label: '先不动，我自己看文件', risk: 'safe' },
            { id: 'retry', label: '再试一次自动处理', risk: 'safe' },
          ],
          found: { path: layout.libraryCsv, rows: 0 },
          autoFixable: false,
        };
        ctx.logger?.warn?.(
          '[dsh-tag-memory] 旧格式空库备份失败，已放弃自动处理（原文件保持不动）：',
          err?.message ?? err,
        );
        return;
      }
    }

    try {
      // 1 = fs.constants.COPYFILE_EXCL（目标已存在则失败）。
      // 写数字而不 import node:fs 的 constants：本文件只依赖 fsp，
      // 多引一个具名导出没有收益，而这个常量是 POSIX/Win32 都稳定的 1。
      await fsp.copyFile(bundled, layout.libraryCsv, 1);
      ctx.logger?.info?.('[dsh-tag-memory] 已铺初始记忆库（包内自带）。');
      seedState = { seeded: true, reason: null };
    } catch (err) {
      // EEXIST = 库已存在（正常，不覆盖）
      if (err?.code === 'EEXIST') {
        seedState = { seeded: false, reason: 'exists' };
        return;
      }
      // ⚠️ ENOENT 曾在这里**静默吞掉**，注释写「包里没带初始库（旧版本包）」。
      // 实测后果（2026-11-11 主子在容器里装的 1.2.8）：包里确实没有 data/，
      // 于是装完是空库，而插件一声不响——用户只看到「怎么什么都没有」，
      // 完全无法区分「本来就没有种子」和「种子铺失败了」。
      // 现在改成**可诊断状态**：记下来并从 overview 暴露出去（UI/模型能看到）。
      if (err?.code === 'ENOENT') {
        seedState = {
          seeded: false,
          reason: 'no-bundled-seed',
          message:
            '这个插件包里没有自带初始记忆库（data/store/memory.csv）。' +
            '常见于较旧的安装包（初始记忆是 v1.2.9 起才随包发布的）。' +
            '这不影响功能：库是空的，你写第一条记忆就会自动创建。',
        };
        ctx.logger?.warn?.(
          '[dsh-tag-memory] 包内没有初始记忆库（旧版本包？），跳过播种。库为空属正常，写入即创建。',
        );
        return;
      }
      // 其余错误（权限/磁盘）也只记日志——记忆库建不起来不该让插件整体挂掉。
      seedState = { seeded: false, reason: 'failed', message: String(err?.message ?? err) };
      ctx.logger?.warn?.('[dsh-tag-memory] 铺初始记忆库失败（不影响使用）：', err?.message ?? err);
    }
  }

  /**
   * 把体检结论裁成「给智能体/UI 看」的形态。
   *
   * 为什么不全量返回：体检结果里有 `found.columns`（整个表头）、`notes` 等
   * 排查用字段，塞进每次 recall 的返回值会让 token 暴涨，而智能体只需要
   * 「出了什么事、能怎么办、要不要问人」这三样。
   *
   * 返回 null 表示库没问题——**没问题就不占一个字段**，
   * 免得智能体每次都看到一堆 null 去猜含义。
   */
  function publicIssue(issue) {
    if (!issue) return null;
    if (issue.severity === 'ok') return null;
    return {
      code: issue.code ?? null,
      severity: issue.severity,
      message: issue.message ?? null,
      question: issue.question ?? null,
      options: arr(issue.options),
      found: {
        path: issue.found?.path ?? null,
        rows: Number(issue.found?.rows ?? 0),
        ...(arr(issue.found?.missing).length > 0 ? { missing: arr(issue.found.missing) } : {}),
        ...(Number(issue.found?.badRows ?? 0) > 0 ? { badRows: Number(issue.found.badRows) } : {}),
      },
      /** true = 插件能自己安全处理（没有数据可丢），false/缺省 = 必须问用户。 */
      autoFixable: issue.autoFixable === true,
    };
  }

  /** 设置页选的库位置：<包根>/config/data-dir.json。读不到就当没选。 */
  /**
   * 搬家指针的稳定存放位置（2026-11-12 P1-7）。
   *
   * 旧实现写在**包内** config/data-dir.json，pnpm 升级/重装会替换整个包目录 →
   * 指针丢失 → 数据目录回退兜底，用户看到「我的记忆库不见了」（数据其实还在原处）。
   * 现在写到 DSH_HOME 下（包外、跨升级稳定）：`$DSH_HOME/tag-memory-settings.json`。
   * DSH_HOME 拿不到时退回包内（与旧行为一致，至少不崩）。
   */
  function settingsPointerFile() {
    const home = currentDshHome();
    if (home) return path.join(home, 'tag-memory-settings.json');
    return path.join(PACKAGE_DIR, 'config', 'data-dir.json');
  }

  async function readSettingsDir() {
    // 先读稳定位置；读不到再兼容旧的包内指针（升级前搬过家的用户）。
    const candidates = [settingsPointerFile(), path.join(PACKAGE_DIR, 'config', 'data-dir.json')];
    for (const file of candidates) {
      try {
        const raw = await fsp.readFile(file, 'utf8');
        const obj = JSON.parse(raw);
        if (typeof obj?.dataDir === 'string' && obj.dataDir !== '') return obj.dataDir;
      } catch {
        /* 试下一个 */
      }
    }
    return null;
  }

  /** 写设置页的库位置（写到包外稳定位置，升级不丢）。 */
  async function writeSettingsDir(target) {
    const file = settingsPointerFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify({ dataDir: target }, null, 2)}\n`, 'utf8');
  }

  /** 取三份配置（进程内缓存，dispose 时清空；templates 改动需重载插件才生效，不会自动重读）。 */
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
    // P2（2026-11-12）：旧实现 `|| str(项目)` 在取不到工作目录时仍采纳模型项目，
    // 与 writeEntry「模型值一律丢弃」口径不符。现在只用程序值；取不到就留空，
    // 写入时会被 PROJECT_EMPTY 拒（让模型去补环境，而不是猜一个字符串）。
    const programProject = projectOfSync(agent);
    // 进程内兜底：key 是 agent 对象本身；没有 agent 时不缓存（无从归属）。
    if (agent && typeof agent === 'object') {
      identityFallback.set(agent, { 智能体: who, 项目: programProject });
    }
    // 记下「最近一次绑定的身份名」——供 tool-defs 的标签网络做视角过滤。
    // 为什么需要它：工具描述在插件注册时构建，那时拿不到 agent 对象；
    // 这是唯一同步可得的身份线索。拿到旧值也只是网络少显示一些词，不会显示错的。
    lastBoundAgentName = who;
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
      const { records, errors } = await readLibraryCsv(layout.libraryCsv, schema);
      // P1-3（2026-11-12）：表头坏了＝一行都没读进来，绝不是「空库」。
      // 此时若照常 append，新编号基于空记录集计算，会与坏行里的真实编号撞车，
      // 坏库越写越大。必须拒写并把格式问题报出来（error-handling：不得把读不到伪装成没有）。
      const fatal = headerFatal(errors);
      if (fatal.length > 0) {
        return { ok: false, errors: fatal.map((e) => ({ ...e, code: 'LIBRARY_FORMAT_MISMATCH' })) };
      }
      const existingIds = records.map((r) => r['编号']);
      built = buildNewRecord({ input: effectiveInput, existingIds, schema, now: new Date() });
      if (!built.ok) return { ok: false, errors: built.errors };
      await appendRecordCsv(layout.libraryCsv, built.record, schema);
      return { ok: true, rowErrors: arr(errors).filter((e) => e.code !== 'HEADER_MISSING') };
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
    let rowErrors = [];
    await withFileLock(layout.lockFile, async () => {
      const { records, errors } = await readLibraryCsv(layout.libraryCsv, schema);

      // P1-3（2026-11-12）：表头坏了＝一行都没读进来，不是「查空」。
      // 报格式问题，别让模型误以为库里没有而换词重试。
      const fatal = headerFatal(errors);
      if (fatal.length > 0) {
        result = { ok: false, blocked: 'LIBRARY_FORMAT_MISMATCH', errors: fatal, hits: [], near: [] };
        return;
      }
      rowErrors = arr(errors);

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
      // P1-4（2026-11-12）：有坏行时**跳过时距落盘**。writeLibraryCsv 是整库重写，
      // 会把列数不符/引号撕裂的坏行「尽力解析」成缺字段行再写回——原始字节永久丢失，
      // 用户手工修复的物证被抹掉。频率最高的写路径反而最该保护原始数据。
      const ids = arr(result.hits).map((h) => h['编号']);
      if (ids.length > 0 && rowErrors.length === 0) {
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
      // 库本身有问题时（旧格式/缺列/坏行/多份库），把结论一并带出。
      // 智能体看到它就该**停下来问用户**，而不是自己猜着迁移。
      // 注意：这不改变 empty 的语义——「库坏了」和「你确实没有这条记忆」是两件事，
      // 混成一句会让用户以为自己的记忆丢了。
      libraryIssue: publicIssue(libraryIssueCache),
    };
  }

  /* ---------------- 列表 / 概况 / 候选 ---------------- */

  /**
   * 列出条目（只读）。
   * **不记 read.jsonl、不动时距**——它不是召回，只是看一眼（《功能说明》§十二 dtm_review）。
   */
  async function listEntries(agentOrFilter, filterArg) {
    // 两种调用形状（与 retagEntry 同一判别法，2026-11-12 P1-18）：
    //   · 工具侧：listEntries(agent, filter) —— 有会话，按当前归属隔离
    //   · UI 侧： listEntries(filter)        —— 远程端点单参，用户手动通道，不隔离
    // 判别：第二参给了 → 双参（工具）；否则第一参无 .session → 单参 filter（UI）。
    let agent = agentOrFilter;
    let filter = filterArg;
    if (filterArg === undefined && agentOrFilter && typeof agentOrFilter === 'object' && !agentOrFilter.session) {
      agent = null;
      filter = agentOrFilter;
    }
    filter = filter ?? {};

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();
    const { records, errors } = await readLibraryCsv(layout.libraryCsv, schema);

    // ⚠️ 库读不进来时**必须报出来**，不能静默返回空列表。
    // 真实场景：旧版 8 列库（缺「自由标签」）会得到 HEADER_MISSING；
    // 若这里吞掉 errors 只返回 total:0，用户看到的是"我的记忆全没了"，
    // 而真相是"格式不兼容，一行都没读进来"——两者处置完全不同。
    const fatal = headerFatal(errors);
    if (fatal.length > 0) {
      return {
        ...fail(fatal, 'LIBRARY_FORMAT_MISMATCH'),
        items: [],
        rows: [],
        total: 0,
        offset: 0,
        limit: 0,
        libraryIncompatible: true,
        libraryIssue: publicIssue(libraryIssueCache) ?? {
          code: 'LIBRARY_FORMAT_MISMATCH',
          severity: 'blocking',
          message: '记忆库格式不兼容，一条都读不出来。这不代表你没有记忆。',
          question: '记忆库格式不兼容（表头对不上），要我告诉你文件路径吗？',
          options: [{ id: 'keep-as-is', label: '先不动，我自己看文件', risk: 'safe' }],
          found: { path: layout.libraryCsv, rows: 0 },
          autoFixable: false,
        },
      };
    }

    const shape = str(filter['形态']);
    const status = str(filter['状态']);
    const tags = arr(filter['自由标签']).map(str).filter((t) => t !== '');

    // 归属隔离（2026-11-12 P1-18）：工具通道（有 agent）按当前 项目/智能体 强制隔离，
    // 模型不能借 review 读到别的项目/身份的记忆全文；UI 通道（agent=null）是用户手动，
    // 保留按 项目/智能体 自由筛选的能力。
    const identity = agent ? identityOfSync(agent) : null;
    const scope = identity
      ? { project: projectOfSync(agent), agent: identity.智能体 }
      : null;
    const project = scope ? '' : str(filter['项目']);
    const agentName = scope ? '' : str(filter['智能体']);

    const matched = records.filter((r) => {
      if (scope && !ownershipVisible(r, scope, schema)) return false;
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
      // 库有问题时（旧格式/缺列/坏行/多份库）一并带出，让界面能提示。
      // 正常时是 null，不占字段。
      libraryIssue: publicIssue(libraryIssueCache),
    };
  }

  /** 库概况（只读）。 */
  async function getOverview() {
    const { layout, source } = await resolveLayout();
    const { schema } = await loadConfigs();
    const { records, errors } = await readLibraryCsv(layout.libraryCsv, schema);

    // 与 listEntries 同理：库读不进来时必须让 UI 知道，
    // 否则概况显示 total:0 会被误解成"记忆丢了"。
    const fatal = headerFatal(errors);
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
        libraryIssue: publicIssue(libraryIssueCache) ?? {
          code: 'LIBRARY_FORMAT_MISMATCH',
          severity: 'blocking',
          message: '记忆库格式不兼容，一条都读不出来。这不代表你没有记忆。',
          question: '记忆库格式不兼容（表头对不上），要我告诉你文件路径吗？',
          options: [{ id: 'keep-as-is', label: '先不动，我自己看文件', risk: 'safe' }],
          found: { path: layout.libraryCsv, rows: 0 },
          autoFixable: false,
        },
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
      libraryIssue: publicIssue(libraryIssueCache),
      // 初始记忆库的播种结论（2026-11-11）：让「装完空库」有据可查。
      // seed.reason === 'no-bundled-seed' 说明装的是不带种子的旧版本包，
      // 这不是故障，但必须能看见 —— 否则用户只看到空界面，无从判断是不是坏了。
      seed: seedState,
      emptyHint:
        records.length === 0
          ? '库是空的（不是坏了）。写第一条记忆会自动创建文件；'
            + '若这个版本没自带初始记忆，属正常，不影响使用。'
          : null,
      // 版本更新（方案 C）：当前版本恒有；update 是最近一次检查结果（可能为 null = 还没查）
      version: currentVersion(),
      update: updateState,
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

      // 归属守卫（2026-11-12 P1-18）：工具通道只能改自己可见的条，
      // 不能借编号改别的项目/身份的条目。UI 通道（agent=null）是用户手动，放行。
      if (identity && !ownershipVisible(records[idx], { project: projectOfSync(agent), agent: identity.智能体 }, schema)) {
        outcome = { ok: false, errors: [{ code: 'OWNERSHIP_DENIED', field: '编号', message: `条目 ${targetId} 不属于当前项目/身份，无权修改。` }] };
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

      // 归属守卫（2026-11-12 P1-18）：只能顶替自己可见的条。
      const scope = { project: projectOfSync(agent), agent: identity.智能体 };
      if (!ownershipVisible(records[idx], scope, schema)) {
        outcome = { ok: false, errors: [{ code: 'OWNERSHIP_DENIED', field: '旧编号', message: `条目 ${oldId} 不属于当前项目/身份，无权顶替。` }] };
        return;
      }

      const existingIds = records.map((r) => r['编号']);

      // 归属由程序填（2026-11-12 P1-9，与 write/recall 同一裁定）：
      // 新条**沿用旧条的归属**——顶替是「同一条记忆的新版本」，不是搬家。
      // 旧条在「通用」，新条也必须在「通用」，否则可见性会被悄悄改变。
      // 模型不再传 项目/智能体（工具 schema 已移除这两个参数）。
      const built = buildNewRecord({
        input: {
          ...input,
          项目: records[idx]['项目'],
          智能体: records[idx]['智能体'],
        },
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

    await writeTidyLog({ who: identity.智能体, action: 'supersede', target: oldId, before: pickEditable(outcome.old), after: pickEditable(outcome.newRecord), basis });

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
      // 归属守卫（2026-11-12 P1-18）：只能归档自己可见的条。
      if (!ownershipVisible(records[idx], { project: projectOfSync(agent), agent: identity.智能体 }, schema)) {
        outcome = { ok: false, errors: [{ code: 'OWNERSHIP_DENIED', field: '编号', message: `条目 ${targetId} 不属于当前项目/身份，无权归档。` }] };
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

  async function readRecords(agentOrOpts, optsArg) {
    // 两种调用形状（2026-11-12 P1-18）：工具侧 readRecords(agent, opts) 按归属隔离；
    // UI/旧单参 readRecords(opts) 不隔离（用户手动通道）。
    let agent = agentOrOpts;
    let opts = optsArg;
    if (optsArg === undefined && agentOrOpts && typeof agentOrOpts === 'object' && !agentOrOpts.session) {
      agent = null;
      opts = agentOrOpts;
    }
    const { kind, limit, onlyFailed } = opts ?? {};
    const { layout } = await resolveLayout();
    const kinds = kind ? [str(kind)] : Object.keys(RECORD_FILES);
    const cap = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 50;

    // 归属隔离：工具通道只看得到的台账（read 用 cond.项目/cond.智能体 + who；write 用 项目/智能体 + who）。
    const identity = agent ? identityOfSync(agent) : null;
    const scope = identity ? { project: projectOfSync(agent), agent: identity.智能体 } : null;
    const visibleLog = (it) => {
      if (!scope) return true;
      const universals = ['通用', '引入'];
      const okField = (v) => {
        const s = String(v ?? '').trim();
        return s === '' || s === '通用' || universals.includes(s) || s === scope.project || s === scope.agent;
      };
      // read 台账：cond.项目/cond.智能体；write/tidy 台账：顶层 项目/智能体 或 who
      const p = it.cond ? it.cond['项目'] : it['项目'];
      const a = it.cond ? it.cond['智能体'] : it['智能体'];
      const who = String(it.who ?? '').trim();
      const whoOk = who === '' || who === scope.agent || universals.includes(who);
      return okField(p) && okField(a) && whoOk;
    };

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
        if (!visibleLog(it)) continue;
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
      // P2（2026-11-12）：只读查询不该写盘探测。旧实现 mkdir + 写 .dsh-write-probe + unlink，
      // 让一个「列目录」方法产生副作用。改用 access(W_OK) 判可写；目录不存在时
      // 退而判其父目录可写（export 时会 mkdir recursive）。
      // W_OK = 2（POSIX/Win32 稳定，同 COPYFILE_EXCL 用字面量 1 的做法，不另引 fs.constants）。
      const W_OK = 2;
      let writable = false;
      try {
        await fsp.access(c.dir, W_OK);
        writable = true;
      } catch {
        try {
          await fsp.access(path.dirname(c.dir), W_OK);
          writable = true;
        } catch {
          writable = false;
        }
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
  /**
   * 路径围栏（2026-11-12，容器审查 P0-4）。
   *
   * 为什么必须有：export/merge 的 path 由模型自由填写，而宿主以 root 运行——
   * 不围栏就是任意文件写/读（覆盖 ~/.bashrc、读任意文件当库并入）。
   * UI 侧早有 listExportTargets 白名单，但工具侧从不 enforce，这次补齐。
   *
   * 判据（vuln-hunter「带路径参数先按穿越对待」）：
   *   · resolve 后必须落在 数据目录/备份目录/台账目录 之一（与 UI 同一组候选）
   *   · 目标已存在 → realpath 后再验一次（防符号链接穿越）
   *   · 目标不存在 → 验最近的存在祖先（防「真目录/ symlink 指出去」）
   * 返回 { ok, dest } 或 { ok:false, code, message }。
   */
  async function confinePath(target, layout, { mustExist = false } = {}) {
    const raw = str(target);
    if (raw === '') return { ok: false, code: 'PATH_REQUIRED', message: '必须给出路径。' };
    const dest = path.resolve(raw);
    // roots 与 dest 都要归一到真实路径再比：Windows 的 tmpdir/用户目录可能是 8.3 短名
    // （ADMINI~1），realpath 返回长名，不归一会把合法路径误判越界（B1 实测）。
    const realOf = async (p) => {
      try {
        return await fsp.realpath(p);
      } catch {
        return p; // 尚不存在：用 resolve 后的形式
      }
    };
    const roots = await Promise.all(
      [layout.dataDir || path.dirname(layout.libraryCsv), layout.backupDir, layout.recordsDir]
        .filter(Boolean)
        .map(async (r) => realOf(path.resolve(r))),
    );
    const under = (p) => roots.some((r) => p === r || p.startsWith(r + path.sep));
    if (!under(dest) && !under(await realOf(dest))) {
      return {
        ok: false,
        code: 'PATH_NOT_ALLOWED',
        message: `路径越界：${dest}。只允许写在数据目录/备份目录/台账目录内（与设置页导出白名单一致）。`,
      };
    }
    // 符号链接穿越：对「已存在的部分」取 realpath 再验。
    let probe = dest;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (!under(real)) {
          return { ok: false, code: 'PATH_NOT_ALLOWED', message: `路径经符号链接指向白名单外：${real}。` };
        }
        break;
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          if (mustExist) return { ok: false, code: 'PATH_NOT_FOUND', message: `文件不存在：${dest}。` };
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
          continue;
        }
        return { ok: false, code: 'PATH_UNREADABLE', message: `无法校验路径：${err?.message ?? err}` };
      }
    }
    return { ok: true, dest };
  }

  async function exportLibrary({ path: target } = {}) {
    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();

    // 默认导出到备份目录；显式给路径则过围栏。
    let dest;
    if (str(target)) {
      const c = await confinePath(target, layout);
      if (!c.ok) return reject(c.code, c.message, 'path');
      dest = c.dest;
    } else {
      dest = path.join(layout.backupDir, `export-${backupStamp()}.csv`);
    }

    // 默认拒覆盖既有文件（error-handling：不得无保证地覆盖用户数据）。
    try {
      await fsp.access(dest);
      return reject('EXPORT_TARGET_EXISTS', `目标已存在，拒绝覆盖：${dest}。换个文件名，或先移走旧文件。`, 'path');
    } catch {
      /* 不存在才继续 */
    }

    const { records } = await readLibraryCsv(layout.libraryCsv, schema);
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    let bytes = 0;
    try {
      const raw = await fsp.readFile(layout.libraryCsv);
      await fsp.writeFile(dest, raw, { flag: 'wx' });
      bytes = raw.length;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // 库还不存在：导出一个只有表头的空库，别报错
        const header = `${arr(schema.columns).join(',')}\r\n`;
        await fsp.writeFile(dest, header, { flag: 'wx' });
        bytes = Buffer.byteLength(header, 'utf8');
      } else if (err && err.code === 'EEXIST') {
        return reject('EXPORT_TARGET_EXISTS', `目标已存在，拒绝覆盖：${dest}。`, 'path');
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
    let lastTidyTs = '';

    await withFileLock(layout.lockFile, async () => {
      const lib = await readLibraryCsv(layout.libraryCsv, schema);
      records = arr(lib.records);
      // ⚠️ readJsonl 返回的是 { items, errors }，不是数组（core.mjs:626）
      // 直接当数组用会导致台账永远读成空 —— 整理就永远不会改任何东西。
      const rl = await readJsonl(layout.recordsDir + '/read.jsonl');
      const wl = await readJsonl(layout.recordsDir + '/write.jsonl');
      const tl = await readJsonl(layout.recordsDir + '/tidy.jsonl');
      readLogs = arr(rl && rl.items);
      writeLogs = arr(wl && wl.items);
      // P1-1（2026-11-12）：反馈开窗起点 = 上次整理的时间戳（tidy.jsonl 最后一条）。
      // 没有它，wrong 按全历史累计永远 >0，「易变→观察」自愈永远不可达。
      // 复用既有台账，不新增持久化文件（最懒可行）。首次整理无台账 → 全量。
      const tidyItems = arr(tl && tl.items);
      for (const t of tidyItems) {
        const ts = String(t?.ts ?? '');
        if (ts > lastTidyTs) lastTidyTs = ts;
      }
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
        // 反馈统计窗口：只算上次整理以来的召回（P1-1）。
        sinceTs: lastTidyTs,
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

  /**
   * 从备份恢复。破坏性操作：**先把当前库再备份一次**再覆盖。
   *
   * ── 2026-11-12 修复（容器审查 P0-3）──────────────────────────
   * 旧实现三个洞：① 安全备份失败仍继续覆盖（失去回滚点）；
   * ② 全程无锁，与并发 write/recall 竞态；③ 不写台账，审计链断裂。
   * 现在与 retag/tidy 同口径：备份失败即中止；整个恢复包进文件锁；补台账。
   */
  async function restore({ from } = {}) {
    const src = str(from);
    if (src === '') return reject('SOURCE_REQUIRED', '必须给出要恢复的备份文件路径。', 'from');

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();

    await ensureDirs(layout);
    return await withFileLock(layout.lockFile, async () => {
      // 恢复本身会覆盖库：先留一个回滚点。**失败即中止，绝不无回滚点覆盖。**
      const safety = await backupLibrary({ libraryCsv: layout.libraryCsv, backupDir: layout.backupDir, schema, suffix: '-before-restore' });
      if (!safety.ok) return { ...fail(safety.errors, 'BACKUP_FAILED'), backupErrors: safety.errors };

      const before = await readLibraryCsv(layout.libraryCsv, schema);
      const result = await restoreBackup({ backupCsv: src, libraryCsv: layout.libraryCsv, schema });
      if (!result.ok) return { ...fail(result.errors, 'RESTORE_FAILED'), backupPathBefore: safety.path };

      await writeTidyLog({
        who: '（恢复）',
        action: 'restore',
        target: src,
        before: { count: before.records.length },
        after: { count: result.records },
        basis: safety.path,
      });

      return {
        ok: true,
        records: result.records,
        backupPathBefore: safety.path,
      };
    });
  }

  /**
   * 合并另一份记忆库。
   * 冲突原则：编号唯一，同号保留较新（时距大 > 稳定性高 > 保留当前库，见 mergeInto）。
   */
  async function mergeLibrary({ path: otherPath, dryRun } = {}) {
    const src = str(otherPath);
    if (src === '') return reject('PATH_REQUIRED', '必须给出要合并的库文件路径。', 'path');

    const { layout } = await resolveLayout();
    const { schema } = await loadConfigs();

    // 路径围栏（P0-4）：merge 会读任意文件当库并入，必须与 export 同一白名单。
    // 合法工作流：先 dtm_export 到数据目录，再 dtm_merge 该文件。
    const conf = await confinePath(src, layout, { mustExist: true });
    if (!conf.ok) return reject(conf.code, conf.message, 'path');

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

    // ── 2026-11-12 修复（容器审查 P0-2/P0-3）─────────────────────
    // 旧实现：锁外读当前库 → 锁外算 merged → 锁内用旧快照整体覆写。
    // 读库到覆写之间任何 dtm_write/retag/tidy 的改动都被无声抹掉（丢失更新）。
    // 现在「读当前库 + 合并 + 备份 + 写回」整体在同一把锁内；
    // 安全备份失败即中止（与 retag/tidy 同口径），绝不无回滚点覆盖。
    const fieldAudit = inspectMergeFields(incoming.records, schema);

    if (dryRun === true) {
      // 预演也要读当前库算冲突，但不写任何东西，无需持锁。
      const { records } = await readLibraryCsv(layout.libraryCsv, schema);
      const preview = mergeInto(records, incoming.records);
      return {
        ok: true, changed: preview.changed, added: preview.added, conflicts: preview.conflicts,
        backupPath: null, dryRun: true, total: preview.merged.length,
        fieldAudit,
      };
    }

    await ensureDirs(layout);
    const outcome = await withFileLock(layout.lockFile, async () => {
      const { records } = await readLibraryCsv(layout.libraryCsv, schema);
      const { merged, added, changed, conflicts } = mergeInto(records, incoming.records);

      const backup = await backupLibrary({ libraryCsv: layout.libraryCsv, backupDir: layout.backupDir, schema, suffix: '-merge' });
      if (!backup.ok) return { ...fail(backup.errors, 'BACKUP_FAILED'), backupErrors: backup.errors };

      await writeLibraryCsv(layout.libraryCsv, merged, schema);

      await writeTidyLog({
        who: '（合并）',
        action: 'merge',
        target: src,
        before: { count: records.length },
        after: { count: merged.length, added, changed, conflicts },
        basis: src,
      });

      return { ok: true, changed, added, conflicts, backupPath: backup.path, total: merged.length, fieldAudit };
    });
    if (outcome.ok) lastBackupAt = localIsoString(new Date());
    return outcome;
  }

  /**
   * 合并计算（纯逻辑，无 I/O）：incoming 并进 current，同号保留较新。
   * 从 mergeLibrary 抽出，让 dryRun 与实跑共用同一套冲突口径。
   */
  function mergeInto(currentRecords, incomingRecords) {
    const byId = new Map(currentRecords.map((r) => [str(r['编号']), r]));
    let added = 0;
    let changed = 0;
    let conflicts = 0;
    for (const rec of incomingRecords) {
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
    return { merged: Array.from(byId.values()), added, changed, conflicts };
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
    const destLayout = layoutOf(path.resolve(dest));

    // P1-6（2026-11-12）：目标已有库 → 拒绝，绝不静默覆盖（目标侧数据丢失）。
    try {
      const dstLib = await fsp.stat(destLayout.libraryCsv);
      if (dstLib.isFile() && dstLib.size > 0) {
        return reject(
          'MIGRATE_TARGET_NOT_EMPTY',
          `目标目录已有记忆库（${destLayout.libraryCsv}），拒绝覆盖。请先移走或换个空目录。`,
          'target',
        );
      }
    } catch {
      /* 目标库不存在＝可搬 */
    }

    // 搬家前记源库的字节/记录数，搬完据此校验（verifyMigration 原来引了从不调）。
    const { schema } = await loadConfigs();
    const srcLib = await readLibraryCsv(layout.libraryCsv, schema);
    let srcBytes = 0;
    try {
      srcBytes = (await fsp.stat(layout.libraryCsv)).size;
    } catch {
      srcBytes = 0;
    }
    const before = { bytes: srcBytes, records: srcLib.records.length };

    let moved = false;
    // 全程持源库锁：复制期间并发 write/recall 会造成新旧两侧不一致。
    try {
      await withFileLock(layout.lockFile, async () => {
        await fsp.mkdir(dest, { recursive: true });
        const entries = await fsp.readdir(from, { withFileTypes: true }).catch(() => []);
        for (const ent of entries) {
          // 排除锁文件与临时文件：搬过去会让新目录首次操作 LOCK_TIMEOUT，
          // 或把半成品 tmp 当数据。backup/ 要搬（旧实现漏了，契约与实现脱节）。
          if (ent.name === '.memory.lock' || ent.name.endsWith('.tmp')) continue;
          const srcPath = path.join(from, ent.name);
          const dstPath = path.join(dest, ent.name);
          await fsp.cp(srcPath, dstPath, { recursive: true, force: true });
        }
        moved = true;
      });
    } catch (err) {
      return reject('MIGRATE_FAILED', `搬家失败：${err?.message ?? err}`);
    }

    // 搬后校验：字节数 + 记录数。不过就报失败，不切指针（否则指向一个坏库）。
    const dstLib = await readLibraryCsv(destLayout.libraryCsv, schema);
    let dstBytes = 0;
    try {
      dstBytes = (await fsp.stat(destLayout.libraryCsv)).size;
    } catch {
      dstBytes = 0;
    }
    const verdict = verifyMigration(before, { bytes: dstBytes, records: dstLib.records.length });
    if (!verdict.ok) {
      return { ok: false, code: 'MIGRATE_VERIFY_FAILED', message: verdict.message, from, to: dest };
    }

    // 校验通过才记录选择（④包内 时才允许设置页生效；③设置页 也是可写的）
    await writeSettingsDir(dest);

    return { ok: true, from, to: dest, moved, verified: verdict.message };
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
      // 初始记忆库的播种结论（2026-11-11）：让「装完空库」这件事有据可查，
      // 而不是让用户对着空界面猜。null = 还没走过初始化。
      seed: seedState,
      // 空库时给一句人话：这不是坏了，写第一条就会建库。
      emptyHint:
        records.length === 0
          ? '库是空的（不是坏了）。写第一条记忆会自动创建文件；'
            + '若这个版本没自带初始记忆，属正常，不影响使用。'
          : null,
      // 版本更新（方案 C）：设置页显示「当前版本 + 有无新版」就靠这两个字段。
      version: currentVersion(),
      update: updateState,
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
    // `identityOf` 是 `identityOfSync` 的历史别名（同步实现，无异步版）。
    // 两个名字都要保留：preset 与既有调用方按 `identityOf` 取，测试按 `identityOfSync` 取。
    identityOf: identityOfSync,
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
    _ensureInitialized: ensureInitialized,
    // 标签词表（2026-11-11）：preset 在注册 dtm_recall 时同步取库路径。
    //
    // ⚠️ 必须是**同步**且**零 IO**：preset 的 registerTools 是同步函数，
    // 没法 await resolveLayout()。所以这里只做路径拼接（layoutOf 是纯函数），
    // 不校验文件存在性——文件不存在时 wordlist 那边读失败会自动降级为空。
    //
    // 优先级链（configDir / env / settings / dshHome）这里的同步版本读不到
    // settings（那是异步文件读），所以**只保证「多数情况对」**：
    // config/env 与默认 dsh-home 都能算对，只有「用户在设置页手动搬家过」
    // 这一种情况会退回默认位置。这个偏差可以接受——词表算不出来只是少了路标，
    // 不会给出错误信息；而为了它把整个工具注册链改异步，代价太大。
    libraryCsvPath,
    // 当前视角（项目/智能体）——供 preset 注册工具时给标签网络做隔离过滤。
    // 与 libraryCsvPath 同样的理由：preset 的 registerTools 是**同步**的，
    // 没法 await，所以只给同步可得的粗粒度值；拿不到就返回 ''，网络退化为只含「通用」。
    currentProjectNameSync,
    currentAgentNameSync,
  // 版本更新（方案 C）：启动后台检查 + UI 手动按钮共用这一个实现。
  // checkUpdate 必须是**零参**（gateway 按 Function.length 校验，传实参就报
  // expected 0 arguments），所以这里挂一个零参包装，而不是带 {force} 的原函数。
  _checkUpdateNow: checkUpdateNow,
    checkUpdate,
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
  // 2026-11-12 P1-19：与 typert 同口径，用 ctx.inject 延迟到服务就绪再注册。
  // 旧实现 apply 期同步 ctx.get('sessionProjections')，加载顺序不利时服务还没
  // ACTIVE → 拿到 undefined → 静默 return，身份投影永不注册，resume/fork 身份
  // 重建失效、所有写入被拒（UNBOUND_IDENTITY）且无显式错误。inject 由框架保证
  // 依赖就绪后才跑回调，规避这个时序坑。
  const register = (pctx) => {
    try {
      const projections = pctx.get?.('sessionProjections');
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
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], register);
  } else {
    // 极老宿主/测试假 ctx 没有 inject：退回同步取（拿不到就静默跳过，不崩）。
    register(ctx);
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

/**
 * 启动时铺初始记忆库。
 *
 * 为什么单独一步、而不是等第一次读写：从官方插件界面装（pnpm add）不执行
 * `scripts/install.mjs`，所以那条路上的播种从来不会发生——用户装完打开界面
 * 看到的是空库，误以为坏了。这里在**插件加载时**就把包内自带的
 * `data/store/memory.csv` 复制到数据目录，装完即见。
 *
 * 三条纪律：
 *   · **异步、不 await** —— 初始化失败绝不能拖住插件装配或阻塞启动。
 *   · **只补不改** —— 库已存在就跳过（`COPYFILE_EXCL` 保证原子性），
 *     用户已有的记忆一个字都不动。
 *   · **失败不报错给用户** —— 初始记忆是便利，不是功能前提；只记一条日志。
 */
function registerStartup(ctx, service) {
  Promise.resolve()
    .then(() => service._ensureInitialized())
    .catch((err) => {
      ctx.logger?.warn?.('[dsh-tag-memory] 启动初始化失败（不影响使用）：', err?.message ?? err);
    });

  // 方案 C 的「启动静默查一次」：不 await、失败只留日志。
  // 延迟 3 秒：启动瞬间宿主还在装配，抢网络没意义；也避开初始化铺种子的 IO 高峰。
  // `.unref()`：这个定时器不该拖着进程不退出（若此时 DSH 被关掉）。
  // 绝不阻塞：检查版本是**便利功能**，它失败绝不能让插件看起来坏了。
  const delayed = new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    if (typeof t.unref === 'function') t.unref();
  });
  delayed
    .then(() => service._checkUpdateNow?.())
    .catch((err) => {
      ctx.logger?.warn?.('[dsh-tag-memory] 启动检查更新失败（不影响使用）：', err?.message ?? err);
    });
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
