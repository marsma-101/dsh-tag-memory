/**
 * tests/gate3/initial-library.test.mjs —— 初始记忆库（包内自带）
 *
 * 要守的是一条**实测过的用户路径**：从官方插件界面装插件走的是 `pnpm add`，
 * 不执行 `scripts/install.mjs`，所以「安装时播种」那条路根本不会发生——
 * 用户装完打开界面看到空库，以为坏了。
 *
 * 现在的做法：包内自带 `data/store/memory.csv`，插件加载时复制到数据目录。
 * 这组测试固定住三件事：
 *   I1 包内确实带了这个文件，且是 9 列新格式、能被引擎读出来
 *   I2 首次初始化会把它铺到数据目录
 *   I3 **已有库绝不被覆盖**（这是用户的资产，最不能错的一条）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..', '..');
const BUNDLED = path.join(PACKAGE_DIR, 'data', 'store', 'memory.csv');

const { loadSchema } = await import(
  `file://${path.join(PACKAGE_DIR, 'lib', 'engine', 'dict.mjs').replaceAll('\\', '/')}`
);
const { readLibraryCsv } = await import(
  `file://${path.join(PACKAGE_DIR, 'lib', 'engine', 'core.mjs').replaceAll('\\', '/')}`
);

const schema = await loadSchema({ baseDir: path.join(PACKAGE_DIR, 'lib', 'engine', 'templates') });

test('I1 包内自带初始记忆库，且是 9 列新格式、能被引擎读出', async () => {
  assert.ok(fs.existsSync(BUNDLED), `包内缺初始记忆库：${BUNDLED}——从界面装完会是空库`);

  const raw = fs.readFileSync(BUNDLED, 'utf8');
  assert.ok(raw.length > 0, '初始记忆库不能是空文件');

  // 必须无 BOM：带 BOM 时第一列名会变成 "\uFEFF编号"，按列名定位会全部落空。
  assert.notEqual(raw.charCodeAt(0), 0xfeff, '初始记忆库不能带 BOM');

  const { records, errors } = await readLibraryCsv(BUNDLED, schema);
  assert.equal(errors.length, 0, `初始记忆库有解析错误：${JSON.stringify(errors.slice(0, 2))}`);
  assert.ok(records.length >= 1, '初始记忆库至少要有一条，否则新装还是空的');

  // 每条都必须是 通用/通用 —— 否则新装会话（任意项目、任意身份）一条都看不到。
  for (const r of records) {
    assert.equal(r['项目'], '通用', `${r['编号']}: 初始记忆必须是 项目=通用`);
    assert.equal(r['智能体'], '通用', `${r['编号']}: 初始记忆必须是 智能体=通用`);
    assert.equal(r['状态'], '生效', `${r['编号']}: 初始记忆必须是 生效`);
  }
});

test('I2 首次初始化把初始记忆铺到数据目录', async () => {
  const { makeHostCtx } = await import('../_host-ctx.mjs');
  // 注意：这里**不能**传 seed:false —— 就是要验证播种真的发生了。
  // makeHostCtx 默认 seed:false，所以手工造一个开着播种的上下文。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seed-'));
  try {
    const { apply } = await import(`file://${path.join(PACKAGE_DIR, 'index.js').replaceAll('\\', '/')}`);

    // 最小 ctx：只要 provide / get / effect / logger 这几个，够 apply 跑完同步段。
    const services = new Map();
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on: () => () => {},
      effect: (fn) => {
        try {
          return fn();
        } catch {
          return () => {};
        }
      },
      get: (n) => services.get(n),
      provide: (n, v) => {
        services.set(n, v);
        return () => services.delete(n);
      },
      inject: () => {},
      typert: { register: () => () => {} },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
    };

    const dispose = apply(ctx, { dataDir });
    const host = services.get('dtmHost');
    assert.ok(host, 'apply 之后应有 dtmHost 服务');

    // 启动初始化是异步的（registerStartup 不 await），等它落盘。
    const lib = path.join(dataDir, 'store', 'memory.csv');
    let ok = false;
    for (let i = 0; i < 100; i += 1) {
      if (fs.existsSync(lib)) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(ok, '首次初始化应把初始记忆库铺到数据目录');

    const { records, errors } = await readLibraryCsv(lib, schema);
    assert.equal(errors.length, 0, '铺过去的库也要能正常解析');
    assert.ok(records.length >= 1, '铺过去的库不能是空的');

    try {
      dispose?.();
    } catch {
      /* 卸载期忽略 */
    }
    void makeHostCtx; // 保留导入语义，避免 lint 误报未使用
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('I3 已有库绝不被覆盖（用户的记忆不能被初始记忆冲掉）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seed-keep-'));
  try {
    const storeDir = path.join(dataDir, 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    const lib = path.join(storeDir, 'memory.csv');

    // 造一个「用户已经写了一条」的库（表头 + 1 行）。
    const userRow =
      'M-20260101-001,用户自己的记忆,事实,通用,通用,自定义|标签,观察,1,生效';
    const userCsv = `${schema.columns.join(',')}\r\n${userRow}\r\n`;
    fs.writeFileSync(lib, userCsv, 'utf8');

    const { apply } = await import(`file://${path.join(PACKAGE_DIR, 'index.js').replaceAll('\\', '/')}`);
    const services = new Map();
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on: () => () => {},
      effect: (fn) => {
        try {
          return fn();
        } catch {
          return () => {};
        }
      },
      get: (n) => services.get(n),
      provide: (n, v) => {
        services.set(n, v);
        return () => services.delete(n);
      },
      inject: () => {},
      typert: { register: () => () => {} },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
    };

    const dispose = apply(ctx, { dataDir });
    // 给初始化足够时间跑完（如果它会覆盖，这里就会发生）。
    await new Promise((r) => setTimeout(r, 400));

    const after = fs.readFileSync(lib, 'utf8');
    assert.equal(after, userCsv, '已有库必须逐字节不变——初始记忆不许覆盖用户数据');

    try {
      dispose?.();
    } catch {
      /* 卸载期忽略 */
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
