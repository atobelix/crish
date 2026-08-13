// terminalStore（R2-14 第三波）：run 终端行缓冲数据面（领域层 store）
// - 纯逻辑在 terminalReducers.ts（jest 直测），本文件只做一行转发 + 状态装配
//   （M5 §3.1 reducers 纪律）；行缓冲本体为 R2-05c 纯函数库（terminalLineBuffer，
//   5000 行环形 / ANSI 白名单剥离 / \n 提交 / \r 覆盖），本 store 持有实例状态；
// - 数据面关系（接线注记，不重复造轮子）：
//   · 入站：tool-update（S1 协议 text 流）/ task-output（line/chunk）→ ingestLines；
//     tool-end 终值权威（F3 §4.2 replaceAllTerminalText 语义，与流式增量不一致时以
//     终值为准）与 run 收口释放（resetRun）由接线层在 wiring 层编排；
//   · 持久化：不落库（terminalStore 为纯内存镜像；历史回放由 eventStore 窗口承载，
//     terminalScreen 现状经 collectRunTerminalChunks 从事件流重建，R2-05c）；
//   · 渲染消费：linesOf(runId) 选择器 → TerminalView（行 + 行键起点 + 截断计数 + 游标）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  clearTerminalRuns,
  ingestTerminalText,
  removeTerminalRun,
  terminalViewOf,
  type TerminalRunState,
  type TerminalView,
} from './terminalReducers';

export interface TerminalState {
  /** runId → run 终端状态（行缓冲实例 + 游标；有界：每 run 5000 行环形，R2UX-05-07） */
  runs: Record<string, TerminalRunState>;

  /** 流式文本块入缓冲（ANSI 剥离 + \n/\r 切行在缓冲层完成；自动创建 run 实例） */
  ingestLines: (runId: string, text: string) => void;
  /** 释放 run 缓冲（run 收口 / 内存预算卸载；再 ingest 会重新创建空缓冲） */
  resetRun: (runId: string) => void;
  /** 清空全部 run 缓冲（切会话 / 登出全清） */
  clearAll: () => void;
}

// 显式 StoreApi 标注（对齐 approvalStore/eventStore：immer 中间件组合链推断类型
// 引用外部 draft 类型无法在导出声明中命名，公共面以 StoreApi<TerminalState> 收敛）
export const terminalStore: StoreApi<TerminalState> =
  createStore<TerminalState>()(
    immer((set) => ({
      runs: {},

      ingestLines: (runId, text) =>
        set((s) => {
          ingestTerminalText(s, runId, text);
        }),

      resetRun: (runId) =>
        set((s) => {
          removeTerminalRun(s, runId);
        }),

      clearAll: () =>
        set((s) => {
          clearTerminalRuns(s);
        }),
    }))
  );

/** 终端视图选择器（run 不存在 → null；行键 key = startIndex + idx 防滚动抖动） */
export function linesOf(runId: string): TerminalView | null {
  return terminalViewOf(terminalStore.getState().runs, runId);
}
