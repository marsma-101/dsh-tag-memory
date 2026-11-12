// 闸门③ V 组：标签词表与触发词（vocab.mjs）+ near 提示增强 + 词表注入
//
// ── 为什么要有这组（2026-11-11 真实事故）──────────────────────────
// 用户说「有问题要改源码，记忆库里有这条」，模型却查不到。
// 复现：查 ["改源码","生产环境"]，而那条记的是「规矩|源码|生产端|同步|边界|改动落点」。
// 精确交集 = 0 → e_ratio=0 → 被 ENTRY_RATIO 否决 → blocked=QUERY_OFF_DIRECTION
// → 报「假查空」。换 ["源码","生产端"] 立刻召回（93.17 分）。
//
// 根因不是「不想查」，是**不知道该用什么词**。这组测两件事：
//   ① near 必须把「条目原始标签 + 差几个」交出来，别自己猜建议词
//   ② 词表（频次分档）+ 触发词（英文自动 / 中文显式）必须按实测判据走
//
// 纯逻辑测试：不模拟 React/DOM、不执行渲染（遵守官方 verification.md 铁律）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countTags,
  splitByFrequency,
  pickTriggerWords,
  matchTriggers,
  renderVocab,
  isUsefulTag,
  resolveExclusions,
  DEFAULT_EXCLUDES,
  selectVisible,
  renderTagNetwork,
  networkStats,
} from '../../lib/engine/vocab.mjs';
import { readLibraryCsv } from '../../lib/engine/core.mjs';
import { recall, buildEquivalenceIndex } from '../../lib/engine/read.mjs';
import { loadSchema, loadScoring, loadTagEquivalence } from '../../lib/engine/dict.mjs';
import { buildToolDefs, clearNetworkCache, renderNetworkFromLibrary } from '../../preset/tool-defs.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TEMPLATES = join(ROOT, 'lib', 'engine', 'templates');

/**
 * 造一条最小可用记录（只填 vocab/recall 会读的字段）。
 *
 * ⚠️ `自由标签` 必须是**数组**：真实链路里 `readLibraryCsv` 会把 CSV 的
 * `a|b|c` 解析成数组再交给 recall。这里若不看齐，就会造出「字符串 vs 数组」
 * 的假失败——本项目已踩过一次这种坑（Qa2 的同类误判），故显式写清。
 */
function rec(id, tags, { shape = '技能', status = '生效', project = '通用', agent = '通用' } = {}) {
  return {
    编号: id,
    主要内容: `正文 ${id}`,
    形态: shape,
    项目: project,
    智能体: agent,
    自由标签: tags.slice(),
    稳定性: '观察',
    时距: 1,
    状态: status,
  };
}

/* ================================================================== *
 * V1-V4 词表基础：频次统计与分档
 * ================================================================== */

test('V1 countTags 只数「生效」条目，同条目内重复标签只算一次', () => {
  const records = [
    rec('A', ['npm', 'npm', '发布']),      // 同条内重复只计一次
    rec('B', ['npm']),
    rec('C', ['npm'], { status: '被取代' }), // 状态不是生效，不计
    rec('D', ['npm'], { status: '已归档' }),
  ];
  const { counts } = countTags(records);
  assert.equal(counts.get('npm'), 2, '被取代/已归档条目的标签不该进词表');
  assert.equal(counts.get('发布'), 1);
});

test('V2 countTags 排除「不是概念」的标签（纯数字/来源标记/单字）', () => {
  const records = [rec('A', ['3190', '原话', '推断', 'a', '正常词'])];
  const { counts } = countTags(records, { excludes: resolveExclusions() });
  assert.equal(counts.has('3190'), false, '纯数字是正文碎片，不是标签');
  assert.equal(counts.has('原话'), false, '来源标记不描述内容，只描述来源');
  assert.equal(counts.has('推断'), false);
  assert.equal(counts.has('a'), false, '单字既无意义又易误触发');
  assert.equal(counts.get('正常词'), 1);
});

