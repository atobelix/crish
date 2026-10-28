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
//   onReconnectAttempt 计数（诊断数据面，M5 §3.1.1 retryCount 语义对齐）。
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';

// 连接相位（D4 §6.2.5 五态）：ReconnectingWsClient 内部相位经 mapWsPhase 归一为 UI 相位
export type ConnectionPhase =
  'disconnected' | 'connecting' | 'ready' | 'recovering' | 'offline';

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

  /** 归一相位写入（接线层经 mapWsPhase 投影后调用；ready → 打点 lastSyncAt + 清 attemptCount） */
  setPhase: (phase: ConnectionPhase) => void;
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

    setPhase: (phase) =>
      set((s) => {
        s.phase = phase;
        if (phase === 'ready') {
          s.lastSyncAt = Date.now();
          // 重连成功：清连续失败计数（M5 §4.3.2「重连成功重置 retryCount」对齐）
          s.attemptCount = 0;
        }
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
      }),
  }))
);

// ── 派生的 UI 投影（M5 §4.3.1 映射表转发，不重复造轮子）────────────────────
// 本体在 domain/pure/selectors.ts（mapWsPhase 映射表 + CONNECTION_PHASE_TEXT 标签表 +
// selectConnectionPhaseText 选择器），经本 store 统一出口供 UI/诊断消费：
// - 相位投影：mapWsPhase(wsPhase, offline) → ConnectionPhase；
// - 连接状态标签：CONNECTION_PHASE_TEXT[phase] / selectConnectionPhaseText(phase)；
// - WsPhase 类型：ReconnectingWsClient 内部相位（数据源契约）。
export {
  mapWsPhase,
  CONNECTION_PHASE_TEXT,
  selectConnectionPhaseText,
} from '../pure/selectors';
export type { WsPhase } from '../pure/selectors';
