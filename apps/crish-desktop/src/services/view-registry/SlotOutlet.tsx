// apps/crish-desktop/src/services/view-registry/SlotOutlet.tsx
import React, { useSyncExternalStore, useMemo, Component } from 'react';
import { slotCore } from './SlotCore';
import type { StandardSlotId, OwnerPropsOf } from './SlotTypes';

const CONTENTS_STYLE: React.CSSProperties = { display: 'contents' };

interface SlotErrorBoundaryProps {
  slotKey: string;
  entryId: string;
  mode?: 'single' | 'keyed' | 'list' | 'chain';
  children: React.ReactNode;
  fallback?: React.ReactNode;
  resetKeys?: unknown[];
}

interface SlotErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

/**
 * 局部插槽错误隔离与自愈状态机 (Self-healing Error Boundary & Abdication Trigger)
 */
class SlotErrorBoundary extends Component<
  SlotErrorBoundaryProps,
  SlotErrorBoundaryState
> {
  override state: SlotErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): SlotErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidUpdate(prevProps: SlotErrorBoundaryProps): void {
    if (this.state.hasError) {
      // 容灾自愈协议：当 slotKey、entryId 或 resetKeys 变动时自动重置错误态
      const prevKeys = prevProps.resetKeys;
      const nextKeys = this.props.resetKeys;
      let shouldReset = false;

      if (
        prevProps.slotKey !== this.props.slotKey ||
        prevProps.entryId !== this.props.entryId
      ) {
        shouldReset = true;
      } else if (prevKeys && nextKeys) {
        if (
          prevKeys.length !== nextKeys.length ||
          prevKeys.some((k, i) => !Object.is(k, nextKeys[i]))
        ) {
          shouldReset = true;
        }
      } else if (prevProps.children !== this.props.children) {
        shouldReset = true;
      }

      if (shouldReset) {
        this.setState({ hasError: false, error: undefined });
      }
    }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(
      `[SlotOutlet] Component in slot '${this.props.slotKey}' (entry: '${this.props.entryId}', mode: '${this.props.mode ?? 'single'}') crashed:`,
      error,
      errorInfo
    );
    // 仅在 Single 模式下触发影子退位容灾，Keyed/List/Chain 模式避免误调 abdicateSingle 导致死循环
    if (this.props.mode === 'single') {
      slotCore.abdicateSingle(this.props.slotKey, this.props.entryId);
    }
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

export interface SlotOutletProps<K extends StandardSlotId | string> {
  slotKey: K;
  context: OwnerPropsOf<K>;
  entryKey?: string;
  fallback?: React.ReactNode;
}

export function SlotOutlet<K extends StandardSlotId | string>({
  slotKey,
  context,
  entryKey,
  fallback = null,
}: SlotOutletProps<K>) {
  // 接入 uSES 响应式单通道更新，插槽变更时局部重绘
  const version = useSyncExternalStore(
    (cb) => slotCore.subscribe(slotKey, cb),
    () => slotCore.getVersion(slotKey)
  );

  const renderedContent = useMemo(() => {
    // 1. Keyed 优先分发 (装配 ErrorBoundary 容灾保护与自愈协议)
    if (entryKey) {
      const entry = slotCore.getKeyed(slotKey, entryKey);
      if (entry) {
        const Comp = entry.component;
        return (
          <SlotErrorBoundary
            key={entry.id}
            slotKey={slotKey}
            entryId={entry.id}
            mode="keyed"
            resetKeys={[slotKey, entryKey, context]}
            fallback={fallback}
          >
            <Comp {...context} />
          </SlotErrorBoundary>
        );
      }
      return null;
    }

    // 2. Single 独占分发 (装配 ErrorBoundary 影子退让容灾保护与自愈协议)
    const single = slotCore.getSingle(slotKey);
    if (single) {
      const Comp = single.component;
      return (
        <SlotErrorBoundary
          key={single.id}
          slotKey={slotKey}
          entryId={single.id}
          mode="single"
          resetKeys={[slotKey, single.id, context]}
          fallback={fallback}
        >
          <Comp {...context} />
        </SlotErrorBoundary>
      );
    }

    // 3. List 序列分发 (装配 ErrorBoundary 逐项隔离保护与自愈协议)
    const list = slotCore.getList(slotKey);
    if (list.length > 0) {
      return (
        <>
          {list.map((item) => {
            const Comp = item.component;
            return (
              <SlotErrorBoundary
                key={item.id}
                slotKey={slotKey}
                entryId={item.id}
                mode="list"
                resetKeys={[slotKey, item.id, context]}
                fallback={null}
              >
                <Comp key={item.id} {...context} />
              </SlotErrorBoundary>
            );
          })}
        </>
      );
    }

    // 4. Chain 责任链分发 (装配 ErrorBoundary 容灾保护与自愈协议)
    const chain = slotCore.getChain(slotKey, context);
    if (chain) {
      const Comp = chain.component;
      return (
        <SlotErrorBoundary
          key={chain.id}
          slotKey={slotKey}
          entryId={chain.id}
          mode="chain"
          resetKeys={[slotKey, chain.id, context]}
          fallback={fallback}
        >
          <Comp {...context} />
        </SlotErrorBoundary>
      );
    }

    return null;
  }, [slotKey, context, entryKey, fallback, version]);

  return (
    <div
      data-slot={slotKey}
      data-slot-key={entryKey}
      style={CONTENTS_STYLE}
    >
      {renderedContent ?? fallback}
    </div>
  );
}
