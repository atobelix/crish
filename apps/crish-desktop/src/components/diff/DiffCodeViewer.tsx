import React from 'react';
import styles from './DiffCard.module.css';
import { DiffCardUnifiedView } from './DiffCardUnifiedView';
import { DiffCardSplitView } from './DiffCardSplitView';
import { VirtualPlainCodeViewer } from './VirtualPlainCodeViewer';
import type { FileDiff } from '../../store/types';
import type { CompareMode, ComputedChange, SplitRenderItem, UnifiedRenderItem } from './diffCardTypes';
import { AppIcon } from '../ui/icons/index';

export interface DiffCodeViewerProps {
  f: FileDiff;
  compareMode: CompareMode;
  diffViewMode: 'unified' | 'split';
  diffSearchQuery: string;
  plainLoading?: boolean;
  plainContent?: string;
  unifiedRenderItems: UnifiedRenderItem[];
  splitRenderItems: SplitRenderItem[];
  computed: ComputedChange[];
  onExpandBlock: (fileKey: string, startIndex: number) => void;
}

export const DiffCodeViewer: React.FC<DiffCodeViewerProps> = React.memo(
  function DiffCodeViewer({
    f,
    compareMode,
    diffViewMode,
    diffSearchQuery,
    plainLoading,
    plainContent,
    unifiedRenderItems,
    splitRenderItems,
    computed,
    onExpandBlock,
  }) {
    if (compareMode === 'plain') {
      if (plainLoading) {
        return (
          <div className={styles.detailLoading}>
            <AppIcon name="loader" size={16} className="spin" />
            <span>正在加载源码...</span>
          </div>
        );
      }

      const fileContent = plainContent || '';
      return <VirtualPlainCodeViewer content={fileContent} filePath={f.filePath} />;
    }

    const q = diffSearchQuery.trim();
    if (
      q &&
      computed.filter((item) => item.change.content.toLowerCase().includes(q.toLowerCase())).length === 0
    ) {
      return (
        <div className={styles.empty} role="status" aria-live="polite" style={{ padding: '16px 10px' }}>
          <div>无匹配行</div>
          <div className={styles.emptySub}>筛选「{q}」无结果</div>
        </div>
      );
    }

    if (diffViewMode === 'split') {
      return (
        <DiffCardSplitView
          f={f}
          renderItems={splitRenderItems}
          onExpandBlock={onExpandBlock}
        />
      );
    }

    return (
      <DiffCardUnifiedView
        f={f}
        renderItems={unifiedRenderItems}
        onExpandBlock={onExpandBlock}
      />
    );
  }
);
