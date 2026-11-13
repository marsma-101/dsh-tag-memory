/**
 * reminder.js — 轮级「漏记提醒」（§4.7）
 *
 * ── 为什么恢复它（回归背景）──────────────────────────────────────
 * 《改进与迭代方向-2026-11-11.md》§2：写入触发链只有半截
 *   「说明（判据）→ 模型自觉 → dtm_write」，缺轮级检查点，漏写后无任何反馈。
 * 旧版 0.3.x 曾有 `agent/pre-step` + `tools/result` 兜底，重构到 1.x（9 列 / 10 工具 /
 * section+context 拆分）时被删掉且没用等价机制补回 → 判据变成「靠自觉」。
 *
 * ── 必须沿用的旧版原则（别重新设计）──────────────────────────────
 * 1. **只判「这轮写没写过」，绝不判内容**。判据给模型用；程序里做正则/关键词
 *    分类必崩，换一种说法就漏。宁可少提醒，也不误判。
 * 2. **提醒走消息历史（pre-step decision），不塞进 system prompt**——section 内容
 *    一变，其后 KV cache 全废（这也是 §4.2 说明表走工具 description 的同一理由）。
 * 3. 去重（`isDeepStrictEqual`）、每轮最多一次、插在已认领消息之后
 *    （`toSpliced` 语义）、异常一律放行不卡住对话、可关闭。
 * 4. 工具名用 1.x 的 `dtm_write` / `dtm_supersede`。
 *
 * ── 当前 DSH 契约（0.2.2-rc.1，已核实，勿照抄旧版参数形状）──────────
 *   · `agent/pre-step` 是 **waterfall**：回调 `(payload, next)`，
 *     必须 `const decision = await next()`，再 `return { ...decision, messages }`。
 *     **原地改 payload.messages 无效**——宿主只读 waterfall 的返回值。
 *     payload: { agent, messages, turn, step, signal, modelSelection }。
 *     decision: { kind:'reject' } | { kind:'enter', messages:UserMessage[], startsRequestSeries? }。
 *   · `tools/result` 是 **emit**：回调 `(exec, result)` 两个位置参数。
 *     exec 有 name / agent，**没有 turn / session**；result.isError 表示成败。
 *     轮次状态一律由 pre-step 的 payload.turn 建立。
 *   · desired 消息按 UserMessage 形状内联构造（不 import @deepseek-ai/dsh-llm，
 *     保持插件零运行时依赖）：{ role:'user', id, content:[{type:'text',text}], source }。
 *     source.kind 必须用插件自有名（'tag-memory'），不能用 'runtime-context'。
 *
 * 依据：官方 `dsh-agent-instructions` 的 pre-step / tools/result 用法、
 *       `dsh-agent` runtime-types.d.ts 的 PreStepDecision、
 *       归档 `_work_preset.js` L1055-1137（WeakMap 版，已验证原则）。
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createInjectionLedger, claimInjection, injectionKey } from '../lib/engine/inject-gate.mjs';

/** 本插件的写工具（1.x 命名）。只判名字，不判内容。 */
export const WRITE_TOOLS = new Set(['dtm_write', 'dtm_supersede']);

/** 极短提醒文案。只问「这轮写没写过」，不分类用户输入。 */
export const REMINDER_TEXT =
  '这一轮还没写记忆。若有该记的规矩/决定/坑，先调 dtm_write（改旧条用 dtm_supersede）再继续；只是闲聊就忽略。';

/** 可关闭：Config 里 `reminderEnabled === false` 时不注册任何钩子。 */
export function isReminderEnabled(config) {
  return config?.reminderEnabled !== false;
}

/** 内联构造 UserMessage（不依赖 @deepseek-ai/dsh-llm）。 */
export function createReminderMessage(text = REMINDER_TEXT) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    // kind 必须插件自有：'runtime-context' 会被 loop 自己的快照顶掉。
    source: { kind: 'tag-memory', form: 'notice', summary: '漏记提醒' },
  };
}

/** 去重：照官方 sameContextPayload 的口径，比 content + source。 */
export function sameMessage(a, b) {
  try {
    return isDeepStrictEqual(a?.content, b?.content) && isDeepStrictEqual(a?.source, b?.source);
  } catch {
    return false;
  }
}

/**
 * 纯判定：这一轮该不该插入提醒。
 * 抽成纯函数是为了能脱离框架单测（tests/gate2/reminder.test.mjs）。
 *
 * @param {object} s
 * @param {number|undefined} s.step   pre-step 的 step（step>=2 才判）
 * @param {boolean} s.sawUser          第一步是否见过真实 user 消息
 * @param {boolean} s.wrote            本轮是否调过写工具
 * @param {boolean} s.reminded         本轮是否已提醒过
 * @returns {boolean}
 */
export function shouldRemind({ step, sawUser, wrote, reminded } = {}) {
  if (typeof step !== 'number' || !Number.isFinite(step) || step < 2) return false;
  return sawUser === true && wrote === false && reminded === false;
}

/**
 * 在已认领消息之后插入提醒（官方同款写法）。
 * 不改入参数组，返回新数组；`findLastIndex` 为 -1 时插到最前（step>=2 时 claimed 常为空）。
 */
