import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: async () => true,
    isVisible: async () => true,
    isMinimized: async () => false,
    show: async () => undefined,
    unminimize: async () => undefined,
    setFocus: async () => undefined,
  }),
}));

const actionCallbacks: Array<(event: unknown) => void> = [];
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: () => undefined,
  onAction: async (cb: (event: unknown) => void) => {
    actionCallbacks.push(cb);
    return { unregister: async () => undefined };
  },
}));

vi.mock('../api/preferences/preferencesClient', () => ({
  getPreference: async () => true,
}));
vi.mock('../api/uiEvents', () => ({ emitUiEvent: () => undefined }));
vi.mock('./LoggerService', () => ({
  logger: {
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  },
}));
vi.mock('../store/sessionStore', () => ({
  getActiveSessionId: () => '',
}));
vi.mock('./toast/ToastStore', () => ({
  ToastStore: { show: () => 'toast-x', dismiss: () => undefined },
}));

import {
  DesktopNotificationService,
  type DesktopNotificationDeps,
  type DesktopNotificationRequest,
} from './DesktopNotificationService';

function fakeDeps(overrides: Partial<DesktopNotificationDeps> = {}) {
  const sent: Array<{ req: DesktopNotificationRequest; id: number }> = [];
  const clicked: Array<string | undefined> = [];
  const presented: DesktopNotificationRequest[] = [];
  const dismissed: string[] = [];
  let presentSeq = 0;
  const deps: DesktopNotificationDeps = {
    isMasterEnabled: async () => true,
    isCompletionEnabled: async () => true,
    probeUserWatching: async () => false,
    // 缺省：用户正在看 s1（与下方 req 的 sessionId 对齐，聚焦即亲见）
    probeActiveSessionId: () => 's1',
    ensurePermission: async () => true,
    send: async (req, id) => {
      sent.push({ req, id });
    },
    presentInApp: (req) => {
      presented.push(req);
      presentSeq += 1;
      return `inapp-${presentSeq}`;
    },
    dismissInApp: (entryId) => {
      dismissed.push(entryId);
    },
    onClicked: (sessionId) => {
      clicked.push(sessionId);
    },
    ...overrides,
  };
  return { deps, sent, clicked, presented, dismissed };
}

const completionReq: DesktopNotificationRequest = {
  category: 'completion',
  dedupeKey: 'run:r1:completed',
  title: '任务已完成',
  body: '',
  sessionId: 's1',
};
const failureReq: DesktopNotificationRequest = {
  category: 'failure',
  dedupeKey: 'run:r1:failed',
  title: '任务运行失败',
  body: 'boom',
  sessionId: 's1',
};
const approvalReq: DesktopNotificationRequest = {
  category: 'approval',
  dedupeKey: 'approval:tc1',
  title: 'Crish 需要你的批准',
  body: 'bash',
  sessionId: 's1',
};

