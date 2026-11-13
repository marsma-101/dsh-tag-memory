/**
 * inject-gate.mjs — 注入节流闸门（会话级投递台账）
 *
 * ── 为什么需要它（2026-11-13 用户裁定的框架级缺陷）─────────────────
 * 用户反馈：「有一条记忆每一轮都会自动传递……要从规则上避免某一个记忆被
 * 同一轮对话反复推送，不能头痛医头脚痛医脚。」
 *
 * 根因不在某条文案，而在**去重的作用域错了**：
 *   · 旧 `sameMessage` 只比对「当前这一步的 decision.messages 数组」，
 *     而每轮/每步的数组都是新建的 → 上一步送过的内容，这一步查不到；
 *   · 轮级 `reminded` 标志在 step 1 就重置 → 跨轮完全不设防。
 * 于是**任何**注入通道（漏记提醒、身份段、将来的记忆自动推送）都能把
 * 同一条内容在一个会话里无限次重投。实测会话 d91a310d：同一句提醒 4 轮 4 次。
 *
 * 所以这里补的是**会话级投递台账**：一条内容在一个会话里送过几次、
 * 上次哪一轮送的，全部记账；超额就永久静默。它与「是什么内容」无关——
 * 提醒、身份提示、记忆条目都走同一个闸门，这才叫从规则上解决。
 *
 * ── 三道闸（按序判，任一不过即静默）──────────────────────────────
 *   ① 同轮不重投：同一 turn 内同一内容只允许一次（硬规则，不可配）
 *   ② 会话配额：同一内容整个会话最多 maxPerSession 次，用尽即永久静默
 *   ③ 退避间隔：距上次投递至少 minTurnGap 轮，且每次投递后间隔翻倍
 *
 * ── 边界纪律 ───────────────────────────────────────────────────
 * · 引擎零框架依赖：本模块不认识 ctx/agent/会话，只认「台账对象 + 内容键 + 轮号」。
 *   台账由调用方持有（preset 用 WeakMap keyed by agent），**不做模块级全局状态**
 *   ——那会让多会话串台（《DSH 插件守则》P2）。
 * · claim 是「判定+记账」一步完成（不是 check 后再 claim），避免调用方漏记账。
 * · 判不了就少送：轮号异常时按「同一未知轮」处理，宁可静默不刷屏。
 */

/** 默认策略：一条内容一个会话最多 2 次，跨轮至少隔 1 轮，之后间隔翻倍。 */
export const DEFAULT_INJECTION_POLICY = Object.freeze({
  maxPerSession: 2,
  minTurnGap: 1,
  backoffFactor: 2,
});

/**
 * 把注入内容归一成稳定指纹（同一句话不因空白差异被当成两条）。
 *
 * 只做空白归一，**不做语义归一**：程序判不了「两句话是不是一个意思」，
 * 硬做只会误合并（旧版教训：程序侧做内容分类必崩）。
 *
 * @param {string} text
 * @returns {string}
 */
export function injectionKey(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 建一个空台账（调用方按会话/agent 各持一个）。
 * @returns {{entries: Map<string, {deliveries:number, lastTurn:number|null}>}}
 */
export function createInjectionLedger() {
  return { entries: new Map() };
}

/** 解析策略，非法值回落默认（配置写错不该让注入失控）。 */
function resolvePolicy(policy) {
  const p = policy ?? {};
  const num = (v, d, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : d;
  };
  return {
    maxPerSession: num(p.maxPerSession, DEFAULT_INJECTION_POLICY.maxPerSession, 1),
    minTurnGap: num(p.minTurnGap, DEFAULT_INJECTION_POLICY.minTurnGap, 0),
    backoffFactor: num(p.backoffFactor, DEFAULT_INJECTION_POLICY.backoffFactor, 1),
  };
}

/**
 * 申请投递一条内容：**判定 + 记账一步完成**。
 *
 * @param {object} ledger  createInjectionLedger() 的产物（调用方按会话持有）
 * @param {string} key     injectionKey(内容) 的指纹
 * @param {object} ctx
 * @param {number} ctx.turn  当前轮号（拿不到传 undefined，按未知轮处理）
 * @param {object} [ctx.policy] 覆盖默认策略
 * @returns {{allowed:boolean, reason:string, deliveries:number, nextEligibleTurn:number|null}}
 *   reason: 'OK' | 'SAME_TURN' | 'SESSION_QUOTA' | 'TOO_SOON' | 'EMPTY_KEY'
 */
export function claimInjection(ledger, key, { turn, policy } = {}) {
  const k = injectionKey(key);
  const deny = (reason, entry) => ({
    allowed: false,
    reason,
    deliveries: entry?.deliveries ?? 0,
    nextEligibleTurn: null,
  });

  if (!ledger || !(ledger.entries instanceof Map)) {
    // 台账坏了：不记账也不投递（宁可少送，绝不失控刷屏）
    return deny('EMPTY_KEY', null);
  }
  if (k === '') return deny('EMPTY_KEY', null);

  const pol = resolvePolicy(policy);
  const curTurn = Number.isFinite(Number(turn)) ? Number(turn) : null;
  const entry = ledger.entries.get(k);

  // ① 同轮不重投（硬规则）。未知轮视为同一轮，只许一次。
  if (entry && entry.lastTurn === curTurn) return deny('SAME_TURN', entry);

  // ② 会话配额用尽 → 永久静默
  if (entry && entry.deliveries >= pol.maxPerSession) return deny('SESSION_QUOTA', entry);

  // ③ 退避间隔：第 n 次投递后要求 minTurnGap * backoffFactor^(n-1)
  if (entry && curTurn !== null && entry.lastTurn !== null) {
    const required = pol.minTurnGap * Math.pow(pol.backoffFactor, Math.max(0, entry.deliveries - 1));
    if (curTurn - entry.lastTurn < required) return deny('TOO_SOON', entry);
  }

  const next = { deliveries: (entry?.deliveries ?? 0) + 1, lastTurn: curTurn };
  ledger.entries.set(k, next);
  return { allowed: true, reason: 'OK', deliveries: next.deliveries, nextEligibleTurn: null };
}

/**
 * 只读查看某条内容的投递状态（诊断/测试用，不记账）。
 * @returns {{deliveries:number, lastTurn:number|null}}
 */
export function injectionStats(ledger, key) {
  const entry = ledger?.entries instanceof Map ? ledger.entries.get(injectionKey(key)) : null;
  return { deliveries: entry?.deliveries ?? 0, lastTurn: entry?.lastTurn ?? null };
}
