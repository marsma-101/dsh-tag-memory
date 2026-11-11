/**
 * update-check.mjs — 版本更新检查（§方案 C：启动静默查一次 + 手动按钮）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 《功能说明》没有这条要求，是主子 2026-11-11 明确要的：
 *   装完插件后，如果 npm 上出了新版，用户应该能看到「有新版本」，
 *   而不是像这次一样——本地停在 1.2.8、npm 都发到 1.4.1 了还毫不知情。
 *
 * ── 为什么不改 DSH 插件管理器 ─────────────────────────────────────
 *   那是官方包（`.mise/@deepseek-ai+dsh-plugin-manager`），按项目纪律
 *   「不改官方内容」。而且它的更新按钮依赖 `updateRefusal()` 的一堆条件
 *   （availability / source / shipped...），我们改不动也预测不了。
 *   本模块是**插件自己**的能力：自带检查、自带展示，不依赖宿主配合。
 *
 * ── 网络现实（实测 2026-11-11，必须按这个写）────────────────────
 *   当前环境有本地代理（HTTPS_PROXY=127.0.0.1:31181）且 NO_PROXY 不含 npmjs：
 *     · registry.npmjs.org      → UNABLE_TO_VERIFY_LEAF_SIGNATURE（TLS 中间证书）
 *     · registry.npmmirror.com  → 200 / 163ms  ✅
 *   所以**必须先试镜像**，成功了就不碰官方源；镜像失败才回退官方。
 *   单源写死会在真实环境里 100% 失败，这正是本次要避免的坑。
 *
 * ── 三条硬纪律 ───────────────────────────────────────────────────
 *   1. **绝不阻塞**：启动时后台跑，超时（默认 6s）就放弃，不影响插件装配。
 *   2. **绝不抛错**：任何失败都吞掉并记 null，检查版本失败不是插件故障。
 *   3. **绝不自动升级**：只提示「有新版本 X」，装不装由用户决定。
 */

import https from 'node:https';

/** 查询顺序：镜像优先（本环境实测唯一能通的），官方兜底。 */
export const REGISTRY_ENDPOINTS = [
  { name: 'npmmirror', base: 'https://registry.npmmirror.com' },
  { name: 'npmjs', base: 'https://registry.npmjs.org' },
];

/** 单个源超时（毫秒）。查版本不值得让用户等。 */
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * 语义化版本比较：a > b 返回 true。
 *
 * 只支持 x.y.z（可带 prerelease），够本插件用。
 * 不用 semver 包：插件零运行时依赖是硬约束（见 define-tool.js 顶部说明）。
 */
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.main[i] !== b.main[i]) return a.main[i] > b.main[i];
  }
  // 主版本相同：正式版 > 预发布版；都有预发布时按字典序（简化，够用）
  if (a.pre === '' && b.pre !== '') return true;
  if (a.pre !== '' && b.pre === '') return false;
  return a.pre > b.pre;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim());
  if (!m) return null;
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

/**
 * 从某个 registry 取最新版本号。
 *
 * 用 `/latest` 端点（返回单个 version 对象，比拿全量元数据小得多）。
 * 任何异常都 resolve 成 `{ok:false, reason}`，**绝不 reject**。
 *
 * @returns {Promise<{ok:boolean, version?:string, source?:string, reason?:string, ms?:number}>}
 */
export function fetchLatestFrom({ base, name }, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const url = `${base}/${encodeURIComponent(name)}/latest`;
    let settled = false;

    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve({ ...v, ms: Date.now() - startedAt });
    };

    let req;
    try {
      req = https.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          // 防御：/latest 正常只有几百字节，超过 256KB 视为异常直接切断
          if (body.length > 262144) {
            try { req.destroy(); } catch { /* ignore */ }
            done({ ok: false, reason: 'response-too-large' });
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            done({ ok: false, reason: `http-${res.statusCode}` });
            return;
          }
          try {
            const j = JSON.parse(body);
            const version = typeof j?.version === 'string' ? j.version : '';
            if (version === '') {
              done({ ok: false, reason: 'no-version-field' });
              return;
            }
            done({ ok: true, version, source: base });
          } catch {
            done({ ok: false, reason: 'bad-json' });
          }
        });
      });
      req.on('timeout', () => {
        try { req.destroy(); } catch { /* ignore */ }
        done({ ok: false, reason: 'timeout' });
      });
      req.on('error', (err) => {
        // TLS 证书失败在这里（UNABLE_TO_VERIFY_LEAF_SIGNATURE / self-signed 等）
        done({ ok: false, reason: err?.code ?? String(err?.message ?? err) });
      });
    } catch (err) {
      done({ ok: false, reason: String(err?.message ?? err) });
    }
  });
}

/**
 * 依次尝试各源，第一个成功的就用它。
 *
 * @returns {Promise<{ok:boolean, version?:string, source?:string, attempts:object[]}>}
 */
export async function fetchLatestVersion(name, { endpoints = REGISTRY_ENDPOINTS, timeoutMs } = {}) {
  const attempts = [];
  for (const ep of endpoints) {
    const r = await fetchLatestFrom({ ...ep, name }, { timeoutMs });
    attempts.push({ source: ep.base, ok: r.ok, version: r.version ?? null, reason: r.reason ?? null, ms: r.ms });
    if (r.ok) {
      return { ok: true, version: r.version, source: ep.base, attempts };
    }
  }
  return { ok: false, attempts };
}

/**
 * 完整检查：取最新版 → 与当前版比较 → 给出结论。
 *
 * @param {{ currentVersion:string, name:string, endpoints?:object[], timeoutMs?:number }} args
 * @returns {Promise<{
 *   checkedAt: string, current: string, latest: string|null, source: string|null,
 *   hasUpdate: boolean, error: string|null, attempts: object[]
 * }>}
 */
export async function checkForUpdate({ currentVersion, name, endpoints, timeoutMs } = {}) {
  const checkedAt = new Date().toISOString();
  const current = String(currentVersion ?? '').trim();
  const got = await fetchLatestVersion(name, { endpoints, timeoutMs });

  if (!got.ok) {
    // 一个源都没通：如实记「没查到」，不是「没有新版本」。
    // 这个区别很重要——UI 上要能分清「已是最新」和「检查失败」。
    const reasons = got.attempts.map((a) => `${a.source}: ${a.reason}`).join('; ');
    return {
      checkedAt, current, latest: null, source: null,
      hasUpdate: false, error: `无法连接任何一个 registry（${reasons}）`, attempts: got.attempts,
    };
  }

  const hasUpdate = isNewerVersion(got.version, current);
  return {
    checkedAt, current, latest: got.version, source: got.source,
    hasUpdate, error: null, attempts: got.attempts,
  };
}
