// connectionStore（M5 §3.1.1 / D4 §6.2.5）：连接相位 + 端点 + 重连状态（领域层 store）
//
// 数据面关系（接线注记，不重复造轮子）：
// - 相位投影本体 = domain/pure/selectors.mapWsPhase（M5 §4.3.1 映射表单一真源），本 store
//   只持有「归一后的 UI 相位」ConnectionPhase，并把投影/标签表转发为统一出口
//   （见文件底部 re-export：mapWsPhase / CONNECTION_PHASE_TEXT / selectConnectionPhaseText）；
// - 数据源 = ReconnectingWsClient 内部相位（WsPhase：idle/connecting/open/reconnecting/dead，
//   src/network/ReconnectingWsClient.ts）——由适配层 wiring（feedBridge.handlePhaseChange）
//   经 mapWsPhase 投影后调用 setPhase 写入；断网判定（NetInfo，offline 参数）同样由接线层
//   注入（feedBridge 现传 false，R2-03 补 NetInfo 接线点，M5 §4.3.1「offline 优先级最高」）；
// - devicePresenceStore（src/adapters/wiring/devicePresenceStore.ts）只管「桌面侧已配对设备数」，
//   与本 store 的「本机连接相位」职责正交，不合并、不重复；
// - setPhase('ready') 打点 lastSyncAt（useDashboardVm stale 灰字数据面，R2UX-05-10）并清
//   attemptCount（重连成功清零）；attemptCount 由 ReconnectingWsClient 重连调度触发
//   onReconnectAttempt 计数（诊断数据面，M5 §3.1.1 retryCount 语义对齐）；
// - 会话索引对账状态（M1 数据完整性面）：对账成败不再只留 console.warn——feedBridge 把
//   ok/error+错误信息写入本 store 的 sessionSync* 字段（主页错误浮层 + 重试据此呈现）。
//   同步增量化（2026-11-02 用户裁决）后口径修订：列表常态由 WS 增量事件驱动，全量对账
//   退为连接建立/手动刷新时的校准兜底；无差分的对账必须静默（不置 syncing、不打点、
//   不改状态），后台对账永不呈现「同步中」——呈现面只剩失败浮层与下拉刷新原生指示。
// - 连接纪元 connectedSinceMs：进入 ready 的时刻，主界面状态板「本次连接后完成」
//   资格的起算点（连接前完成的历史会话不进状态板，进完整会话列表页）。
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';

// 连接相位（D4 §6.2.5 五态）：ReconnectingWsClient 内部相位经 mapWsPhase 归一为 UI 相位
export type ConnectionPhase =
  'disconnected' | 'connecting' | 'ready' | 'recovering' | 'offline';

/**
 * 会话索引对账状态（M1 一等状态）：idle = 尚未对账 / syncing = 对账中 /
 * ok = 最近一次对账成功 / error = 最近一次对账失败（错误信息见 sessionSyncError）
 */
export type SessionSyncStatus = 'idle' | 'syncing' | 'ok' | 'error';

/** 已选连接端点（用户手动输入 / device_meta 恢复，R2-03 EndpointResolver 接线） */
export interface ConnectionEndpoint {
  /** 桌面主机（IP/域名） */
  host: string;
  /** 网关端口（裁决 P-1：8765） */
  port: number;
  /** 完整连接地址（wss://host:port/…；EXPO_PUBLIC_ENGINE_URL 覆盖优先，D8 §6.2） */
  url: string;
}

export interface ConnectionState {
  /** 归一 UI 相位（投影本体在 pure/selectors.mapWsPhase，M5 §4.3.1） */
  phase: ConnectionPhase;
  /** 当前选中的桌面端点（null = 未配置/未配对） */
  selectedEndpoint: ConnectionEndpoint | null;
  /** 累计连接/重连尝试次数（任务书 attemptCount，诊断数据面；ready 相位与 reset 清零） */
  attemptCount: number;
  /** 最近一次连接错误（可读文案；useDashboardVm 诊断展示，不改相位） */
  lastError: string | null;
  /** 最后同步时刻 ms（ready 相位打点；stale 灰字数据面，R2UX-05-10） */
  lastSyncAt: number | null;
  /** 会话索引对账状态（M1：feedBridge 对账成败的唯一可观察出口） */
  sessionSyncStatus: SessionSyncStatus;
  /** 最近一次对账失败的错误信息（sessionSyncStatus=error 时有效；成功即清） */
  sessionSyncError: string | null;
  /** 最近一次对账成功时刻 ms（未成功过 = null；与 lastSyncAt 分开：后者是连接相位面） */
  lastReconcileAt: number | null;
  /** 本次连接纪元起点 ms（自非 ready 跃入 ready 时打点；非 ready 时为 null） */
  connectedSinceMs: number | null;

