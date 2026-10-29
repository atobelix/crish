/**
 * 数学公式 Island：Rust 只输出带 `data-tex` 的占位，这里按需加载 KaTeX
 * 并渲染为 HTML。KaTeX 使用 `trust:false`，不接受任意 HTML 命令。
 */
import { useEffect, useState } from 'react';

interface KatexApi {
  renderToString: (tex: string, options?: Record<string, unknown>) => string;
}

let katexPromise: Promise<KatexApi> | null = null;

async function loadKatex(): Promise<KatexApi> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([module]) => {
      const candidate = module as unknown as { default?: KatexApi } & KatexApi;
      return candidate.default ?? candidate;
    });
  }
  return katexPromise;
}

const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 256;

function cacheKey(source: string, displayMode: boolean): string {
  return `${displayMode ? 'block' : 'inline'}\u0000${source}`;
}

export interface MathIslandProps {
  source: string;
  displayMode: boolean;
}

export function MathIsland({
  source,
  displayMode,
}: MathIslandProps): React.ReactElement {
  const [html, setHtml] = useState<string | null>(() => {
    return renderCache.get(cacheKey(source, displayMode)) ?? null;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!source) return;
    const key = cacheKey(source, displayMode);
    const cached = renderCache.get(key);
    if (cached) {
      setHtml(cached);
      setFailed(false);
      return;
    }

    let cancelled = false;
    void loadKatex()
      .then((katex) => {
        const rendered = katex.renderToString(source, {
          displayMode,
          throwOnError: false,
          trust: false,
          strict: 'ignore',
          output: 'htmlAndMathml',
        });
        if (cancelled) return;
        if (renderCache.size >= RENDER_CACHE_MAX) {
          const firstKey = renderCache.keys().next().value;
          if (firstKey !== undefined) renderCache.delete(firstKey);
        }
        renderCache.set(key, rendered);
        setHtml(rendered);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [source, displayMode]);

  if (failed || !html) {
    return (
      <code
        className="md-math-fallback"
        data-math-failed={failed ? 'true' : undefined}
      >
        {source}
      </code>
    );
  }

  return (
    <span
      className={`md-math-rendered ${
        displayMode ? 'md-math-rendered-block' : 'md-math-rendered-inline'
      }`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
