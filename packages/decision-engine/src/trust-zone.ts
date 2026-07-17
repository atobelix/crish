/**
 * 信任区（TrustZone）— 权限架构核心。
 *
 * 不再用「isReadOnly 二元」驱动策略，而是：
 *   工具 + 参数 → 风险分级 → TrustZone → 模式矩阵 → allow | ask | deny
 *
 * T0 只读      — 任何模式默认可自动
 * T1 工作区写  — ask 需确认；full 自动（工作区内变更，有 snapshot/checkpoint）
 * T2 网络/进程 — ask/auto 可自动；plan 拒绝
 * T3 有风险    — ask 需确认；full 自动（破坏性 / 外泄 / 凭据）
 * T4 极危      — ask/plan/unattended 拒绝；full 仍需确认
 */

import { classifyCommand, type CommandRisk } from "./command-classifier.js";
import { DEFAULT_HARDLINE_REGISTRY } from "./hardline-patterns.js";

/** 已知信任区（升序：低 → 高） */
export const TRUST_ZONES = ["T0", "T1", "T2", "T3", "T4"] as const;

export type TrustZone = (typeof TRUST_ZONES)[number];

export type TrustBehavior = "allow" | "ask" | "deny";

/** 引擎权限模式（含 unattended 架构位） */
export const TRUST_POLICY_MODES = [
  "ask",
  "auto",
  "full-access",
  "plan",
  "unattended",
] as const;

export type TrustPolicyMode = (typeof TRUST_POLICY_MODES)[number];

/** 与 UI / BE-04 对齐的风险等级 */
export type TrustRiskLevel = "low" | "medium" | "high" | "critical";

export type TrustZoneResolution = {
  zone: TrustZone;
  risk: CommandRisk | "hardline" | "readonly-tool" | "workspace-tool" | "unknown-tool";
  reason: string;
  /** 用于会话意图缓存的指纹（不含具体参数） */
  intentKey: string;
  command?: string;
};

/** 信任区短标签（中文；与桌面审批 badge 语义一致） */
export const TRUST_ZONE_LABELS: Readonly<Record<TrustZone, string>> = Object.freeze({
  T0: "只读",
  T1: "工作区写",
  T2: "网络/进程",
  T3: "有风险",
  T4: "极危",
});

/** 信任区说明（中文副文案） */
export const TRUST_ZONE_HINTS: Readonly<Record<TrustZone, string>> = Object.freeze({
  T0: "只读类操作，任意模式默认可自动",
  T1: "工作区写入；ask 需确认，full 可自动",
  T2: "网络或进程类；ask/auto 可自动，plan 拒绝",
  T3: "破坏性 / 外泄 / 凭据；ask 需确认，full 可自动",
  T4: "极危 hardline；禁止静默放行，full 仍需确认",
});

/** 信任区数值等级（越高越危险） */
export const TRUST_ZONE_LEVEL: Readonly<Record<TrustZone, number>> = Object.freeze({
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
  T4: 4,
});

/** 未知区代码时的保守回落（按高风险处理，需确认 / unattended 拒绝） */
export const UNKNOWN_ZONE_FALLBACK: TrustZone = "T3";

/**
 * 模式 × 信任区 → 默认行为
 *
 * 产品约定（2026-07）：
 * - 只读 T0：始终自动
 * - 工作区写入 T1：ask 需确认；full 自动
 * - 网络/进程 T2：可自动
 * - 风险 T3：ask 需确认；full 自动（由系统提示约束极危操作）
 * - 极危 T4：ask 拒绝；full 仍确认（不可静默）
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
    T3: "allow",
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

// ─── 守卫 / 元数据 ──────────────────────────────────────────────────────────

/** 是否为已知信任区 T0–T4 */
export function isTrustZone(v: unknown): v is TrustZone {
  if (typeof v !== "string") return false;
  const z = v.trim().toUpperCase();
  return (TRUST_ZONES as readonly string[]).includes(z);
}

/** 是否为已知权限模式 */
export function isTrustPolicyMode(v: unknown): v is TrustPolicyMode {
  if (typeof v !== "string") return false;
  return (TRUST_POLICY_MODES as readonly string[]).includes(v.trim() as TrustPolicyMode);
}

/**
 * 规范化信任区：trim + 大写；空白/非字符串 → undefined。
 * 保留未知代码字符串（大写）以便调用方透传，仅规范形态。
 */
export function normalizeTrustZone(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    const s = String(v).trim().toUpperCase();
    return s || undefined;
  }
  if (typeof v !== "string") return undefined;
  const s = v.trim().toUpperCase();
  return s || undefined;
}

/**
 * 将任意输入收成已知 TrustZone；未知 / 空 → fallback（默认 T3 保守）。
 */
