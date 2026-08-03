/**
 * 审批弹窗数据源载荷（I3-S9）。
 *
 * S6 提供 approval_payload API（crates/agent-tools/src/revert.rs：revertGate
 * 载荷——文件数/行数/ref 年代/阈值/审批人=user/指引）；S8 提供 security-audit
 * 事件（ImpactAssessment 影响面）。本模块把这些载荷从 approval-requested
 * 事件 raw 中**宽容解析**（engine 侧 metadata 可能缺失 → 前端降级，不报错），
 * 并产出中文展示文案，供 ApprovalAskCard 影响面区段消费。
 *
 * 数据源位置（宽容逐级查找，与 parseApprovalRiskMeta 同风格）：
 * - revertGate：`request.metadata.revertGate` / `metadata.revertGate` /
 *   顶层 `revertGate`；
 * - delete 影响面：`request.metadata.impact` / `metadata.impact` / 顶层
 *   `impact`（S8 ImpactAssessment）；目标清单从 `parameters` 提取。
 *
 * 本模块为纯函数（无 store / 无 React），测试覆盖解析与文案。
 */
import type {
  DeleteApprovalPayload,
  MessageToolApprovalPayload,
  RevertGatePayload,
} from '../store/types';

/** 删除类工具名（S9 删除确认弹窗判别；引擎侧 delete_file / delete_dir） */
const DELETE_TOOL_NAMES = new Set(['delete_file', 'delete_dir']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNum(v: unknown): number | null | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function asBool(v: unknown): boolean | null | undefined {
  if (typeof v === 'boolean') return v;
  return undefined;
}

function asStr(v: unknown): string | null | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return undefined;
}

