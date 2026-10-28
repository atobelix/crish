import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DetectedExternalSession,
  ExternalSessionSourceScan,
} from './types';

const scanMocks = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
}));

vi.mock('./scan', () => ({
  scanClaudeCodeSessions: scanMocks.claude,
  scanCodexSessions: scanMocks.codex,
  combineExternalSessionScans: (scans: ExternalSessionSourceScan[]) => ({
    sessions: scans.flatMap((scan) => scan.sessions),
    issues: scans.flatMap((scan) => scan.issues),
  }),
}));

import {
  getOrScanExternalSessions,
  loadExternalSessionsFromCache,
  saveExternalSessionsToCache,
} from './externalSessionCache';
import { setPersistedClaudeImportRoot } from './importRootSettings';

function sourceScan(
  source: 'claude-code' | 'codex',
  sessions: DetectedExternalSession[],
  issues: ExternalSessionSourceScan['issues'] = []
): ExternalSessionSourceScan {
  return { source, sessions, issues };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('external session scan cache', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    scanMocks.claude.mockResolvedValue(sourceScan('claude-code', []));
    scanMocks.codex.mockResolvedValue(sourceScan('codex', []));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets only the newest overlapping scan update the cached result', async () => {
    const oldScan = deferred<ExternalSessionSourceScan>();
    const newScan = deferred<ExternalSessionSourceScan>();
    scanMocks.claude
      .mockReturnValueOnce(oldScan.promise)
      .mockReturnValueOnce(newScan.promise);

    const oldRequest = getOrScanExternalSessions(true);
    const newRequest = getOrScanExternalSessions(true);
    const newerSession: DetectedExternalSession = {
      id: 'newer',
      source: 'claude-code',
      title: 'Newer scan',
      messageCount: 1,
    };
    const olderSession: DetectedExternalSession = {
      id: 'older',
      source: 'claude-code',
      title: 'Older scan',
      messageCount: 1,
    };

    newScan.resolve(sourceScan('claude-code', [newerSession]));
    await expect(newRequest).resolves.toMatchObject({
      sessions: [newerSession],
    });
    oldScan.resolve(sourceScan('claude-code', [olderSession]));
    await oldRequest;

    expect(loadExternalSessionsFromCache().sessions).toEqual([newerSession]);
  });

  it('does not cache partial scan results', async () => {
    const previousSession: DetectedExternalSession = {
      id: 'previous-complete',
      source: 'claude-code',
      title: 'Previous complete scan',
      messageCount: 2,
    };
    const session: DetectedExternalSession = {
      id: 'partial',
      source: 'claude-code',
      title: 'Partial result',
      messageCount: 1,
    };
    scanMocks.claude.mockResolvedValue(
      sourceScan('claude-code', [previousSession])
    );
    await getOrScanExternalSessions(true);
    expect(loadExternalSessionsFromCache().sessions).toEqual([previousSession]);

    scanMocks.claude.mockResolvedValue(
      sourceScan(
        'claude-code',
        [session],
        [
          {
            source: 'claude-code',
            kind: 'warning',
            message: 'One project could not be read',
          },
        ]
      )
    );

    await expect(getOrScanExternalSessions(true)).resolves.toMatchObject({
      sessions: [session],
      issues: [{ kind: 'warning' }],
    });
    expect(loadExternalSessionsFromCache().sessions).toEqual([]);
  });

  it('does not expose a cache created for a different configured root', async () => {
    const session: DetectedExternalSession = {
      id: 'default-root-session',
      source: 'claude-code',
      title: 'Default root result',
      messageCount: 1,
    };
    scanMocks.claude.mockResolvedValue(sourceScan('claude-code', [session]));

    await getOrScanExternalSessions(true);
    expect(loadExternalSessionsFromCache().sessions).toEqual([session]);

    setPersistedClaudeImportRoot('/custom/claude');
    expect(loadExternalSessionsFromCache().sessions).toEqual([]);
  });

  it('does not expose an expired cached scan as initial importable data', () => {
    const session: DetectedExternalSession = {
      id: 'expired-cache-session',
      source: 'claude-code',
      title: 'Expired cached session',
      messageCount: 1,
    };
    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 11 * 60 * 1000);

    saveExternalSessionsToCache([session]);

    expect(loadExternalSessionsFromCache()).toEqual({
      sessions: [],
      issues: [],
    });
  });

  it('retries with the newly configured roots when paths change during a scan', async () => {
    const oldScan = deferred<ExternalSessionSourceScan>();
    const customRootSession: DetectedExternalSession = {
      id: 'custom-root-session',
      source: 'claude-code',
      title: 'Custom root result',
      messageCount: 1,
    };
    scanMocks.claude
      .mockReturnValueOnce(oldScan.promise)
      .mockResolvedValueOnce(sourceScan('claude-code', [customRootSession]));

    const request = getOrScanExternalSessions(true);
    setPersistedClaudeImportRoot('/custom/claude');
    oldScan.resolve(sourceScan('claude-code', []));

    await expect(request).resolves.toMatchObject({
      sessions: [customRootSession],
      issues: [],
    });
    expect(scanMocks.claude).toHaveBeenNthCalledWith(1, {
      persistedRoots: {},
    });
    expect(scanMocks.claude).toHaveBeenNthCalledWith(2, {
      persistedRoots: { claudeConfigDir: '/custom/claude' },
    });
  });
});
