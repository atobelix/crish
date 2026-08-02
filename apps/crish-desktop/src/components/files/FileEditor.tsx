import React from 'react';

interface FileEditorProps {
  editBuf: string;
  content: string;
  dirty: boolean;
  onChange: (value: string, isDirty: boolean) => void;
}

export const FileEditor = React.memo(function FileEditor({
  editBuf, content, onChange,
}: FileEditorProps) {
  return (
    <textarea
      className="files-editor"
      value={editBuf}
      onChange={(e) => onChange(e.target.value, e.target.value !== content)}
      spellCheck={false}
      style={{
        width: '100%', height: '100%', resize: 'none', border: 'none',
        outline: 'none', padding: '8px', fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-size-sm)', lineHeight: '1.5',
        background: 'var(--bg-primary)', color: 'var(--text-primary)',
      }}
    />
  );
});
