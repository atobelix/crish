import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
    },
    configurable: true,
  });
});

import {
  agentProfilesPromptHint,
  defaultAgentProfiles,
  loadAgentProfiles,
  saveAgentProfiles,
} from './agentProfiles';

describe('agentProfiles', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads defaults when empty', () => {
    const list = loadAgentProfiles();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some((p) => p.mode === 'research')).toBe(true);
  });

  it('persists custom profiles', () => {
    saveAgentProfiles([
      { id: 'x', name: '自定义', mode: 'verify', hint: '只做验证' },
    ]);
    const list = loadAgentProfiles();
    expect(list).toHaveLength(1);
    expect(list![0]!.name).toBe('自定义');
  });

  it('prompt hint tells model to use run_subagent', () => {
    const hint = agentProfilesPromptHint(defaultAgentProfiles());
    expect(hint).toContain('run_subagent');
    expect(hint).toContain('调研');
  });
});