export function insertReminder(decisionMessages, claimedMessages, desired) {
  const list = Array.isArray(decisionMessages) ? decisionMessages : [];
  if (list.some((m) => sameMessage(m, desired))) return list; // 去重
  const claimed = Array.isArray(claimedMessages) ? claimedMessages : [];
  const lastClaimedIndex = list.findLastIndex((m) => claimed.includes(m));
  return list.toSpliced(lastClaimedIndex + 1, 0, desired);
}

/**
 * 注册两个事件钩子。返回 dispose 函数（供 ctx.effect 撤销）。
 *
 * 异常纪律：next() 的异常**不吞**（那是别人的决策，吞了会静默改坏轮次）；
 * 我们自己这段逻辑的任何异常都吞掉并原样返回 decision —— 提醒是兜底，
 * 绝不能因为它让整轮对话失败（旧版实测教训：pre-step 抛异常 = 整轮失败且无超时）。
 *
 * @param {object} ctx       Cordis 上下文（需 ctx.on / ctx.logger）
 * @param {object} [options]
 * @param {WeakMap|Map} [options.state]  可注入状态容器（测试用）
 * @param {string} [options.text]        可覆盖提醒文案（测试用）
 * @param {object} [options.policy]      注入节流策略（maxPerSession/minTurnGap/backoffFactor）
 * @returns {() => void} dispose
 */
export function installWriteReminder(ctx, options = {}) {
  const state = options.state ?? new WeakMap();
  const text = options.text ?? REMINDER_TEXT;
  const policy = options.policy;
  const logger = ctx?.logger;
  const disposes = [];

  // 会话级投递台账（2026-11-13 框架级修复）：keyed by agent，随 agent 回收。
  // 为什么必须独立于 state：state 每轮 step 1 就重置（那是「本轮写没写过」的
  // 瞬时状态），而「这条内容在本会话送过几次」必须跨轮长存。两者混在一起
  // 就是旧版反复推送的根因——去重作用域只有当前一步的数组。
  const ledgers = new WeakMap();
  const ledgerOf = (agent) => {
    let l = ledgers.get(agent);
    if (!l) {
      l = createInjectionLedger();
      ledgers.set(agent, l);
    }
    return l;
  };

  const on = (event, fn) => {
    if (typeof ctx?.on !== 'function') return;
    const d = ctx.on(event, fn);
    if (typeof d === 'function') disposes.push(d);
  };

  /* ---- 1. 观察写工具调用：只记「写过」，不判内容 ---- */
  on('tools/result', (exec, result) => {
    try {
      const agent = exec?.agent;
      if (!agent || !WRITE_TOOLS.has(exec?.name)) return;
      // 失败也算「尝试过写过」吗？不算——失败的写入没进库，仍值得提醒一次。
      if (result && result.isError === true) return;
      const st = state.get(agent);
      if (st) st.wrote = true;
    } catch {
      // observer 出错只丢日志，绝不冒泡（官方 pipeline 已逐个 try/catch，这里再兜一层）
    }
  });

  /* ---- 2. 每轮 step>=2 检查：本轮没写过 → 插一条极短提醒 ---- */
  on('agent/pre-step', async (payload, next) => {
    // ⚠️ 先取别人的决策，且 next() 的异常原样冒泡，不包进我们的 try。
    const decision = await next();
    try {
      if (!decision || decision.kind === 'reject') return decision;
      const agent = payload?.agent;
      if (!agent) return decision;

      const { messages, turn, step, signal } = payload;
      const sawUser = Array.isArray(messages)
        && messages.some((m) => m?.source?.kind === 'user');

      // step 1：只重置本轮状态（第一步是判断「用户发起」唯一可靠时机）。
      // 不在第一步判提醒：此时还没轮到模型动手写。
      if (typeof step === 'number' && step <= 1) {
        state.set(agent, { turn, sawUser, wrote: false, reminded: false });
        return decision;
      }

      let st = state.get(agent);
      if (!st || st.turn !== turn) {
        st = { turn, sawUser: false, wrote: false, reminded: false };
        state.set(agent, st);
      }

      if (!shouldRemind({ step, sawUser: st.sawUser, wrote: st.wrote, reminded: st.reminded })) {
        return decision;
      }

      const desired = createReminderMessage(text);
      if (Array.isArray(decision.messages) && decision.messages.some((m) => sameMessage(m, desired))) {
        return decision;
      }

      // 会话级节流（2026-11-13）：同一内容在本会话送过几次、上次哪一轮送的，
      // 由台账记账。超额/同轮/太近一律静默——这道闸对任何注入内容都成立，
      // 不是给提醒开的特例。上面的 sameMessage 只防「同一步数组内重复」，
      // 跨轮/跨步的重投靠这里挡住。
      const claim = claimInjection(ledgerOf(agent), injectionKey(text), { turn, policy });
      if (!claim.allowed) return decision;

      // 取消信号：已被中止就别再插消息，原样放行。
      if (signal && typeof signal.throwIfAborted === 'function') signal.throwIfAborted();

      const entered = insertReminder(decision.messages, messages, desired);
      st.reminded = true; // 每轮最多一次
      // 必须 spread：保住 startsRequestSeries 等官方字段（practices.md 明令）。
      return { ...decision, messages: entered };
    } catch (e) {
      try {
        logger?.warn?.(`[dsh-tag-memory] 漏记提醒跳过（异常已放行）：${e?.message ?? e}`);
      } catch {
        /* logger 本身坏了也不冒泡 */
      }
      return decision;
    }
  });

  return () => {
    for (const d of disposes) {
      try { d(); } catch { /* 卸载期忽略 */ }
    }
  };
}
