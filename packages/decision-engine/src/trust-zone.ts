/**
 * 信任区（TrustZone）— 权限架构核心。
 *
 * 不再用「isReadOnly 二元」驱动策略，而是：
 *   工具 + 参数 → 风险分级 → TrustZone → 模式矩阵 → allow | ask | deny
 *
 * T0 只读      — 任何模式默认可自动
 * T1 工作区写  — ask 下也可自动（工作区内变更，有 snapshot/checkpoint）
 * T2 网络/进程 — ask 需确认；full 自动
 * T3 有风险    — 默认需确认（破坏性 / 外泄 / 凭据）
 * T4 极危      — ask/plan 拒绝；full 仍需确认
 */

import { classifyCommand, type CommandRisk } from "./command-classifier.js";
import { DEFAULT_HARDLINE_REGISTRY } from "./hardline-patterns.js";

export type TrustZone = "T0" | "T1" | "T2" | "T3" | "T4";

export type TrustBehavior = "allow" | "ask" | "deny";

/** 引擎权限模式（含 unattended 架构位） */
export type TrustPolicyMode = "ask" | "auto" | "full-access" | "plan" | "unattended";

export type TrustZoneResolution = {
  zone: TrustZone;
  risk: CommandRisk | "hardline" | "readonly-tool" | "workspace-tool" | "unknown-tool";
  reason: string;
  /** 用于会话意图缓存的指纹（不含具体参数） */
  intentKey: string;
  command?: string;
};

/**
 * 模式 × 信任区 → 默认行为
 *
 * 产品约定（2026-07）：
 * - 只读 T0：始终自动
 * - 工作区写入 T1：需确认（edit / echo> / mkdir / git commit…）
 * - 网络/进程 T2：可自动（npm install / curl 等）
 * - 风险 T3：需确认（rm、git push、删分支、凭据…）
 * - 极危 T4：ask 拒绝；full 仍确认
 */
export const TRUST_ZONE_MATRIX: Record<TrustPolicyMode, Record<TrustZone, TrustBehavior>> = {
  ask: {
    T0: "allow",
    T1: "ask",
    T2: "allow",
    T3: "ask",
    T4: "deny",
  },
  auto: {
    T0: "allow",
    T1: "ask",
    T2: "allow",
    T3: "ask",
    T4: "deny",
  },
  "full-access": {
    T0: "allow",
    T1: "allow",
    T2: "allow",
    T3: "ask",
    T4: "ask",
  },
  plan: {
    T0: "allow",
    T1: "deny",
    T2: "deny",
    T3: "deny",
    T4: "deny",
  },
  unattended: {
    T0: "allow",
    T1: "allow",
    T2: "allow",
    T3: "deny",
    T4: "deny",
  },
};

const READONLY_TOOL_RE =
  /^(read|read_file|list|list_directory|glob|grep|search|search_files|stat|find|web_search|web_fetch)$/i;

const WORKSPACE_WRITE_TOOL_RE =
  /^(edit|write|write_file|str_replace|search_replace|apply_patch|apply_workspace_edits|create_file|delete_file|rename_file)$/i;

const NETWORK_TOOL_RE = /^(fetch|http|web_|mcp_|browser_)/i;

function riskToZone(risk: CommandRisk): TrustZone {
  switch (risk) {
    case "read":
      return "T0";
    case "write":
    case "unknown":
      return "T1";
    case "network":
    case "process":
      return "T2";
    case "destructive":
    case "secret":
    case "external-side-effect":
      return "T3";
    default:
      return "T1";
  }
}

