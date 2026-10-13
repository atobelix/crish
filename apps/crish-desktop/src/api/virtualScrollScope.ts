/**
 * apps/crish-desktop/src/api/virtualScrollScope.ts
 *
 * 虚拟滚动复合作用域注册表与索引协议 (W2-5 / VULN-04)
 * 采用 ${paneId}::${sessionId} 复合键物理隔离多分屏同会话实例与高度缓存
 */

import type { VirtualScrollManager } from './VirtualScrollManager';

export const _activeVsmByScope = new Map<string, VirtualScrollManager>();

export interface ParsedScopeKey {
  paneId: string;
  sessionId: string;
  isComposite: boolean;
}

export function formatScopeKey(
  paneId: string | null | undefined,
  sessionId: string
): string {
  const normalizedPane =
    paneId && typeof paneId === 'string' && paneId.trim()
      ? paneId.trim()
      : 'default';
  return `${normalizedPane}::${sessionId}`;
}

export function makeScopeKey(
  sessionId: string,
  paneId?: string | null | undefined
): string {
  if (!sessionId) return formatScopeKey(paneId, '');
  if (sessionId.includes('::')) {
    const parsed = parseScopeKey(sessionId);
    return formatScopeKey(parsed.paneId, parsed.sessionId);
  }
  return formatScopeKey(paneId, sessionId);
}

export function parseScopeKey(scopeKey: string): ParsedScopeKey {
  if (!scopeKey) {
    return { paneId: 'default', sessionId: '', isComposite: false };
  }
  const idx = scopeKey.indexOf('::');
  if (idx === -1) {
    return { paneId: 'default', sessionId: scopeKey, isComposite: false };
  }
  const rawPane = scopeKey.slice(0, idx).trim();
  return {
    paneId: rawPane || 'default',
    sessionId: scopeKey.slice(idx + 2),
    isComposite: true,
  };
}

export function registerScope(
  sessionId: string,
  paneId: string | null | undefined,
  vsm: VirtualScrollManager
): void;
export function registerScope(
  scopeKeyOrSessionId: string,
  vsm: VirtualScrollManager
): void;
export function registerScope(
  sessionIdOrScope: string,
  paneIdOrVsm: string | null | undefined | VirtualScrollManager,
  maybeVsm?: VirtualScrollManager
): void {
  if (!sessionIdOrScope) return;

  if (
    maybeVsm &&
    typeof (maybeVsm as unknown as { getHeight?: unknown }).getHeight ===
      'function'
  ) {
    const paneId =
      typeof paneIdOrVsm === 'string'
        ? paneIdOrVsm
        : paneIdOrVsm === null || paneIdOrVsm === undefined
          ? null
          : 'default';
    const key = makeScopeKey(sessionIdOrScope, paneId);
    const parsed = parseScopeKey(key);
    if (!parsed.sessionId) return;
    _activeVsmByScope.set(key, maybeVsm);
    maybeVsm.setScope?.(paneId ?? parsed.paneId, parsed.sessionId);
    return;
  }

  if (
    paneIdOrVsm &&
    typeof (paneIdOrVsm as unknown as { getHeight?: unknown }).getHeight ===
      'function'
  ) {
    const vsm = paneIdOrVsm as VirtualScrollManager;
    const compKey = makeScopeKey(sessionIdOrScope, 'default');
    const parsed = parseScopeKey(compKey);
    if (!parsed.sessionId) return;
    _activeVsmByScope.set(compKey, vsm);
    vsm.setScope?.(parsed.paneId, parsed.sessionId);
  }
}

export function unregisterScope(
  sessionIdOrScope: string,
  paneId?: string | null,
  expectedVsm?: VirtualScrollManager
): boolean {
  if (!sessionIdOrScope) return false;
  const key = makeScopeKey(sessionIdOrScope, paneId);
  if (expectedVsm && _activeVsmByScope.get(key) !== expectedVsm) {
    return false;
  }
  return _activeVsmByScope.delete(key);
}

export function getScope(
  sessionIdOrScope: string,
  paneId?: string | null
): VirtualScrollManager | undefined {
  if (!sessionIdOrScope) return undefined;
  const key = makeScopeKey(sessionIdOrScope, paneId);
  return _activeVsmByScope.get(key);
}

export function hasScope(
  sessionIdOrScope: string,
  paneId?: string | null
): boolean {
  return getScope(sessionIdOrScope, paneId) !== undefined;
}

export function getScopesBySession(sessionId: string): VirtualScrollManager[] {
  if (!sessionId) return [];
  const suffix = `::${sessionId}`;
  const result: VirtualScrollManager[] = [];
  for (const [key, vsm] of _activeVsmByScope.entries()) {
    if (key.endsWith(suffix)) result.push(vsm);
  }
  return result;
}

export function unregisterScopesBySession(sessionId: string): number {
  if (!sessionId) return 0;
  const suffix = `::${sessionId}`;
  let removed = 0;
  for (const key of Array.from(_activeVsmByScope.keys())) {
    if (key.endsWith(suffix) && _activeVsmByScope.delete(key)) {
      removed += 1;
    }
  }
  return removed;
}

export function clearAllScopes(): void {
  _activeVsmByScope.clear();
}
