import type {
  WorkbenchContinuationDecision,
  WorkbenchRunEvent,
  WorkbenchRuntimeStatus,
  WorkbenchStartRequest,
  WorkbenchTaskSnapshot
} from "./workbench-contract";
import { createContinuationDecision } from "./task-controller";

export interface WorkbenchRuntimeBridge {
  getStatus(): Promise<WorkbenchRuntimeStatus>;
  getTaskSnapshot(): Promise<WorkbenchTaskSnapshot>;
  startTask(request: WorkbenchStartRequest): AsyncIterable<WorkbenchRunEvent>;
  requestContinuation(snapshot: WorkbenchTaskSnapshot): Promise<WorkbenchContinuationDecision>;
}

export function decideContinuation(snapshot: WorkbenchTaskSnapshot): WorkbenchContinuationDecision {
  return createContinuationDecision(snapshot);
}

export function createRunEvent(type: WorkbenchRunEvent["type"], message: string, payload?: unknown): WorkbenchRunEvent {
  return {
    type,
    message,
    timestamp: new Date().toISOString(),
    payload
  };
}