export function coerceTrustZone(v: unknown, fallback: TrustZone = UNKNOWN_ZONE_FALLBACK): TrustZone {
  const n = normalizeTrustZone(v);
  if (n && isTrustZone(n)) return n;
  return isTrustZone(fallback) ? fallback : UNKNOWN_ZONE_FALLBACK;
}

/** 模式规范化；未知 → ask */
export function coerceTrustPolicyMode(
  v: unknown,
  fallback: TrustPolicyMode = "ask",
): TrustPolicyMode {
  if (typeof v === "string") {
    const m = v.trim() as TrustPolicyMode;
    if (isTrustPolicyMode(m)) return m;
  }
  return isTrustPolicyMode(fallback) ? fallback : "ask";
}

/** 信任区短标签；未知区返回空串（不瞎编） */
export function trustZoneLabel(zone: unknown): string {
  const z = coerceTrustZone(zone, UNKNOWN_ZONE_FALLBACK);
  if (!isTrustZone(normalizeTrustZone(zone) ?? "")) {
    // 输入本身不是已知区：不伪装成 fallback 的标签
    const raw = normalizeTrustZone(zone);
    return raw ? raw : "";
  }
  return TRUST_ZONE_LABELS[z];
}

/** 信任区说明；未知区返回空串 */
export function trustZoneHint(zone: unknown): string {
  const raw = normalizeTrustZone(zone);
  if (!raw || !isTrustZone(raw)) return "";
  return TRUST_ZONE_HINTS[raw];
}

/** 数值等级；未知 → UNKNOWN_ZONE_FALLBACK 的等级 */
export function trustZoneLevel(zone: unknown): number {
  return TRUST_ZONE_LEVEL[coerceTrustZone(zone)];
}

/** 风险等级映射（与 runtime riskPresentationFromZone 对齐） */
export function riskLevelForZone(zone: unknown): TrustRiskLevel {
  const z = coerceTrustZone(zone);
  switch (z) {
    case "T0":
      return "low";
    case "T1":
    case "T2":
      return "medium";
    case "T3":
      return "high";
    case "T4":
      return "critical";
    default:
      return "high";
  }
}

/** 比较两区：负 = a 更安全，0 = 同级，正 = a 更危险 */
export function compareTrustZones(a: unknown, b: unknown): number {
  return trustZoneLevel(a) - trustZoneLevel(b);
}

/** 结构化描述（展示 / 日志） */
export function describeTrustZone(zone: unknown): {
  zone: TrustZone;
  known: boolean;
  label: string;
  hint: string;
  level: number;
  riskLevel: TrustRiskLevel;
} {
  const raw = normalizeTrustZone(zone);
  const known = Boolean(raw && isTrustZone(raw));
  const z = known ? (raw as TrustZone) : UNKNOWN_ZONE_FALLBACK;
  return {
    zone: z,
    known,
    label: known ? TRUST_ZONE_LABELS[z] : raw ?? "",
    hint: known ? TRUST_ZONE_HINTS[z] : "",
    level: TRUST_ZONE_LEVEL[z],
    riskLevel: riskLevelForZone(z),
  };
}

// ─── 内部：风险 → 区 ────────────────────────────────────────────────────────

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
    default: {
      // 穷尽守卫：未来新增 CommandRisk 时不静默落到 T1 而不被察觉
      const _exhaustive: never = risk;
      void _exhaustive;
      return UNKNOWN_ZONE_FALLBACK;
    }
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

function extractCommand(params: Record<string, unknown>): string | undefined {
  if (typeof params.command === "string" && params.command.trim()) return params.command;
  if (typeof params.cmd === "string" && params.cmd.trim()) return params.cmd;
  if (typeof params.script === "string" && params.script.trim()) return params.script;
  return undefined;
}

function isTerminalTool(toolName: string): boolean {
  return (
    toolName.includes("shell") ||
    toolName.includes("command") ||
    toolName.includes("terminal") ||
    toolName === "bash" ||
    toolName === "exec"
  );
}

// ─── 意图指纹 ───────────────────────────────────────────────────────────────

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
  const zone = coerceTrustZone(input.zone);
  const tool = (input.toolName || "tool").toLowerCase();
  const risk = (input.risk || "unknown").toLowerCase();
  if (input.command && input.command.trim()) {
    return `${zone}|${risk}|shell|${normalizeCommandIntent(input.command)}`;
  }
  if (WORKSPACE_WRITE_TOOL_RE.test(tool)) {
    return `${zone}|write|edit-family|*`;
  }
  if (READONLY_TOOL_RE.test(tool)) {
    return `${zone}|read|${tool}|*`;
  }
  return `${zone}|${risk}|${tool}|*`;
}

// ─── 解析 ───────────────────────────────────────────────────────────────────

/**
 * 解析工具调用所属信任区。
 * shell：优先命令分类 + hardline；其它工具按名称族。
 */
