/**
 * migrate.mjs — 数据目录搬家的纯逻辑层
 *
 * 边界（《接口契约》§一）：
 *   ✅ 纯判定：算"能不能搬、搬哪些文件、搬完怎么校验"
 *   ❌ 不执行复制/删除 —— 那是宿主的 I/O 编排职责
 *
 * 依据《架构说明》§六：数据目录 5 级优先级
 *   ① config.dataDir（profile 补丁写死）
 *   ② 环境变量 DSH_TAG_MEMORY_DATA_DIR
 *   ③ 设置页选的
 *   ④ $DSH_HOME/tag-memory（用户级默认）
 *   ⑤ 插件包内（最后手段，会随 pnpm 重装被删）
 * ①② 优先级高于设置页 —— 这种情况下搬家不生效，必须**明确告诉用户改哪一行**。
 *
 * ── 2026-11-16 修复（数据损坏级）──────────────────────────────
 * 旧 canMigrate 只挡 `to === from`，**不挡包含关系**。而迁移执行序是
 * mkdir(dest) → readdir(from) → cp 每个 entry，所以 dest 落在 from 内部时
 * 会读到 dest 自己并递归复制（实测嵌套 41 层才因 Windows MAX_PATH 中止）。
 * 现在加了 isInsideDir 双向检查（目标在源内 / 源在目标内）。
 *
 * ⚠️ 纯字符串比较**不足以**挡软链接：dest 可能是指向 from 的软链接。
 *    所以 canMigrate 支持传入 realFrom/realTo（宿主用 fs.realpath 解析后传入）。
 */

import path from 'node:path';

/** 数据目录里需要搬的东西（相对路径）。 */
export const MIGRATE_ITEMS = [
  { rel: 'store/memory.csv', kind: 'library', required: true },
  { rel: 'records/write.jsonl', kind: 'records', required: false },
  { rel: 'records/read.jsonl', kind: 'records', required: false },
  { rel: 'records/tidy.jsonl', kind: 'records', required: false },
  { rel: 'settings.json', kind: 'settings', required: false },
];

/**
 * 判断两个路径的**包含关系**（纯字符串语义，不做 IO）。
 *
 * ⚠️ 这是 2026-11-16 修的那个数据损坏级 bug 的核心判据。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────
 * 旧代码只有一句 `path.resolve(dest) === path.resolve(dataDir)`，**只挡相等**。
 * 而迁移的执行顺序是：
 *   ① mkdir(dest)  ② readdir(from)  ③ 对每个 entry 做 cp
 * 如果 dest 在 from 内部：
 *   ① 建出 from/sub → ② readdir(from) 读到 sub 自己 → ③ cp(from/sub → from/sub/sub)
 *   → 无限递归。实测嵌套 41 层才因 Windows MAX_PATH 中止；
 *   Linux 上不会撞路径上限，会一直复制到磁盘写满或 inode 耗尽。
 *
 * ── 为什么用 path.relative 而不是 startsWith ──────────────────
 * `'/a/bc'.startsWith('/a/b')` 为 true，但 `/a/bc` 并不在 `/a/b` 里。
 * path.relative 返回 `..` 开头表示不在内部，语义正确。
 *
 * @param {string} parent 候选父目录（绝对路径）
 * @param {string} child  候选子路径（绝对路径）
 * @returns {boolean} child 是否严格位于 parent 内部（相等不算内部）
 */
