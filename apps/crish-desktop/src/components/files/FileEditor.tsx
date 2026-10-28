/**
 * apps/crish-desktop/src/components/files/FileEditor.tsx
 */
import React from 'react';
import { Textarea } from '@/components/ui';
import styles from './FileEditor.module.css';

interface FileEditorProps {
  editBuf: string;
  content: string;
  dirty: boolean;
  onChange: (value: string, isDirty: boolean) => void;
}

export const FileEditor = React.memo(function FileEditor({
  editBuf,
  content,
  onChange,
}: FileEditorProps) {
  return (
    <div className={styles.editorWrapper}>
      <Textarea
        bare
        className={styles.editor}
        value={editBuf}
        onChange={(e) => onChange(e.target.value, e.target.value !== content)}
        spellCheck={false}
        aria-label="源码编辑区域"
      />
    </div>
  );
});

FileEditor.displayName = 'FileEditor';
