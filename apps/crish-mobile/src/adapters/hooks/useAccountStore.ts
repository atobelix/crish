// 账号 store React 订阅面。
import { useStore } from 'zustand';
import { accountStore } from '@/domain/store/accountStore';

export function useAccountStore<T>(
  selector: (state: ReturnType<typeof accountStore.getState>) => T
): T {
  return useStore(accountStore, selector);
}
