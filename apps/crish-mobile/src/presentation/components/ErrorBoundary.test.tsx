// 根级错误边界测试：渲染异常 → 兜底界面（不白屏）。
import { render } from '@testing-library/react-native';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): null {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('渲染兜底界面并记录错误', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const view = await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(view.getByText('应用遇到问题')).toBeTruthy();
    expect(view.getByText('重试')).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
