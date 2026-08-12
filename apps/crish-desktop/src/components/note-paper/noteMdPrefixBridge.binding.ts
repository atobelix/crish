/**
 * 产品 Strict MD 前缀写锥绑定工厂（SD-22 · CONN-D2/D3）
 *
 * 类型见 `noteMdPrefixBridge.types`；叶提交见 `noteMdPrefixBridge.commit`。
 * 公开入口仍为 `noteMdPrefixBridge.ts` barrel。
 *
 * ## 诚实
 * - 无后端 **不得** 静默 mock 可写；disabled 由 UI 钉
 *   `data-md-prefix-write-mode=disabled`
 * - **只**走 `TurnIntoSink`；slash 仍走 `IntentSink`（不互抹）
 * - **≠ EL-01**；**≠ A-BLK-08/09 e2e**；provisional ≠ kind
 */

import {
  createTurnIntoProvisionalCollabSink,
  type TurnIntoSink,
} from '@crish/block-paper';
import type {
  CreateProductMdPrefixBindingOptions,
  ProductMdPrefixBinding,
  ProductMdPrefixSinkSource,
  ProductMdPrefixWriteMode,
  ResolveStrictMdPrefixBindingInput,
  StrictMdPrefixUiBinding,
} from './noteMdPrefixBridge.types';

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 解析产品 Strict MD 前缀写锥绑定。
 *
 * 诚实：无后端 **不得** 静默 mock 可写；disabled 由 UI 钉
 * `data-md-prefix-write-mode=disabled`。
 */
export function createProductMdPrefixBinding(
  options: CreateProductMdPrefixBindingOptions = {}
): ProductMdPrefixBinding {
  if (options.turnIntoSink) {
    return {
      mode: 'writable',
      sink: options.turnIntoSink,
      collab: null,
      source: 'injected-sink',
    };
  }

  if (typeof options.applyOps === 'function') {
    const collab = createTurnIntoProvisionalCollabSink(options.applyOps);
    return {
      mode: 'writable',
      sink: collab.sink,
      collab,
      source: options.sourceLabel ?? 'injected-applyOps',
    };
  }

  return {
    mode: 'disabled',
    sink: undefined,
    collab: null,
    source: 'none',
  };
}

/**
 * 从 Strict 面板 props 拼装叶宿主用 binding（无 collab 审计句柄）。
 * EmptyState / 测可用 `createProductMdPrefixBinding` 拿 collab.wireCalls。
 */
export function bindingFromStrictMdPrefixProps(input: {
  turnIntoSink?: TurnIntoSink;
  writeMode?: ProductMdPrefixWriteMode;
  sinkSource?: ProductMdPrefixSinkSource;
}): ProductMdPrefixBinding {
  const hasSink = Boolean(input.turnIntoSink);
  const mode =
    input.writeMode ??
    (hasSink ? ('writable' as const) : ('disabled' as const));
  if (mode === 'disabled' || !input.turnIntoSink) {
    return {
      mode: 'disabled',
      sink: undefined,
      collab: null,
      source: input.sinkSource ?? 'none',
    };
  }
  return {
    mode: 'writable',
    sink: input.turnIntoSink,
    collab: null,
    source: input.sinkSource ?? 'injected-sink',
  };
}

/**
 * 解析 Strict 上 MD 前缀写模式与来源诚实标注。
 * 产品默认：无 sink → disabled；有 sink → writable。
 */
export function resolveStrictMdPrefixBinding(
  input: ResolveStrictMdPrefixBindingInput
): StrictMdPrefixUiBinding {
  const hasSink = Boolean(input.turnIntoSink);
  return {
    writeMode: input.mdPrefixWriteMode ?? (hasSink ? 'writable' : 'disabled'),
    sinkSource:
      input.mdPrefixSinkSource ?? (hasSink ? 'injected-sink' : 'none'),
  };
}
