import React from 'react';

/** 富文本输入装配失败兜底边界：捕获 lazy 加载 / 渲染错误 → 通知宿主切 textarea */
export class InputFieldErrorBoundary extends React.Component<
  { onFail: () => void; children?: React.ReactNode },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFail();
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
