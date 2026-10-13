/**
 * 运行期本地临时缓存与非偏好状态统一管理层 (Runtime Local Cache & Non-Preference State Storage)
 *
 * 职责边界：
 * 1. 集中管理运行期临时缓存（如 workflows, mcp, skills, font scan）与本地草稿/状态（emergency drafts, wizard state, plugin state），
 *    彻底消除 UI 组件层裸写 localStorage.setItem 的违规；
 * 2. 提供带生命周期清理（TTL 自动淘汰、Quota 超限主动驱逐过期项）的封装；
 * 3. 严格区分偏好数据（走 SQLite preferencesClient）与运行期临时缓存/草稿（本层）。
 */

import {
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  safeGetJson,
  safeSetJson,
} from '../localStorageApi';
import type { WorkflowDefinition, WorkflowRunEntry } from '../workflowApi';
import type { McpServerInfo } from '../mcpApi';
import type { DesktopSkill } from '../skillsApi';

/** 统一运行期存储 Key 定义 */
export const RUNTIME_CACHE_KEYS = {
  FONT_SCAN: 'crish_local_fonts_cache_v1',
  WORKFLOWS: 'crish_workflows_cache_v1',
  WORKFLOW_RUNS: 'crish_workflow_runs_cache_v1',
  MCP_SERVERS: 'crish_mcp_servers_cache_v1',
  SKILLS: 'crish_skills_cache_v1',
  FIRST_RUN_DONE: 'crish_first_run_done_v1',
  SHOW_ONBOARDING_ON_STARTUP: 'crish_show_onboarding_on_startup_v1',
  PLUGIN_ENABLED: 'crish_plugin_enabled_v1',
  SKILL_KNOWN_IDS: 'crish_skill_known_ids_v1',
  NOTE_EMERGENCY_DRAFT_PREFIX: 'crish_note_emergency_draft_',
  SIDEBAR_SECTIONS: 'crish_sidebar_sections_v1',
  SIDEBAR_LIST_PREFS: 'crish_sidebar_list_prefs',
} as const;

export interface CacheEnvelope<T> {
  __crish_cache__: true;
  v: number;
  t: number;
  ttl?: number;
  data: T;
}

/** 字体扫描缓存格式（对齐存量结构与单测约定） */
export interface CompressedFontCache {
  v: 1;
  t: number;
  f: string[];
}

export const FONT_CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 扫描并清理所有带有 TTL 且已过期的运行时缓存条目。
 * 可在启动时调用，或在写操作触发 QuotaExceededError 时主动触发清理。
 */
export function pruneExpiredRuntimeCache(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToPrune: string[] = [];
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith('crish_')) {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          if (raw.includes('"__crish_cache__":true')) {
            const parsed = JSON.parse(raw) as CacheEnvelope<unknown>;
            if (parsed.ttl && now - parsed.t > parsed.ttl) {
              keysToPrune.push(key);
            }
          } else if (key === RUNTIME_CACHE_KEYS.FONT_SCAN) {
            const parsed = JSON.parse(raw) as CompressedFontCache;
            if (parsed && parsed.t && now - parsed.t > FONT_CACHE_EXPIRY_MS) {
              keysToPrune.push(key);
            }
          }
        } catch {
          /* ignore json parse failure */
        }
      }
    }
    for (const k of keysToPrune) {
      safeRemoveItem(k);
    }
  } catch {
    /* ignore storage access failure */
  }
}

/**
 * 带生命周期的通用运行时缓存写入。
 * 写入失败时自动尝试触发过期缓存驱逐后重试。
 */
export function setRuntimeCache<T>(
  key: string,
  data: T,
  options?: { ttlMs?: number; version?: number }
): void {
  const envelope: CacheEnvelope<T> = {
    __crish_cache__: true,
    v: options?.version ?? 1,
    t: Date.now(),
    ttl: options?.ttlMs,
    data,
  };
  try {
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    pruneExpiredRuntimeCache();
    try {
      localStorage.setItem(key, JSON.stringify(envelope));
    } catch {
      /* swallow: quota 超限回退静默，不阻断主流程 */
    }
  }
}

