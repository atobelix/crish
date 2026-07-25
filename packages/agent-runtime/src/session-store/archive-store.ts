import type { AgentMessage } from "@crish/shared-types";

export interface ArchivedTurn {
  turnIndex: number;
  messages: AgentMessage[];
  estimatedTokens: number;
  archivedAt: string;
}

export interface ArchiveStore {
  archiveTurn(sessionId: string, branchId: string, turn: ArchivedTurn): Promise<void>;
  loadTurn(sessionId: string, branchId: string, turnIndex: number): Promise<ArchivedTurn | null>;
  listArchivedTurns(sessionId: string, branchId: string): Promise<number[]>;
}

export class NoopArchiveStore implements ArchiveStore {
  async archiveTurn(_sessionId: string, _branchId: string, _turn: ArchivedTurn): Promise<void> {}

  async loadTurn(_sessionId: string, _branchId: string, _turnIndex: number): Promise<ArchivedTurn | null> {
    return null;
  }

  async listArchivedTurns(_sessionId: string, _branchId: string): Promise<number[]> {
    return [];
  }
}