test('V2b isUsefulTag 拦住版本号/错误码/整条报错（首版曾漏进来）', () => {
  // 这些是 2026-11-11 首版跑真实库时，混进「精准词」档的真实垃圾
  for (const bad of ['v3.5.0', 'V4', '0xc0000142', '5%', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', '3190']) {
    assert.equal(isUsefulTag(bad), false, `${bad} 不该被当成可用标签`);
  }
  for (const good of ['假查空', 'npm', '改动落点', 'CSV']) {
    assert.equal(isUsefulTag(good), true, `${good} 应被接受`);
  }
});

test('V3 splitByFrequency 分两档，泛词按频次降序；同频按字面排保证可复现', () => {
  const counts = new Map([['a词', 5], ['b词', 3], ['c词', 3], ['d词', 1]]);
  const { common, precise } = splitByFrequency(counts, { commonCount: 2 });
  // 同频 3 的两个词按字面排序（b词 < c词），所以 common 取 a词 + b词
  assert.deepEqual(common.map(([t]) => t), ['a词', 'b词'], '泛词取频次最高的两个；同频按字面排');
  assert.deepEqual(precise.map(([t]) => t), ['c词', 'd词'], '其余进精准词档');
});

test('V4 resolveExclusions 是「追加」不是「替换」：内置判据不能被配置清空', () => {
  const withExtra = resolveExclusions({ exclude: ['自定义'] });
  for (const d of DEFAULT_EXCLUDES) {
    assert.ok(withExtra.has(d), `内置排除项 ${d} 必须保留（配置只能追加）`);
  }
  assert.ok(withExtra.has('自定义'));
});

/* ================================================================== *
 * V5-V8 触发词：两条被实测打回的路，和最后成立的那条
 * ================================================================== */

test('V5 自动触发词只收含拉丁字母的（中文短语「像不像人话」程序判不了）', () => {
  // 实测背景：自动筛中文触发词得到 428→410 个，仍混进「按内容判」「报数顺序」
  // 「必读位置」这类用户永远不会原样说出的短语。它们在统计上与「安全漏洞」
  // 完全一样（都是低频精准词），任何阈值都分不开 → 只能不自动收。
  const counts = new Map([
    ['npm', 3],
    ['github', 2],
    ['按内容判', 1],   // 中文短语，不该自动进
    ['必读位置', 1],
  ]);
  const trig = pickTriggerWords(counts, { commonCount: 0 });
  assert.ok(trig.includes('npm'));
  assert.ok(trig.includes('github'));
  assert.equal(trig.includes('按内容判'), false, '中文短语不该被自动当作触发词');
  assert.equal(trig.includes('必读位置'), false);
});

test('V6 显式触发词可以覆盖泛词档与拉丁限制（npm 曾被误当泛词排除）', () => {
  // 实测事故：npm 因 df=4 进了泛词档，被自动排除 →
  // 「npm 发布报 409」这条最该触发的消息反而不触发。
  // 专有名词的高频含义是「本项目天天用」，不是「这词没信息量」。
  const counts = new Map([['npm', 9], ['其他', 9], ['上传', 1]]);
  const auto = pickTriggerWords(counts, { commonCount: 2 });
  assert.equal(auto.includes('npm'), false, '（前提）不加显式名单时 npm 会被泛词档排除');

  const withAlways = pickTriggerWords(counts, { commonCount: 2, always: ['npm', '上传'] });
  assert.ok(withAlways.includes('npm'), '显式名单必须能救回被泛词档排除的专有名词');
  assert.ok(withAlways.includes('上传'), '显式名单里的中文词直接纳入');
});

test('V7 触发词按长度降序：长词优先，避免短词抢匹配', () => {
  const trig = pickTriggerWords(new Map([['npm', 1], ['npmignore', 1]]), { commonCount: 0 });
  assert.equal(trig[0], 'npmignore', '长词必须排在前面');
});

test('V8 matchTriggers 在闲聊上零误触发，在真实话题上命中（实测回归）', () => {
  const trig = pickTriggerWords(
    new Map([['npm', 1], ['privhub', 1], ['github', 1]]),
    { commonCount: 0, always: ['上传', '召回'] },
  );

  // 实测：这批句子误触发 0 条。任何一条命中都说明判据被放宽坏了。
  for (const small of ['今天天气不错', '你哈', '吃了吗', '帮我写首诗', '好的', '继续', '嗯']) {
    assert.deepEqual(matchTriggers(small, trig), [], `「${small}」不该触发任何记忆`);
  }
  // 2026-11-11 首版把「配置/测试」当 2 字触发词，这句就会被误触发 —— 现在不会
  assert.deepEqual(
    matchTriggers('这个方案不错，我想再看看测试的情况，配置也要确认一下。', trig),
    [],
    '普通工作句不该触发',
  );

  assert.deepEqual(matchTriggers('npm 发布报 409', trig), ['npm']);
  assert.ok(matchTriggers('复制 privhub 的东西', trig).includes('privhub'));
  assert.ok(matchTriggers('上传到服务器', trig).includes('上传'));
});

/* ================================================================== *
 * V9-V11 near 提示：给原料不给结论
 * ================================================================== */

/** 造一组能让指定条目「差 1 个标签」过闸的库。 */
async function recallWith(records, queryTags) {
  const schema = await loadSchema({ baseDir: TEMPLATES });
  const scoring = await loadScoring({ baseDir: TEMPLATES });
  const equivalence = await loadTagEquivalence({ baseDir: TEMPLATES });
  return recall({
    records,
    query: { 项目: '通用', 智能体: '通用', 形态: '技能', 自由标签: queryTags },
    identity: { bound: true, who: '测试' },
    schema,
    config: scoring,
    equivalence,
  });
}

test('V9 召回撞空时 near 必须带「条目原始标签」，让模型自己判断该换什么词', () => {
  // 复刻 2026-11-11 事故形态：5 个标签，命中 1 个 → 0.2 不过 0.3 闸门 → near
  const records = [
    rec('M-1', ['源码', '生产端', '同步', '边界', '改动落点']),
    rec('M-2', ['别的', '无关', '词']),
  ];
  return recallWith(records, ['源码']).then((r) => {
    assert.equal(r.hits.length, 0, '（前提）只命中 1/5 应被否决');
    assert.ok(r.near.length > 0, '必须有擦边条目');

    const n = r.near.find((x) => x['编号'] === 'M-1');
    assert.ok(n, 'M-1 应进 near');
    assert.ok(n['自由标签'], 'near 必须带出条目原始标签——没有它模型无从判断该换什么词');
    assert.ok(String(n['自由标签']).includes('生产端'), '标签要原样给出，不能加工成建议词');
    assert.equal(n.gap, 1, '还差 1 个标签过闸，gap 应为 1');
    assert.deepEqual(n.hitTags, ['源码'], '已命中的标签也要给出，模型才知道「差的是哪一类」');
  });
});

test('V10 near 不许自动生成「建议补哪个词」（实测证明那是噪声）', async () => {
  // 实测：四个毫不相关的查询（源码/npm/生产端/召回）返回的建议完全一样
  // （记忆库位置/数据目录/CSV），因为「最能解锁的词」由全库分布决定、与查询无关。
  // 所以 near 只允许出现「原料字段」，不允许出现 suggestion/tip 一类结论字段。
  const records = [rec('M-1', ['源码', '生产端', '同步', '边界', '改动落点'])];
  const r = await recallWith(records, ['源码']);
  assert.ok(r.near.length > 0, '（前提）应有擦边条目');

  const n = r.near[0];
  for (const forbidden of ['suggestion', 'suggest', 'tip', '建议', 'recommend', 'suggestedTags']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(n, forbidden),
      false,
      `near 不得带 ${forbidden}：程序猜词是噪声，只该把条目原始标签交出来`,
    );
  }
  // 该有的「原料」一个都不能少
  assert.ok(Object.prototype.hasOwnProperty.call(n, '自由标签'));
  assert.ok(Object.prototype.hasOwnProperty.call(n, 'gap'));
  assert.ok(Object.prototype.hasOwnProperty.call(n, 'hitTags'));
});

