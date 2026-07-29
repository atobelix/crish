import { sessionListDisplayTitle } from '../../api/sessionTitle';

export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 360;
export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_RESIZE_STEP = 12;
export const SIDEBAR_RESIZE_STEP_LARGE = 24;

export const SIDEBAR_LIST_PREFS_KEY = 'crish_sidebar_list_prefs';
/** 侧栏分区折叠状态（pinned / general / projects / 各 projectId） */
export const SIDEBAR_SECTIONS_KEY = 'crish_sidebar_sections_v1';

export type SortType = 'active' | 'name';
export type GroupType = 'folder' | 'none';
export type FilterType = 'all' | 'pinned';

export interface SidebarListPrefs {
  sortType: SortType;
  groupType: GroupType;
  filterType: FilterType;
}

export interface SidebarSectionsState {
  pinned: boolean;
  general: boolean;
  projects: boolean;
  projectIds: Record<string, boolean>;
}

export const DEFAULT_LIST_PREFS: SidebarListPrefs = {
  sortType: 'active',
  groupType: 'folder',
  filterType: 'all',
};

export const DEFAULT_SECTIONS_STATE: SidebarSectionsState = {
  pinned: false,
  general: false,
  projects: false,
  projectIds: {},
};

export function loadSidebarListPrefs(): SidebarListPrefs {
  try {
    const raw = localStorage.getItem(SIDEBAR_LIST_PREFS_KEY);
    if (!raw) return { ...DEFAULT_LIST_PREFS };
    const parsed = JSON.parse(raw) as Partial<SidebarListPrefs>;
    return {
      sortType:
        parsed.sortType === 'name' || parsed.sortType === 'active'
          ? parsed.sortType
          : DEFAULT_LIST_PREFS.sortType,
      groupType:
        parsed.groupType === 'none' || parsed.groupType === 'folder'
          ? parsed.groupType
          : DEFAULT_LIST_PREFS.groupType,
      filterType:
        parsed.filterType === 'pinned' || parsed.filterType === 'all'
          ? parsed.filterType
          : DEFAULT_LIST_PREFS.filterType,
    };
  } catch {
    return { ...DEFAULT_LIST_PREFS };
  }
}

export function loadSidebarSectionsState(): SidebarSectionsState {
  try {
    const raw = localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    if (!raw) return { ...DEFAULT_SECTIONS_STATE, projectIds: {} };
    const parsed = JSON.parse(raw) as Partial<SidebarSectionsState>;
    const projectIds =
      parsed.projectIds &&
      typeof parsed.projectIds === 'object' &&
      !Array.isArray(parsed.projectIds)
        ? (parsed.projectIds as Record<string, boolean>)
        : {};
    return {
      pinned: Boolean(parsed.pinned),
      general: Boolean(parsed.general),
      projects: Boolean(parsed.projects),
      projectIds,
    };
  } catch {
    return { ...DEFAULT_SECTIONS_STATE, projectIds: {} };
  }
}

export function saveSidebarSectionsState(state: SidebarSectionsState): void {
  try {
    localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

export function openSessionInNewWindow(session: {
  title?: string;
  messages?: Array<{
    sender?: string;
    text?: string;
    status?: string;
    toolCalls?: Array<{ name?: string; status?: string; output?: string }>;
  }>;
}): void {
  const w = window.open(
    '',
    '_blank',
    'noopener,noreferrer,width=960,height=800'
  );
  if (!w) return;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const title = sessionListDisplayTitle(session);
  const lines: string[] = [];
  lines.push(`<h1>${esc(title)}</h1>`);
  lines.push(
    `<p class="meta">会话只读快照 · ${esc(String(session.messages?.length || 0))} 条消息</p>`
  );
  for (const m of session.messages || []) {
    if (m.sender === 'user') {
      lines.push(`<div class="u">${esc(m.text || '')}</div>`);
    } else {
      lines.push(
        `<div class="a">${esc(m.text || (m.status === 'processing' ? '生成中…' : ''))}</div>`
      );
      for (const tc of m.toolCalls || []) {
        lines.push(
          `<div class="t"><b>${esc(tc.name || 'tool')}</b> ${esc(tc.status || '')}<pre>${esc(
            (tc.output || '').slice(0, 2000)
          )}</pre></div>`
        );
      }
    }
  }
  if (!(session.messages && session.messages.length)) {
    lines.push('<p class="meta">（暂无消息）</p>');
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;padding:20px;max-width:800px;margin:0 auto;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 8px}.meta{color:#888;font-size:12px;margin:0 0 20px}
.u{background:#e8eef8;padding:10px 12px;border-radius:12px;margin:10px 0 10px auto;max-width:85%;width:fit-content;white-space:pre-wrap}
.a{background:#fff;border:1px solid #eee;padding:10px 12px;border-radius:12px;margin:10px 0;white-space:pre-wrap}
.t{font-size:12px;color:#666;margin:6px 0 6px 8px}pre{white-space:pre-wrap;font-size:11px;background:#f4f4f5;padding:8px;border-radius:6px}
</style></head><body>${lines.join('\n')}</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const revoke = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };
  try {
    w.addEventListener('load', revoke, { once: true });
  } catch {
    /* ignore */
  }
  w.location.href = url;
  window.setTimeout(revoke, 60_000);
}