export function isInsideDir(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  if (parent === '' || child === '') return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  // rel === '' → 同一个目录（不算"内部"，由 SAME_DIR 单独判）
  // rel 以 '..' 开头 → 不在内部
  // path.isAbsolute(rel) → 不同盘符（Windows），不在内部
  if (rel === '') return false;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * 判断能否搬家。
 *
 * @param {object} opts
 * @param {string} opts.source    当前生效来源：'config' | 'env' | 'settings' | 'dsh-home' | 'package'
 * @param {string} opts.from      当前目录
 * @param {string} opts.to        目标目录
 * @param {string} [opts.realFrom] 已解析软链接后的源目录（可选；给了就用它做包含判断）
 * @param {string} [opts.realTo]   已解析软链接后的目标目录（可选）
 * @returns {{ok:boolean, code?:string, message?:string, hint?:string}}
 */
export function canMigrate({ source, from, to, realFrom, realTo } = {}) {
  if (!to || typeof to !== 'string' || to.trim() === '') {
    return { ok: false, code: 'TARGET_EMPTY', message: '目标目录不能为空。' };
  }
  const target = to.trim();

  // ── 路径关系校验（先于锁定判断：这是数据安全问题，比"能不能搬"更优先）──
  // 用 realpath 后的值判，否则 dest 是指向 from 的软链接时同样会递归。
  const cmpFrom = typeof realFrom === 'string' && realFrom !== '' ? realFrom : from;
  const cmpTo = typeof realTo === 'string' && realTo !== '' ? realTo : target;

  if (from && path.resolve(cmpTo) === path.resolve(cmpFrom)) {
    return {
      ok: false,
      code: 'SAME_DIR',
      message: '目标目录与当前目录相同，无需搬家。',
      // 软链接指向同一目录时，提示可能不直观，补一句
      hint:
        typeof realTo === 'string' && path.resolve(target) !== path.resolve(cmpTo)
          ? `（目标 ${target} 经软链接解析后是 ${cmpTo}，与当前目录相同）`
          : undefined,
    };
  }

  // 目标在源内部 → 会无限递归复制（数据损坏）。必须挡死。
  if (from && isInsideDir(cmpFrom, cmpTo)) {
    return {
      ok: false,
      code: 'TARGET_INSIDE_SOURCE',
      message:
        `目标目录 ${cmpTo} 位于当前数据目录 ${cmpFrom} 内部。` +
        '搬过去会把源目录连同目标目录一起复制，形成无限嵌套（直到磁盘写满）。请换一个源目录之外的路径。',
      hint: '选一个与当前数据目录互不包含的目录',
    };
  }

  // 源在目标内部（目标 = 源的父目录）→ 会把源复制进自己的父目录，同样会造成重复与混乱
  if (from && isInsideDir(cmpTo, cmpFrom)) {
    return {
      ok: false,
      code: 'TARGET_IS_PARENT',
      message:
        `目标目录 ${cmpTo} 是当前数据目录 ${cmpFrom} 的上级目录。` +
        '搬过去会让新旧库混在同一个目录里，无法区分哪份有效。请换一个与当前数据目录互不包含的路径。',
      hint: '选一个与当前数据目录互不包含的目录',
    };
  }

  // 关键：①② 优先级高于设置页，搬家不生效
  if (source === 'config') {
    return {
      ok: false,
      code: 'DATA_DIR_LOCKED',
      message:
        '数据目录被 profile 配置锁定：改 cordis.patch.yml 里本插件那一行的 config.dataDir 才会生效（设置页搬家不起作用）。',
      // ⚠️ id 必须与 bundle 补丁 insert 里的 id 逐字一致（2026-11-06 事故根因）：
      //    profile 补丁的顶层 `- id: xxx` 是"按 id 覆盖已存在条目"，找不到就整条静默丢弃。
      hint: 'cordis.patch.yml → 找 `id: dsh-tag-memory` → 改 `config.dataDir`',
    };
  }
  if (source === 'env') {
    return {
      ok: false,
      code: 'DATA_DIR_LOCKED',
      message:
        '数据目录被环境变量 DSH_TAG_MEMORY_DATA_DIR 锁定：清掉这个环境变量之后，设置页搬家才会生效。',
      hint: '清掉环境变量 DSH_TAG_MEMORY_DATA_DIR',
    };
  }

  return { ok: true };
}

/**
 * 搬家时**不搬**的条目（相对路径的任意层级都适用）。
 *
 * 2026-11-16：从 index.js 的内联判断提到这里，理由有二：
 *   ① 它是"搬什么"的一部分，属于本文件的职责，散落在 I/O 编排里容易被改漏；
 *   ② 需要被测试直接断言（负对照要能证明"锁文件确实没被搬"）。
 *
 * ⚠️ 关键：**必须能作用于任意层级，不能只看顶层。**
 * 锁文件在 `store/.memory.lock`，`*.tmp` 也可能出现在 `store/` 里。
 * 而迁移是 `cp(<from>/store → <dest>/store, { recursive: true })`，
 * 递归复制**不会**回调这个函数——所以必须在复制前把子项剔除，
 * 或者复制后清理。见 index.js 的 copyTreeFiltered。
 */
export function shouldSkipOnMigrate(name) {
  if (typeof name !== 'string' || name === '') return true;
  // 锁文件：搬过去会让新目录首次操作 LOCK_TIMEOUT
  if (name === '.memory.lock') return true;
  // 临时文件：半成品，搬过去会被当成数据
  if (name.endsWith('.tmp')) return true;
  // 迁移临时目录自身（见 index.js 的 .migrating-<ts>）：绝不搬
  if (name.startsWith('.migrating-')) return true;
  return false;
}

/**
 * 递归复制，**逐层应用 shouldSkipOnMigrate**。
 *
 * ── 为什么不能直接用 fsp.cp({recursive:true}) ─────────────────
 * 2026-11-16 端到端实测发现：`fsp.cp` 的 recursive 是整棵树搬过去，
 * 不会回调跳过规则。于是 `store/.memory.lock` 被原样带到新目录，
 * 新目录首次操作会因锁文件残留而 LOCK_TIMEOUT（最长等到 staleMs）。
 *
 * 这是**单元测试测不出来的**——只有真的走一遍文件系统才会暴露。
 *
 * @param {object} args
 * @param {string} args.src
 * @param {string} args.dst
 * @param {(src:string, dst:string)=>Promise<void>} args.cpFn   复制单个文件
 * @param {(dir:string, opts:object)=>Promise<Array>} args.readdirFn
 * @param {(dir:string, opts:object)=>Promise<void>} args.mkdirFn
 * @returns {Promise<{skipped:string[]}>} **完整**跳过清单（含所有递归层级，路径为相对 src 的形式）
 */
export async function copyTreeFiltered({ src, dst, cpFn, readdirFn, mkdirFn }) {
  const skipped = [];
  await walk({ src, dst, prefix: '', cpFn, readdirFn, mkdirFn, skipped });
  return { skipped };
}

/**
 * 递归主体。`prefix` 累积相对路径，让 skipped 里能看出「哪个层级的哪个文件」，
 * 而不是一堆同名的 `.memory.lock`。
 */
async function walk({ src, dst, prefix, cpFn, readdirFn, mkdirFn, skipped }) {
  await mkdirFn(dst, { recursive: true });
  const entries = await readdirFn(src, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
    if (shouldSkipOnMigrate(ent.name)) {
      // 记相对路径：顶层是 `.memory.lock`，嵌套层是 `store/.memory.lock`
      skipped.push(rel);
      continue;
    }
    const s = `${src}/${ent.name}`;
    const d = `${dst}/${ent.name}`;
    if (ent.isDirectory()) {
      await walk({ src: s, dst: d, prefix: rel, cpFn, readdirFn, mkdirFn, skipped });
    } else {
      await cpFn(s, d);
    }
  }
}

/**
 * 校验搬家结果（字节数 + 记录数双校验）。
 *
 * @param {object} before  { bytes:number, records:number }
 * @param {object} after   { bytes:number, records:number }
 * @returns {{ok:boolean, message:string}}
 */
export function verifyMigration(before, after) {
  const b = before || {};
  const a = after || {};
  if (!Number.isFinite(b.bytes) || !Number.isFinite(a.bytes)) {
    return { ok: false, message: '无法读取文件大小，搬家结果未验证（请人工检查目标目录）。' };
  }
  if (a.bytes === 0 && b.bytes > 0) {
    return { ok: false, message: `目标库是空的（源 ${b.bytes} 字节 → 目标 0 字节），搬家失败。` };
  }
  if (Number.isFinite(b.records) && Number.isFinite(a.records) && a.records < b.records) {
    return {
      ok: false,
      message: `记录数变少（源 ${b.records} 条 → 目标 ${a.records} 条），搬家不完整。`,
    };
  }
  return { ok: true, message: `搬家完成：${b.records} 条记录 / ${b.bytes} 字节已转移。` };
}
