/**
 * AppErrorBoundary v2
 *
 * 分层错误边界，支持三种 variant:
 * - fullscreen: 整页级错误，居中卡片 + 大标题 + 操作按钮 + 可折叠错误详情
 * - compact:    面板/标签级错误，行内卡片 + "重试" + "关闭面板" + "重新加载"链接
 * - minimal:    小区域级错误，仅错误图标 + "此区域出错"文本，不影响周围布局
 *
 * 兼容旧版 compact boolean prop (视为 variant="compact")。
 * Fix #19: 按钮顺序统一为 [重试] [其他操作]
 * Fix #20: dismiss 后焦点自动移到第一个可聚焦元素
 * Fix #21: 添加 onError 回调
 */
import React from 'react';
import styles from './AppErrorBoundary.module.css';
import { errorStore } from '../services/ErrorStore';
import { logger, toErrMeta } from '../services/LoggerService';
import { Button, Tooltip } from './ui';

type Variant = 'fullscreen' | 'compact' | 'minimal';

type Props = {
  children: React.ReactNode;
  /** 标题；各 variant 有默认值 */
  title?: string;
  /** 自定义恢复：不刷新整页时调用（如重开设置面板） */
  onReset?: () => void;
  /** 关闭面板回调（compact variant 的"关闭面板"按钮触发） */
  onClose?: () => void;
  /** 错误捕获回调，每次捕获到错误时触发 */
  onError?: (error: Error) => void;
  /** @deprecated 使用 variant="compact"。@see variant="compact" */
  compact?: boolean;
  /** 显示变体，默认 fullscreen */
  variant?: Variant;
};

type State = {
  error: Error | null;
  retryCount: number;
  circuitOpen: boolean;
};

const CIRCUIT_KEY = 'crish_error_boundary_circuit';
const MAX_RETRIES = 3;
const RETRY_WINDOW_MS = 30000;

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

function formatErrorMessage(error: Error): string {
  const msg = (error.message || String(error)).trim() || '未知渲染错误';
  const name = error.name && error.name !== 'Error' ? error.name : '';
  if (name && !msg.startsWith(name)) return `${name}: ${msg}`;
  return msg;
}

/** 取 error.stack 前 6 行（含错误消息 + 5 栈帧） */
function formatErrorStack(error: Error): string {
  if (!error.stack) return '';
  const lines = error.stack.split('\n');
  return lines.slice(0, 6).join('\n');
}

