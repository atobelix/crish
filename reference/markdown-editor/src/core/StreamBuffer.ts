/**
 * 流式文本注入的帧批处理缓冲区。
 * 将高频 push() 调用合并为每帧一次的 callback，
 * 避免 500 token/s 级别的注入导致每个 token 都触发一次 React 提交。
 */
export class StreamBuffer {
  private buffer = '';
  private rafId: number | null = null;
  private callback: (chunk: string) => void;
  private isActive = false;

  constructor(callback: (chunk: string) => void) {
    this.callback = callback;
  }

  push(text: string): void {
    // 空串不入队：避免空内容也调度 rAF 并触发一次无意义回调
    if (!text) return;
    this.buffer += text;
    if (!this.isActive) {
      this.isActive = true;
      this.rafId = requestAnimationFrame(() => {
        const chunk = this.buffer;
        this.buffer = '';
        this.isActive = false;
        this.rafId = null;
        this.callback(chunk);
      });
    }
  }

  /**
   * 显式冲刷（stop-flush）：流式结束时由宿主调用，强制同步吐出剩余缓冲，
   * 不等下一帧 rAF。语义：
   * - 取消挂起的 rAF（若已调度），保证剩余内容立即且仅回调一次；
   * - 幂等：无待冲刷内容时为空操作，返回空串；
   * - 返回本次冲刷的 chunk（宿主可据此判断是否发生了冲刷）。
   */
  flush(): string {
    // 无条件清理挂起 rAF 并复位活跃标记（幂等：重复调用安全）
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.isActive = false;
    if (this.buffer) {
      const chunk = this.buffer;
      this.buffer = '';
      this.callback(chunk);
      return chunk;
    }
    return '';
  }

  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.buffer = '';
    this.isActive = false;
  }

  get pending(): number {
    return this.buffer.length;
  }
}