/**
 * 通用运行时缓存读取。
 * 支持 TTL 过期自动删除与向后兼容非 envelope 纯数据。
 */
export function getRuntimeCache<T>(key: string, fallback: T): T {
  const raw = safeGetItem(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.__crish_cache__ === true
    ) {
      const envelope = parsed as CacheEnvelope<T>;
      if (envelope.ttl && Date.now() - envelope.t > envelope.ttl) {
        safeRemoveItem(key);
        return fallback;
      }
      return envelope.data;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function removeRuntimeCache(key: string): void {
  safeRemoveItem(key);
}

// ── 领域专用收敛方法（类型安全且集中） ────────────────────────────────────────

// 1. 字体扫描瘦身缓存
export function readFontScanCache(): { family: string }[] | null {
  const raw = safeGetItem(RUNTIME_CACHE_KEYS.FONT_SCAN);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CompressedFontCache;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.f)) return null;
    if (Date.now() - parsed.t > FONT_CACHE_EXPIRY_MS) {
      safeRemoveItem(RUNTIME_CACHE_KEYS.FONT_SCAN);
      return null;
    }
    return parsed.f.map((fam) => ({ family: fam }));
  } catch {
    return null;
  }
}

export function writeFontScanCache(fonts: { family: string }[]): void {
  const payload: CompressedFontCache = {
    v: 1,
    t: Date.now(),
    f: fonts.map((f) => f.family),
  };
  try {
    safeSetJson(RUNTIME_CACHE_KEYS.FONT_SCAN, payload);
  } catch {
    safeRemoveItem(RUNTIME_CACHE_KEYS.FONT_SCAN);
  }
}

export function clearFontScanCache(): void {
  safeRemoveItem(RUNTIME_CACHE_KEYS.FONT_SCAN);
}

// 2. 工作流定义与运行记录缓存
export function readWorkflowsCache(): WorkflowDefinition[] {
  const res = safeGetJson<WorkflowDefinition[]>(
    RUNTIME_CACHE_KEYS.WORKFLOWS,
    []
  );
  return Array.isArray(res) ? res : [];
}

export function writeWorkflowsCache(list: WorkflowDefinition[]): void {
  safeSetJson(RUNTIME_CACHE_KEYS.WORKFLOWS, list);
}

export function readWorkflowRunsCache(): WorkflowRunEntry[] {
  const res = safeGetJson<WorkflowRunEntry[]>(
    RUNTIME_CACHE_KEYS.WORKFLOW_RUNS,
    []
  );
  return Array.isArray(res) ? res : [];
}

export function writeWorkflowRunsCache(list: WorkflowRunEntry[]): void {
  safeSetJson(RUNTIME_CACHE_KEYS.WORKFLOW_RUNS, list);
}

// 3. MCP 服务列表缓存
export function readMcpServersCache(): McpServerInfo[] {
  const res = safeGetJson<McpServerInfo[]>(RUNTIME_CACHE_KEYS.MCP_SERVERS, []);
  return Array.isArray(res) ? res : [];
}

export function writeMcpServersCache(list: McpServerInfo[]): void {
  safeSetJson(RUNTIME_CACHE_KEYS.MCP_SERVERS, list);
}

// 4. Skills 技能列表缓存
export function readSkillsCache(): DesktopSkill[] {
  const res = safeGetJson<DesktopSkill[]>(RUNTIME_CACHE_KEYS.SKILLS, []);
  return Array.isArray(res) ? res : [];
}

export function writeSkillsCache(list: DesktopSkill[]): void {
  safeSetJson(RUNTIME_CACHE_KEYS.SKILLS, list);
}

// 5. 首次运行向导状态与启动显示开关
export function readFirstRunWizardDone(): boolean {
  try {
    return safeGetItem(RUNTIME_CACHE_KEYS.FIRST_RUN_DONE) === '1';
  } catch {
    return true;
  }
}

