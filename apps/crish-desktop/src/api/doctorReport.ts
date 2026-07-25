/**
 * /doctor 诊断报告：纯函数，无 store / 网络副作用。
 * 对缺失字段诚实标注为「未提供 / 未知」，不发明 ok / model / 能力。
 */

export type DoctorStatusSlice = {
  ok?: boolean;
  connected?: boolean;
  reconnecting?: boolean;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  credentialMode?: string;
  error?: string;
  activeRuns?: number;
  pendingApprovals?: number;
};

export type DoctorCapabilityEntry = {
  id?: string;
  state?: string;
  reason?: string;
};

export type DoctorCapabilitiesSlice = {
  mcp?: string;
  error?: string;
  lifecycle?: {
    state?: string;
    reason?: string;
    configuredHint?: boolean;
  } | null;
  /** 能力条目列表；undefined=未提供，[]=空列表 */
  capabilities?: DoctorCapabilityEntry[];
};

export type FormatDoctorReportOptions = {
  /** epoch ms；缺省不写时间行 */
  fetchedAt?: number;
};

function present(value: unknown, fallback = '未提供'): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : fallback;
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value);
}

function yn(v: boolean | undefined): string {
  if (v === undefined) return '未知';
  return v ? '是' : '否';
}

/** 从 list-capabilities 原始响应抽取能力条目（纯） */
export function extractCapabilityEntries(
  raw: unknown,
): DoctorCapabilityEntry[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const snapshot =
    r.snapshot && typeof r.snapshot === 'object' && !Array.isArray(r.snapshot)
      ? (r.snapshot as Record<string, unknown>)
      : null;
  const caps = Array.isArray(snapshot?.capabilities)
    ? snapshot!.capabilities
    : Array.isArray(r.capabilities)
      ? r.capabilities
      : undefined;
  if (!caps) return undefined;
  return caps.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
    const o = c as Record<string, unknown>;
    return {
      id: typeof o.id === 'string' ? o.id : undefined,
      state: typeof o.state === 'string' ? o.state : undefined,
      reason: typeof o.reason === 'string' ? o.reason : undefined,
    };
  });
}

/** EngineStatus / 活体状态 → 报告切片（不发明字段） */
export function doctorStatusFromEngine(
  status:
    | {
        ok?: boolean;
        connected?: boolean;
        reconnecting?: boolean;
        model?: string;
        baseUrl?: string;
        hasApiKey?: boolean;
        credentialMode?: string;
        error?: string;
        activeRuns?: unknown;
        pendingApprovals?: unknown;
      }
    | null
    | undefined,
): DoctorStatusSlice | null {
  if (!status) return null;
  const slice: DoctorStatusSlice = {
    ok: status.ok,
    connected: status.connected,
    reconnecting: status.reconnecting,
    model: status.model,
    baseUrl: status.baseUrl,
    hasApiKey: status.hasApiKey,
    credentialMode: status.credentialMode,
    error: status.error,
  };
  if (Array.isArray(status.activeRuns)) {
    slice.activeRuns = status.activeRuns.length;
  } else if (
    typeof status.activeRuns === 'number' &&
    Number.isFinite(status.activeRuns)
  ) {
    slice.activeRuns = status.activeRuns;
  }
  if (Array.isArray(status.pendingApprovals)) {
    slice.pendingApprovals = status.pendingApprovals.length;
  } else if (
    typeof status.pendingApprovals === 'number' &&
    Number.isFinite(status.pendingApprovals)
  ) {
    slice.pendingApprovals = status.pendingApprovals;
  }
  return slice;
}

/** product / list-capabilities 快照 → 报告切片 */
export function doctorCapabilitiesFromSnapshot(
  snap:
    | {
        mcp?: string;
        raw?: unknown;
        lifecycle?: {
          state?: string;
          reason?: string;
          configuredHint?: boolean;
        } | null;
        error?: string;
      }
    | null
    | undefined,
): DoctorCapabilitiesSlice | null {
  if (!snap) return null;
  return {
    mcp: snap.mcp,
    lifecycle: snap.lifecycle,
    capabilities: extractCapabilityEntries(snap.raw),
    error: snap.error,
  };
}

/**
 * 格式化 /doctor 诊断 Markdown。
 * status / capabilities 为 null → 对应整段「未提供」；字段缺省 → 行内「未提供/未知」。
 */
export function formatDoctorReport(
  status: DoctorStatusSlice | null | undefined,
  capabilities: DoctorCapabilitiesSlice | null | undefined,
  opts?: FormatDoctorReportOptions,
): string {
  const lines: string[] = ['## 诊断报告', ''];

  if (opts?.fetchedAt != null && Number.isFinite(opts.fetchedAt)) {
    try {
      lines.push(`时间：${new Date(opts.fetchedAt).toISOString()}`);
      lines.push('');
    } catch {
      /* ignore invalid date */
    }
  }

  lines.push('### 引擎状态');
  if (!status) {
    lines.push('- 状态快照：未提供');
  } else {
    lines.push(`- 可用（ok）：${yn(status.ok)}`);
    lines.push(`- 已连接：${yn(status.connected)}`);
    if (status.reconnecting !== undefined) {
      lines.push(`- 重连中：${yn(status.reconnecting)}`);
    }
    lines.push(`- 模型：${present(status.model)}`);
    lines.push(`- Base URL：${present(status.baseUrl)}`);
    lines.push(
      `- API Key：${
        status.hasApiKey === undefined
          ? '未知'
          : status.hasApiKey
            ? '已配置'
            : '未配置'
      }`,
    );
    lines.push(`- 凭证模式：${present(status.credentialMode)}`);
    if (status.activeRuns !== undefined) {
      lines.push(`- 活动 runs：${present(status.activeRuns)}`);
    }
    if (status.pendingApprovals !== undefined) {
      lines.push(`- 待审批：${present(status.pendingApprovals)}`);
    }
    if (status.error) {
      lines.push(`- 错误：${status.error}`);
    }
  }

  lines.push('');
  lines.push('### 能力');
  if (!capabilities) {
    lines.push('- 能力快照：未提供');
  } else {
    lines.push(`- MCP：${present(capabilities.mcp)}`);
    if (capabilities.lifecycle === null) {
      lines.push('- mcp.lifecycle：无');
    } else if (capabilities.lifecycle === undefined) {
      lines.push('- mcp.lifecycle：未提供');
    } else {
      lines.push(
        `- mcp.lifecycle.state：${present(capabilities.lifecycle.state)}`,
      );
      lines.push(
        `- mcp.lifecycle.reason：${present(capabilities.lifecycle.reason)}`,
      );
      if (capabilities.lifecycle.configuredHint !== undefined) {
        lines.push(
          `- mcp.lifecycle.configured：${yn(capabilities.lifecycle.configuredHint)}`,
        );
      }
    }
    if (capabilities.error) {
      lines.push(`- 错误：${capabilities.error}`);
    }
    const caps = capabilities.capabilities;
    if (caps === undefined) {
      lines.push('- 能力列表：未提供');
    } else if (caps.length === 0) {
      lines.push('- 能力列表：空');
    } else {
      lines.push('- 能力列表：');
      for (const c of caps) {
        const id = present(c.id, '(无 id)');
        const state = present(c.state, '未知');
        const reason = c.reason?.trim() ? ` — ${c.reason.trim()}` : '';
        lines.push(`  - \`${id}\`: ${state}${reason}`);
      }
    }
  }

  lines.push('');
  lines.push(
    '_本报告仅汇总本地已获字段；缺失项标注为未提供/未知，不表示检查通过。_',
  );
  return lines.join('\n');
}