/** 本地提交/暂存：自动放行；不含 push、branch -d、reset --hard */
function isAutoLocalGitCommand(command: string): boolean {
  const t = command.trim();
  if (!/^git\s+/i.test(t)) return false;
  // 推送 / 删除远程 / 硬重置 / 删分支 → 不自动
  if (/\b(push|reset\s+--hard|clean\s+-[a-z]*f)\b/i.test(t)) return false;
  if (/\bbranch\s+(-d|-D)\b/i.test(t)) return false;
  if (/\btag\s+(-d|--delete)\b/i.test(t)) return false;
  // 仅 add / commit / stash
  if (/^git\s+add(\s|$)/i.test(t)) return true;
  if (/^git\s+commit(\s|$)/i.test(t)) return true;
  if (/^git\s+stash(\s|$)/i.test(t)) return true;
  return false;
}

/** 把具体命令泛化成意图模式，供 run 内缓存 */
export function normalizeCommandIntent(command: string): string {
  let p = command.trim().toLowerCase();
  // 引号内容
  p = p.replace(/"[^"]*"/g, '"*"').replace(/'[^']*'/g, "'*'");
  // 包管理
  p = p.replace(
    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update)\s+[^\s|&;]+/gi,
    "$1 $2 *",
  );
  p = p.replace(/\b(pip|uv|pip3)\s+install\s+[^\s|&;]+/gi, "$1 install *");
  // 重定向目标
  p = p.replace(/>{1,2}\s*[^\s|&;]+/g, "> *");
  // Windows / Unix 路径
  p = p.replace(/[a-z]:\\[^\s|&;]+/gi, "*");
  p = p.replace(/(?<![:\w])\/[^\s|&;]+/g, "*");
  // 多余空白
  p = p.replace(/\s+/g, " ").trim();
  return p || "*";
}

export function buildIntentKey(input: {
  toolName: string;
  zone: TrustZone;
  risk: string;
  command?: string;
}): string {
  const tool = (input.toolName || "tool").toLowerCase();
  if (input.command && input.command.trim()) {
    return `${input.zone}|${input.risk}|shell|${normalizeCommandIntent(input.command)}`;
  }
  if (WORKSPACE_WRITE_TOOL_RE.test(tool)) {
    return `${input.zone}|write|edit-family|*`;
  }
  if (READONLY_TOOL_RE.test(tool)) {
    return `${input.zone}|read|${tool}|*`;
  }
  return `${input.zone}|${input.risk}|${tool}|*`;
}

/**
 * 解析工具调用所属信任区。
 * shell：优先命令分类 + hardline；其它工具按名称族。
 */
