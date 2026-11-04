import { Keyboard, Platform } from 'react-native';

/**
 * 抽屉键盘与焦点清理门面：
 * 抽屉在关闭触发（或手势开始关闭/失焦/取消搜索）时调用，
 * 彻底收起软键盘并清空 active 焦点，严禁将 focus 转移给主界面。
 */
export function dismissKeyboardAndBlur(): void {
  Keyboard.dismiss();
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const active = document.activeElement as { blur?: () => void } | null;
    if (active && typeof active.blur === 'function') {
      active.blur();
    }
  }
}
