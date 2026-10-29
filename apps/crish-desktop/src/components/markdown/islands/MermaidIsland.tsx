/**
 * Mermaid Island：Rust 输出带源码的代码块外壳，这里懒加载 Mermaid 渲染 SVG。
 *
 * - Mermaid 只在出现图表时动态加载，不进入首屏静态图；
 * - securityLevel=strict + DOMPurify(SVG) 双重清洗；
 * - 源码保留在代码块 `<pre>` 中，渲染成功后由 CSS 隐藏源码、显示图表。
 */
import DOMPurify from 'dompurify';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useMarkdownTheme } from './useMarkdownTheme';

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderSerial = 0;
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 64;

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((module) => {
      const candidate = module as unknown as {
        default?: MermaidApi;
      } & MermaidApi;
      return candidate.default ?? candidate;
    });
  }
  return mermaidPromise;
}

export interface MermaidIslandProps {
  source: string;
  host?: HTMLElement;
}

export function MermaidIsland({
  source,
  host,
}: MermaidIslandProps): React.ReactElement | null {
  const theme = useMarkdownTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    if (!host) return;
    const state = failed ? 'error' : svg ? 'ready' : 'loading';
    host.dataset.mermaidState = state;
    return () => {
      delete host.dataset.mermaidState;
    };
  }, [host, svg, failed]);

  useEffect(() => {
    if (!source) return;
    const key = `${theme}\u0000${source}`;
    const cached = renderCache.get(key);
    if (cached) {
      setSvg(cached);
      setFailed(false);
      return;
    }

    let cancelled = false;
    void loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit',
          htmlLabels: false,
          // 原生 SVG text 标签才能通过 DOMPurify 的 SVG profile；
          // 默认 foreignObject HTML 标签会被清洗掉，导致节点空白。
          flowchart: { htmlLabels: false },
        });
        const id = `md-mermaid-${++renderSerial}`;
        const result = await mermaid.render(id, source);
        const clean = DOMPurify.sanitize(result.svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        if (cancelled) return;
        if (renderCache.size >= RENDER_CACHE_MAX) {
          const firstKey = renderCache.keys().next().value;
          if (firstKey !== undefined) renderCache.delete(firstKey);
        }
        renderCache.set(key, clean);
        setSvg(clean);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  if (failed) {
    return (
      <pre className="md-mermaid-error" data-mermaid-failed="true">
        {source}
      </pre>
    );
  }
  if (!svg) {
    return <div className="md-mermaid-loading" aria-hidden="true" />;
  }
  return (
    <div
      className="md-mermaid-rendered"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
