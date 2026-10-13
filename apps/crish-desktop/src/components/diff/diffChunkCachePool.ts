/**
 * 重型工具视图性能优化核心原语（Stage 07）：
 * 1. SotaDiffChunkCachePool / DiffChunkCachePool：
 *    - L1 视口核心工作集锁定（pinnedChunkIndices 绝对免疫 LRU 驱逐）
 *    - L2 64 行分块池（默认容纳 128 个 Chunk = 8,192 行）
 *    - Generation Token 代次守卫（大跨跳时立即作废旧代次请求，防止 Worker 堵死与旧数据回写污染）
 * 2. NativeHighlightManager：
 *    - Blink 原生 CSS.highlights 渐进增强（单行单 TextNode 零 Span 爆炸渲染与安全回退）
 * 3. PrefixFileTreeIndex 重导出（SSOT 位于 utils/prefixFileTreeIndex.ts）
 */

export {
  DEFAULT_FILE_TREE_ROW_HEIGHT,
  FILE_TREE_COLLATOR,
  MAX_FILE_TREE_DOM_NODES,
  PrefixFileTreeIndex,
  getVisibleSlice,
  type FileTreeNode,
  type VisibleFileTreeSlice,
} from '../../utils/prefixFileTreeIndex';

export const CHUNK_SIZE = 64;
export const DIFF_CHUNK_SIZE = CHUNK_SIZE;
export const DEFAULT_MAX_CHUNKS = 128; // 128 * 64 = 8,192 行
export const DEFAULT_OVERSCAN_LINES = 128; // 上下各预取 2 个 Chunk

export interface ChunkSlice<TLineToken> {
  readonly chunkIndex: number;
  readonly lines: readonly TLineToken[];
  readonly generation: number;
}

export class SotaDiffChunkCachePool<TLineToken = string> {
  static readonly CHUNK_SIZE = DIFF_CHUNK_SIZE;
  readonly chunkSize = DIFF_CHUNK_SIZE;
  readonly maxChunks: number;

  // L1 视口核心工作集锁定索引（绝对豁免 LRU 驱逐）
  readonly pinnedChunkIndices: Set<number> = new Set<number>();

  // L2 有界 64 行分块 LRU 缓存池
  private readonly chunks = new Map<number, ChunkSlice<TLineToken>>();

  // 代次守卫：大跨度跳转时自增，拦截过期 Worker 回写
  private currentGeneration = 0;

  constructor(opts: number | { maxChunks?: number } = DEFAULT_MAX_CHUNKS) {
    const raw =
      typeof opts === 'number' ? opts : (opts?.maxChunks ?? DEFAULT_MAX_CHUNKS);
    this.maxChunks =
      Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CHUNKS;
  }