export function resolveTrustZone(input: {
  toolName: string;
  parameters?: Record<string, unknown> | null;
  isReadOnly?: boolean;
}): TrustZoneResolution {
  const toolName = (input.toolName || "").toLowerCase();
  const params = input.parameters ?? {};
  const command =
    typeof params.command === "string"
      ? params.command
      : typeof params.cmd === "string"
        ? params.cmd
        : typeof params.script === "string"
          ? params.script
          : undefined;

  const isTerminal =
    toolName.includes("shell") ||
    toolName.includes("command") ||
    toolName.includes("terminal") ||
    toolName === "bash" ||
    toolName === "exec";

  // ── T4 极危（命令级 hardline）──
  if (command) {
    const hard = DEFAULT_HARDLINE_REGISTRY.isHardline(command);
    if (hard) {
      const zone: TrustZone = "T4";
      return {
        zone,
        risk: "hardline",
        reason: hard.reason,
        command,
        intentKey: buildIntentKey({
          toolName,
          zone,
          risk: "hardline",
          command,
        }),
      };
    }
  }

  // ── Shell：本地 git add/commit 自动（push/删除仍走风险分级需确认）──
  if (isTerminal && command && isAutoLocalGitCommand(command)) {
    const zone: TrustZone = "T2"; // 与网络一样：需确认模式下自动
    return {
      zone,
      risk: "write",
      reason: "Local git add/commit — auto under ask",
      command,
      intentKey: buildIntentKey({
        toolName,
        zone,
        risk: "local-git",
        command,
      }),
    };
  }

  // ── Shell：完整风险分级 ──
  if (isTerminal && command) {
    const classified = classifyCommand(command);
    const zone = riskToZone(classified.risk);
    return {
      zone,
      risk: classified.risk,
      reason: classified.reason,
      command,
      intentKey: buildIntentKey({
        toolName,
        zone,
        risk: classified.risk,
        command,
      }),
    };
  }

  // ── 文件系统只读工具 ──
  if (READONLY_TOOL_RE.test(toolName) || input.isReadOnly === true) {
    // isReadOnly 且非 shell 写伪装
    if (!isTerminal || input.isReadOnly === true) {
      if (READONLY_TOOL_RE.test(toolName) || (input.isReadOnly === true && !isTerminal)) {
        const zone: TrustZone = "T0";
        return {
          zone,
          risk: "readonly-tool",
          reason: "Read-only tool",
          intentKey: buildIntentKey({ toolName, zone, risk: "read" }),
        };
      }
    }
  }

  // shell 但 isReadOnly（分类为 read 的命令）
  if (isTerminal && input.isReadOnly === true) {
    const zone: TrustZone = "T0";
    return {
      zone,
      risk: "read",
      reason: "Read-only shell command",
      command,
      intentKey: buildIntentKey({ toolName, zone, risk: "read", command }),
    };
  }

  // ── 工作区编辑工具 ──
  if (WORKSPACE_WRITE_TOOL_RE.test(toolName)) {
    const zone: TrustZone = "T1";
    return {
      zone,
      risk: "workspace-tool",
      reason: "Workspace mutation tool",
      intentKey: buildIntentKey({ toolName, zone, risk: "write" }),
    };
  }

  // ── 网络类工具名 ──
  if (NETWORK_TOOL_RE.test(toolName)) {
    const zone: TrustZone = "T2";
    return {
      zone,
      risk: "network",
      reason: "Network-capable tool",
      intentKey: buildIntentKey({ toolName, zone, risk: "network" }),
    };
  }

  // ── shell 无 command：保守 T2 ──
  if (isTerminal) {
    const zone: TrustZone = "T2";
    return {
      zone,
      risk: "unknown-tool",
      reason: "Shell without classifiable command",
      intentKey: buildIntentKey({ toolName, zone, risk: "unknown" }),
    };
  }

  // ── 默认：有 isReadOnly 则 T0，否则工作区级 T1 ──
  if (input.isReadOnly === true) {
    const zone: TrustZone = "T0";
    return {
      zone,
      risk: "readonly-tool",
      reason: "Tool marked read-only",
      intentKey: buildIntentKey({ toolName, zone, risk: "read" }),
    };
  }

  const zone: TrustZone = "T1";
  return {
    zone,
    risk: "unknown-tool",
    reason: "Unclassified tool — treated as workspace write",
    intentKey: buildIntentKey({ toolName, zone, risk: "write" }),
  };
}

/** 查矩阵 */
export function behaviorForMode(mode: TrustPolicyMode, zone: TrustZone): TrustBehavior {
  const row = TRUST_ZONE_MATRIX[mode] ?? TRUST_ZONE_MATRIX.ask;
  return row[zone];
}

/** 端到端：解析区 + 查表 */
export function decideByTrustZone(input: {
  mode: TrustPolicyMode;
  toolName: string;
  parameters?: Record<string, unknown> | null;
  isReadOnly?: boolean;
}): {
  behavior: TrustBehavior;
  resolution: TrustZoneResolution;
  matchedRule: string;
} {
  const mode = input.mode in TRUST_ZONE_MATRIX ? input.mode : "ask";
  const resolution = resolveTrustZone({
    toolName: input.toolName,
    parameters: input.parameters,
    isReadOnly: input.isReadOnly,
  });
  const behavior = behaviorForMode(mode, resolution.zone);
  return {
    behavior,
    resolution,
    matchedRule: `trust-${mode}-${resolution.zone}-${behavior}`,
  };
}