function pickNestedPath(
  root: Record<string, unknown>,
  ...keys: string[]
): unknown {
  let cur: unknown = root;
  for (const key of keys) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 宽容读取一个可空数字（undefined 也视为未知） */
function optNum(v: unknown): number | null {
  const n = asNum(v);
  return n === undefined ? null : n;
}

function optBool(v: unknown): boolean | null {
  const b = asBool(v);
  return b === undefined ? null : b;
}

function optStr(v: unknown): string | null {
  const s = asStr(v);
  return s === undefined ? null : s;
}

/** 解析 revertGate 载荷（宽容：字段缺失/类型错 → null 或可空） */
export function parseRevertGatePayload(raw: unknown): RevertGatePayload | null {
  const root = isRecord(raw) ? raw : {};
  const gate = pickNestedPath(root, 'request', 'metadata', 'revertGate');
  const gate2 =
    gate === undefined ? pickNestedPath(root, 'metadata', 'revertGate') : gate;
  const gateRaw = gate2 === undefined ? root.revertGate : gate2;
  if (!isRecord(gateRaw)) return null;

  const areaRaw = isRecord(gateRaw.area) ? gateRaw.area : {};
  const thresholdsRaw = isRecord(gateRaw.thresholds) ? gateRaw.thresholds : {};
  return {
    ...(optStr(gateRaw.form) !== null
      ? { form: optStr(gateRaw.form) ?? '' }
      : {}),
    ...(optStr(gateRaw.targetRef) !== null
      ? { targetRef: optStr(gateRaw.targetRef) ?? '' }
      : {}),
    ...(optStr(gateRaw.target) !== null
      ? { target: optStr(gateRaw.target) ?? '' }
      : {}),
    ...(isRecord(gateRaw.area) || gateRaw.area !== undefined
      ? {
          area: {
            fileCount: optNum(areaRaw.fileCount),
            lineCount: optNum(areaRaw.lineCount),
            crossDirectory: optBool(areaRaw.crossDirectory),
            refAgeSeconds: optNum(areaRaw.refAgeSeconds),
          },
        }
      : {}),
    ...(isRecord(gateRaw.thresholds) || gateRaw.thresholds !== undefined
      ? {
          thresholds: {
            maxFiles: optNum(thresholdsRaw.maxFiles),
            maxLines: optNum(thresholdsRaw.maxLines),
            maxRefAgeHours: optNum(thresholdsRaw.maxRefAgeHours),
          },
        }
      : {}),
    ...(optStr(gateRaw.approver) !== null
      ? { approver: optStr(gateRaw.approver) ?? '' }
      : {}),
    ...(optStr(gateRaw.guidance) !== null
      ? { guidance: optStr(gateRaw.guidance) ?? '' }
      : {}),
  };
}

/** 从删除类工具参数提取目标路径清单（delete_file/delete_dir 的 paths/path） */
export function extractDeleteTargets(parameters: unknown): string[] {
  const params = isRecord(parameters) ? parameters : {};
  const rawPaths =
    params.paths ?? params.path ?? params.targets ?? params.target;
  const list: string[] = [];
  if (Array.isArray(rawPaths)) {
    for (const p of rawPaths) {
      const s = asStr(p);
      if (s) list.push(s);
    }
  } else {
    const s = asStr(rawPaths);
    if (s) list.push(s);
  }
  return list;
}

/** 解析删除类载荷（目标清单 + S8 impact；宽容降级） */
export function parseDeleteApprovalPayload(
  raw: unknown
): DeleteApprovalPayload | null {
  const root = isRecord(raw) ? raw : {};
  const req = isRecord(root.request) ? root.request : root;
  const parameters = isRecord(req.parameters) ? req.parameters : {};
  const targets = extractDeleteTargets(parameters);
  if (targets.length === 0) return null;

  const impactRaw =
    pickNestedPath(root, 'request', 'metadata', 'impact') ??
    pickNestedPath(root, 'metadata', 'impact') ??
    root.impact;
  const impact = isRecord(impactRaw)
    ? {
        fileCount: optNum(impactRaw.fileCount),
        totalSizeBytes: optNum(impactRaw.totalSizeBytes),
        directoryCount: optNum(impactRaw.directoryCount),
        crossDirectory: optBool(impactRaw.crossDirectory),
        flagged: optBool(impactRaw.flagged),
      }
    : undefined;

  return impact ? { targets, impact } : { targets };
}

/**
 * 从 approval-requested 事件 raw 解析 S9 载荷。
 * 无任何载荷 → null（前端降级：卡不渲染影响面区段）。
 * 永不抛；null / 非对象 → null。
 */
export function parseApprovalPayload(
  raw: unknown
): MessageToolApprovalPayload | null {
  if (!isRecord(raw)) return null;
  const req = isRecord(raw.request) ? raw.request : raw;
  const toolName = asStr(req.toolName ?? raw.toolName) ?? '';
  const revertGate = parseRevertGatePayload(raw);
  if (revertGate) {
    return { kind: 'revert-gate', revertGate };
  }
  if (DELETE_TOOL_NAMES.has(toolName)) {
    const deleteImpact = parseDeleteApprovalPayload(raw);
    if (deleteImpact) return { kind: 'delete', deleteImpact };
  }
  return null;
}

// ─── 中文文案（卡展示 / aria / 审计视图共用）────────────────────────

/** ref 年代可读化（秒 → 小时/分钟/天）；null → 「未知」 */
export function formatRefAge(seconds: number | null | undefined): string {
  if (seconds == null) return '未知';
  const hours = seconds / 3600;
  if (hours >= 48) return `${(hours / 24).toFixed(0)} 天`;
  if (hours >= 1) return `${hours.toFixed(1)} 小时`;
  return `${Math.max(1, Math.round(hours * 60))} 分钟`;
}

/** 字节可读化（< 1KB → B；< 1MB → KB；其余 MB） */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 回退影响面摘要（卡区段主行）。
 * 例：「影响 25 个文件 · 1200 行 · ref 年代 36.0 小时 · 跨目录」
 * 字段全未知 → ''（区段隐藏）。
 */
export function revertGateSummary(payload: RevertGatePayload): string {
  const parts: string[] = [];
  const area = payload.area;
  if (area) {
    if (area.fileCount != null) parts.push(`影响 ${area.fileCount} 个文件`);
    if (area.lineCount != null) parts.push(`${area.lineCount} 行`);
    if (area.refAgeSeconds != null)
      parts.push(`ref 年代 ${formatRefAge(area.refAgeSeconds)}`);
    if (area.crossDirectory) parts.push('跨目录');
  }
  const target = payload.targetRef ?? payload.target;
  if (target) parts.push(`目标 ${target}`);
  return parts.join(' · ');
}

/** 审批人标注（C3：裁决权归用户） */
export function approverLabel(approver: string | null | undefined): string {
  const a = (approver || '').trim().toLowerCase();
  if (!a) return '';
  if (a === 'user') return '审批人：用户（我）';
  return `审批人：${approver}`;
}

/** 删除影响面摘要；无 impact → ''（未知，走降级提示） */
export function deleteImpactSummary(
  impact: DeleteApprovalPayload['impact']
): string {
  if (!impact) return '';
  const parts: string[] = [];
  if (impact.fileCount != null) parts.push(`${impact.fileCount} 个文件`);
  if (impact.directoryCount != null)
    parts.push(`${impact.directoryCount} 个目录`);
  if (impact.totalSizeBytes != null)
    parts.push(`共 ${formatBytes(impact.totalSizeBytes)}`);
  if (impact.crossDirectory) parts.push('跨目录');
  return parts.join(' · ');
}

/** 目标路径展示（长路径只留尾部，避免卡内溢出） */
export function shortPath(path: string, maxLen = 48): string {
  const s = (path || '').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `…${s.slice(-maxLen)}`;
}

/** 删除降级提示（impact 缺失时展示；01 方案 S9 内容 2「降级模式显式提示」） */
export const DELETE_UNKNOWN_IMPACT_HINT =
  '影响面未上报：确认目标清单后仍可继续，删除结果可经回收站恢复面板查看';
