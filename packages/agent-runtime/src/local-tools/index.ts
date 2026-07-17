import { BackgroundCommandManager, createBackgroundCommandTools } from "../background-command";
import type { AgentTool } from "../types";
import { createApplyWorkspaceEditsTool, createEditTool } from "./fs-edit-tools";
import { createListDirectoryTool, createReadTool } from "./fs-read-tools";
import {
  createRestoreFileSnapshotTool,
  createRestoreWorkspaceCheckpointTool,
  createWorkspaceCheckpointTool
} from "./checkpoint-tools";
import { createSearchFilesTool } from "./search-tools";
import { createTerminalCommandTool } from "./shell-tools";
import type { TerminalToolOptions } from "./types";

export type {
  LocalExecutionGuardOptions,
  LocalPreMutationCheckpointHook,
  LocalPreMutationCheckpointOptions,
  LocalPreMutationCheckpointRequest,
  LocalPreMutationCheckpointResult,
  LocalToolOptions,
  TerminalShell,
  TerminalToolOptions
} from "./types";

export { createTerminalCommandTool } from "./shell-tools";
export { createListDirectoryTool, createReadFileTool, createReadTool } from "./fs-read-tools";
export { createApplyWorkspaceEditsTool, createEditTool, createWriteFileTool } from "./fs-edit-tools";
export { createSearchFilesTool } from "./search-tools";
export {
  createRestoreFileSnapshotTool,
  createRestoreWorkspaceCheckpointTool,
  createWorkspaceCheckpointTool
} from "./checkpoint-tools";

export function createLocalWorkspaceTools(options: TerminalToolOptions): AgentTool[] {
  const backgroundManager =
    options.backgroundManager ??
    new BackgroundCommandManager({
      workspaceRoot: options.workspaceRoot,
      defaultTimeoutMs: options.backgroundDefaultTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      heartbeatIntervalMs: options.backgroundHeartbeatIntervalMs,
      shell: options.shell,
      guard: options.guard,
    });

  return [
    // Clear AI surface: foreground shell + dedicated background task tools
    createTerminalCommandTool({ ...options, backgroundManager }),
    ...createBackgroundCommandTools(backgroundManager),
    createReadTool(options),
    createEditTool(options),
    createApplyWorkspaceEditsTool(options),
    createListDirectoryTool(options),
    createSearchFilesTool(options),
    createRestoreFileSnapshotTool(options),
    createWorkspaceCheckpointTool(options),
    createRestoreWorkspaceCheckpointTool(options),
  ];
}
