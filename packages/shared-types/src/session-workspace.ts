export const SESSION_ACTION_PROTOCOL_VERSION = 1;

export const SESSION_ACTION_KINDS = [
  "pin",
  "unpin",
  "fork",
  "rename",
  "archive",
  "unarchive",
  "delete",
  "rewind",
  "open"
] as const;

export const SESSION_OPEN_TARGETS = ["split-view"] as const;

type SESSION_PANE_ROLES = ["primary", "secondary", "reference", "diff"];

export const SPLIT_LAYOUT_MAX_PANES = 6;

export type SessionActionKind = (typeof SESSION_ACTION_KINDS)[number];

export type SessionOpenTarget = (typeof SESSION_OPEN_TARGETS)[number];

export type SessionPaneRole = SESSION_PANE_ROLES[number];

export const SESSION_ACTION_STATUSES = ["pending", "committed", "rejected", "failed"] as const;

export type SplitAxis = "horizontal" | "vertical";

export type SplitLayoutNode =
  | {
      type: "pane";
      paneId: string;
    }
  | {
      type: "split";
      axis: SplitAxis;
      first: SplitLayoutNode;
      second: SplitLayoutNode;
      ratio: number;
    };

export interface SessionActionConsistencyRef {
  expectedSessionVersion?: string;
  eventLogCursor?: string;
  workspaceVersionId?: string;
  parentActionId?: string;
}

export interface SessionActionBase {
  protocolVersion: typeof SESSION_ACTION_PROTOCOL_VERSION;
  actionId: string;
  kind: SessionActionKind;
  sessionId: string;
  requestedAt: string;
  requestedBy: "workbench" | "daemon" | "automation";
  idempotencyKey?: string;
  consistency?: SessionActionConsistencyRef;
}

export type SessionAction =
  | (SessionActionBase & {
      kind: "pin" | "unpin" | "archive" | "unarchive" | "delete";
    })
  | (SessionActionBase & {
      kind: "rename";
      title: string;
    })
  | (SessionActionBase & {
      kind: "fork";
      fromEventId?: string;
      fromMessageId?: string;
      targetSessionId?: string;
    })
  | (SessionActionBase & {
      kind: "rewind";
      targetEventId: string;
      restoreWorkspace: boolean;
    })
  | (SessionActionBase & {
      kind: "open";
      target: SessionOpenTarget;
      paneId?: string;
    });

export type SessionActionStatus = (typeof SESSION_ACTION_STATUSES)[number];

export interface SessionActionReceipt {
  protocolVersion: typeof SESSION_ACTION_PROTOCOL_VERSION;
  actionId: string;
  kind: SessionActionKind;
  sessionId: string;
  status: SessionActionStatus;
  committedAt?: string;
  resultingSessionId?: string;
  resultingEventId?: string;
  resultingWorkspaceVersionId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface SessionPaneBinding {
  paneId: string;
  sessionId: string;
  role: SessionPaneRole;
  title?: string | undefined;
  selectedEventId?: string | undefined;
  selectedMessageId?: string | undefined;
  pendingActionIds?: string[] | undefined;
}

export interface SplitLayout {
  layoutId: string;
  activePaneId: string;
  panes: SessionPaneBinding[];
  root: SplitLayoutNode;
  updatedAt: string;
  revision: number;
}

export interface SplitLayoutValidationIssue {
  code:
    | "missing-active-pane"
    | "too-many-panes"
    | "duplicate-pane-id"
    | "unknown-pane-reference"
    | "orphan-pane"
    | "invalid-ratio";
  message: string;
  paneId?: string;
}

export interface SplitLayoutValidationResult {
  ok: boolean;
  issues: SplitLayoutValidationIssue[];
}

export function isSessionActionKind(value: unknown): value is SessionActionKind {
  return typeof value === "string" && SESSION_ACTION_KINDS.includes(value as SessionActionKind);
}

export function isSessionOpenTarget(value: unknown): value is SessionOpenTarget {
  return typeof value === "string" && SESSION_OPEN_TARGETS.includes(value as SessionOpenTarget);
}

export function createSingleSessionLayout(input: {
  layoutId: string;
  paneId: string;
  sessionId: string;
  updatedAt: string;
  title?: string;
}): SplitLayout {
  return {
    layoutId: input.layoutId,
    activePaneId: input.paneId,
    panes: [
      {
        paneId: input.paneId,
        sessionId: input.sessionId,
        role: "primary",
        title: input.title
      }
    ],
    root: {
      type: "pane",
      paneId: input.paneId
    },
    updatedAt: input.updatedAt,
    revision: 1
  };
}

export function validateSplitLayout(layout: SplitLayout): SplitLayoutValidationResult {
  const issues: SplitLayoutValidationIssue[] = [];
  const paneIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const pane of layout.panes) {
    if (paneIds.has(pane.paneId)) {
      duplicateIds.add(pane.paneId);
    }
    paneIds.add(pane.paneId);
  }

  if (layout.panes.length > SPLIT_LAYOUT_MAX_PANES) {
    issues.push({
      code: "too-many-panes",
      message: `Split layout supports at most ${SPLIT_LAYOUT_MAX_PANES} panes.`
    });
  }

  for (const paneId of duplicateIds) {
    issues.push({
      code: "duplicate-pane-id",
      message: "Pane ids must be unique within a split layout.",
      paneId
    });
  }

  if (!paneIds.has(layout.activePaneId)) {
    issues.push({
      code: "missing-active-pane",
      message: "The active pane must reference a pane binding.",
      paneId: layout.activePaneId
    });
  }

  const referencedPaneIds = collectPaneReferences(layout.root, issues);
  for (const paneId of referencedPaneIds) {
    if (!paneIds.has(paneId)) {
      issues.push({
        code: "unknown-pane-reference",
        message: "Split layout references a pane without a binding.",
        paneId
      });
    }
  }

  for (const paneId of paneIds) {
    if (!referencedPaneIds.has(paneId)) {
      issues.push({
        code: "orphan-pane",
        message: "Pane binding is not reachable from the split layout root.",
        paneId
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function collectPaneReferences(
  node: SplitLayoutNode,
  issues: SplitLayoutValidationIssue[],
  found = new Set<string>()
): Set<string> {
  if (node.type === "pane") {
    found.add(node.paneId);
    return found;
  }

  if (node.ratio <= 0 || node.ratio >= 1) {
    issues.push({
      code: "invalid-ratio",
      message: "Split ratio must be greater than 0 and less than 1."
    });
  }

  collectPaneReferences(node.first, issues, found);
  collectPaneReferences(node.second, issues, found);
  return found;
}
