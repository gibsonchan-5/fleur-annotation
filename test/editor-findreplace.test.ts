// findAndReplace 转义容忍匹配回归测试
// 背景：剪藏笔记中脚注写作 \[1\]，阅读模式渲染后用户选中的是 [1]，
// 旧逻辑全部匹配层级失败 → 静默不写文件但批注入库 → 侧边栏有、正文无高亮。
import { findAndReplace } from '../src/editor';

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.error(`  FAIL - ${name}`); }
}

// ① 核心案例：转义脚注括号（\mkts 2026-09-29 真实故障）
const note = '在数字技术重构生活方式与后物质主义思潮渗透的双重作用下，大众消费行为逐渐突破传统实用主义框架\\[1\\]，呈现出情感化、符号化和社交化特征。';
const sel = '在数字技术重构生活方式与后物质主义思潮渗透的双重作用下，大众消费行为逐渐突破传统实用主义框架[1]，呈现出情感化、符号化和社交化特征。';
const r1 = findAndReplace(note, sel, (m) => `==${m}==`);
assert(r1 !== null, '① 转义脚注 \\[1\\] 选区可匹配');
assert(r1 !== null && r1.startsWith('==在数字技术重构') && r1.includes('框架\\[1\\]') && r1.endsWith('=='), '① 包裹保留原始转义形式');

// ② 普通文本不受影响（精确匹配仍优先）
const r2 = findAndReplace('前文，目标句子，后文', '目标句子', (m) => `==${m}==`);
assert(r2 === '前文，==目标句子==，后文', '② 普通精确匹配行为不变');

// ③ occurrence 语义保持：跳过第 n 处
const r3 = findAndReplace('甲、乙、甲', '甲', (m) => `==${m}==`, 1);
assert(r3 === '甲、乙、==甲==', '③ occurrence=1 命中第二处');

// ④ 转义星号：剪藏正文 \*强调\* 渲染为 *强调*
const r4 = findAndReplace('她说\\*强调\\*了一下', '她说*强调*了一下', (m) => `==${m}==`);
assert(r4 !== null && r4.includes('==她说\\*强调\\*了一下=='), '④ 转义星号可匹配');

// ⑤ 全部失败仍返回 null
assert(findAndReplace('完全无关的内容', '不存在的文本', (m) => `==${m}==`) === null, '⑤ 无匹配返回 null');

// ⑥ 空白容忍 + 转义混合：选区跨换行且含转义括号
const r6 = findAndReplace('第一行结尾\\[1\\]\n第二行开头', '第一行结尾[1] 第二行开头', (m) => `==${m}==`);
assert(r6 !== null && r6.startsWith('==第一行') && r6.endsWith('开头=='), '⑥ 跨行+转义混合匹配');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