/** 查询容器内首个可聚焦元素 */
function queryFirstFocusable(container: HTMLElement): HTMLElement | null {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return container.querySelector(selector);
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, retryCount: 0, circuitOpen: false };

  private containerRef = React.createRef<HTMLDivElement>();

  static getDerivedStateFromError(error: unknown): State {
    try {
      if (!import.meta.env.DEV) {
        const err = toError(error);
        sessionStorage.setItem('crish_error_boundary_crash', JSON.stringify({
          message: err.message, name: err.name, stack: err.stack?.split('\n').slice(0,6).join('\n'), timestamp: Date.now(),
        }));
      }
    } catch { /* ignore */ }
    return { error: toError(error), retryCount: 0, circuitOpen: false };
  }

  private readCircuitState(): { count: number; windowStart: number } {
    try {
      const saved = sessionStorage.getItem(CIRCUIT_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { count: 0, windowStart: 0 };
  }

  private writeCircuitState(state: { count: number; windowStart: number }): void {
    try {
      sessionStorage.setItem(CIRCUIT_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 修复 5：console.error → logger.error（可观测性链路统一到 LoggerService）。
    // React componentStack 在下方 errorStore.push 的 technical 字段已记录，
    // logger 只记标准 err meta（message/stack/name）。
    logger.error('[crish] render crash', {
      module: 'AppErrorBoundary',
      err: toErrMeta(error),
    });
    this.props.onError?.(error);

    const circuit = this.readCircuitState();
    const now = Date.now();

    if (now - circuit.windowStart > RETRY_WINDOW_MS) {
      circuit.count = 0;
      circuit.windowStart = now;
    }

    circuit.count++;
    this.writeCircuitState(circuit);

    if (circuit.count >= MAX_RETRIES) {
      this.setState({ error, circuitOpen: true, retryCount: circuit.count });
    } else {
      this.setState({ error, circuitOpen: false, retryCount: circuit.count });
    }

    try {
      const technical = (info.componentStack || error.stack) ?? undefined;
      errorStore.push({
        code: 'REACT_RENDER_ERROR',
        module: 'AppErrorBoundary',
        severity: 'error',
        message: error.message || '渲染崩溃',
        ...(technical !== undefined && { technical }),
        autoResolve: true,
      });
    } catch { /* prevent recursive crash */ }
  }

  componentDidMount() {
    try {
      if (import.meta.env.DEV) return;
      if (this.resolveVariant() !== 'fullscreen') return;
      const raw = sessionStorage.getItem('crish_error_boundary_crash');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.timestamp < 30000) {
          this.setState({ error: new Error(parsed.message), retryCount: 0, circuitOpen: false });
        }
      }
    } catch { /* ignore */ }
  }

  componentDidUpdate(_prevProps: Props, prevState: State) {
    // Fix #20: dismiss 后焦点自动移到第一个可聚焦元素
    if (prevState.error && !this.state.error) {
      requestAnimationFrame(() => {
        const el = this.containerRef.current;
        if (!el) return;
        const first = queryFirstFocusable(el);
        first?.focus({ preventScroll: true });
      });
    }
    // Reset circuit counter if error cleared (dismissed)
    if (prevState.error && !this.state.error) {
      this.writeCircuitState({ count: 0, windowStart: 0 });
    }
  }

  private reload = () => {
    this.setState({ error: null });
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  };

  private dismiss = () => {
    this.setState({ error: null });
    this.props.onReset?.();
    try {
      sessionStorage.removeItem('crish_error_boundary_crash');
    } catch { /* ignore */ }
  };

  private handleClose = () => {
    this.dismiss();
    this.props.onClose?.();
  };

  private resolveVariant(): Variant {
    if (this.props.variant) return this.props.variant;
    if (this.props.compact) return 'compact';
    return 'fullscreen';
  }

  render() {
    if (!this.state.error) {
      return <div ref={this.containerRef} style={{ display: 'contents' }}>{this.props.children}</div>;
    }

    const variant = this.resolveVariant();
    const error = this.state.error;
    const { circuitOpen, retryCount } = this.state;
    const msg = formatErrorMessage(error);
    const stack = formatErrorStack(error);

    // --- circuit open: excessive errors ---
    if (circuitOpen) {
      if (variant === 'minimal') {
        return (
          <div className={styles.appErrorMinimal} role="alert">
            <span className={styles.appErrorMinimalIcon} aria-hidden="true">!</span>
            <span className={styles.appErrorMinimalText}>重复出错，请重新加载</span>
          </div>
        );
      }
      return (
        <div className={styles.appErrorBoundary}>
          <div className={styles.appErrorCard}>
            <div className={styles.appErrorTitle}>频繁出错</div>
            <div className={styles.appErrorMsg} role="alert">
              应用连续 {retryCount} 次发生渲染错误（{RETRY_WINDOW_MS / 1000}秒内），暂时无法自动恢复。
            </div>
            <div className={styles.appErrorActions}>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={this.reload}
              >
                重新加载
              </Button>
            </div>
            {stack && (
              <details className={styles.appErrorDetails}>
                <summary className={styles.appErrorDetailsSummary}>
                  错误详情
                </summary>
                <pre className={styles.appErrorDetailsPre}>{stack}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    // --- minimal: 仅错误图标 + "此区域出错"，不影响周围布局 ---
    if (variant === 'minimal') {
      return (
        <div className={styles.appErrorMinimal} role="alert">
          <span className={styles.appErrorMinimalIcon} aria-hidden="true">!</span>
          <span className={styles.appErrorMinimalText}>此区域出错</span>
        </div>
      );
    }

    // --- compact: 行内小卡片 + "重试" + "关闭面板" + "重新加载"链接 ---
    if (variant === 'compact') {
      const compactTitle = this.props.title || '此面板出错';
      return (
        <div className={`${styles.appErrorBoundary} ${styles.appErrorBoundaryCompact}`}>
          <div className={`${styles.appErrorCard} ${styles.appErrorCardCompact}`}>
            <div className={styles.appErrorTitle}>{compactTitle}</div>
            <Tooltip content={msg}>
              <div className={styles.appErrorMsg} role="alert">
                {msg}
              </div>
            </Tooltip>
            <div className={styles.appErrorActions}>
              {/* Fix #19: 按钮顺序 [重试] [其他操作] */}
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={this.dismiss}
              >
                重试
              </Button>
              {this.props.onClose && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={this.handleClose}
                >
                  关闭面板
                </Button>
              )}
              <button
                type="button"
                className={styles.appErrorReloadLink}
                onClick={this.reload}
              >
                重新加载
              </button>
            </div>
          </div>
        </div>
      );
    }

    // --- fullscreen: 居中卡片 + 大标题 + 操作按钮 + 可折叠错误详情 ---
    const fullscreenTitle = this.props.title || '界面出错了';
    return (
      <div className={styles.appErrorBoundary}>
        <div className={styles.appErrorCard}>
          <div className={styles.appErrorTitle}>{fullscreenTitle}</div>
          <Tooltip content={msg}>
            <div className={styles.appErrorMsg} role="alert">
              {msg}
            </div>
          </Tooltip>
          {/* Fix #19: 按钮顺序 [重试] [其他操作] */}
          <div className={styles.appErrorActions}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={this.dismiss}
            >
              {this.props.onReset ? '重试' : '尝试恢复'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={this.reload}
            >
              重新加载
            </Button>
          </div>
          {/* 可折叠错误详情 */}
          {stack && (
            <details className={styles.appErrorDetails}>
              <summary className={styles.appErrorDetailsSummary}>
                错误详情
              </summary>
              <pre className={styles.appErrorDetailsPre}>{stack}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
