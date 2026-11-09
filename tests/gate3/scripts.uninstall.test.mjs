/**
 * scripts.uninstall.test.mjs —— 卸载流程（scripts/install.mjs 的 uninstall 段）
 *
 * ════════════════════════════════════════════════════════════════════
 *  为什么必须测这个（而不是「看着跑通了就行」）
 * ════════════════════════════════════════════════════════════════════
 *
 * 卸载是不可逆操作，且**只发生一次**——用户在卸载时不会反复跑、
 * 也就没有机会「下次注意」。这里最坏的错误不是报错，而是
 * 「报告成功、但记忆库其实被删了」或「报告成功、但库其实在别处没找到」。
 *
 * 所以本组测试的判据全部围绕一件事：**库还在，且脚本说的是真话**。
 *
 * 覆盖：
 *   U1 默认：库保留，records/backup/settings 清掉
 *   U2 预演（不带 apply）：一个字节都不动
 *   U3 --keep-backups：backup/ 保留，其余照清
 *   U4 --keep-runtime：运行期产物全保留
 *   U5 ③ 设置页指定库位置：必须去那里找，不能误报默认位置
 *   U6 库不存在时：如实说"清理前就没有"，不谎称删过
 *   U7 摘清单条目：依赖与 bundles 都摘掉，且留备份
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(PACKAGE_DIR, 'scripts', 'install.mjs');

let tmpRoot = '';

/**
 * 建一份完整的假 DSH_HOME：profile + 数据目录。
 *
 * `dataDir` 必须落在 `home` 之内——脚本按 `--dsh-home` 推默认数据目录
 * （`<home>/tag-memory`），若把数据放到 home 外面，脚本会找不到库、
 * 于是「什么都没删」却报告成功。U1 最初就栽在这里。
 */
function buildEnv({ tag = 'u', customDataDir = null, withLibrary = true } = {}) {
  const home = path.join(tmpRoot, tag, 'home');
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { 'dsh-tag-memory': 'link:G:/nonexistent' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-tag-memory'] } },
      },
      null,
      2,
    ),
    'utf8',
  );

  const dataDir = customDataDir ?? path.join(home, 'tag-memory');

  fs.mkdirSync(path.join(dataDir, 'store'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'records'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backup'), { recursive: true });

  if (withLibrary) {
    fs.writeFileSync(
      path.join(dataDir, 'store', 'memory.csv'),
      '编号,主要内容,形态,项目,智能体,自由标签,稳定性,时距,状态\r\nM-20260101-001,测试记忆,事实,proj,agent,标签,观察,0,生效\r\n',
      'utf8',
    );
  }
  fs.writeFileSync(path.join(dataDir, 'records', 'write.jsonl'), '{"a":1}\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'backup', 'bk.csv'), 'x\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"backupAuto":true}\n', 'utf8');

  return { home, profileDir, dataDir };
}

/** 跑脚本，返回 stdout。参数一律显式给，不依赖当前环境。 */
function run(args, { home }) {
  return execFileSync(process.execPath, [SCRIPT, 'uninstall', ...args, '--dsh-home', home, '--profile', 'web'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_TAG_MEMORY_DATA_DIR: '' },
  });
}

/** 递归列出目录下所有文件的相对路径。 */
function listFiles(dir) {
  const out = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtm-uninst-'));
});

after(() => {
  if (tmpRoot !== '') fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('卸载流程（scripts/install.mjs uninstall）', () => {
  test('U1 默认卸载：库保留，records/backup/settings 清掉', () => {
    const env = buildEnv({ tag: 'u1' });
    const dataDir = env.dataDir;

    run(['apply'], env);

    // 唯一不可违背的判据
    assert.ok(fs.existsSync(path.join(dataDir, 'store', 'memory.csv')), '记忆库必须保留');
    assert.deepEqual(listFiles(dataDir), ['store/memory.csv'], '除库之外不该留下任何东西');
  });

  test('U2 预演（不带 apply）：一个字节都不动', () => {
    const env = buildEnv({ tag: 'u2' });
    const dataDir = env.dataDir;
    const before = listFiles(dataDir);

    const out = run([], env);

    assert.deepEqual(listFiles(dataDir), before, '预演不得改动任何文件');
    assert.match(out, /一个字节没动/, '预演必须明确说明没动');
    assert.match(out, /将清理/, '预演必须列出将清理什么');
  });

  test('U3 --keep-backups：backup/ 保留，其余照清', () => {
    const env = buildEnv({ tag: 'u3' });
    const dataDir = env.dataDir;

    run(['apply', '--keep-backups'], env);

    assert.deepEqual(listFiles(dataDir), ['backup/bk.csv', 'store/memory.csv']);
  });

  test('U4 --keep-runtime：运行期产物全保留', () => {
    const env = buildEnv({ tag: 'u4' });
    const dataDir = env.dataDir;
    const before = listFiles(dataDir);

    run(['apply', '--keep-runtime'], env);

    assert.deepEqual(listFiles(dataDir), before, '--keep-runtime 下不该删任何数据');
  });

  test('U5 ③设置页指定的库位置：必须去那里找，不能误报默认位置', () => {
    const customDir = path.join(tmpRoot, 'u5', 'my-custom-lib');
    const env = buildEnv({ tag: 'u5', customDataDir: customDir });

    // 让脚本读到「设置页选了 customDir」：写进本包 config/data-dir.json
    const cfgDir = path.join(PACKAGE_DIR, 'config');
    const cfgFile = path.join(cfgDir, 'data-dir.json');
    const hadCfg = fs.existsSync(cfgFile);
    const oldCfg = hadCfg ? fs.readFileSync(cfgFile, 'utf8') : null;
    try {
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: customDir }), 'utf8');

      const out = run(['apply'], env);

      assert.match(out, /设置页选择的库位置/, '必须认出③来源');
      assert.ok(fs.existsSync(path.join(customDir, 'store', 'memory.csv')), '自定义位置的库必须保留');
      assert.deepEqual(listFiles(customDir), ['store/memory.csv'], '自定义位置的运行期产物要清掉');
      assert.ok(
        !fs.existsSync(path.join(env.home, 'tag-memory')),
        '不能因为找不到库就误建/误删默认位置',
      );
    } finally {
      if (hadCfg) fs.writeFileSync(cfgFile, oldCfg, 'utf8');
      else fs.rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  test('U6 库不存在：如实说"清理前就没有"，不谎称删过', () => {
    const env = buildEnv({ tag: 'u6', withLibrary: false });
    const dataDir = env.dataDir;

    const out = run(['apply'], env);

    assert.match(out, /记忆库不存在/, '必须如实报告库不存在');
    assert.match(out, /不是本次删的/, '必须澄清不是自己删的');
    assert.ok(!fs.existsSync(path.join(dataDir, 'records')), '运行期产物照清');
  });

  test('U7 摘清单条目：依赖与 bundles 都摘掉，且留备份', () => {
    const env = buildEnv({ tag: 'u7' });
    const dataDir = env.dataDir;

    run(['apply'], env);

    const manifest = JSON.parse(fs.readFileSync(path.join(env.profileDir, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies?.['dsh-tag-memory'], undefined, '依赖条目必须摘掉');
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base'], 'bundles 里必须摘掉本包');
    assert.equal(manifest.dependencies, undefined, '依赖清空后整个键也要删');

    const baks = fs.readdirSync(env.profileDir).filter((n) => n.includes('.bak-tag-memory-'));
    assert.equal(baks.length, 1, '改清单前必须留一份备份');
  });
});
