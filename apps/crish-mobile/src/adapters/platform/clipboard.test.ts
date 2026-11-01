// 剪贴板适配单测：不 mock react-native 模块（jest-expo 依赖其完整表面，
// 整模块替换/展开都会破坏 setup），只以 spyOn 替换真实 Clipboard 对象的方法。
import { Clipboard } from 'react-native';
import { copyTextToClipboard } from './clipboard';

const setString = jest
  .spyOn(Clipboard, 'setString')
  .mockImplementation(() => {});

beforeEach(() => {
  setString.mockClear();
});

afterAll(() => {
  setString.mockRestore();
});

describe('copyTextToClipboard', () => {
  it('写入成功返回 true 并透传原文', async () => {
    await expect(copyTextToClipboard('acc_6f3k9d2x')).resolves.toBe(true);
    expect(setString).toHaveBeenCalledWith('acc_6f3k9d2x');
  });

  it('空串不写入并返回 false', async () => {
    await expect(copyTextToClipboard('')).resolves.toBe(false);
    expect(setString).not.toHaveBeenCalled();
  });

  it('原生层抛错时返回 false，不冒泡', async () => {
    setString.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(copyTextToClipboard('x')).resolves.toBe(false);
  });
});
