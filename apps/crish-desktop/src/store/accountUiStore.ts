/**
 * 账号界面 UI 状态：
 * - loginOpen：登录弹窗（仅登录前流程）开关，由设置「账户」分区的「登录」按钮打开；
 * - view：设置「账户」分区的子视图（概览 / 修改密码），面包屑与 Esc 返回据此联动。
 * 登录后的账号管理全部在设置弹窗内完成，主界面不再浮出账号弹窗。
 */
import { create } from 'zustand';

export type AccountView = 'overview' | 'changePassword';

interface AccountUiState {
  loginOpen: boolean;
  view: AccountView;
  openLogin: () => void;
  closeLogin: () => void;
  setView: (view: AccountView) => void;
}

export const useAccountUiStore = create<AccountUiState>((set) => ({
  loginOpen: false,
  view: 'overview',
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),
  setView: (view) => set({ view }),
}));