test('V11 gap=1 的条目排在 gap>1 之前（低成本可救的优先）', async () => {
  const records = [
    rec('M-BIG', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']), // 8 标签，命中 2 → 需 3 → gap 1
    rec('M-FAR', ['源码', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11']), // 11 标签，命中 1 → 需 4 → gap 3
  ];
  const r = await recallWith(records, ['源码', 'a1', 'a2']);
  const gap1 = r.near.filter((x) => x.gap === 1);
  const gapMore = r.near.filter((x) => typeof x.gap === 'number' && x.gap > 1);
  if (gap1.length > 0 && gapMore.length > 0) {
    const lastGap1 = r.near.findLastIndex((x) => x.gap === 1);
    const firstMore = r.near.findIndex((x) => typeof x.gap === 'number' && x.gap > 1);
    assert.ok(lastGap1 < firstMore, 'gap=1 必须全部排在 gap>1 之前');
  }
});

test('V11b 【事故回归】撞空时 near 要给原始标签，且网络能带出相关组（两条防线）', async () => {
  // 2026-11-11 事故复刻。当时的解法一度是「在 near 里按子串接近度排序」，
  // 但该判据已于同日**退役**——标签网络接管了这个职责（程序猜词不如把原料给模型）。
  //
  // 现在靠两条防线：
  //   ① near 仍给出「差 1 个标签」的条目及其原始标签（「这次确实没查到」的证据）
  //   ② 标签网络让模型自己看出「规矩|源码|生产端|同步|边界|改动落点」是一组
  const records = [
    rec('M-TARGET', ['规矩', '源码', '生产端', '同步', '边界', '改动落点']),
    rec('M-NOISE1', ['不要臆测', '防污染', '优先级']),
    rec('M-NOISE2', ['正向表述', '规则写法', '不要用负向']),
  ];
  const r = await recallWith(records, ['改源码', '生产环境']);

  assert.equal(r.hits.length, 0, '（前提）精确匹配撞空，这正是事故形态');
  assert.equal(r.empty, 'false_but_near', '（前提）应判为假查空');
  assert.ok(r.near.length > 0, '必须有擦边提示');

  // ① near 的每一条都必须交出原始标签（否则模型无从判断该换什么词）
  for (const n of r.near) {
    assert.ok(n['自由标签'], `near[${n['编号']}] 必须带原始标签`);
    assert.ok(Object.prototype.hasOwnProperty.call(n, 'gap'), 'near 必须带 gap');
  }

  // ② 网络必须让「源码」与「生产端」同行——这是模型能自救的关键
  const net = renderTagNetwork(records);
  const line = net.split('\n').find((l) => l.includes('源码'));
  assert.ok(line && line.includes('生产端'), '网络里「源码」与「生产端」必须同行');
});

/* ================================================================== *
 * V12-V16 标签共现网络（用户裁定：这才是 wiki 的真实形态）
 * ================================================================== */

test('V12 频次词表仍可用（降级形态），分两档且带频次', () => {
  const counts = new Map([['dsh', 20], ['npm', 8], ['假查空', 1]]);
  const text = renderVocab({ counts }, { commonCount: 2, commonLimit: 5, preciseLimit: 5 });
  assert.ok(text.includes('高频泛词'), '泛词档要标注用途（别单独用）');
  assert.ok(text.includes('精准词'), '精准词档要标注用途（优先用）');
  assert.ok(text.includes('dsh(20)'), '必须带频次——不带频次等于把噪声当路标');
});

test('V13 selectVisible 按「本项目/通用 × 本智能体/通用」隔离', () => {
  const records = [
    rec('M-1', ['a'], { project: '项目A', agent: '甲' }),
    rec('M-2', ['b'], { project: '通用', agent: '甲' }),
    rec('M-3', ['c'], { project: '项目A', agent: '通用' }),
    rec('M-4', ['d'], { project: '通用', agent: '通用' }),
    rec('M-5', ['e'], { project: '项目B', agent: '甲' }),   // 别的项目 → 隐藏
    rec('M-6', ['f'], { project: '项目A', agent: '乙' }),   // 别的身份 → 隐藏
    rec('M-7', ['g'], { project: '项目A', agent: '甲', status: '已归档' }), // 非生效 → 隐藏
  ];
  const vis = selectVisible(records, { project: '项目A', agent: '甲' });
  assert.deepEqual(
    vis.map((x) => x['编号']).sort(),
    ['M-1', 'M-2', 'M-3', 'M-4'],
    '只应保留「本项目或通用」且「本身份或通用」的生效条目',
  );
});

test('V14 renderTagNetwork：每行一条记忆的标签，同行即相连；无标签的条目跳过', () => {
  const records = [
    rec('M-1', ['规矩', '源码', '生产端']),
    rec('M-2', ['决策', '召回']),
    rec('M-3', []),                    // 无标签 → 连不成线，跳过
  ];
  const net = renderTagNetwork(records);
  const lines = net.split('\n');
  assert.equal(lines.length, 2, '无标签的条目不占行');
  assert.equal(lines[0], '规矩|源码|生产端');
  assert.equal(lines[1], '决策|召回');

  const st = networkStats(net);
  assert.equal(st.lines, 2);
  assert.equal(st.nodes, 5, '节点应有 5 个不同标签');
  // 每组 3 个词 → 3 条边；2 个词 → 1 条边
  assert.equal(st.edges, 3 + 1, '边数按「同行两两相连」计');
});

test('V15 【事故回归】网络里「源码」与「生产端」必须同行（这是本方案的全部意义）', () => {
  // 2026-11-11 真实事故：查「改源码/生产环境」撞空，因为库里打的是「源码/生产端」。
  // 网络能让模型一眼看到这两个词是一组，从而知道该用什么词去查。
  const records = [rec('M-1', ['规矩', '源码', '生产端', '同步', '边界', '改动落点'])];
  const net = renderTagNetwork(records);
  const line = net.split('\n').find((l) => l.includes('源码'));
  assert.ok(line, '网络里必须有含「源码」的那一行');
  assert.ok(line.includes('生产端'), '「源码」与「生产端」必须同一行——否则网络救不了这次事故');
});

test('V16 网络注入到 dtm_write / dtm_recall 描述；库读不到时静默降级', async () => {
  clearNetworkCache();
  const domain = { shapes: ['技能', '流程', '规则', '偏好', '事实', '模板'] };

  // ① 无库路径 → 不渲染网络，但 10 个工具照常产出
  const without = buildToolDefs(domain, {});
  assert.equal(without.length, 10, '网络是可选增强，不能影响工具数量');
  for (const name of ['dtm_write', 'dtm_recall']) {
    const d = without.find((x) => x.name === name).parameters['自由标签'].description;
    assert.equal(d.includes('现有标签网络'), false, `${name}：没有库就不该出现网络`);
  }

  // ② 给了不存在的路径 → 同样降级，不抛错
  const bogus = buildToolDefs(domain, { libraryCsv: join(ROOT, '__not_exist__.csv') });
  assert.equal(bogus.length, 10, '读库失败不能让工具注册挂掉');

  // ③ 真库 → 两个工具都出现网络
  clearNetworkCache();
  const fsMod = await import('node:fs');
  const fakeCsv = join(ROOT, 'tests', '_network-fixture.csv');
  const rows = [
    '编号,主要内容,形态,项目,智能体,自由标签,稳定性,时距,状态',
    'M-1,"x",技能,项目A,甲,"规矩|源码|生产端",观察,1,生效',
    'M-2,"y",技能,项目B,乙,"别的|项目的|词",观察,1,生效',
  ].join('\n');
  fsMod.writeFileSync(fakeCsv, rows, 'utf8');
  try {
    const body = renderNetworkFromLibrary(fakeCsv, { project: '项目A', agent: '甲' });
    assert.ok(body.includes('源码|生产端'), `网络应含目标行，实际：${body}`);
    assert.equal(body.includes('别的'), false, '别的项目/身份的词必须被隔离掉');

    clearNetworkCache();
    const defs = buildToolDefs(domain, { libraryCsv: fakeCsv, view: { project: '项目A', agent: '甲' } });
    for (const name of ['dtm_write', 'dtm_recall']) {
      const d = defs.find((x) => x.name === name).parameters['自由标签'].description;
      assert.ok(d.includes('现有标签网络'), `${name}：有库时描述里应出现网络`);
      assert.ok(d.includes('规矩|源码|生产端'), `${name}：网络内容要真的进去`);
    }
  } finally {
    fsMod.rmSync(fakeCsv, { force: true });
    clearNetworkCache();
  }
});

test('V17 网络绝不进 section（KV cache 硬约束）', () => {
  // section 每轮在 system prompt 前缀里，内容一变就毁掉其后整段缓存；
  // 网络随库增长而变，进去等于每次写入都让缓存失效一次。
  // 只允许在每轮注入里留一句「有这个表」的存在性提示（约 200 字节），
  // 网络本体必须走工具 description。
  const toolsSrc = readFileSync(join(ROOT, 'preset', 'tool-defs.js'), 'utf8');
  assert.ok(toolsSrc.includes('现有标签网络'), '（前提）网络确实渲染在工具描述里');
  assert.equal(
    /renderInjection\s*\([^)]*network/i.test(toolsSrc),
    false,
    '网络不得进入 renderInjection 的 section 文本',
  );

  // 每轮注入只能提一句「有这个表」，不能带网络内容
  const promptSrc = readFileSync(join(ROOT, 'preset', 'prompt.js'), 'utf8');
  assert.ok(promptSrc.includes('标签网络'), '每轮注入要告诉模型「有这么个东西」');
  assert.equal(
    /\|/.test(promptSrc.split('标签网络')[1]?.slice(0, 200) ?? ''),
    false,
    '注入里不得出现 `|` 分隔的标签串（那说明网络内容漏进 section 了）',
  );
});
