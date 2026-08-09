import React from 'react';
import {
  approverLabel,
  DELETE_UNKNOWN_IMPACT_HINT,
  deleteImpactSummary,
  formatRefAge,
  revertGateSummary,
  shortPath,
} from '../../api/approvalPayload';
import type { MessageToolApprovalPayload } from '../../store/types';
import styles from './ApprovalAskCard.module.css';

/**
 * S9 审批影响面区段（数据源 = approval-requested 载荷，宽容缺失）：
 * - revert-gate：回退面积摘要（文件数/行数/ref 年代/跨目录/目标）+ 阈值 +
 *   审批人标注 + 指引（S6 拒绝文案同源）；
 * - delete：目标清单 + impact 摘要 + 降级提示（impact 未上报时显式提示）。
 * 无载荷 → null（既有卡行为不变，不新增噪音）。
 */
export const ApprovalPayloadSection: React.FC<{
  payload?: MessageToolApprovalPayload | null | undefined;
}> = ({ payload }) => {
  if (!payload || payload.kind === 'unknown') return null;

  if (payload.kind === 'revert-gate') {
    const gate = payload.revertGate;
    const summary = revertGateSummary(gate);
    const area = gate.area;
    const chips: string[] = [];
    if (area?.fileCount != null) chips.push(`${area.fileCount} 个文件`);
    if (area?.lineCount != null) chips.push(`${area.lineCount} 行`);
    if (area?.refAgeSeconds != null)
      chips.push(`ref 年代 ${formatRefAge(area.refAgeSeconds)}`);
    if (area?.crossDirectory) chips.push('跨目录');
    if (gate.targetRef) chips.push(`目标 ${gate.targetRef}`);
    const approver = approverLabel(gate.approver);
    if (approver) chips.push(approver);
    return (
      <div
        className={styles.approvalCardMeta}
        role="list"
        aria-label="回退影响面"
        data-testid="approval-payload-revert"
      >
        {summary ? (
          <div
            className={styles.approvalCardDesc}
            data-testid="revert-gate-summary"
          >
            {summary}
          </div>
        ) : null}
        {chips.length > 0 ? (
          <div role="list" aria-label="回退影响面标签">
            {chips.map((label) => (
              <span
                key={label}
                role="listitem"
                className={`${styles.approvalCardChip} ${styles.approvalCardChipDanger}`}
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}
        {gate.guidance ? (
          <div
            className={styles.approvalCardHint}
            role="note"
            data-testid="revert-gate-guidance"
          >
            {gate.guidance}
          </div>
        ) : null}
      </div>
    );
  }

  const { deleteImpact } = payload;
  const impactSummary = deleteImpactSummary(deleteImpact.impact);
  const flagged = deleteImpact.impact?.flagged;
  const targets = deleteImpact.targets.slice(0, 4);
  const more = deleteImpact.targets.length - targets.length;
  return (
    <div
      className={styles.approvalCardMeta}
      role="list"
      aria-label="删除影响面"
      data-testid="approval-payload-delete"
    >
      {targets.length > 0 ? (
        <div
          className={styles.approvalCardCmdWrap}
          role="list"
          aria-label="删除目标清单"
        >
          {targets.map((t) => (
            <code
              key={t}
              role="listitem"
              className={styles.approvalCardCmd}
              data-testid="delete-target"
            >
              {shortPath(t)}
            </code>
          ))}
          {more > 0 ? (
            <span className={styles.approvalCardHint}>
              …等共 {deleteImpact.targets.length} 个目标
            </span>
          ) : null}
        </div>
      ) : null}
      {impactSummary ? (
        <div
          className={styles.approvalCardDesc}
          data-testid="delete-impact-summary"
        >
          {impactSummary}
        </div>
      ) : null}
      {flagged ? (
        <div
          className={`${styles.approvalCardHint} ${styles.approvalCardHintWarn}`}
          role="alert"
          data-testid="delete-impact-flagged"
        >
          影响面大（超过阈值），请仔细核对后再允许
        </div>
      ) : null}
      {!impactSummary ? (
        <div
          className={styles.approvalCardHint}
          role="note"
          data-testid="delete-impact-unknown"
        >
          {DELETE_UNKNOWN_IMPACT_HINT}
        </div>
      ) : null}
    </div>
  );
};
