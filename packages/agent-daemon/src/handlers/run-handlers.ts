/**
 * Run Handlers Facade
 *
 * Extracted from DaemonRequestHandlers.
 * Handles run task orchestration, cancellation, mutation leases,
 * workflow background runs, and related admission control.
 *
 * Implementation is split into submodules under ./run-handlers/:
 * - run-lifecycle.ts: Run lifecycle & admission control.
 * - run-tool-executor.ts: Tool execution & event notification bridge.
 */

export type {
  DaemonMessageTransport,
  RunEventSink,
} from './run-handlers/run-tool-executor.js';

export {
  correlateResponse,
  correlationFrom,
} from './run-handlers/run-tool-executor.js';

export type {
  OrchestratedRunInput,
  WorkflowBackgroundRunInput,
  RunAdmissionLease,
  RunHandlerOptions,
} from './run-handlers/run-lifecycle.js';

export {
  DaemonRunPreflightError,
  RunHandler,
} from './run-handlers/run-lifecycle.js';
