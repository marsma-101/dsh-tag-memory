// 临时冒烟脚本（跑完即删，不进包）
import { readFileSync } from 'node:fs';
import { parseCsv, serializeCsv, tagCellToArray, tagsToCell, resolveColumnIndex, rowsToRecords, recordToCells } from './lib/engine/core.mjs';

const schema = JSON.parse(readFileSync('./lib/engine/templates/schema.json', 'utf8'));
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };

const rows = [
  ['M-20261105-001', '部署时先跑 build 再跑 test, 否则旧产物会被打进包', '技能', '用户设置', '通用', ['发版检查', '需先build', '部署'], '观察', 3, '生效'],
  ['M-20261105-002', '含引号 "强调" 与"双引号""转义"', '流程', 'P1', 'A1', ['a'], '稳定', 10, '生效'],
  ['M-20261105-003', '第一行\n第二行\r\n第三行', '规则', '通用', '通用', [], '观察', 1, '已归档'],
  ['M-20261105-004', '', '事实', '通用', '通用', ['x'], '观察', 0, '生效'],
];
const cells = rows.map((r) => r.map((v, i) => (i === 5 ? tagsToCell(v) : String(v))));
const text = serializeCsv({ header: schema.columns, rows: cells });
const back = parseCsv(text);

assert(back.errors.length === 0, 'no parse errors: ' + JSON.stringify(back.errors));
assert(back.rows.length === 4, '4 rows, got ' + back.rows.length);
assert(back.rows.every((r) => r.length === 9), '9 cells each, got ' + back.rows.map((r) => r.length));
assert(back.rows[0][1] === rows[0][1], 'comma body roundtrip');
assert(back.rows[1][1] === rows[1][1], 'quote body roundtrip: ' + back.rows[1][1]);
assert(back.rows[2][1] === rows[2][1], 'newline body roundtrip');
assert(back.rows[3][1] === '', 'empty body roundtrip');
assert(back.rows[0][5] === '发版检查|需先build|部署', 'tag cell');
assert(JSON.stringify(tagCellToArray(back.rows[0][5])) === JSON.stringify(rows[0][5]), 'tag array roundtrip');
assert(tagCellToArray('') .length === 0, 'empty tag cell -> []');

// 反例：简单 split(',') 必然错
const naive = back.rows[0][1].split(',');
assert(naive.length > 1, 'naive split breaks comma body');

// 列序打乱仍能读
const shuffled = ['状态', '编号', '自由标签', '主要内容', '形态', '项目', '智能体', '时距', '稳定性'];
const shuffledRows = [[
  cells[0][8], cells[0][0], cells[0][5], cells[0][1], cells[0][2], cells[0][3], cells[0][4], cells[0][7], cells[0][6],
]];
const parsedShuffled = parseCsv(serializeCsv({ header: shuffled, rows: shuffledRows }));
const recs = rowsToRecords(parsedShuffled, schema);
assert(recs.records.length === 1, 'shuffled header 1 record');
assert(recs.records[0]['编号'] === 'M-20261105-001', 'shuffled 编号');
assert(recs.records[0]['主要内容'] === rows[0][1], 'shuffled 主要内容');
assert(recs.records[0]['时距'] === 3, 'shuffled 时距 int');
assert(JSON.stringify(recs.records[0]['自由标签']) === JSON.stringify(rows[0][5]), 'shuffled tags');

// recordToCells 往返
const c2 = recordToCells(recs.records[0], schema);
assert(c2.length === 9 && c2[1] === rows[0][1] && c2[5] === '发版检查|需先build|部署' && c2[7] === '3', 'recordToCells');

// 表头缺失
const noHeader = rowsToRecords(parseCsv(''), schema);
assert(noHeader.errors.some((e) => e.code === 'HEADER_MISSING'), 'HEADER_MISSING on empty');

// 列变多（模拟正文逗号未转义）
const broken = parseCsv('编号,主要内容,形态,项目,智能体,自由标签,稳定性,时距,状态\r\nM-1,a,b,技能,P,A,t,S,1,生效\r\n');
assert(broken.errors.some((e) => e.code === 'ROW_CELL_COUNT'), 'ROW_CELL_COUNT on 10 cells');

// 引号未闭合
const unterm = parseCsv('编号,主要内容\r\nM-1,"abc\r\n');
assert(unterm.errors.some((e) => e.code === 'CSV_UNTERMINATED_QUOTE'), 'unterminated quote detected');

// 标签含 | 的读侧行为（切分，正是要拒写的原因）
assert(tagCellToArray('发版检查|a|b|部署').length === 4, 'pipe in tag splits -> 4');

console.log('OK: core CSV 层全部冒烟通过');
console.log('  4 行往返 / 引号 / 换行 / 空值 / 引号转义 / 列序打乱 / 表头缺失 / 10 格 / 未闭合引号 / 标签| ');