export function writeFirstRunWizardDone(): void {
  safeSetItem(RUNTIME_CACHE_KEYS.FIRST_RUN_DONE, '1');
}

export function clearFirstRunWizardDone(): void {
  safeRemoveItem(RUNTIME_CACHE_KEYS.FIRST_RUN_DONE);
}

export function readShowOnboardingOnStartup(): boolean {
  try {
    return safeGetItem(RUNTIME_CACHE_KEYS.SHOW_ONBOARDING_ON_STARTUP) === '1';
  } catch {
    return false;
  }
}

export function writeShowOnboardingOnStartup(enabled: boolean): void {
  if (enabled) {
    safeSetItem(RUNTIME_CACHE_KEYS.SHOW_ONBOARDING_ON_STARTUP, '1');
  } else {
    safeRemoveItem(RUNTIME_CACHE_KEYS.SHOW_ONBOARDING_ON_STARTUP);
  }
}

// 6. 插件启用清单（启停状态）
export function readPluginEnabledIds(): Set<string> {
  const arr = safeGetJson<string[]>(RUNTIME_CACHE_KEYS.PLUGIN_ENABLED, []);
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr.map(String).filter(Boolean));
}

export function writePluginEnabledIds(ids: Set<string>): void {
  safeSetJson(RUNTIME_CACHE_KEYS.PLUGIN_ENABLED, [...ids]);
}

// 7. 已知技能 ID 清单
export function readSkillKnownIds(): Set<string> {
  const arr = safeGetJson<unknown>(RUNTIME_CACHE_KEYS.SKILL_KNOWN_IDS, []);
  return new Set(Array.isArray(arr) ? arr.map(String) : []);
}

export function writeSkillKnownIds(ids: Set<string>): void {
  safeSetJson(RUNTIME_CACHE_KEYS.SKILL_KNOWN_IDS, [...ids]);
}

// 8. 笔记应急草稿本地抢救暂存
export interface EmergencyDraftPayload {
  docId: string;
  drafts: Record<string, string>;
  savedAt: number;
}

export function readEmergencyDraft(
  docId: string
): Record<string, string> | null {
  const key = `${RUNTIME_CACHE_KEYS.NOTE_EMERGENCY_DRAFT_PREFIX}${docId}`;
  const payload = safeGetJson<EmergencyDraftPayload | null>(key, null);
  return payload?.drafts ?? null;
}

export function writeEmergencyDraft(
  docId: string,
  drafts: Record<string, string>
): void {
  const key = `${RUNTIME_CACHE_KEYS.NOTE_EMERGENCY_DRAFT_PREFIX}${docId}`;
  if (Object.keys(drafts).length === 0) {
    safeRemoveItem(key);
  } else {
    safeSetJson(key, { docId, drafts, savedAt: Date.now() });
  }
}

export function removeEmergencyDraft(docId: string): void {
  const key = `${RUNTIME_CACHE_KEYS.NOTE_EMERGENCY_DRAFT_PREFIX}${docId}`;
  safeRemoveItem(key);
}

// 9. 侧边栏分区折叠状态缓存
export function readSidebarSectionsCache<T>(fallback: T): T {
  return safeGetJson<T>(RUNTIME_CACHE_KEYS.SIDEBAR_SECTIONS, fallback);
}

export function writeSidebarSectionsCache<T>(state: T): void {
  safeSetJson(RUNTIME_CACHE_KEYS.SIDEBAR_SECTIONS, state);
}

// 10. 侧边栏列表偏好缓存（排序、分组、筛选）
export function readSidebarListPrefsCache<T>(fallback: T): T {
  return safeGetJson<T>(RUNTIME_CACHE_KEYS.SIDEBAR_LIST_PREFS, fallback);
}

export function writeSidebarListPrefsCache<T>(prefs: T): void {
  safeSetJson(RUNTIME_CACHE_KEYS.SIDEBAR_LIST_PREFS, prefs);
}
