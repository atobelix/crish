import {
  FileOrchestratorEventStore,
  OrchestratorEventStoreError,
  OrchestratorEventStoreWriteError,
  type OrchestratorEvent,
  type OrchestratorEventLogMetadata,
  type OrchestratorEventStore,
  type OrchestratorEventReadOptions,
} from "@crish/agent-orchestrator";

export class DaemonEventStore implements OrchestratorEventStore {
  private readonly delegate: FileOrchestratorEventStore;
  private _failure: OrchestratorEventStoreError | undefined;

  constructor(private readonly eventLogPath: string) {
    this.delegate = new FileOrchestratorEventStore(eventLogPath);
  }

  async append(event: OrchestratorEvent): Promise<void> {
    try {
      await this.delegate.append(event);
    } catch (cause) {
      this._failure = normalizeEventStoreFailure(cause, this.delegatePath(), event.id);
      throw this._failure;
    }
  }

  async readAll(afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<OrchestratorEvent[]> {
    return this.delegate.readAll(afterSequence, options);
  }

  async readSession(sessionId: string, afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<OrchestratorEvent[]> {
    return this.delegate.readSession(sessionId, afterSequence, options);
  }

  async readRun(runId: string, afterSequence?: number, options?: OrchestratorEventReadOptions): Promise<OrchestratorEvent[]> {
    return this.delegate.readRun(runId, afterSequence, options);
  }

  async getMetadata(): Promise<OrchestratorEventLogMetadata> {
    return this.delegate.getMetadata();
  }

  async close(): Promise<void> {
    await this.delegate.close();
    if (this._failure) throw this._failure;
  }

  installSignalHandlers(): () => void {
    return this.delegate.installSignalHandlers();
  }

  getFailure(): OrchestratorEventStoreError | undefined {
    return this._failure;
  }

  private delegatePath(): string {
    return this.eventLogPath;
  }
}

function normalizeEventStoreFailure(cause: unknown, filePath: string, eventId?: string): OrchestratorEventStoreError {
  if (cause instanceof OrchestratorEventStoreError) return cause;
  return new OrchestratorEventStoreWriteError(filePath, eventId, cause);
}
