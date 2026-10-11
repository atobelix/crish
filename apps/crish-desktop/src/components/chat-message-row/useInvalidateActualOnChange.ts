import { useEffect, useRef } from 'react';

type HeightOwner = {
  invalidateActual: (id: string) => void;
} | null | undefined;

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/**
 * 挂载时不调用 invalidateActual（用 ref 记下首帧签名）。
 * 仅当 signature 的值真正变化且 enabled 时才作废实测。
 * 调用方必须把「是否 enabled」所依赖的字段放进 signature。
 */
export function useInvalidateActualOnChange(
  owner: HeightOwner,
  messageId: string,
  enabled: boolean,
  signature: readonly unknown[],
): void {
  const prevRef = useRef<readonly unknown[] | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = signature;
    if (prev == null || !enabled || sameList(prev, signature)) return;
    owner?.invalidateActual(messageId);
  }, [owner, messageId, enabled, signature]);
}
