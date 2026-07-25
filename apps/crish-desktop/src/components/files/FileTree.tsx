import React from 'react';
import { FileTreeView, type FileTreeViewProps } from './FileTreeView';

export type FileTreeProps = FileTreeViewProps;

export const FileTree = React.memo(function FileTree(props: FileTreeViewProps) {
  return <FileTreeView {...props} />;
});
