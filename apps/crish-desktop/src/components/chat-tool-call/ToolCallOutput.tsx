import React, { useMemo } from 'react';
import styles from './ChatToolCallBlock.module.css';
import type { FileDiff, MessageToolCall } from '../../store/types';
import { ToolCallInputPane } from './ToolCallInputPane';
import { ToolCallOutputPane } from './ToolCallOutputPane';
import { extractImageRefs, fullToolOutput } from '../../api/toolPresentation';
import { toolStatusZh } from './chatToolCallUtils';

export const TOOL_OUTPUT_LINE_CAP = 2000;
export const TOOL_OUTPUT_BYTE_CAP = 256 * 1024;

export interface ToolCallOutputProps {
  tc: {
    id?: string;
    output?: string | undefined;
    diffs?: FileDiff[] | undefined;
    name?: string;
    status?: string;
    arguments?: string;
    startedAt?: number;
    completedAt?: number;
  };
  bodyId: string;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
  onOpenTerminal?: (() => void) | undefined;
}

/**
 * 下一代工具卡片展开区：结构化两段式分栏 + 大输出 2000 行 / 256KB 轻量视口保护 (FIN-01, RUL-05)
 */
export const ToolCallOutput: React.FC<ToolCallOutputProps> = ({
  tc,
  bodyId,
  onOpenDiff,
  onOpenTerminal,
}) => {
  const raw = tc.output || '';
  const full = useMemo(() => fullToolOutput(raw), [raw]);
  const images = useMemo(() => extractImageRefs(raw), [raw]);

  // 计算耗时（精确至 0.1s）
  const durationStr = useMemo(() => {
    if (tc.startedAt && tc.completedAt) {
      const sec = (tc.completedAt - tc.startedAt) / 1000;
      return sec >= 0.1 ? `${sec.toFixed(1)}s` : null;
    }
    return null;
  }, [tc.startedAt, tc.completedAt]);

  // RUL-05: 2000 行 / 256KB 门限裁切保护
  const { displayOutput, isTruncated, totalLines, totalBytes } = useMemo(() => {
    if (!full) {
      return {
        displayOutput: '',
        isTruncated: false,
        totalLines: 0,
        totalBytes: 0,
      };
    }
    const lines = full.split('\n');
    const bytes =
      typeof Blob !== 'undefined' ? new Blob([full]).size : full.length;
    const overLine = lines.length > TOOL_OUTPUT_LINE_CAP;
    const overByte = bytes > TOOL_OUTPUT_BYTE_CAP;

    if (!overLine && !overByte) {
      return {
        displayOutput: full,
        isTruncated: false,
        totalLines: lines.length,
        totalBytes: bytes,
      };
    }

    // 轻量裁切
    let sliced = lines.slice(0, TOOL_OUTPUT_LINE_CAP).join('\n');
    if (sliced.length > TOOL_OUTPUT_BYTE_CAP) {
      sliced = sliced.slice(0, TOOL_OUTPUT_BYTE_CAP);
    }

    return {
      displayOutput: `${sliced}\n… [输出过长，已截断显示前 ${TOOL_OUTPUT_LINE_CAP} 行 / 256 KB]`,
      isTruncated: true,
      totalLines: lines.length,
      totalBytes: bytes,
    };
  }, [full]);

  const statusZh = toolStatusZh(
    tc.status as MessageToolCall['status'] | undefined
  );

  return (
    <div
      id={bodyId}
      className={styles.toolResultBody}
      role="region"
      aria-label={`${statusZh}的工具详情`}
    >
      {/* 📥 1. 结构化输入分栏 */}
      <ToolCallInputPane
        toolId={tc.id}
        name={tc.name}
        argumentsStr={tc.arguments}
      />

      {/* 📤 2. 结构化输出分栏 */}
      <ToolCallOutputPane
        toolId={tc.id}
        output={displayOutput}
        rawOutput={full || raw}
        status={tc.status}
        durationStr={durationStr}
        diffs={tc.diffs}
        images={images}
        isTruncated={isTruncated}
        totalLines={totalLines}
        totalBytes={totalBytes}
        onOpenDiff={onOpenDiff}
        onOpenTerminal={onOpenTerminal}
      />
    </div>
  );
};
