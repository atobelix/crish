import { useLayoutStore } from './layoutStore';
import { useSessionStore } from './sessionStore';
import { useWorkspaceStore } from './workspaceStore';

export function checkStoreConsistency(): string[] {
  const issues: string[] = [];
  const layout = useLayoutStore.getState();
  const session = useSessionStore.getState();
  const workspace = useWorkspaceStore.getState();

  if ('permissionMode' in session) {
    issues.push('permissionMode found in sessionStore; should only live in layoutStore');
  }
  if ('permissionMode' in workspace) {
    issues.push('permissionMode found in workspaceStore; should only live in layoutStore');
  }

  if (session.activeSessionId && !session.sessionsById[session.activeSessionId]) {
    issues.push('activeSessionId points to a session that does not exist in sessionsById');
  }

  if (layout.activeSessionId && !layout.sessionsById[layout.activeSessionId]) {
    issues.push('layout activeSessionId points to a session that does not exist in sessionsById');
  }

  const wi = layout.activeWorkspaceIndex;
  if (wi < 0 || wi >= layout.workspaces.length) {
    issues.push(`activeWorkspaceIndex ${wi} is out of bounds (workspaces length ${layout.workspaces.length})`);
  }

  if (layout.terminalBySession) {
    for (const sid of Object.keys(layout.terminalBySession)) {
      if (!layout.sessionsById[sid]) {
        issues.push(`terminalBySession has orphaned key "${sid}" with no matching session`);
      }
    }
  }

  if (session.terminalBySession) {
    for (const sid of Object.keys(session.terminalBySession)) {
      if (!session.sessionsById[sid]) {
        issues.push(`session terminalBySession has orphaned key "${sid}"`);
      }
    }
  }

  const sessionsSet = new Set(layout.sessions.map((s) => s.id));
  const byIdKeys = Object.keys(layout.sessionsById);
  for (const key of byIdKeys) {
    if (!sessionsSet.has(key)) {
      issues.push(`sessionsById has key "${key}" not present in sessions array`);
    }
  }
  for (const s of layout.sessions) {
    if (s.id && !layout.sessionsById[s.id]) {
      issues.push(`session "${s.id}" exists in sessions array but not in sessionsById`);
    }
  }

  return issues;
}