  /** 归一相位写入（接线层经 mapWsPhase 投影后调用；ready → 打点 lastSyncAt + 清 attemptCount） */
  setPhase: (phase: ConnectionPhase) => void;
  /** 对账开始（feedBridge refreshSessions 入口调用；保留上次错误直至本轮结果落定，避免错误条闪烁） */
  markSessionSyncStarted: () => void;
  /** 对账成功（reconcile 落地后调用：状态 ok + 清错误 + 打点 lastReconcileAt） */
  markSessionSyncSucceeded: (nowMs?: number) => void;
  /** 对账失败（feedBridge catch 调用：状态 error + 错误信息入面，主页错误条据此呈现） */
  markSessionSyncFailed: (message: string) => void;
  /** 设置/清空已选端点（用户手动输入或 device_meta 恢复时调用；null = 清除） */
  setEndpoint: (endpoint: ConnectionEndpoint | null) => void;
  /** 重连尝试计数（ReconnectingWsClient 重连调度触发，R2-03 接线点） */
  onReconnectAttempt: () => void;
  /** 记录连接错误（onerror/onclose 非主动断开、解码失败等；不改相位） */
  onError: (message: string) => void;
  /** 全量复位（断开/注销）：phase→disconnected + 清计数/错误/同步点；保留端点配置 */
  reset: () => void;
}

// 领域层 store：vanilla createStore + immer；R2-02 由 ReconnectingWsClient 事件投影驱动
export const connectionStore = createStore<ConnectionState>()(
  immer((set) => ({
    phase: 'disconnected',
    selectedEndpoint: null,
    attemptCount: 0,
    lastError: null,
    lastSyncAt: null,
    sessionSyncStatus: 'idle',
    sessionSyncError: null,
    lastReconcileAt: null,
    connectedSinceMs: null,

    setPhase: (phase) =>
      set((s) => {
        // 连接纪元：跃入 ready 时开启新纪元（重复 ready 不挪动起点，保证同一
        // 连接内状态板资格稳定）；离开 ready 即清空，下次连接重新起算。
        const wasReady = s.phase === 'ready';
        s.phase = phase;
        if (phase === 'ready') {
          s.lastSyncAt = Date.now();
          // 重连成功：清连续失败计数（M5 §4.3.2「重连成功重置 retryCount」对齐）
          s.attemptCount = 0;
          if (!wasReady) {
            s.connectedSinceMs = s.lastSyncAt;
          }
        } else {
          s.connectedSinceMs = null;
        }
      }),

    markSessionSyncStarted: () =>
      set((s) => {
        s.sessionSyncStatus = 'syncing';
      }),

    markSessionSyncSucceeded: (nowMs = Date.now()) =>
      set((s) => {
        s.sessionSyncStatus = 'ok';
        s.sessionSyncError = null;
        s.lastReconcileAt = nowMs;
      }),

    markSessionSyncFailed: (message) =>
      set((s) => {
        s.sessionSyncStatus = 'error';
        s.sessionSyncError = message;
      }),

    setEndpoint: (endpoint) =>
      set((s) => {
        s.selectedEndpoint = endpoint;
      }),

    onReconnectAttempt: () =>
      set((s) => {
        s.attemptCount += 1;
      }),

    onError: (message) =>
      set((s) => {
        s.lastError = message;
      }),

    reset: () =>
      set((s) => {
        s.phase = 'disconnected';
        s.attemptCount = 0;
        s.lastError = null;
        s.lastSyncAt = null;
        s.sessionSyncStatus = 'idle';
        s.sessionSyncError = null;
        s.lastReconcileAt = null;
        s.connectedSinceMs = null;
      }),
  }))
);

// ── 派生的 UI 投影（M5 §4.3.1 映射表转发，不重复造轮子）────────────────────
// 本体在 domain/pure/selectors.ts（mapWsPhase 映射表 + CONNECTION_PHASE_TEXT 标签表 +
// selectConnectionPhaseText 选择器），经本 store 统一出口供 UI/诊断消费：
// - 相位投影：mapWsPhase(wsPhase, offline) → ConnectionPhase；
// - 连接状态标签：CONNECTION_PHASE_TEXT[phase] / selectConnectionPhaseText(phase)。
// WsPhase 类型不经此转发（R4 批次6 归位）：消费方直接 import 自
// '@/network/ReconnectingWsClient'（类型所有权 = network）。
export {
  mapWsPhase,
  CONNECTION_PHASE_TEXT,
  selectConnectionPhaseText,
  selectEffectiveChatMode,
  type EffectiveChatMode,
} from '../pure/selectors';