  get size(): number {
    return this.chunks.size;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  hasChunk(chunkIndex: number): boolean {
    return (
      Number.isFinite(chunkIndex) &&
      chunkIndex >= 0 &&
      this.chunks.has(Math.floor(chunkIndex))
    );
  }

  getChunk(chunkIndex: number): ChunkSlice<TLineToken> | undefined {
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return undefined;
    const idx = Math.floor(chunkIndex);
    const slice = this.chunks.get(idx);
    if (!slice) return undefined;
    this.chunks.delete(idx);
    this.chunks.set(idx, slice);
    return slice;
  }

  /**
   * 锁定当前视口核心工作集并递增代次（大跨跳时作废在途旧代次请求）
   */
  lockViewportAndAdvanceGen(
    startLine: number,
    endLine: number,
    overscanLines = DEFAULT_OVERSCAN_LINES
  ): {
    generation: number;
    missingChunks: number[];
    pinnedChunks: ReadonlySet<number>;
  } {
    this.currentGeneration += 1;
    this.pinnedChunkIndices.clear();

    if (
      !Number.isFinite(startLine) ||
      !Number.isFinite(endLine) ||
      endLine < 0
    ) {
      this.evictColdChunks();
      return {
        generation: this.currentGeneration,
        missingChunks: [],
        pinnedChunks: this.pinnedChunkIndices,
      };
    }

    const pad = Number.isFinite(overscanLines)
      ? Math.max(0, Math.floor(overscanLines))
      : DEFAULT_OVERSCAN_LINES;
    const low = Math.max(0, Math.floor(Math.min(startLine, endLine)) - pad);
    const high = Math.max(0, Math.floor(Math.max(startLine, endLine)) + pad);
    const firstChunk = Math.floor(low / DIFF_CHUNK_SIZE);
    const lastChunk = Math.floor(high / DIFF_CHUNK_SIZE);

    const missingChunks: number[] = [];

    for (let idx = firstChunk; idx <= lastChunk; idx++) {
      this.pinnedChunkIndices.add(idx);
      const cached = this.chunks.get(idx);
      if (cached !== undefined) {
        this.chunks.delete(idx);
        this.chunks.set(idx, cached);
      } else {
        missingChunks.push(idx);
      }
    }

    this.evictColdChunks();
    return {
      generation: this.currentGeneration,
      missingChunks,
      pinnedChunks: this.pinnedChunkIndices,
    };
  }

  /**
   * 锁定视口工作集并返回锁定集合（递增代次）
   */
  lockViewportRange(
    startLine: number,
    endLine: number,
    overscanLines = 64
  ): ReadonlySet<number> {
    return this.lockViewportAndAdvanceGen(startLine, endLine, overscanLines)
      .pinnedChunks;
  }

  /**
   * 写入分块数据；若提供 generation 且不等于当前代次，则静默丢弃并返回 false
   */
  putChunk(
    chunkIndex: number,
    lines: readonly TLineToken[],
    generation?: number
  ): boolean {
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return false;
    if (generation !== undefined && generation !== this.currentGeneration) {
      return false;
    }
    const idx = Math.floor(chunkIndex);
    if (this.chunks.has(idx)) {
      this.chunks.delete(idx);
    }
    this.chunks.set(idx, {
      chunkIndex: idx,
      lines: lines.slice(0, DIFF_CHUNK_SIZE),
      generation: generation ?? this.currentGeneration,
    });
    this.evictColdChunks(idx);
    return true;
  }

  getLine(lineNumber: number): TLineToken | undefined {
    if (!Number.isFinite(lineNumber) || lineNumber < 0) return undefined;
    const line = Math.floor(lineNumber);
    const idx = Math.floor(line / DIFF_CHUNK_SIZE);
    const slice = this.chunks.get(idx);
    if (!slice) return undefined;
    this.chunks.delete(idx);
    this.chunks.set(idx, slice);
    return slice.lines[line % DIFF_CHUNK_SIZE];
  }

  getMissingChunksInRange(startLine: number, endLine: number): number[] {
    if (
      !Number.isFinite(startLine) ||
      !Number.isFinite(endLine) ||
      endLine < startLine ||
      endLine < 0
    ) {
      return [];
    }
    const first = Math.floor(
      Math.max(0, Math.floor(startLine)) / DIFF_CHUNK_SIZE
    );
    const last = Math.floor(Math.max(0, Math.floor(endLine)) / DIFF_CHUNK_SIZE);
    const missing: number[] = [];
    for (let c = first; c <= last; c++) {
      if (!this.chunks.has(c)) missing.push(c);
    }
    return missing;
  }

  clear(): void {
    this.pinnedChunkIndices.clear();
    this.chunks.clear();
    this.currentGeneration += 1;
  }

  private evictColdChunks(protectedIdx?: number): void {
    if (this.chunks.size <= this.maxChunks) return;
    for (const key of this.chunks.keys()) {
      if (this.chunks.size <= this.maxChunks) break;
      if (!this.pinnedChunkIndices.has(key) && key !== protectedIdx) {
        this.chunks.delete(key);
      }
    }
  }
}

export { SotaDiffChunkCachePool as DiffChunkCachePool };

export interface HighlightTokenSpan {
  readonly start: number;
  readonly end: number;
  readonly type:
    'keyword' | 'string' | 'number' | 'comment' | 'function' | 'operator';
}

const TOKEN_REGEX =
  /(\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|import|export|from|class|interface|type|async|await|true|false|null|undefined|new|try|catch|finally|switch|case|default|extends|implements|public|private|protected|readonly|static)\b|\b(\d+(?:\.\d+)?)\b|\b([a-zA-Z_$][\w$]*)(?=\s*\()/g;

/**
 * 轻量级单行词法扫描器：为 Blink CSS.highlights 生成字符区间偏移
 */
export function tokenizeLineForHighlights(
  text: string,
  maxTokens = 256
): HighlightTokenSpan[] {
  if (!text) return [];
  const tokens: HighlightTokenSpan[] = [];
  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (
    (match = TOKEN_REGEX.exec(text)) !== null &&
    tokens.length < maxTokens
  ) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[1] !== undefined) {
      tokens.push({ start, end, type: 'comment' });
    } else if (match[2] !== undefined) {
      tokens.push({ start, end, type: 'string' });
    } else if (match[3] !== undefined) {
      tokens.push({ start, end, type: 'keyword' });
    } else if (match[4] !== undefined) {
      tokens.push({ start, end, type: 'number' });
    } else if (match[5] !== undefined) {
      tokens.push({ start, end, type: 'function' });
    }
  }
  return tokens;
}

