export type ToolConcurrency = 'parallel' | 'serial';

export interface TrackedTool {
  id: string;
  name: string;
  index: number;
  status: 'queued' | 'executing' | 'completed' | 'failed';
  concurrency: ToolConcurrency;
  result?: ToolResult;
  error?: Error;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError: boolean;
}

export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private signal: AbortSignal;

  constructor(signal: AbortSignal) {
    this.signal = signal;
  }

  addTool(id: string, name: string, concurrency: ToolConcurrency): void {
    this.tools.push({
      id,
      name,
      index: this.tools.length,
      status: 'queued',
      concurrency,
    });
  }

  async *execute(
    toolRunner: (tool: TrackedTool) => Promise<ToolResult>
  ): AsyncIterable<ToolResult> {
    const parallelTools = this.tools.filter(
      (t) => t.concurrency === 'parallel' && t.status === 'queued'
    );
    const serialTools = this.tools.filter(
      (t) => t.concurrency === 'serial' && t.status === 'queued'
    );

    const parallelResults = new Map<number, ToolResult>();
    if (parallelTools.length > 0) {
      const promises = parallelTools.map(async (tool) => {
        tool.status = 'executing';
        try {
          const result = await toolRunner(tool);
          tool.status = 'completed';
          parallelResults.set(tool.index, result);
        } catch (err) {
          tool.status = 'failed';
          parallelResults.set(tool.index, {
            toolCallId: tool.id,
            output: `Error: ${(err as Error).message}`,
            isError: true,
          });
        }
      });
      await Promise.all(promises);
    }

    for (const tool of this.tools.filter((t) => t.concurrency === 'parallel')) {
      const result = parallelResults.get(tool.index);
      if (result) yield result;
    }

    for (const tool of serialTools) {
      if (this.signal.aborted) break;
      tool.status = 'executing';
      try {
        const result = await toolRunner(tool);
        tool.status = 'completed';
        yield result;
      } catch (err) {
        tool.status = 'failed';
        yield {
          toolCallId: tool.id,
          output: `Error: ${(err as Error).message}`,
          isError: true,
        };
      }
    }
  }

  get pendingCount(): number {
    return this.tools.filter(
      (t) => t.status === 'queued' || t.status === 'executing'
    ).length;
  }
  get completedCount(): number {
    return this.tools.filter((t) => t.status === 'completed').length;
  }
  get failedCount(): number {
    return this.tools.filter((t) => t.status === 'failed').length;
  }
}
