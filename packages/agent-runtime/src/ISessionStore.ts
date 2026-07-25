import type { AgentMessage } from "@crish/shared-types";
import type { SessionBranch, MessageRangeQuery, MessageRangeResult, SessionStats, AppendResult } from "./session-store";
import type { ArchiveStore } from "./session-store/archive-store";

export interface ISessionStore {
  getSessionId(): string;
  appendMessage(message: AgentMessage, turnIndex: number, estimatedTokens?: number): Promise<AppendResult> | AppendResult;
  appendMessages(messages: AgentMessage[], turnIndex: number, estimatedTokens?: number): Promise<AppendResult> | AppendResult;
  queryRange(query?: MessageRangeQuery): MessageRangeResult;
  getAllMessages(): AgentMessage[];
  getActiveBranch(): SessionBranch;
  getBranch(branchId: string): SessionBranch | undefined;
  listBranches(): SessionBranch[];
  getActiveBranchId(): string;
  getStats(): SessionStats;
  registerBranch(branch: SessionBranch): void;
  setActiveBranch(branchId: string): void;
  setArchiveStore(store: ArchiveStore): void;
}
