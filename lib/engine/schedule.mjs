/**
 * schedule.mjs — 定时任务的纯逻辑层
 *
 * 边界（《接口契约》§一）：
 *   ✅ 纯判定：算"这一轮该不该跑"
 *   ❌ 不持有 timer、不调用 setInterval —— 那是宿主的职责
 *     （engine 契约要求"能脱离框架单测"，持有 timer 的文件做不到）
 *
 * 注意与 tick.mjs 的分工：
 *   tick.mjs 的 createTickQueue 是**纯队列**（pending 集合 + 去重），也不持有 timer。
 *   宿主用 setInterval 驱动，把 flush 回调喂给队列。
 *   所以"定时任务在宿主"和"tick/schedule 在 engine"不矛盾，是**队列/判定 vs 触发器**的分工。
 */

/** 毫秒 → 人类可读 */
export function formatInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '关闭';
  const h = Math.round(n / 3600000);
  if (h >= 24 && h % 24 === 0) return `${h / 24} 天`;
  if (h >= 1) return `${h} 小时`;
  return `${Math.round(n / 60000)} 分钟`;
}

/**
 * 判断备份是否到期。
 *
 * @param {object} opts
 * @param {number} opts.intervalMs   间隔（0 或负数 = 关闭）
 * @param {number|null} opts.lastAt  上次执行时间戳（ms），null = 从未执行
 * @param {number} opts.now          当前时间戳
 * @returns {{due:boolean, reason:string}}
 */
export function isBackupDue({ intervalMs, lastAt, now }) {
  const iv = Number(intervalMs);
  if (!Number.isFinite(iv) || iv <= 0) return { due: false, reason: '自动备份已关闭' };
  if (lastAt == null) return { due: true, reason: '从未备份过' };
  const elapsed = Number(now) - Number(lastAt);
  if (!Number.isFinite(elapsed)) return { due: true, reason: '时间戳异常，保守执行一次' };
  if (elapsed >= iv) return { due: true, reason: `距上次 ${formatInterval(elapsed)}，已超过 ${formatInterval(iv)}` };
  return { due: false, reason: `距下次还需 ${formatInterval(iv - elapsed)}` };
}

/**
 * 判断整理是否该被"提醒"（注意：整理本身需要模型参与，
 * 定时器不能代替模型做判断 —— 这里只算"该不该提示用户/模型去整理"）。
 *
 * @param {object} opts
 * @param {number} opts.intervalMs
 * @param {number|null} opts.lastAt
 * @param {number} opts.now
 * @param {number} opts.pendingReadLogs  自上次整理以来新增的 read 记录数
 * @param {number} opts.readLogThreshold 阈值（默认 50）
 * @returns {{due:boolean, reason:string}}
 */
export function isTidyDue({ intervalMs, lastAt, now, pendingReadLogs = 0, readLogThreshold = 50 }) {
  const iv = Number(intervalMs);

  // 记录积压也值得提示（哪怕定时关着）
  const pending = Number(pendingReadLogs);
  if (Number.isFinite(pending) && pending >= Number(readLogThreshold)) {
    return { due: true, reason: `积压 ${pending} 条读取记录（阈值 ${readLogThreshold}），建议整理` };
  }

  if (!Number.isFinite(iv) || iv <= 0) return { due: false, reason: '自动整理已关闭' };
  if (lastAt == null) return { due: true, reason: '从未整理过' };
  const elapsed = Number(now) - Number(lastAt);
  if (elapsed >= iv) return { due: true, reason: `距上次 ${formatInterval(elapsed)}，已超过 ${formatInterval(iv)}` };
  return { due: false, reason: `距下次还需 ${formatInterval(iv - elapsed)}` };
}
