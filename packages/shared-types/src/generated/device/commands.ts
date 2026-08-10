// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/device/**
// Registry: crates/conex-types/contracts/device-protocol.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

import type { StatusQuery, StatusResult, RunSnapshotParams, RunSnapshotResult, EventPageParams, EventPageResult, RunEventsParams, ListSessionsParams, ListSessionsResult, ListTasksParams, ListTasksResult, TaskOutputParams, TaskOutputResult, FlowSnapshotParams, FlowSnapshotResult, ListCommandsParams, ListCommandsResult, SearchIndexParams, SearchIndexResult, ApproveParams, ApproveResult, DenyParams, ListPendingApprovalsParams, ListPendingApprovalsResult, ApprovalHistoryParams, ApprovalHistoryResult, CheckCommandParams, CheckCommandResult, ListDirParams, ListDirResult, ReadFileParams, ReadFileResult, WriteFileParams, WriteFileResult, ListWorkspacesParams, ListWorkspacesResult, SwitchWorkspaceParams, SwitchWorkspaceResult, SearchFilesParams, SearchFilesResult, AssetUrlParams, AssetUrlResult, FileStatParams, FileStatResult, RunTaskParams, RunTaskResult, RunControlParams, RunControlResult, CancelRunParams, CancelRunResult, SearchSessionsParams, SearchSessionsResult, GetSettingsParams, GetSettingsResult, SetSettingsParams, SetSettingsResult, SettingsConfirmParams, SettingsConfirmResult, PauseAutomationParams, PauseAutomationResult, PresenceParams, PresenceResult, ListDevicesParams, ListDevicesResult, RenameDeviceParams, GenericOkResult, RevokeDeviceParams, PairStateParams, PairStateResult, UnlinkParams, UnlinkResult } from "./types";

