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
 */

/** 数据目录里需要搬的东西（相对路径）。 */
export const MIGRATE_ITEMS = [
  { rel: 'store/memory.csv', kind: 'library', required: true },
  { rel: 'records/write.jsonl', kind: 'records', required: false },
  { rel: 'records/read.jsonl', kind: 'records', required: false },
  { rel: 'records/tidy.jsonl', kind: 'records', required: false },
  { rel: 'settings.json', kind: 'settings', required: false },
];

/**
 * 判断能否搬家。
 *
 * @param {object} opts
 * @param {string} opts.source    当前生效来源：'config' | 'env' | 'settings' | 'dsh-home' | 'package'
 * @param {string} opts.from      当前目录
 * @param {string} opts.to        目标目录
 * @returns {{ok:boolean, code?:string, message?:string, hint?:string}}
 */
export function canMigrate({ source, from, to }) {
  if (!to || typeof to !== 'string' || to.trim() === '') {
    return { ok: false, code: 'TARGET_EMPTY', message: '目标目录不能为空。' };
  }
  const target = to.trim();
  if (from && target === from) {
    return { ok: false, code: 'SAME_DIR', message: '目标目录与当前目录相同，无需搬家。' };
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
