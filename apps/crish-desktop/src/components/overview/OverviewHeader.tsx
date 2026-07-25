import React from 'react';
import styles from '../OverviewCard.module.css';
import { Tooltip } from '../Tooltip';
import { basename } from './helpers';
import { ProgressSection } from './ProgressSection';
import type { SessionState } from '../../store/types';

export interface OverviewHeaderProps {
  wsPath?: string | null | undefined;
  session?: SessionState | undefined;
  onGoalClick?: (() => void) | undefined;
}

/**
 * 概览页顶栏与状态组件
 */
export const OverviewHeader: React.FC<OverviewHeaderProps> = React.memo(
  function OverviewHeader({ wsPath, session, onGoalClick }) {
    return (
      <>
        {wsPath ? (
          <div className={styles.metaLine} aria-label="会话状态">
            <Tooltip content={wsPath}>
              <span className={styles.metaChip}>{basename(wsPath)}</span>
            </Tooltip>
          </div>
        ) : null}

        <ProgressSection session={session} onGoalClick={onGoalClick} />
      </>
    );
  }
);
