/**
 * LR-H1 · 产品 Strict 打开 docId 解析
 *
 * 打开面不再只有死合成 `strict-${wsId}`：
 * 1. 显式 `productStrictDocId`（宿主 / 测）
 * 2. `recentPersistedDocId`（最近一篇已 persist）
 * 3. 打开前 apply+commit 登记（`bindWorkspacePersistedStrictDoc`）
 * 4. 无绑定 → 仍回退 `strict-${wsId}` 诚实空（不得删）
 *
 * 本解析只换 docId，不改 hydrate 分轨：
 * 无 Tauri 仍 `source:'fixture'`；有 Tauri 走 tauri-ipc（空成功也诚实）。
 *
 * ≠ 打开完成（G-HYD 产品句）· ≠ EL-01 / EL-04 / EL-08
 */

export type ProductStrictDocBindingKind =
  'explicit-prop' | 'recent-persisted' | 'pre-open-bind' | 'synthetic-unbound';

export type ResolveProductStrictDocIdInput = {
  wsId: string;
  /** 宿主显式绑定：已 persist 文档 / 打开前 apply+commit 的 id */
  productStrictDocId?: string | null;
  /** 最近一篇已 persist 文档 id（prop 注入） */
  recentPersistedDocId?: string | null;
};

export type ProductStrictDocResolution = {
  docId: string;
  binding: ProductStrictDocBindingKind;
  /** 合成回退 id，便于测「绑定后 ≠ 死合成」 */
  syntheticFallback: string;
};

/** 无绑定诚实空：`strict-${wsId}`（LR-H1 回退，禁止删除） */
export function syntheticStrictDocId(wsId: string): string {
  return `strict-${wsId}`;
}

function normalizeBoundDocId(
  value: string | null | undefined
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 打开前 apply+commit 登记：同 ws 最近一篇 persist id（进程内） */
const preOpenBindByWs = new Map<string, string>();

/**
 * 打开前对某 id apply+commit 后登记，供空态打开覆盖合成 id。
 * 空 / 空白 docId 忽略（不覆盖既有绑定）。
 */
export function bindWorkspacePersistedStrictDoc(
  wsId: string,
  docId: string
): void {
  const bound = normalizeBoundDocId(docId);
  if (!bound) return;
  preOpenBindByWs.set(wsId, bound);
}

/** 解除某工作区的打开前绑定 */
export function unbindWorkspacePersistedStrictDoc(wsId: string): void {
  preOpenBindByWs.delete(wsId);
}

/** 读当前打开前绑定（无则 undefined） */
export function peekWorkspacePersistedStrictDoc(
  wsId: string
): string | undefined {
  return preOpenBindByWs.get(wsId);
}

/** 测隔离：清空全部打开前绑定 */
export function resetWorkspacePersistedStrictDocBindings(): void {
  preOpenBindByWs.clear();
}

/**
 * 解析产品 Strict 打开用 docId。
 * 优先级：显式 prop → 最近一篇 prop → 打开前登记 → 合成诚实空。
 */
export function resolveProductStrictDocId(
  input: ResolveProductStrictDocIdInput
): ProductStrictDocResolution {
  const syntheticFallback = syntheticStrictDocId(input.wsId);
  const explicit = normalizeBoundDocId(input.productStrictDocId);
  if (explicit) {
    return {
      docId: explicit,
      binding: 'explicit-prop',
      syntheticFallback,
    };
  }
  const recent = normalizeBoundDocId(input.recentPersistedDocId);
  if (recent) {
    return {
      docId: recent,
      binding: 'recent-persisted',
      syntheticFallback,
    };
  }
  const preOpen = peekWorkspacePersistedStrictDoc(input.wsId);
  if (preOpen) {
    return {
      docId: preOpen,
      binding: 'pre-open-bind',
      syntheticFallback,
    };
  }
  return {
    docId: syntheticFallback,
    binding: 'synthetic-unbound',
    syntheticFallback,
  };
}

/** 落地 / Strict 宿主可观测绑定钉（≠ 打开完成） */
export function buildStrictDocBindingDataAttrs(
  resolution: ProductStrictDocResolution
): Record<string, string> {
  return {
    'data-strict-doc-id': resolution.docId,
    'data-strict-doc-binding': resolution.binding,
    'data-synthetic-strict-doc-id': resolution.syntheticFallback,
  };
}
