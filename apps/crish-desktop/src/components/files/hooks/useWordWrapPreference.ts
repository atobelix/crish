import { useCallback, useState } from 'react';

export const WORD_WRAP_STORAGE_KEY = 'crish:file-viewer-word-wrap';

/**
 * 代码与文件查看自动换行首选项单一真理源 (SSOT) Hook
 * 默认开启 (true)，统一读写 localStorage: crish:file-viewer-word-wrap
 */
export function useWordWrapPreference(): [
  boolean,
  (valOrUpdater?: boolean | ((prev: boolean) => boolean)) => void,
] {
  const [wordWrap, setWordWrap] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(WORD_WRAP_STORAGE_KEY);
      if (saved !== null) {
        return saved === 'true';
      }
    } catch {
      /* swallow */
    }
    return true;
  });

  const toggleOrSetWordWrap = useCallback(
    (valOrUpdater?: boolean | ((prev: boolean) => boolean)) => {
      setWordWrap((prev) => {
        let next: boolean;
        if (typeof valOrUpdater === 'function') {
          next = valOrUpdater(prev);
        } else if (typeof valOrUpdater === 'boolean') {
          next = valOrUpdater;
        } else {
          next = !prev;
        }

        try {
          localStorage.setItem(WORD_WRAP_STORAGE_KEY, String(next));
        } catch {
          /* swallow */
        }
        return next;
      });
    },
    []
  );

  return [wordWrap, toggleOrSetWordWrap];
}
