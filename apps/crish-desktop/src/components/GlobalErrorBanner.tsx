/**
 * GlobalErrorBanner —— React 渲染树之外的全局错误呈现面（T5-4）。
 *
 * 消费 `errorStore` 的 `GLOBAL_UNCAUGHT_ERROR` 槽位（bootstrap-services
 * 注册 window.onerror / unhandledrejection → errorStore.push 的唯一活路径
 * 产物）：
 * - 非阻塞：不弹模态、不打断正常渲染，仅常驻可见告知；
 * - dismiss：resolveByCode 关闭；
 * - 可展开详情：technical（stack / message）经 <details> 折叠。
 *
 * 形态对齐 CircuitBreakerBanner / SetupHintBanner（软色 + hairline 描边，
 * 无重阴影无粗边框——UI 纪律 §13）。挂载点 = main.tsx（AppErrorBoundary
 * 兄弟节点），与边界层级无关：React 树外异常（store 初始化 / timer /
 * 回调）也可见。
 */
import React from 'react';
import { useSyncExternalStore } from 'react';
import { errorStore, type UiError } from '../services/ErrorStore';
import { Button } from './ui';
import styles from './GlobalErrorBanner.module.css';

const GLOBAL_ERROR_CODE = 'GLOBAL_UNCAUGHT_ERROR';

function subscribe(callback: () => void): () => void {
  return errorStore.subscribeActive(callback);
}

function getSnapshot(): UiError | null {
  const errors = errorStore.getActiveErrors();
  return errors.find((e) => e.code === GLOBAL_ERROR_CODE) ?? null;
}

export const GlobalErrorBanner: React.FC<Record<string, never>> = () => {
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!entry) return null;

  const handleDismiss = () => {
    errorStore.resolveByCode(GLOBAL_ERROR_CODE);
  };

  return (
    <div
      className={styles.globalErrorBanner}
      data-global-error-banner="true"
      role="status"
      aria-live="assertive"
      aria-label="发生一次未预期的错误"
    >
      <span className={styles.globalErrorIcon} aria-hidden="true">
        !
      </span>
      <span className={styles.globalErrorText}>
        {entry.message || '发生一次未预期的错误'}
      </span>
      {entry.technical ? (
        <details className={styles.globalErrorDetails}>
          <summary className={styles.globalErrorDetailsSummary}>详情</summary>
          <pre className={styles.globalErrorDetailsPre}>{entry.technical}</pre>
        </details>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={styles.globalErrorDismiss}
        onClick={handleDismiss}
      >
        知道了
      </Button>
    </div>
  );
};
