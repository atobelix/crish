import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AppErrorBoundary } from '../../src/components/AppErrorBoundary';

describe('AppErrorBoundary snapshots', () => {
  it('renders compact variant', () => {
    const { container } = render(
      <AppErrorBoundary compact title="测试错误">
        <div>child content</div>
      </AppErrorBoundary>
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders minimal variant', () => {
    const { container } = render(
      <AppErrorBoundary variant="minimal" title="mini error">
        <div>child</div>
      </AppErrorBoundary>
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