export const DEVICE_COMMANDS = [
  {"number":"C01","name":"getStatus","kind":"remote.getStatus","tauriCommand":"core_get_status","surface":"engine","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"StatusQuery","resultType":"StatusResult","errorCodes":["cmd.engine_not_ready","internal"]},
  {"number":"C02","name":"getRunSnapshot","kind":"remote.getRunSnapshot","tauriCommand":"core_get_run_snapshot","surface":"engine","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"RunSnapshotParams","resultType":"RunSnapshotResult","errorCodes":["cmd.not_found","cmd.invalid"]},
  {"number":"C03","name":"readSessionEvents","kind":"remote.readSessionEvents","tauriCommand":"core_read_session_events","surface":"engine","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"EventPageParams","resultType":"EventPageResult","errorCodes":["cmd.not_found","cmd.invalid"]},
  {"number":"C04","name":"readRunEvents","kind":"remote.readRunEvents","tauriCommand":"core_read_run_events","surface":"engine","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"RunEventsParams","resultType":"EventPageResult","errorCodes":["cmd.not_found"]},
  {"number":"C05","name":"listSessions","kind":"remote.listSessions","tauriCommand":"list_sessions","surface":"engine","registered":true,"domain":"sessions","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ListSessionsParams","resultType":"ListSessionsResult","errorCodes":["internal"]},
  {"number":"C06","name":"listBackgroundTasks","kind":"remote.listBackgroundTasks","tauriCommand":"workbench_list_background_tasks","surface":"gui","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ListTasksParams","resultType":"ListTasksResult","errorCodes":["internal"]},
  {"number":"C07","name":"getTaskOutput","kind":"remote.getTaskOutput","tauriCommand":"workbench_get_background_task_output","surface":"gui","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"TaskOutputParams","resultType":"TaskOutputResult","errorCodes":["cmd.not_found","cmd.invalid"]},
  {"number":"C08","name":"getFlowSnapshot","kind":"remote.getFlowSnapshot","tauriCommand":"get_flow_snapshot","surface":"engine","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"FlowSnapshotParams","resultType":"FlowSnapshotResult","errorCodes":["cmd.not_found"]},
  {"number":"C09","name":"listCommands","kind":"remote.listCommands","tauriCommand":"core_list_commands","surface":"engine","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ListCommandsParams","resultType":"ListCommandsResult","errorCodes":["internal"]},
  {"number":"C10","name":"getSearchIndex","kind":"remote.getSearchIndex","tauriCommand":"core_search_files","surface":"engine","registered":true,"domain":"monitor","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"SearchIndexParams","resultType":"SearchIndexResult","errorCodes":["cmd.engine_not_ready"]},
  {"number":"C11","name":"approve","kind":"remote.approve","tauriCommand":"core_approve_tool","surface":"engine","registered":true,"domain":"approval","write":true,"outbox":true,"idempotencyKey":"toolCallId + msgId","paramsType":"ApproveParams","resultType":"ApproveResult","errorCodes":["cmd.approval_mismatch","cmd.denied","approval.expired","approval.rejected"]},
  {"number":"C12","name":"deny","kind":"remote.deny","tauriCommand":"core_deny_tool","surface":"engine","registered":true,"domain":"approval","write":true,"outbox":true,"idempotencyKey":"toolCallId + msgId","paramsType":"DenyParams","resultType":"ApproveResult","errorCodes":["cmd.approval_mismatch","cmd.denied","approval.expired","approval.rejected"]},
  {"number":"C13","name":"listPendingApprovals","kind":"remote.listPendingApprovals","tauriCommand":"mobile_list_pending_approvals","surface":"engine","registered":false,"domain":"approval","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ListPendingApprovalsParams","resultType":"ListPendingApprovalsResult","errorCodes":["internal"]},
  {"number":"C14","name":"approvalHistory","kind":"remote.approvalHistory","tauriCommand":"mobile_approval_sync_state","surface":"engine","registered":false,"domain":"approval","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ApprovalHistoryParams","resultType":"ApprovalHistoryResult","errorCodes":["cmd.not_found"]},
  {"number":"C15","name":"checkCommand","kind":"remote.checkCommand","tauriCommand":"core_check_command","surface":"engine","registered":true,"domain":"approval","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"CheckCommandParams","resultType":"CheckCommandResult","errorCodes":["cmd.unknown"]},
  {"number":"C16","name":"listDir","kind":"remote.listDir","tauriCommand":"workbench_list_directory","surface":"gui","registered":true,"domain":"files","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ListDirParams","resultType":"ListDirResult","errorCodes":["file.not_found","file.not_granted","cmd.invalid"]},
  {"number":"C17","name":"readFile","kind":"remote.readFile","tauriCommand":"workbench_read_file_content","surface":"gui","registered":true,"domain":"files","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ReadFileParams","resultType":"ReadFileResult","errorCodes":["file.not_found","file.too_large","file.not_granted","file.binary","file.encoding","cmd.invalid"]},
  {"number":"C18","name":"writeFile","kind":"remote.writeFile","tauriCommand":"workbench_write_file_content","surface":"gui","registered":true,"domain":"files","write":true,"outbox":true,"idempotencyKey":"msgId","paramsType":"WriteFileParams","resultType":"WriteFileResult","errorCodes":["file.not_granted","cmd.invalid","file.too_large","cmd.denied","file.exists"]},
  {"number":"C19","name":"listWorkspaces","kind":"remote.listWorkspaces","tauriCommand":"workbench_list_workspaces","surface":"gui","registered":false,"domain":"files","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ListWorkspacesParams","resultType":"ListWorkspacesResult","errorCodes":["internal"]},
  {"number":"C20","name":"switchWorkspace","kind":"remote.switchWorkspace","tauriCommand":"workbench_open_workspace","surface":"gui","registered":false,"domain":"files","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"SwitchWorkspaceParams","resultType":"SwitchWorkspaceResult","errorCodes":["file.not_granted","cmd.not_found"]},
  {"number":"C21","name":"searchFiles","kind":"remote.searchFiles","tauriCommand":"mobile_search_files","surface":"engine","registered":false,"domain":"files","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"SearchFilesParams","resultType":"SearchFilesResult","errorCodes":["cmd.invalid","file.not_granted"]},
  {"number":"C22","name":"assetUrl","kind":"remote.assetUrl","tauriCommand":"mobile_asset_url","surface":"engine","registered":false,"domain":"files","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"AssetUrlParams","resultType":"AssetUrlResult","errorCodes":["file.not_granted","file.not_found"]},
  {"number":"C23","name":"fileStat","kind":"remote.fileStat","tauriCommand":"file_stat","surface":"engine","registered":false,"domain":"files","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"FileStatParams","resultType":"FileStatResult","errorCodes":["file.not_found","file.not_granted"]},
  {"number":"C24","name":"runTask","kind":"remote.runTask","tauriCommand":"core_run_task","surface":"engine","registered":true,"domain":"sessions","write":true,"outbox":false,"idempotencyKey":"clientMessageId","paramsType":"RunTaskParams","resultType":"RunTaskResult","errorCodes":["cmd.engine_not_ready","cmd.restore_in_progress","cmd.session_busy","cmd.denied","cmd.invalid"]},
  {"number":"C25","name":"runControl","kind":"remote.runControl","tauriCommand":"core_run_control","surface":"engine","registered":true,"domain":"sessions","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"RunControlParams","resultType":"RunControlResult","errorCodes":["cmd.not_found","cmd.invalid","cmd.denied"]},
  {"number":"C26","name":"cancelRun","kind":"remote.cancelRun","tauriCommand":"core_cancel_run","surface":"engine","registered":true,"domain":"sessions","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"CancelRunParams","resultType":"CancelRunResult","errorCodes":["cmd.not_found","cmd.invalid"]},
  {"number":"C27","name":"searchSessions","kind":"remote.searchSessions","tauriCommand":"mobile_search_sessions","surface":"engine","registered":false,"domain":"sessions","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"SearchSessionsParams","resultType":"SearchSessionsResult","errorCodes":["cmd.unknown","cmd.invalid"]},
  {"number":"C28","name":"getSettings","kind":"remote.getSettings","tauriCommand":"config_get","surface":"engine","registered":true,"domain":"settings","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"GetSettingsParams","resultType":"GetSettingsResult","errorCodes":["cmd.denied","internal"]},
  {"number":"C29","name":"setSettings","kind":"remote.setSettings","tauriCommand":"config_update","surface":"engine","registered":true,"domain":"settings","write":true,"outbox":true,"idempotencyKey":"key + value / confirmRequestId","paramsType":"SetSettingsParams","resultType":"SetSettingsResult","errorCodes":["cmd.denied","cmd.invalid","settings.key_denied","settings.confirm_timeout"]},
  {"number":"C30","name":"settingsConfirm","kind":"remote.settingsConfirm","tauriCommand":"mobile_settings_confirm","surface":"engine","registered":false,"domain":"settings","write":false,"outbox":false,"idempotencyKey":"confirmRequestId","paramsType":"SettingsConfirmParams","resultType":"SettingsConfirmResult","errorCodes":["cmd.not_found"]},
  {"number":"C31","name":"pauseAutomation","kind":"remote.pauseAutomation","tauriCommand":"mobile_pause_automation","surface":"engine","registered":false,"domain":"settings","write":true,"outbox":true,"idempotencyKey":"msgId","paramsType":"PauseAutomationParams","resultType":"PauseAutomationResult","errorCodes":["cmd.denied"]},
  {"number":"C32","name":"queryPresence","kind":"remote.queryPresence","tauriCommand":"device_presence_query","surface":"engine","registered":false,"domain":"settings","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"PresenceParams","resultType":"PresenceResult","errorCodes":["internal"]},
  {"number":"C33","name":"listDevices","kind":"remote.listDevices","tauriCommand":"device_registry_query","surface":"engine","registered":false,"domain":"devices","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"ListDevicesParams","resultType":"ListDevicesResult","errorCodes":["internal"]},
  {"number":"C34","name":"renameDevice","kind":"remote.renameDevice","tauriCommand":"device_registry_update","surface":"engine","registered":false,"domain":"devices","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"RenameDeviceParams","resultType":"GenericOkResult","errorCodes":["cmd.not_found"]},
  {"number":"C35","name":"revokeDevice","kind":"remote.revokeDevice","tauriCommand":"device_registry_delete","surface":"engine","registered":false,"domain":"devices","write":true,"outbox":false,"idempotencyKey":"natural","paramsType":"RevokeDeviceParams","resultType":"GenericOkResult","errorCodes":["cmd.not_found"]},
  {"number":"C36","name":"getPairState","kind":"remote.getPairState","tauriCommand":"pairing_service_query","surface":"engine","registered":false,"domain":"devices","write":false,"outbox":false,"idempotencyKey":"natural","paramsType":"PairStateParams","resultType":"PairStateResult","errorCodes":["internal"]},
  {"number":"C37","name":"unlink","kind":"remote.unlink","tauriCommand":"device_registry_unlink","surface":"engine","registered":false,"domain":"devices","write":true,"outbox":false,"idempotencyKey":"natural","paramsType":"UnlinkParams","resultType":"UnlinkResult","errorCodes":["cmd.not_found"]}
] as const;
export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];
export type DeviceCommandKind = DeviceCommand["kind"];

export const COMMAND_WHITELIST = ["remote.getStatus","remote.getRunSnapshot","remote.readSessionEvents","remote.readRunEvents","remote.listSessions","remote.getFlowSnapshot","remote.listCommands","remote.getSearchIndex","remote.approve","remote.deny","remote.checkCommand","remote.runTask","remote.runControl","remote.cancelRun","remote.getSettings","remote.setSettings"] as const;
export type CommandWhitelistKind = (typeof COMMAND_WHITELIST)[number];

export interface CommandParamsTypeMap {
  StatusQuery: StatusQuery;
  RunSnapshotParams: RunSnapshotParams;
  EventPageParams: EventPageParams;
  RunEventsParams: RunEventsParams;
  ListSessionsParams: ListSessionsParams;
  ListTasksParams: ListTasksParams;
  TaskOutputParams: TaskOutputParams;
  FlowSnapshotParams: FlowSnapshotParams;
  ListCommandsParams: ListCommandsParams;
  SearchIndexParams: SearchIndexParams;
  ApproveParams: ApproveParams;
  DenyParams: DenyParams;
  ListPendingApprovalsParams: ListPendingApprovalsParams;
  ApprovalHistoryParams: ApprovalHistoryParams;
  CheckCommandParams: CheckCommandParams;
  ListDirParams: ListDirParams;
  ReadFileParams: ReadFileParams;
  WriteFileParams: WriteFileParams;
  ListWorkspacesParams: ListWorkspacesParams;
  SwitchWorkspaceParams: SwitchWorkspaceParams;
  SearchFilesParams: SearchFilesParams;
  AssetUrlParams: AssetUrlParams;
  FileStatParams: FileStatParams;
  RunTaskParams: RunTaskParams;
  RunControlParams: RunControlParams;
  CancelRunParams: CancelRunParams;
  SearchSessionsParams: SearchSessionsParams;
  GetSettingsParams: GetSettingsParams;
  SetSettingsParams: SetSettingsParams;
  SettingsConfirmParams: SettingsConfirmParams;
  PauseAutomationParams: PauseAutomationParams;
  PresenceParams: PresenceParams;
  ListDevicesParams: ListDevicesParams;
  RenameDeviceParams: RenameDeviceParams;
  RevokeDeviceParams: RevokeDeviceParams;
  PairStateParams: PairStateParams;
  UnlinkParams: UnlinkParams;
}

export interface CommandResultTypeMap {
  StatusResult: StatusResult;
  RunSnapshotResult: RunSnapshotResult;
  EventPageResult: EventPageResult;
  ListSessionsResult: ListSessionsResult;
  ListTasksResult: ListTasksResult;
  TaskOutputResult: TaskOutputResult;
  FlowSnapshotResult: FlowSnapshotResult;
  ListCommandsResult: ListCommandsResult;
  SearchIndexResult: SearchIndexResult;
  ApproveResult: ApproveResult;
  ListPendingApprovalsResult: ListPendingApprovalsResult;
  ApprovalHistoryResult: ApprovalHistoryResult;
  CheckCommandResult: CheckCommandResult;
  ListDirResult: ListDirResult;
  ReadFileResult: ReadFileResult;
  WriteFileResult: WriteFileResult;
  ListWorkspacesResult: ListWorkspacesResult;
  SwitchWorkspaceResult: SwitchWorkspaceResult;
  SearchFilesResult: SearchFilesResult;
  AssetUrlResult: AssetUrlResult;
  FileStatResult: FileStatResult;
  RunTaskResult: RunTaskResult;
  RunControlResult: RunControlResult;
  CancelRunResult: CancelRunResult;
  SearchSessionsResult: SearchSessionsResult;
  GetSettingsResult: GetSettingsResult;
  SetSettingsResult: SetSettingsResult;
  SettingsConfirmResult: SettingsConfirmResult;
  PauseAutomationResult: PauseAutomationResult;
  PresenceResult: PresenceResult;
  ListDevicesResult: ListDevicesResult;
  GenericOkResult: GenericOkResult;
  PairStateResult: PairStateResult;
  UnlinkResult: UnlinkResult;
}

export type CommandParamsOf<C extends DeviceCommand> = CommandParamsTypeMap[C["paramsType"]];
export type CommandResultOf<C extends DeviceCommand> = CommandResultTypeMap[C["resultType"]];

