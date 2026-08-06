/**
 * mermaidLoader — Mermaid 的按需加载与渲染
 *
 * Mermaid 打包体积在 500KB 以上，绝不能进首屏包。
 * 这里做三件事：
 *   1. 动态 import，全局只加载一次（Promise 缓存）；
 *   2. 统一初始化配置，保证所有图表风格一致；
 *   3. 渲染失败时抛出可读的错误，交给调用方决定如何呈现。
 */

type MermaidModule = typeof import('mermaid');

let modulePromise: Promise<MermaidModule> | null = null;
let renderSeq = 0;

/** 加载并初始化 mermaid，重复调用复用同一个 Promise */
async function loadMermaid(): Promise<MermaidModule> {
  if (!modulePromise) {
    modulePromise = import('mermaid').then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        // 编辑器里的图表由用户自己输入，不允许其中的 HTML 生效
        securityLevel: 'strict',
        fontFamily: 'var(--font-sans)',
        flowchart: { curve: 'basis', useMaxWidth: true },
        sequence: { useMaxWidth: true },
      });
      return mod;
    });
  }
  return modulePromise;
}

/**
 * 把 Mermaid 源码渲染成 SVG 字符串。
 *
 * @throws 语法错误时抛出，错误信息已去掉 mermaid 内部的冗余前缀
 */
export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  const id = `mermaid-render-${++renderSeq}`;
  try {
    const { svg } = await mermaid.default.render(id, source);
    return svg;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^.*?Error:\s*/i, '').trim() || '无法解析该图表');
  }
}

/** 预热：在空闲时段提前加载，让用户第一次插入图表时不用等 */
export function prefetchMermaid(): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => void loadMermaid(), { timeout: 4000 });
  }
}
