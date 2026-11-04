// 软键盘高度订阅（0 = 收起）。
// 单源纪律（键盘审计 §4.2）：全仓唯一的键盘高度/状态生产者是根布局挂载的
// KeyboardProvider（react-native-keyboard-controller）；本 hook 只是对它的
// 只读投影，禁止再接 RN Keyboard 事件另起第二套高度来源——历史上主页与
// ApprovalFloat 各写一套事件补偿正是双源苗头。需要逐帧动画值的场景走库的
// 动画面（KeyboardStickyView / useKeyboardHandler），不要经本 hook 中转。
import { useKeyboardState } from 'react-native-keyboard-controller';

export function useKeyboardHeight(): number {
  return useKeyboardState((state) => (state.isVisible ? state.height : 0));
}
