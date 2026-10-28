import React from 'react';
import {
  approvalRiskKindLabel,
  approvalRiskLevelLabel,
  approvalTrustZoneLabel,
  type ApprovalRiskMeta,
} from '../../api/approvalMeta';
import type { ApprovalRiskChip } from '../../api/chatApprovalUi';
import styles from './ApprovalAskCard.module.css';

/** 将 helper 产出的英/代码 chips 本地化为中文短标签（不改 chatApprovalUi） */
export function localizeRiskChips(
  chips: ApprovalRiskChip[],
  riskMeta: ApprovalRiskMeta | null
): ApprovalRiskChip[] {
  if (chips.length === 0) return chips;
  return chips.map((chip) => {
    if (chip.key === 'zone') {
      const zh = approvalTrustZoneLabel(riskMeta?.trustZone || chip.label);
      return zh && zh !== chip.label ? { ...chip, label: zh } : chip;
    }
    if (chip.key === 'risk') {
      const zh = approvalRiskKindLabel(riskMeta?.risk || chip.label);
      return zh && zh !== chip.label ? { ...chip, label: zh } : chip;
    }
    if (chip.key === 'level') {
      const raw = riskMeta?.riskLevel || chip.label;
      const zh = approvalRiskLevelLabel(raw);
      return zh && zh !== chip.label ? { ...chip, label: zh } : chip;
    }
    // double / snap 已是中文
    return chip;
  });
}

/** 去重中文 chip 标签（zone/risk 中文可能撞车，如写操作） */
export function dedupeChipLabels(
  chips: ApprovalRiskChip[]
): ApprovalRiskChip[] {
  const seen = new Set<string>();
  const out: ApprovalRiskChip[] = [];
  for (const c of chips) {
    const k = c.label.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** 风险 chip 渲染（兼收 badge 族，与 E3 联动） */
export const ApprovalRiskChips: React.FC<{
  chips: ApprovalRiskChip[];
  id: string;
}> = ({ chips, id }) => {
  return (
    <div
      className={styles.approvalCardMeta}
      id={id}
      role="list"
      aria-label="风险标签"
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          role="listitem"
          className={`${styles.approvalCardChip} ${
            chip.tone === 'warn'
              ? styles.approvalCardChipWarn
              : chip.tone === 'danger'
                ? styles.approvalCardChipDanger
                : chip.tone === 'info'
                  ? styles.approvalCardChipInfo
                  : chip.tone === 'neutral'
                    ? styles.approvalCardChipNeutral
                    : ''
          }`}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
};
