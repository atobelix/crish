/**
 * CustomTagErrorBoundary.tsx
 *
 * 局部故障隔离边界（Tier 4 XSS / Runtime 防护）
 *
 * 核心机制：
 * 1. 拦截单个自定义组件（如 <widget-diff> 或 <file-tree>）内部的渲染异常；
 * 2. 局部熔断降级，防止单个富交互组件崩溃导致整条消息时间线或 WebView 白屏；
 * 3. 提供可重试能力与故障诊断信息展示，100% Token 化错误态卡片。
 */

import React, { Component, type ReactNode, type ErrorInfo, type ComponentType } from 'react';
import styles from './custom-tags.module.css';

export interface CustomTagErrorBoundaryProps {
  tagName?: string;
  children?: ReactNode;
  fallback?: ComponentType<{
    error: Error;
    resetError: () => void;
    tagName?: string;
  }>;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class CustomTagErrorBoundary extends Component<
  CustomTagErrorBoundaryProps,
  State
> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  public handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  public override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        const FallbackComponent = this.props.fallback;
        return (
          <FallbackComponent
            error={this.state.error}
            resetError={this.handleReset}
            tagName={this.props.tagName}
          />
        );
      }

      return (
        <div
          className={styles.customTagError}
          role="alert"
          data-tag-error={this.props.tagName || 'custom-tag'}
        >
          <div className={styles.customTagErrorHeader}>
            <span className={styles.customTagErrorTitle}>
              ⚠️ 自定义组件渲染异常 [{this.props.tagName || 'custom-tag'}]
            </span>
            <button
              type="button"
              className={styles.customTagErrorResetBtn}
              onClick={this.handleReset}
              aria-label="重试"
            >
              重试
            </button>
          </div>
          <div className={styles.customTagErrorMessage}>
            {this.state.error.message || '未知运行时错误'}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
