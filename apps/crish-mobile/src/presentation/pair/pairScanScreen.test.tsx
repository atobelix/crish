// 扫码配对占位页组件测试（R2-03 部分 3，P2 / G-10 注记）：
// 占位文案（扫码功能即将推出，请使用手动输入）+ 返回按钮（onBack）。
import { fireEvent, render, screen } from '@testing-library/react-native';
import PairScanScreen from './pairScanScreen';

describe('PairScanScreen 占位（P2 / G-10 注记）', () => {
  it('渲染占位文案（扫码功能即将推出，请使用手动输入）', async () => {
    await render(<PairScanScreen onBack={jest.fn()} />);

    expect(screen.getByText('扫码配对')).toBeTruthy();
    expect(screen.getByText('扫码功能即将推出，请使用手动输入。')).toBeTruthy();
    expect(screen.getByTestId('pair-scan-back')).toBeTruthy();
  });

  it('点「返回」→ onBack（回到配对引导）', async () => {
    const onBack = jest.fn();
    await render(<PairScanScreen onBack={onBack} />);

    await fireEvent.press(screen.getByTestId('pair-scan-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
