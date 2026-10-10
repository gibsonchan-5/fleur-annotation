// 气泡注入探针:验证 injectCommentBubbles 的四种场景
// 运行:test/run-bubble-probe.mjs(esbuild 打包后 node 执行,jsdom 提供 DOM)
import { MarkdownPatcher } from '../src/patcher';

function makeDom(): void {
  document.body.innerHTML = `
    <div class="markdown-preview-view">
      <p>前面一,<mark id="m1">already injected text</mark>后文。</p>
      <p>前面二,<mark id="m2">fresh commented text</mark>后文。</p>
      <p>前面三,<mark id="m3">fresh plain text</mark>后文。</p>
    </div>`;
}

function makePlugin(annotations: any[]): any {
  return {
    app: { workspace: { getActiveFile: () => ({ path: 'f.md' }) } },
    store: { load: async () => ({ annotations }) },
    settings: {},
  };
}

async function inject(plugin: any): Promise<any> {
  const patcher: any = new MarkdownPatcher(plugin);
  await patcher.injectCommentBubbles();
  return patcher;
}

const fail: string[] = [];
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fail.push(name);
}

async function main() {
  // 预置:三个批注。a1 已注入(老行为 bug 场景:批注内容是后来写入的)
  const anns = [
    { id: 'a1', type: 'highlight', text: 'already injected text', color: '#FFC107', comment: 'AI 写入的批注', occurrence: 0, createdAt: 1 },
    { id: 'a2', type: 'comment', text: 'fresh commented text', color: '#FFC107', comment: '全新批注', occurrence: 0, createdAt: 2 },
    { id: 'a3', type: 'highlight', text: 'fresh plain text', color: '#FFC107', occurrence: 0, createdAt: 3 },
  ];
  // m1 预先标记为已注入、无气泡(复现旧 bug 的 DOM 状态)
  makeDom();
  (document.getElementById('m1') as HTMLElement).dataset.fleurAnnotation = 'a1';

  const plugin = makePlugin(anns);
  await inject(plugin);

  // ① 核心 bug 场景:已注入的 mark,批注内容后来才有 → 必须补上气泡
  const m1 = document.getElementById('m1') as HTMLElement;
  const b1 = m1.nextElementSibling;
  check('① 已注入 mark 补出气泡', !!b1 && b1.classList.contains('fleur-annotation-bubble'));
  check('① 气泡带 id', !!b1 && b1.dataset.fleurAnnotation === 'a1');
  check('① 气泡含 SVG', !!b1 && !!b1.querySelector('svg'));

  // ② 幂等:再跑一次不重复注入
  await inject(plugin);
  const bubbles1 = document.querySelectorAll('.fleur-annotation-bubble');
  check('② 幂等(仍为 2 个气泡)', bubbles1.length === 2);

  // ③ 全新 mark:带批注内容 → 有气泡;纯高亮 → 只有标记无气泡
  const m2 = document.getElementById('m2') as HTMLElement;
  const m3 = document.getElementById('m3') as HTMLElement;
  check('③ 新批注 mark 有气泡', !!m2.nextElementSibling?.classList?.contains?.('fleur-annotation-bubble'));
  check('③ 纯高亮 mark 无气泡但有 id', !m3.querySelector('.fleur-annotation-bubble') && m3.dataset.fleurAnnotation === 'a3');

  // ④ 批注内容清空 → 气泡随之移除
  plugin.store.load = async () => ({ annotations: anns.map(a => a.id === 'a2' ? { ...a, comment: undefined } : a) });
  await inject(plugin);
  check('④ 批注清空后气泡移除', !m2.nextElementSibling?.classList?.contains?.('fleur-annotation-bubble'));

  // ⑤ 悬停回调绑定:补出的气泡 mouseenter 不抛错
  const b1b = m1.nextElementSibling as HTMLElement;
  check('⑤ 气泡可触发 mouseenter', !!b1b && (() => { try { b1b.dispatchEvent(new window.MouseEvent('mouseenter')); return true; } catch { return false; } })());

  console.log(fail.length === 0 ? '\nALL PASS' : `\n${fail.length} FAILED`);
  if (fail.length > 0) process.exit(1);
}

void main();
