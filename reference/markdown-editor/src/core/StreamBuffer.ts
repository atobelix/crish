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

  flush(): void {
    if (this.buffer) {
      const chunk = this.buffer;
      this.buffer = '';
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.isActive = false;
      this.callback(chunk);
    }
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
