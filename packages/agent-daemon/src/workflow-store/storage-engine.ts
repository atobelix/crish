import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isNodeError, errorMessage, deepFreeze, deepEqual } from "@crish/shared-utils";
import { fsyncPathAsync, fsyncDirectoryPathAsync } from "@crish/shared-utils/node";
import { WORKFLOW_STORE_VERSION, WorkflowStoreReadError, WorkflowStoreWriteError } from "./types.js";
import type { WorkflowStoreState } from "./types.js";
import { validateWorkflowFileState, validateWorkflowRunsFileState, cloneState } from "./validation.js";

export class WorkflowStorageEngine {
  private state?: WorkflowStoreState;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly options: { fsync?: boolean; fsyncDirectory?: boolean | "best-effort" } = {}
  ) {}

  get runsFilePath(): string {
    const dir = dirname(this.filePath);
    const base = basename(this.filePath).replace(/\.[^.]+$/, "");
    return join(dir, `${base}-runs.json`);
  }

  async readState(): Promise<WorkflowStoreState> {
    await this.pending;
    return this.load();
  }

  async mutate<T>(operation: (state: WorkflowStoreState) => T): Promise<T> {
    const next = this.pending.then(async () => {
      const current = await this.load();
      const previousState = this.state;
      const nextState = cloneState(current);
      const result = operation(nextState);
      deepFreeze(nextState);
      await this.writeState(nextState, previousState);
      this.state = nextState;
      return result;
    });

    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async load(): Promise<WorkflowStoreState> {
    if (this.state) return this.state;

    const [workflows, runs] = await Promise.all([
      this.loadWorkflowsFile(),
      this.loadRunsFile()
    ]);

    const state: WorkflowStoreState = {
      version: WORKFLOW_STORE_VERSION,
      workflows,
      runs,
    };
    this.state = deepFreeze(state);
    return this.state;
  }

  private async loadWorkflowsFile(): Promise<import("../types.js").WorkflowDefinition[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw new WorkflowStoreReadError(
        this.filePath,
        `Failed to read workflow store ${this.filePath}: ${errorMessage(error)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkflowStoreReadError(
        this.filePath,
        `Workflow store ${this.filePath} is not valid JSON: ${errorMessage(error)}`
      );
    }

    const issues = validateWorkflowFileState(parsed);
    if (issues.length > 0) {
      throw new WorkflowStoreReadError(
        this.filePath,
        `Workflow store ${this.filePath} has invalid data`,
        issues
      );
    }

    return (parsed as { workflows: import("../types.js").WorkflowDefinition[] }).workflows;
  }

  private async loadRunsFile(): Promise<import("../types.js").WorkflowRunEntry[]> {
    let text: string;
    try {
      text = await readFile(this.runsFilePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw new WorkflowStoreReadError(
        this.runsFilePath,
        `Failed to read workflow runs store ${this.runsFilePath}: ${errorMessage(error)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkflowStoreReadError(
        this.runsFilePath,
        `Workflow runs store ${this.runsFilePath} is not valid JSON: ${errorMessage(error)}`
      );
    }

    const issues = validateWorkflowRunsFileState(parsed);
    if (issues.length > 0) {
      throw new WorkflowStoreReadError(
        this.runsFilePath,
        `Workflow runs store ${this.runsFilePath} has invalid data`,
        issues
      );
    }

    return (parsed as { runs: import("../types.js").WorkflowRunEntry[] }).runs;
  }

  private async writeState(
    state: WorkflowStoreState,
    previous: WorkflowStoreState | undefined
  ): Promise<void> {
    const workflowsChanged = !previous || !deepEqual(previous.workflows, state.workflows);
    const runsChanged = !previous || !deepEqual(previous.runs, state.runs);

    if (workflowsChanged) {
      await this.writeWorkflowsFile(state.workflows);
    }
    if (runsChanged) {
      await this.writeRunsFile(state.runs);
    }
  }

  private async atomicWriteJsonFile(targetPath: string, data: unknown): Promise<void> {
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
      if (this.options.fsync !== false) {
        await fsyncPathAsync(tmpPath, "r+");
      }
      await rename(tmpPath, targetPath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        await fsyncDirectoryPathAsync(dirname(targetPath), dirFsyncMode);
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new WorkflowStoreWriteError(targetPath, error);
    }
  }

  private async writeWorkflowsFile(workflows: import("../types.js").WorkflowDefinition[]): Promise<void> {
    await this.atomicWriteJsonFile(this.filePath, {
      version: WORKFLOW_STORE_VERSION,
      workflows,
    });
  }

  private async writeRunsFile(runs: import("../types.js").WorkflowRunEntry[]): Promise<void> {
    await this.atomicWriteJsonFile(this.runsFilePath, {
      version: WORKFLOW_STORE_VERSION,
      runs,
    });
  }
}