type HighlightRegistryLike = {
  get(name: string): { add(range: AbstractRange): void } | undefined;
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
};

const HIGHLIGHT_NAMES = [
  'hl-keyword',
  'hl-string',
  'hl-number',
  'hl-comment',
  'hl-function',
  'hl-operator',
] as const;

/**
 * Blink 原生 CSS.highlights 管理器：
 * 支持时单行仅挂载单一原生 TextNode（Zero-Span），由 GPU 光栅化层直接对 Range 着色
 */
export class NativeHighlightManager {
  static isSupported(): boolean {
    if (typeof globalThis === 'undefined') return false;
    const g = globalThis as Record<string, unknown>;
    const cssObj = g.CSS as { highlights?: unknown } | undefined;
    return Boolean(
      cssObj &&
      typeof cssObj === 'object' &&
      'highlights' in cssObj &&
      cssObj.highlights &&
      typeof g.Highlight === 'function' &&
      typeof Range === 'function'
    );
  }

  static clearSyntaxHighlights(): void {
    if (!this.isSupported()) return;
    const g = globalThis as unknown as {
      CSS: { highlights: HighlightRegistryLike };
    };
    for (const name of HIGHLIGHT_NAMES) {
      g.CSS.highlights.delete(name);
    }
  }

  static registerRowHighlights(
    textNode: Text,
    tokens: readonly HighlightTokenSpan[]
  ): number {
    if (!this.isSupported() || tokens.length === 0) return 0;
    const g = globalThis as unknown as {
      CSS: { highlights: HighlightRegistryLike };
      Highlight: new () => { add(range: AbstractRange): void };
    };
    const registry = g.CSS.highlights;
    const nodeLen = textNode.length;
    let count = 0;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.start < 0 || token.start >= token.end || token.end > nodeLen) {
        continue;
      }
      const range = new Range();
      range.setStart(textNode, token.start);
      range.setEnd(textNode, token.end);
      const hlName = `hl-${token.type}`;
      let highlight = registry.get(hlName);
      if (!highlight) {
        highlight = new g.Highlight();
        registry.set(hlName, highlight);
      }
      highlight.add(range);
      count += 1;
    }
    return count;
  }

  static applyContainerHighlights(container: HTMLElement | null): number {
    if (!container || !this.isSupported()) return 0;
    this.clearSyntaxHighlights();
    const nodes = container.querySelectorAll('[data-native-highlight-line]');
    let totalRanges = 0;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i]!;
      const firstChild = el.firstChild;
      if (firstChild && firstChild.nodeType === 3) {
        const textNode = firstChild as Text;
        const text = textNode.nodeValue ?? '';
        if (text.length > 0) {
          const tokens = tokenizeLineForHighlights(text);
          totalRanges += this.registerRowHighlights(textNode, tokens);
        }
      }
    }
    return totalRanges;
  }
}
