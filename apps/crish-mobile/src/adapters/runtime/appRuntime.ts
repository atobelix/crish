// 应用运行时装配根：连接生命周期、前后台恢复、解绑清理。
// 页面与 VM 不再各自 ensure 连接单例。
import { AppState, type AppStateStatus } from 'react-native';
import { authStore } from '@/domain/store/authStore';
import { accountStore } from '@/domain/store/accountStore';
import { approvalStore } from '@/domain/store/approvalStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { terminalStore } from '@/domain/store/terminalStore';
import { filesStore } from '@/domain/store/filesStore';
import { notificationStore } from '@/domain/store/notificationStore';
import {
  disposeObservationWiring,
  ensureObservationWiring,
  getObservationWiring,
} from '../wiring/observationWiring';
import {
  disposeApprovalWiring,
  ensureApprovalWiring,
} from '../wiring/approvalWiring';
import {
  startAccountRuntime,
  stopAccountRuntime,
  syncAccountRemote,
} from './accountRuntime';

let started = false;
let appStateSub: { remove: () => void } | null = null;
let authStateUnsub: (() => void) | null = null;

/** 唤醒即时探活阈值：前台恢复时距上次收包超过该值即主动重连（不等被动心跳） */
const WAKE_PROBE_MS = 15_000;

function clearSessionData(): void {
  eventStore.getState().reset();
  sessionStore.getState().reset();
  approvalStore.getState().reset();
  terminalStore.getState().clearAll();
  filesStore.getState().resetWorkspace(null);
  connectionStore.getState().reset();
  notificationStore.getState().reset();
}

function handleAuthChange(): void {
  const state = authStore.getState();
  const accountLoggedIn = accountStore.getState().status === 'loggedIn';
  if (state.hydrated && state.pairState === 'paired') {
    ensureApprovalWiring();
    return;
  }
  // 账号远程模式拥有观测接线；未登录本地配对时不得把远程连接拆掉。
  if (state.hydrated && state.pairState !== 'paired' && !accountLoggedIn) {
    disposeAll();
  }
}

function handleAppState(next: AppStateStatus): void {
  if (next !== 'active') return;
  const wiring = getObservationWiring();
  if (!wiring) {
    if (authStore.getState().pairState === 'paired') {
      ensureObservationWiring();
    } else {
      // 账号中继模式：长后台后接线实例可能已被销毁，唤醒即恢复
      syncAccountRemote();
    }
    return;
  }
  if (wiring.client.phase === 'open') {
    // 即时探活：后台期间连接可能已半开，距上次收包过久直接重建，消除 0~30s 假死窗口
    if (Date.now() - wiring.client.lastRxMs > WAKE_PROBE_MS) {
      wiring.reconnect();
      return;
    }
    wiring.bridge.syncSubscriptions();
    for (const sessionId of Object.keys(eventStore.getState().windows)) {
      void wiring.bridge.hydrateSession(sessionId);
    }
  } else if (wiring.client.phase !== 'connecting') {
    wiring.reconnect();
  }
}

function disposeAll(): void {
  disposeObservationWiring();
  disposeApprovalWiring();
  clearSessionData();
}

/** 启动运行时（幂等；根布局挂载时调用） */
export function startAppRuntime(): void {
  if (started) return;
  started = true;
  if (__DEV__) {
    // 开发诊断面（对齐桌面 window.__CRISH_* store 门面；不参与生产构建行为）
    Object.assign(globalThis, {
      __CRISH_SESSION_STORE__: sessionStore,
      __CRISH_EVENT_STORE__: eventStore,
      __CRISH_APPROVAL_STORE__: approvalStore,
      __CRISH_NOTIFICATION_STORE__: notificationStore,
      __CRISH_FILES_STORE__: filesStore,
      __CRISH_TERMINAL_STORE__: terminalStore,
      __CRISH_CONNECTION_STORE__: connectionStore,
    });
  }
  appStateSub = AppState.addEventListener('change', handleAppState);
  authStateUnsub = authStore.subscribe(handleAuthChange);
  startAccountRuntime();
  handleAuthChange();
}

/** 停止运行时（解绑 / 测试隔离） */
export function stopAppRuntime(): void {
  appStateSub?.remove();
  appStateSub = null;
  authStateUnsub?.();
  authStateUnsub = null;
  stopAccountRuntime();
  started = false;
  disposeAll();
}

/** 对话页打开时回填历史 */
export function ensureSessionHistory(sessionId: string): void {
  void getObservationWiring()?.bridge.hydrateSession(sessionId);
}

/** 运行详情深链：回填该 run 的事件 */
export function ensureRunHistory(runId: string): void {
  void getObservationWiring()?.bridge.hydrateRun(runId);
}

/** 手动重连（设置 / 空态重试） */
export function reconnectNow(): void {
  const wiring = getObservationWiring();
  if (wiring) {
    wiring.reconnect();
    return;
  }
  if (authStore.getState().pairState === 'paired') {
    ensureObservationWiring();
    return;
  }
  // 账号中继模式：接线不存在时按账号状态重建
  syncAccountRemote();
}
