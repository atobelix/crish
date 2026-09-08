import { useState, useEffect } from 'react';

/**
 * 落地面态感知 hook（RL-01 特例）：
 * 宿主未透传 emptyKind 时，从 DOM 祖先 data-empty-kind（chatBody）读取；
 * 会话在空态/消息态间切换时经 MutationObserver 同步，
 * 保证 session-empty 落地面走 5% 焦点混色而非标准 6%。
 */
export function useComposerEmptyKind(
  emptyKindProp: string | null | undefined,
  wrapperRef: React.RefObject<HTMLDivElement | null>
): string | undefined {
  const [emptyKind, setEmptyKind] = useState<string | undefined>(
    emptyKindProp ?? undefined
  );

  useEffect(() => {
    if (emptyKindProp !== undefined && emptyKindProp !== null) {
      setEmptyKind(emptyKindProp);
      return;
    }
    const root = wrapperRef.current;
    if (!root) return;
    const read = () => {
      const el = root.closest('[data-empty-kind]');
      setEmptyKind(el?.getAttribute('data-empty-kind') ?? undefined);
    };
    read();
    const observed = root.closest('[data-main-surface]') ?? root;
    const mo = new MutationObserver(read);
    mo.observe(observed, {
      attributes: true,
      attributeFilter: ['data-empty-kind'],
    });
    return () => mo.disconnect();
  }, [emptyKindProp, wrapperRef]);

  return emptyKind;
}
