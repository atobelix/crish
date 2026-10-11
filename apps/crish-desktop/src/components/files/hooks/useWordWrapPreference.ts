import { useCallback, useEffect, useState } from 'react';
import { preferencesClient } from '../../../api/preferences';

/**
 * 代码与文件查看自动换行首选项单一真理源 (SSOT) Hook
 * 默认开启 (true)，统一写入 preferencesClient: file_viewer_word_wrap
 */
export function useWordWrapPreference(): [
  boolean,
  (valOrUpdater?: boolean | ((prev: boolean) => boolean)) => void,
] {
  const [wordWrap, setWordWrap] = useState<boolean>(true);

  useEffect(() => {
    let unmounted = false;
    void preferencesClient
      .getPreference('file_viewer_word_wrap')
      .then((saved) => {
        if (!unmounted && typeof saved === 'boolean') {
          setWordWrap(saved);
        }
      })
      .catch(() => {
        /* swallow-ok: 读偏好失败保持默认开启 */
      });
    return () => {
      unmounted = true;
    };
  }, []);

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
          void preferencesClient
            .setPreference('file_viewer_word_wrap', next)
            .catch(() => {
              /* swallow-ok: 本地状态已更新；偏好落盘失败下次会话仍默认 true */
            });
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
