import type { ToolBatchFailurePolicy } from '@crish/shared-types';

export interface ToolExecutorOptions {
  timeoutMs: number;
  parallelFailurePolicy: ToolBatchFailurePolicy;
}
