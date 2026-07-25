import React from 'react';
import {
  OverviewCard as InnerOverviewCard,
  type OverviewCardProps,
} from './overview/OverviewCard';

export const OverviewCard: React.FC<OverviewCardProps> =
  React.memo(InnerOverviewCard);

export default OverviewCard;
export type { OverviewCardProps };
