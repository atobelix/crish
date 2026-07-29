import { isTauriShellFast } from '../createSsrGlobals';

export type PlatformLevel = 0 | 1 | 2 | 3;

export interface PlatformInfo {
  level: PlatformLevel;
  hardwareReady: boolean;
  memoryMB: number;
  cores: number;
  isMobile: boolean;
  isTauri: boolean;
}

let info: PlatformInfo = {
  level: 2,
  hardwareReady: false,
  memoryMB: 2048,
  cores: navigator.hardwareConcurrency || 4,
  isMobile: false,
  isTauri: isTauriShellFast(),
};

export function getPlatformInfo(): PlatformInfo {
  return info;
}

export async function detectPlatform(): Promise<PlatformInfo> {
  try {
    const mem = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);

    let level: PlatformLevel = 2;
    if (isMobile || (mem <= 2 && cores <= 4)) level = 0;
    else if (mem <= 4 && cores <= 4) level = 1;
    else if (mem >= 8 && cores >= 8) level = 3;

    info = {
      level,
      hardwareReady: true,
      memoryMB: mem * 1024,
      cores,
      isMobile,
      isTauri: isTauriShellFast(),
    };
  } catch {
    info.hardwareReady = true;
  }

  return info;
}
