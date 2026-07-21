import { getWorkerPool, Priority } from './index';

interface PendingDelta {
  text: string;
  timestamp: number;
}

interface StreamRenderOptions {
  onHtml: (html: string, isFinal: boolean) => void;
  frameIntervalMs?: number;
  maxDeltasPerFrame?: number;
}

export class StreamingRenderer {
  private pendingBuffer = '';
  private lastRenderedText = '';
  private lastRenderedHtml = '';
  private frameTimer: ReturnType<typeof requestAnimationFrame> | null = null;
  private flushScheduled = false;
  private readonly options: Required<Pick<StreamRenderOptions, 'frameIntervalMs' | 'maxDeltasPerFrame'>>;
  private readonly onHtml: (html: string, isFinal: boolean) => void;
  private workerTaskId: string | null = null;

  constructor(options: StreamRenderOptions) {
    this.onHtml = options.onHtml;
    this.options = {
      frameIntervalMs: options.frameIntervalMs ?? 16,
      maxDeltasPerFrame: options.maxDeltasPerFrame ?? 5,
    };
  }

  appendDelta(delta: string): void {
    this.pendingBuffer += delta;
    this.scheduleFlush();
  }

  flushNow(isFinal = false): void {
    this.cancelScheduledFlush();
    if (!this.pendingBuffer && isFinal) {
      this.onHtml(this.lastRenderedHtml, true);
      return;
    }
    this.doFlush(isFinal);
  }

  reset(): void {
    this.cancelScheduledFlush();
    this.pendingBuffer = '';
    this.lastRenderedText = '';
    this.lastRenderedHtml = '';
    this.workerTaskId = null;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    this.frameTimer = requestAnimationFrame(() => {
      this.flushScheduled = false;
      this.frameTimer = null;
      if (this.pendingBuffer) {
        this.doFlush(false);
      }
    });
  }

  private cancelScheduledFlush(): void {
    if (this.frameTimer) {
      cancelAnimationFrame(this.frameTimer);
      this.frameTimer = null;
    }
    this.flushScheduled = false;
  }

  private doFlush(isFinal: boolean): void {
    const accumulated = this.pendingBuffer;
    this.pendingBuffer = '';

    if (!accumulated) {
      if (isFinal) this.onHtml(this.lastRenderedHtml, true);
      return;
    }

    const fullText = this.lastRenderedText + accumulated;

    getWorkerPool()
      .schedule<string>(
        'render',
        'markdown.render',
        { raw: fullText },
        isFinal ? Priority.Critical : Priority.High,
      )
      .then((html) => {
        this.lastRenderedText = fullText;
        this.lastRenderedHtml = html;

        this.onHtml(html, isFinal);
      })
      .catch(() => {
        if (isFinal) {
          this.onHtml(this.lastRenderedHtml, true);
        }
      });
  }

}
