// 扫码配对占位页路由测试（R2-03 部分 3，P2 / G-10 注记）：
// 整页渲染 + 「返回」→ router.back()。
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import PairScanRoute from './scan';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const backMock = router.back as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('扫码配对占位页路由（P2 / G-10 注记）', () => {
  it('渲染占位文案（扫码功能即将推出，请使用手动输入）', async () => {
    await render(<PairScanRoute />);
    expect(screen.getByText('扫码功能即将推出，请使用手动输入。')).toBeTruthy();
  });

  it('点「返回」→ router.back()', async () => {
    await render(<PairScanRoute />);
    await fireEvent.press(screen.getByTestId('pair-scan-back'));
    expect(backMock).toHaveBeenCalledTimes(1);
  });
});
