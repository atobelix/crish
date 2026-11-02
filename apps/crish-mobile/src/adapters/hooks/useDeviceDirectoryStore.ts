// 已知设备目录 store React 订阅面（G4）。
import { useStore } from 'zustand';
import { deviceDirectoryStore } from '@/domain/store/deviceDirectoryStore';

export function useDeviceDirectoryStore<T>(
  selector: (state: ReturnType<typeof deviceDirectoryStore.getState>) => T
): T {
  return useStore(deviceDirectoryStore, selector);
}
