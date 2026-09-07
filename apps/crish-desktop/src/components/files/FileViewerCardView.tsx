import React from 'react';
import type { ViewRenderContext } from '../../services/view-registry/ViewTypes';
import { FileViewerCard } from './FileViewerCard';

export const FileViewerCardView: React.FC<ViewRenderContext> = (ctx) => {
  const filePath = (ctx.params?.filePath as string) || '';
  const initialMode = (ctx.params?.initialMode as 'plain' | 'diff') || 'plain';
  return (
    <FileViewerCard
      key={filePath}
      filePath={filePath}
      initialMode={initialMode}
    />
  );
};

FileViewerCardView.displayName = 'FileViewerCardView';
