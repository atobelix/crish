/**
 * 面板指示条状态机 —— 纯迁移层（P1-B2：12 文档 §5.1 + T-12/U-9 裁决）。
 *
 * 零副作用、可独立单测；定时（接管 800ms 过渡）由 usePanelStatus 持有。
 *
 * ## 状态与迁移（12 文档 §5.1 表 + T-12）
 * | 状态 | 进入 | 退出 |
 * |---|---|---|
 * | idle | 初始化/动作链结束 | AI_START → ai-busy |
 * | ai-busy | AI 工具开始执行 | AI_END → idle；PAUSE → paused；USER_INPUT → user-taking-over |
 * | paused | 用户点击暂停 | RESUME → idle；AI_START → ai-busy（12 §5.1「重新触发 AI」） |
 * | user-taking-over | 用户输入且 AI 在途 | TAKEOVER_TIMEOUT(800ms) → idle；AI_END → idle；PAUSE → paused |
 *
 * ## 职责边界（T-12/U-9③）
 * 本机仅做 **UI 呈现投影**：吊销链唯一入口为维度 15 的 Coordinator
 * （revoke → abort → cancel → 版本推进），前端只发信号（browser_input
 * 即天然接管信号，Rust 侧 InputPipeline 已 bump 版本），不直接吊销。
 */
import type { PanelStatus } from './browserPanelTypes';

export type PanelStatusEvent =
  | { type: 'AI_START' }
  | { type: 'AI_END' }
  | { type: 'USER_INPUT' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'TAKEOVER_TIMEOUT' };

/** 接管过渡时长（T-12：对齐维度 15 `TOKEN_MIN_STABLE_WINDOW` 常量，800ms）。 */
export const TOKEN_MIN_STABLE_WINDOW_MS = 800;

/** 状态迁移（全表穷举于测试 panelStatusMachine.test.ts）。 */
export function nextPanelStatus(
  status: PanelStatus,
  evt: PanelStatusEvent,
): PanelStatus {
  switch (evt.type) {
    case 'AI_START':
      if (status === 'idle' || status === 'paused') return 'ai-busy';
      // user-taking-over：吊销期忽略 AI_START（U-9 稳定窗内 AI 不得重试，
      // 陈旧/越窗信号不投影 busy——展示层不与吊销链抢语义）
      return status;
    case 'AI_END':
      if (status === 'ai-busy' || status === 'user-taking-over') return 'idle';
      return status;
    case 'USER_INPUT':
      // 仅「AI 在途」时接管（12 §5.1 表）；idle 用户自由操作非接管；
      // paused 已挂起不重复接管；user-taking-over 保持（定时器不重启）
      if (status === 'ai-busy') return 'user-taking-over';
      return status;
    case 'PAUSE':
      if (status === 'ai-busy' || status === 'user-taking-over') return 'paused';
      return status;
    case 'RESUME':
      if (status === 'paused') return 'idle';
      return status;
    case 'TAKEOVER_TIMEOUT':
      // T-12：800ms 过渡（对齐维度 15 TOKEN_MIN_STABLE_WINDOW）→ idle
      if (status === 'user-taking-over') return 'idle';
      return status;
  }
}
