/**
 * Callout 上下文解析（战役 table-systemic-remediation · T4 抽取）
 *
 * 本模块是 `MarkdownEngine.tsx:37-108` 的**逐字迁移**（唯一改动 = 提升为模块导出）：
 * 表格岛（`TableBlock` / `TableIslandRow`）与旧逐行路径（`LineItem`）必须共用
 * 同一份 callout 上下文派生，否则岛内行会形成**第二套行解析口径**（违反 SSOT）。
 * 迁移同时把 ~72 行从 `MarkdownEngine.tsx`（行数门禁例外文件，ceiling 冻结）
 * 下沉到 core 层。
 */
import type { CalloutType } from './ast';
import { type CalloutContext } from './BlockIntervalTree';
import { LRUCache } from './LRUCache';

const calloutContextCache = new LRUCache<string, CalloutContext | null>(1000);

/** 获取当前行的 Callout 上下文（支持任意长度多行 Callout 向上继承，无 50 行截断） */
export function getCalloutContext(
  getLine: (i: number) => string,
  index: number
): CalloutContext | null {
  const line = getLine(index);
  if (!line || !/^ {0,3}>\s?/.test(line)) return null;

  const cacheKey = `${index}:${line}`;
  const cached = calloutContextCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const headerMatch = line.match(
    /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i
  );
  if (headerMatch) {
    const res: CalloutContext = {
      type: headerMatch[1].toLowerCase() as CalloutType,
      title: headerMatch[2]?.trim() || '',
      isHeader: true,
    };
    calloutContextCache.set(cacheKey, res);
    return res;
  }

  // 快速前驱检查：如果前一行就是 Callout，本行以 O(1) 立即继承
  if (index > 0) {
    const prevLine = getLine(index - 1);
    if (prevLine && /^ {0,3}>\s?/.test(prevLine)) {
      const prevKey = `${index - 1}:${prevLine}`;
      const prevCtx = calloutContextCache.get(prevKey);
      if (prevCtx) {
        const res: CalloutContext = {
          type: prevCtx.type,
          title: prevCtx.title,
          isHeader: false,
        };
        calloutContextCache.set(cacheKey, res);
        return res;
      }
    }
  }

  // 向上连续扫描连续引用行，彻底消除 50 行截断限制
  let prevIdx = index - 1;
  while (prevIdx >= 0) {
    const prevLine = getLine(prevIdx);
    if (!prevLine || !/^ {0,3}>\s?/.test(prevLine)) {
      break;
    }
    const prevMatch = prevLine.match(
      /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i
    );
    if (prevMatch) {
      const res: CalloutContext = {
        type: prevMatch[1].toLowerCase() as CalloutType,
        title: prevMatch[2]?.trim() || '',
        isHeader: false,
      };
      calloutContextCache.set(cacheKey, res);
      return res;
    }
    prevIdx--;
  }

  calloutContextCache.set(cacheKey, null);
  return null;
}
