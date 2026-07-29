import type { WorkerRequest, WorkerResponse } from './types';

// =============================================================================
// Stream E 改造后的 io-worker
//
// 已下沉到 Rust 的 case（在 api-adapters.ts 中通过 rustCore.* 调用）：
//   - messages.to-jsonl  → core_messages_to_jsonl
//   - jsonl.to-messages  → core_jsonl_to_messages
//   - text.decode        → core_decode_text
//   - text.encode        → core_text_encode（原 io-worker 实现忽略 encoding 参数，是 bug；
//                          Rust 版本用 encoding_rs 正确处理多编码）
//
// 保留的 case（与 compute-worker 重叠的轻量任务）：
//   - json.parse  V8 原生 JSON 引擎（与 compute-worker.json.parse 重复，但保留兼容）
//   - ping       worker 健康检查
// =============================================================================

function safeJsonParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = e.data;
  const t0 = performance.now();

  try {
    switch (type) {
      case 'json.parse': {
        const { json } = payload as { json: string };
        const obj = safeJsonParse(json, null);
        self.postMessage({ id, type: 'success', payload: obj, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: json.length } } as WorkerResponse);
        break;
      }

      case 'ping': {
        self.postMessage({ id, type: 'success', payload: 'pong', metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: 0 } } as WorkerResponse);
        break;
      }

      default: {
        self.postMessage({ id, type: 'error', payload: `Unknown io task type: ${type}` } as WorkerResponse);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, type: 'error', payload: msg } as WorkerResponse);
  }
};
