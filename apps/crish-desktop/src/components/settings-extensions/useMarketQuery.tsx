import React, { useCallback, useMemo, useState } from 'react';
import {
  EXTENSION_CATALOG,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import type { KindFilter } from './types';

/** 市场查询状态：关键词/类型过滤 + 高亮 + 命中过滤（03-detail T10 拆分：useMarketQuery） */
export function useMarketQuery(installed: InstalledExtension[]) {
  const [searchFilter, setSearchFilter] = useState<{
    kindFilter: KindFilter;
    query: string;
  }>({ kindFilter: 'all', query: '' });
  const kindFilter = searchFilter.kindFilter;
  const query = searchFilter.query;
  const setKindFilter = (val: React.SetStateAction<KindFilter>) =>
    setSearchFilter((prev) => ({
      ...prev,
      kindFilter: typeof val === 'function' ? val(prev.kindFilter) : val,
    }));
  const setQuery = (val: React.SetStateAction<string>) =>
    setSearchFilter((prev) => ({
      ...prev,
      query: typeof val === 'function' ? val(prev.query) : val,
    }));

  const highlightMatch = useCallback(
    (text: string): React.ReactNode => {
      const q = query.trim().toLowerCase();
      if (!q) return text;
      const lower = text.toLowerCase();
      if (!lower.includes(q)) return text;
      const parts: React.ReactNode[] = [];
      let cursor = 0;
      let idx = lower.indexOf(q, cursor);
      while (idx !== -1) {
        if (idx > cursor) parts.push(text.slice(cursor, idx));
        parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
        cursor = idx + q.length;
        idx = lower.indexOf(q, cursor);
      }
      if (cursor < text.length) parts.push(text.slice(cursor));
      return parts;
    },
    [query]
  );

  const matchQ = useCallback(
    (name: string, desc: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
    },
    [query]
  );

  const installedFiltered = useMemo(
    () =>
      installed.filter((item) => {
        if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
        return matchQ(item.name, item.description);
      }),
    [installed, kindFilter, matchQ]
  );

  const catalogFiltered = useMemo(
    () =>
      EXTENSION_CATALOG.filter((entry) => {
        if (kindFilter !== 'all' && entry.kind !== kindFilter) return false;
        return matchQ(entry.name, entry.description);
      }),
    [kindFilter, matchQ]
  );

  return {
    kindFilter,
    setKindFilter,
    query,
    setQuery,
    highlightMatch,
    matchQ,
    installedFiltered,
    catalogFiltered,
  };
}
