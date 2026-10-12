/**
 * 设置运行时层（拆自 clientApi.ts）：localStorage 持久化 + clientApi 方法对象。
 * 依赖 clientApiNormalize（纯规范化）与 clientApi.types（类型契约）。
 */

import {
  parseSettingsJson,
  normalizeSettingsPartial,
  normalizeSettingsPayload,
  deepMergeSettings,
  getDefaultSettings,
  DEFAULT_SETTINGS,
} from './clientApiNormalize';
import type { Settings } from './clientApi.types';

// LocalStorage Keys (settings only)
const SETTINGS_KEY = 'crish_settings';

function lsGet(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
  } catch {
    /* ignore */
  }
  return null;
}

const initSettingsDb = () => {
  if (typeof localStorage === 'undefined') return;
  if (!lsGet(SETTINGS_KEY)) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
    } catch {
      /* ignore */
    }
  }
};

/**
 * 设置写入锁：优先用 Web Locks API（navigator.locks）实现真正的跨窗口互斥。
 * Tauri 多窗口各自有独立 JS 上下文，进程内变量不共享——
 * 旧实现两窗口同时 saveSettings 会产生 write-after-write 竞态。
 * navigator.locks 在同源所有 webview 间提供 OS 级互斥，是最干净的方案。
 * 降级：旧环境无 navigator.locks 时退化为进程内标志（仍有竞态，但至少单窗口顺序）。
 */
const SETTINGS_LOCK_NAME = 'crish-settings-write';
const SETTINGS_LOCK_TIMEOUT_MS = 2_000;

let isWritingSettings = false;

async function withSettingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // Web Locks API：跨窗口互斥，自动排队，finally 释放
    return new Promise<T>((resolve, reject) => {
      navigator.locks.request(
        SETTINGS_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: false },
        async (lock) => {
          if (!lock) {
            // 未获取锁（不应发生在 ifAvailable:false 模式，但兜底）
            try {
              return resolve(await fn());
            } catch (e) {
              return reject(e);
            }
          }
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }
  // 降级：进程内标志 + 超时
  const deadline = Date.now() + SETTINGS_LOCK_TIMEOUT_MS;
  while (isWritingSettings && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  isWritingSettings = true;
  try {
    return await fn();
  } finally {
    isWritingSettings = false;
  }
}

/**
 * Project-scoped settings key. Opening a project means the user chose that
 * directory — no separate "trust this folder" gate.
 */
function projectSettingsKey(cwd: string): string {
  const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
  return `crish_project_settings_${normalizedCwd}`;
}

export const clientApi = {
  // ── Settings（正式路径）────────────────────────────────────────────────

  getSettings: async (): Promise<Settings> => {
    let cwd = '';
    try {
      cwd = localStorage.getItem('crish_workspace') || '';
    } catch {
      cwd = '';
    }
    return clientApi.getSettingsEx(cwd || '__global__');
  },

  updateSettings: async (updates: Partial<Settings>): Promise<Settings> => {
    return clientApi.saveSettingsEx('__global__', 'global', updates);
  },

  /**
   * 仅读项目局部设置（不合并全局）。用于规则/技能等「按具体项目」编辑，
   * 避免 getSettingsEx 合并后把全局 customRules 误显示成项目规则。
   */
  getProjectSettingsPartial: async (
    cwd: string
  ): Promise<Partial<Settings>> => {
    initSettingsDb();
    if (!cwd || cwd === '__global__') return {};
    const projectSettingsStr = localStorage.getItem(projectSettingsKey(cwd));
    if (!projectSettingsStr) return {};
    const parsed = parseSettingsJson(projectSettingsStr);
    if (!parsed) return {};
    return normalizeSettingsPartial(parsed);
  },

  getSettingsEx: async (cwd: string): Promise<Settings> => {
    initSettingsDb();
    // localStorage 是同步 API，无需人为延迟。
    // 旧实现的 20ms 延迟是「模拟异步 IO」遗留，会让设置页每次 tab 切换累计延迟。
    // 始终以 DEFAULT 为底再叠存储 + 字段规范化，避免旧 LS 缺键 / 脏枚举
    let globalSettings: Settings = getDefaultSettings();
    const raw = lsGet(SETTINGS_KEY);
    if (raw) {
      const parsed = parseSettingsJson(raw);
      if (parsed) {
        globalSettings = normalizeSettingsPayload(parsed);
      } else {
        // 损坏 / 非对象 JSON：先备份原值再回退默认，避免静默丢弃用户设置。
        // 旧实现直接覆盖，用户损坏的设置无任何恢复途径。
        try {
          const rawStr = typeof raw === 'string' ? raw : '';
          if (rawStr) {
            localStorage.setItem(
              `${SETTINGS_KEY}__corrupt_backup_${Date.now()}`,
              rawStr
            );
          }
          localStorage.setItem(
            SETTINGS_KEY,
            JSON.stringify(getDefaultSettings())
          );
        } catch {
          /* ignore */
        }
        globalSettings = getDefaultSettings();
      }
    }

    if (!cwd || cwd === '__global__') {
      return globalSettings;
    }

    const projectSettingsStr = localStorage.getItem(projectSettingsKey(cwd));
    if (!projectSettingsStr) {
      return globalSettings;
    }

    const projectPartial = parseSettingsJson(projectSettingsStr);
    if (!projectPartial) {
      return globalSettings;
    }
    return normalizeSettingsPayload(
      deepMergeSettings(
        globalSettings,
        normalizeSettingsPartial(projectPartial)
      )
    );
  },

  saveSettingsEx: async (
    cwd: string,
    scope: 'global' | 'project',
    updates: Partial<Settings>
  ): Promise<Settings> => {
    initSettingsDb();
    return withSettingsWriteLock(async () => {
      const safeUpdates = normalizeSettingsPartial(updates);

      if (scope === 'global') {
        let current: Settings = getDefaultSettings();
        const raw = lsGet(SETTINGS_KEY);
        if (raw) {
          const parsed = parseSettingsJson(raw);
          if (parsed) {
            current = normalizeSettingsPayload(parsed);
          }
        }
        const merged = normalizeSettingsPayload(
          deepMergeSettings(current, safeUpdates)
        );
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
      } else {
        const projKey = projectSettingsKey(cwd);
        const currentStr = localStorage.getItem(projKey);
        let current: Record<string, unknown> = {};
        const parsedProj = parseSettingsJson(currentStr);
        if (parsedProj) {
          current = { ...parsedProj } as Record<string, unknown>;
        }
        const merged = normalizeSettingsPartial(
          deepMergeSettings(current, safeUpdates)
        );
        localStorage.setItem(projKey, JSON.stringify(merged));

        let globalSettings: Settings = getDefaultSettings();
        const raw = lsGet(SETTINGS_KEY);
        if (raw) {
          const parsed = parseSettingsJson(raw);
          if (parsed) {
            globalSettings = normalizeSettingsPayload(parsed);
          }
        }
        return normalizeSettingsPayload(
          deepMergeSettings(globalSettings, merged)
        );
      }
    });
  },

  // ── Telemetry：正式 no-op ───────────────────────

  subscribeTelemetry: (
    _onData: (data: import('../store/layoutStore').TelemetrySyncPayload) => void
  ): (() => void) => {
    return () => undefined;
  },
};
