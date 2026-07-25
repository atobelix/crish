import type { DaemonConfig } from "../types.js";
import { resolveDaemonEventLogPath, resolveDaemonWorkflowStorePath, resolveDaemonPlanDocumentStorePath, resolveDaemonScopedContextStorePath, resolveDaemonSessionMetadataStorePath } from "../persistence.js";
import { DaemonEventStore } from "../server-event-store.js";
import { FileWorkflowStore } from "../workflow-store.js";
import { FilePlanDocumentStore } from "../plan-document-store.js";
import { FileScopedContextStore } from "../scoped-context-store.js";
import { FileSessionMetadataStore } from "../session-metadata-store.js";
import type { OrchestratorEventStoreError } from "@crish/agent-orchestrator";

export class DaemonStoreRegistry {
  readonly eventStore: DaemonEventStore;
  readonly workflowStore: FileWorkflowStore;
  readonly planDocumentStore: FilePlanDocumentStore;
  readonly scopedContextStore: FileScopedContextStore;
  readonly sessionMetadataStore: FileSessionMetadataStore;
  readonly eventLogPath: string;

  constructor(config: DaemonConfig) {
    this.eventLogPath = resolveDaemonEventLogPath(config);
    this.workflowStore = new FileWorkflowStore(
      resolveDaemonWorkflowStorePath(config)
    );
    this.planDocumentStore = new FilePlanDocumentStore(
      resolveDaemonPlanDocumentStorePath(config)
    );
    this.scopedContextStore = new FileScopedContextStore(
      resolveDaemonScopedContextStorePath(config)
    );
    this.sessionMetadataStore = new FileSessionMetadataStore(
      resolveDaemonSessionMetadataStorePath(config)
    );
    this.eventStore = new DaemonEventStore(this.eventLogPath);
    this.eventStore.installSignalHandlers();
  }

  getEventStoreFailure(): OrchestratorEventStoreError | undefined {
    return this.eventStore.getFailure();
  }

  async closeEventStore(): Promise<void> {
    await this.eventStore.close();
  }
}
