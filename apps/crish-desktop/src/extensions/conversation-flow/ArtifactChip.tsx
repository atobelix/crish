/**
 * 已生成文档胶囊。悬停打开阅读面，单击钉住。
 * 代码路径不走本组件（仍 files / file-viewer 叶）。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui';
import { ArtifactNotebookSurface } from './ArtifactNotebookSurface';
import styles from './narrative.module.css';

const HIDE_MS = 240;

export interface ArtifactChipProps {
  label: string;
  path?: string;
  content?: string;
  docId?: string;
  mime?: 'markdown' | 'text';
  derived?: 'engine' | 'frontend';
  onOpenNote?: (docId: string) => void;
}

export function ArtifactChip({
  label,
  path,
  content = '',
  docId,
  mime = 'markdown',
  derived = 'frontend',
  onOpenNote,
}: ArtifactChipProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const text = label.trim() || '文档';

  function clearHide(): void {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }

  function scheduleHide(): void {
    clearHide();
    if (pinned) return;
    hideTimer.current = window.setTimeout(() => {
      setOpen(false);
    }, HIDE_MS);
  }

  useEffect(() => () => clearHide(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div
      className={styles.chipWrap}
      data-flow-artifact-wrap=""
      onPointerEnter={() => {
        clearHide();
        setOpen(true);
      }}
      onPointerLeave={() => {
        scheduleHide();
      }}
    >
      <Button
        variant="ghost"
        type="button"
        className={styles.chip}
        data-flow-artifact="document"
        data-artifact-path={path || undefined}
        data-artifact-doc-id={docId || undefined}
        data-artifact-derived={derived}
        data-derived="frontend"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          clearHide();
          setOpen(true);
          setPinned(true);
        }}
      >
        已生成 · {text}
      </Button>
      {open ? (
        <ArtifactNotebookSurface
          title={text}
          content={content}
          mime={mime}
          pinned={pinned}
          docId={docId}
          onOpenNote={onOpenNote}
          onPin={() => {
            setPinned((v) => {
              const next = !v;
              if (next) setOpen(true);
              return next;
            });
          }}
          onClose={() => {
            clearHide();
            setPinned(false);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
