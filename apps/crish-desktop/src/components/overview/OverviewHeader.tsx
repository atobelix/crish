import React from 'react';
import { ProgressSection } from './ProgressSection';
import type { SessionState } from '../../store/types';

export interface OverviewHeaderProps {
  session?: SessionState | undefined;
  onGoalClick?: (() => void) | undefined;
}

/**
 * 概览页顶栏与状态组件
 */
export const OverviewHeader: React.FC<OverviewHeaderProps> = React.memo(
  function OverviewHeader({ session, onGoalClick }) {
    return <ProgressSection session={session} onGoalClick={onGoalClick} />;
  }
);
