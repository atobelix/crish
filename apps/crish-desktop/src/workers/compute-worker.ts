import type { WorkerRequest, WorkerResponse } from './types';

// =============================================================================
// Stream E 改造后的 compute-worker
//
// 已下沉到 Rust 的 case（在 api-adapters.ts 中通过 rustCore.* 调用）：
//   - sha256           → core_hash_compute
//   - encoding.detect  → core_detect_encoding
//   - diff.parse       → core_parse_diff
//   - base64.encode    → core_base64_encode
//   - base64.decode    → core_base64_decode
//   - externalize.blobs（已删除，references 永远为空，是 placeholder）
//   - session.search   （已删除，无调用方）
//   - clear-cache      （已删除，broadcast 路径从未真正工作过）
//
// 保留的 case（轻量任务，下沉 Rust 收益低）：
//   - budget.text   纯字符串切片
//   - json.stringify V8 原生 JSON 引擎
//   - json.parse     V8 原生 JSON 引擎
//   - ping           worker 健康检查
// =============================================================================

function budgetText(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text?.length ?? 0;
  if (!text || originalChars <= maxChars) {
    return { text: text || '', truncated: false, originalChars };
  }
  return { text: text.slice(0, maxChars) + '\n...(truncated)', truncated: true, originalChars };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = e.data;
  const t0 = performance.now();

  try {
    switch (type) {
      case 'budget.text': {
        const { text, maxChars } = payload as { text: string; maxChars: number };
        const result = budgetText(text, maxChars);
        self.postMessage({ id, type: 'success', payload: result, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: text.length } } as WorkerResponse);
        break;
      }

      case 'json.stringify': {
        const { obj } = payload as { obj: unknown };
        const json = JSON.stringify(obj);
        self.postMessage({ id, type: 'success', payload: json, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: json.length } } as WorkerResponse);
        break;
      }

      case 'json.parse': {
        const { json } = payload as { json: string };
        const obj = JSON.parse(json);
        self.postMessage({ id, type: 'success', payload: obj, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: json.length } } as WorkerResponse);
        break;
      }

      case 'ping': {
        self.postMessage({ id, type: 'success', payload: 'pong', metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: 0 } } as WorkerResponse);
        break;
      }

      default: {
        self.postMessage({ id, type: 'error', payload: `Unknown compute task type: ${type}` } as WorkerResponse);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, type: 'error', payload: msg } as WorkerResponse);
  }
};