export function resolveTrustZone(input: {
  toolName: string;
  parameters?: Record<string, unknown> | null;
  isReadOnly?: boolean;
}): TrustZoneResolution {
  const toolName = (input.toolName || "").toLowerCase().trim();
  const params =
    input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)
      ? input.parameters
      : {};
  const command = extractCommand(params);
  const isTerminal = isTerminalTool(toolName);

  // ── T4 极危（命令级 hardline）──
  if (command) {
    const hard = DEFAULT_HARDLINE_REGISTRY.isHardline(command);
    if (hard) {
      const zone: TrustZone = "T4";
      return {
        zone,
        risk: "hardline",
        reason: hard.reason || "极危 hardline 命令",
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
      reason: "本地 git add/commit/stash — ask 模式下自动",
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

  // ── 文件系统只读工具（名称族；shell 不靠名称冒充只读）──
  if (READONLY_TOOL_RE.test(toolName) && !isTerminal) {
    const zone: TrustZone = "T0";
    return {
      zone,
      risk: "readonly-tool",
      reason: "只读工具",
      intentKey: buildIntentKey({ toolName, zone, risk: "read" }),
    };
  }

  // shell 但 isReadOnly（分类为 read 的命令）
  if (isTerminal && input.isReadOnly === true) {
    const zone: TrustZone = "T0";
    return {
      zone,
      risk: "read",
      reason: "只读 shell 命令",
      command,
      intentKey: buildIntentKey({ toolName, zone, risk: "read", command }),
    };
  }

  // 非 shell 且标记只读
  if (!isTerminal && input.isReadOnly === true) {
    const zone: TrustZone = "T0";
    return {
      zone,
      risk: "readonly-tool",
      reason: "工具标记为只读",
      intentKey: buildIntentKey({ toolName, zone, risk: "read" }),
    };
  }

  // ── 工作区编辑工具 ──
  if (WORKSPACE_WRITE_TOOL_RE.test(toolName)) {
    const zone: TrustZone = "T1";
    return {
      zone,
      risk: "workspace-tool",
      reason: "工作区变更工具",
      intentKey: buildIntentKey({ toolName, zone, risk: "write" }),
    };
  }

  // ── 网络类工具名 ──
  if (NETWORK_TOOL_RE.test(toolName)) {
    const zone: TrustZone = "T2";
    return {
      zone,
      risk: "network",
      reason: "具备网络能力的工具",
      intentKey: buildIntentKey({ toolName, zone, risk: "network" }),
    };
  }

  // ── shell 无 command：保守 T2 ──
  if (isTerminal) {
    const zone: TrustZone = "T2";
    return {
      zone,
      risk: "unknown-tool",
      reason: "Shell 无可用分类命令 — 按网络/进程保守处理",
      intentKey: buildIntentKey({ toolName, zone, risk: "unknown" }),
    };
  }

  // ── 默认：未分类工具按工作区写（T1）──
  const zone: TrustZone = "T1";
  return {
    zone,
    risk: "unknown-tool",
    reason: "未分类工具 — 按工作区写处理",
    intentKey: buildIntentKey({ toolName: toolName || "tool", zone, risk: "write" }),
  };
}

/**
 * 查矩阵。未知 mode → ask 行；未知 zone → T3 列（保守，需确认 / unattended 拒绝）。
 * 永不返回 undefined。
 */
export function behaviorForMode(
  mode: TrustPolicyMode | string,
  zone: TrustZone | string,
): TrustBehavior {
  const safeMode = coerceTrustPolicyMode(mode, "ask");
  const safeZone = coerceTrustZone(zone, UNKNOWN_ZONE_FALLBACK);
  const row = TRUST_ZONE_MATRIX[safeMode] ?? TRUST_ZONE_MATRIX.ask;
  const behavior = row[safeZone];
  // 双重守卫：矩阵残缺时仍给确定值
  if (behavior === "allow" || behavior === "ask" || behavior === "deny") {
    return behavior;
  }
  return "ask";
}

/** 端到端：解析区 + 查表 */
export function decideByTrustZone(input: {
  mode: TrustPolicyMode | string;
  toolName: string;
  parameters?: Record<string, unknown> | null;
  isReadOnly?: boolean;
}): {
  behavior: TrustBehavior;
  resolution: TrustZoneResolution;
  matchedRule: string;
} {
  const mode = coerceTrustPolicyMode(input.mode, "ask");
  const resolution = resolveTrustZone({
    toolName: typeof input.toolName === "string" ? input.toolName : "",
    parameters: input.parameters,
    isReadOnly: input.isReadOnly,
  });
  // 解析结果若异常区代码，仍保守回落
  const zone = coerceTrustZone(resolution.zone, UNKNOWN_ZONE_FALLBACK);
  if (zone !== resolution.zone) {
    resolution.zone = zone;
  }
  const behavior = behaviorForMode(mode, zone);
  return {
    behavior,
    resolution,
    matchedRule: `trust-${mode}-${zone}-${behavior}`,
  };
}
