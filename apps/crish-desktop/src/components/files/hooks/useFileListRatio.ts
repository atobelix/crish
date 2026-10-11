import { useEffect, useState } from 'react';
import { preferencesClient } from '../../../api/preferences';

const DEFAULT_FILE_LIST_RATIO = 35;

export function normalizeFileListRatio(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const percent = value <= 1 ? value * 100 : value;
  return percent >= 15 && percent <= 75 ? percent : undefined;
}

export function useFileListRatio(): [number, (ratio: number) => void] {
  const [ratio, setRatio] = useState(DEFAULT_FILE_LIST_RATIO);

  useEffect(() => {
    let unmounted = false;
    void preferencesClient
      .getPreference('files_list_ratio')
      .then((saved) => {
        if (unmounted) return;
        const normalized = normalizeFileListRatio(saved);
        if (normalized !== undefined) setRatio(normalized);
      })
      .catch(() => {
        /* swallow-ok: 读偏好失败保持默认分栏比例 */
      });
    return () => {
      unmounted = true;
    };
  }, []);

  return [ratio, setRatio];
}