describe('DesktopNotificationService gates', () => {
  it('sends completion when all gates pass', async () => {
    const { deps, sent } = fakeDeps();
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notify(completionReq)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.req.dedupeKey).toBe('run:r1:completed');
  });

  it('never sends scheduled category (desktop default off)', async () => {
    const { deps, sent } = fakeDeps();
    const svc = new DesktopNotificationService(deps);
    await expect(
      svc.notify({
        ...completionReq,
        category: 'scheduled',
        dedupeKey: 'sch:1',
      })
    ).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('master switch vetoes every category including failure/approval', async () => {
    const { deps, sent } = fakeDeps({ isMasterEnabled: async () => false });
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notify(failureReq)).resolves.toBe(false);
    await expect(svc.notify(approvalReq)).resolves.toBe(false);
    await expect(svc.notify(completionReq)).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('completion switch blocks completion only; failure/approval stay always-on', async () => {
    const { deps, sent } = fakeDeps({
      isCompletionEnabled: async () => false,
    });
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notify(completionReq)).resolves.toBe(false);
    await expect(svc.notify(failureReq)).resolves.toBe(true);
    await expect(svc.notify(approvalReq)).resolves.toBe(true);
    expect(sent.map((s) => s.req.category)).toEqual(['failure', 'approval']);
  });

  it('dedupes by business key: same terminal state only sends once', async () => {
    const { deps, sent } = fakeDeps();
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notify(failureReq)).resolves.toBe(true);
    await expect(svc.notify(failureReq)).resolves.toBe(false);
    await expect(svc.notify(completionReq)).resolves.toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('permission denied blocks sending', async () => {
    const { deps, sent } = fakeDeps({ ensurePermission: async () => false });
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notify(failureReq)).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('click routes to the session from extra payload or id map', async () => {
    const { deps, clicked } = fakeDeps();
    const svc = new DesktopNotificationService(deps);
    await svc.initClickHandling();
    expect(actionCallbacks).toHaveLength(1);
    await svc.notify(completionReq);
    const cb = actionCallbacks[0];
    if (!cb) throw new Error('onAction callback not registered');
    // extra.sessionId 直达
    cb({ notification: { id: 999, extra: { sessionId: 's-extra' } } });
    expect(clicked).toEqual(['s-extra']);
    // 无 extra 时按发送 id 映射回查
    cb({ notification: { id: 1, extra: {} } });
    expect(clicked).toEqual(['s-extra', 's1']);
  });
});

describe('DesktopNotificationService 前台三岔（批 C 第 1 件）', () => {
  it('聚焦且正在看该会话 → 静默亲见：不发 OS、不呈现应用内', async () => {
    const { deps, sent, presented } = fakeDeps({
      probeUserWatching: async () => true,
      probeActiveSessionId: () => 's1',
    });
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notifyRouted(failureReq)).resolves.toBe('silent-viewing');
    await expect(svc.notify(approvalReq)).resolves.toBe(false);
    expect(sent).toHaveLength(0);
    expect(presented).toHaveLength(0);
  });

  it('静默亲见按业务键记已达：事后失焦也不补发同一终态', async () => {
    let watching = true;
    const { deps, sent } = fakeDeps({
      probeUserWatching: async () => watching,
      probeActiveSessionId: () => 's1',
    });
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notify(failureReq)).resolves.toBe(false);
    watching = false;
    await expect(svc.notify(failureReq)).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('聚焦但不在该会话 → 应用内呈现（不走 OS）', async () => {
    const { deps, sent, presented } = fakeDeps({
      probeUserWatching: async () => true,
      probeActiveSessionId: () => 'other-session',
    });
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notifyRouted(failureReq)).resolves.toBe('presented');
    expect(presented).toEqual([failureReq]);
    expect(sent).toHaveLength(0);
    // 应用内已达同样去重：再来一次同键不再呈现
    await expect(svc.notify(failureReq)).resolves.toBe(false);
    expect(presented).toHaveLength(1);
  });

  it('聚焦且事件无会话归属 → 应用内呈现', async () => {
    const { deps, presented } = fakeDeps({
      probeUserWatching: async () => true,
      probeActiveSessionId: () => 's1',
    });
    const svc = new DesktopNotificationService(deps);
    const sessionless: DesktopNotificationRequest = {
      category: 'failure',
      dedupeKey: 'task:t9:failed',
      title: '后台任务失败',
      body: 'npm run build',
    };
    await expect(svc.notifyRouted(sessionless)).resolves.toBe('presented');
    expect(presented).toEqual([sessionless]);
  });

  it('应用内呈现失败（无条目 id）→ blocked，不回落 OS', async () => {
    const { deps, sent } = fakeDeps({
      probeUserWatching: async () => true,
      probeActiveSessionId: () => 'other-session',
      presentInApp: () => undefined,
    });
    const svc = new DesktopNotificationService(deps);
    await expect(svc.notifyRouted(failureReq)).resolves.toBe('blocked');
    expect(sent).toHaveLength(0);
  });
});

describe('DesktopNotificationService 打开即退休（批 C 第 1 件）', () => {
  it('retireSession 只退休目标会话的应用内条目', async () => {
    const { deps, dismissed } = fakeDeps({
      probeUserWatching: async () => true,
      probeActiveSessionId: () => 'elsewhere',
    });
    const svc = new DesktopNotificationService(deps);
    await svc.notify(failureReq); // s1 → inapp-1
    await svc.notify({ ...failureReq, dedupeKey: 'run:r2:failed' }); // s1 → inapp-2
    await svc.notify({
      ...failureReq,
      dedupeKey: 'run:r3:failed',
      sessionId: 's2',
    }); // s2 → inapp-3
    svc.retireSession('s1');
    expect(dismissed).toEqual(['inapp-1', 'inapp-2']);
    // 重复退休无副作用；s2 条目仍可在其打开时退休
    svc.retireSession('s1');
    expect(dismissed).toHaveLength(2);
    svc.retireSession('s2');
    expect(dismissed).toEqual(['inapp-1', 'inapp-2', 'inapp-3']);
  });

  it('retireSession 清 OS 点击路由映射（迟到点击不再跳已打开会话）', async () => {
    const { deps, clicked } = fakeDeps();
    const svc = new DesktopNotificationService(deps);
    await svc.initClickHandling();
    await svc.notify(completionReq); // OS 发送 id=1 → s1
    svc.retireSession('s1');
    const cb = actionCallbacks[actionCallbacks.length - 1];
    if (!cb) throw new Error('onAction callback not registered');
    cb({ notification: { id: 1, extra: {} } });
    expect(clicked).toEqual([undefined]);
  });

  it('退休不清去重集：同终态退休后仍不重复送达', async () => {
    const { deps, sent, presented } = fakeDeps({
      probeUserWatching: async () => true,
      probeActiveSessionId: () => 'elsewhere',
    });
    const svc = new DesktopNotificationService(deps);
    await svc.notify(failureReq);
    svc.retireSession('s1');
    await expect(svc.notify(failureReq)).resolves.toBe(false);
    expect(presented).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });
});
