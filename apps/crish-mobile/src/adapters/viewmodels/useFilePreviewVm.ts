// 文件预览视图模型（R2-06b，R2UX-06-02 按需加载）：
// - 按需加载：进入详情（file 非 null）才发起 readFile；浏览列表零预载
//   （R2UX-06-02「进入详情才请求」）；
// - 缓存优先：预览缓存键 (workspaceRoot, relPath, lineBudget)（F4 §5.2），
//   命中直接展示（同预算二次打开 <200ms，X4-2；敏感文件缓存拒绝 → 重拉，
//   F4 §7.1 内容不进任何缓存）；
// - 错误映射：file_too_large（1MB 超限占位，R2UX-06-02）/ binary_file
//   （二进制占位）/ unsupported_encoding（编码占位）/ 其余 → 可重试错误态
//   （F4 附录 B；transport.closed = 未连接文案）；
// - 分块续读：首屏 FILE_PREVIEW_CHUNK_LINES=400，truncated → 阶梯放大预算
//   （400→800→1200→…→5000 硬顶，F4 §4.1 / F4-F27「已达预览上限」）；
// - 竞态防护：file 变化时取消旧请求（cancelled 标记），快速返回不串扰。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@/domain/types/domain';
import { filesStore } from '@/domain/store/filesStore';
import {
  FILE_PREVIEW_CHUNK_LINES,
  filePreviewCacheKey,
} from '@/domain/store/filesCache';
import {
  getFilesContext,
  type FilesContext,
} from '@/adapters/wiring/filesWiring';
import { useFilesStore } from '@/adapters/hooks/useFilesStore';
import { errorCodeOf } from './useFilesVm';
import type { ReadFileResult } from '../../../../../packages/shared-types/src/generated/device/types';

/** 行数硬顶（桌面端 read_file_content 5000 行上限，F4 §2.3 / F4-F27） */
export const PREVIEW_LINES_HARD_CAP = 5000;

/** 续读阶梯（F4 §4.1：400→800→1200…；硬顶 5000 由桌面端保证，F4 §2.3） */
const LINE_BUDGET_STEPS = [400, 800, 1200, 2000, 3000, 4000, 5000] as const;

/** 下一档行预算（当前档末位或已达硬顶 → 保持硬顶，F4-F27 语义） */
export function nextLineBudget(current: number): number {
  const step = LINE_BUDGET_STEPS.find((s) => s > current);
  return step ?? LINE_BUDGET_STEPS[LINE_BUDGET_STEPS.length - 1]!;
}

/** 预览状态机（占位态 = too-large/binary/unsupported-encoding，R2UX-06-02/06-07） */
export type PreviewStatus =
  | 'loading'
  | 'loaded'
  | 'too-large'
  | 'binary'
  | 'unsupported-encoding'
  | 'error';

export interface FilePreviewVm {
  /** 预览目标（null = 未选择，页面显示列表） */
  file: FileEntry | null;
  status: PreviewStatus;
  /** 错误码（error/占位态时有效；F4 附录 B 映射面在 UI 层） */
  errorCode: string | null;
  /** 已加载文本内容（loaded 时有效；空串 = 空文件） */
  content: string;
  /** 服务端行数（loaded 时有效；truncated 展示数据面） */
  lineCount: number;
  /** 是否截断（F4-F27：显示「已显示前 N 行」+ 继续加载） */
  truncated: boolean;
  /** 敏感标记（F4-F28：顶部横幅；内容不落缓存） */
  sensitive: boolean;
  /** 当前行预算（续读阶梯数据面） */
  lineBudget: number;
  /** 已达 5000 行硬顶（F4-F27「已达预览上限」） */
  atCap: boolean;
  /** 续读（truncated 时；阶梯放大预算重拉，F4 §4.1） */
  loadMore: () => void;
  /** 失败重试（重拉当前预算） */
  retry: () => void;
}

interface PreviewState {
  status: PreviewStatus;
  errorCode: string | null;
  content: string;
  lineCount: number;
  truncated: boolean;
  sensitive: boolean;
  lineBudget: number;
}

const LOADING_STATE: PreviewState = {
  status: 'loading',
  errorCode: null,
  content: '',
  lineCount: 0,
  truncated: false,
  sensitive: false,
  lineBudget: FILE_PREVIEW_CHUNK_LINES,
};

/** 错误码 → 状态机态（占位态 vs 可重试错误，R2UX-06-02） */
export function mapPreviewErrorCode(code: string): PreviewStatus {
  switch (code) {
    case 'file_too_large':
      return 'too-large';
    case 'binary_file':
      return 'binary';
    case 'unsupported_encoding':
      return 'unsupported-encoding';
    default:
      return 'error';
  }
}

function applyResult(state: PreviewState, res: ReadFileResult): PreviewState {
  return {
    status: 'loaded',
    errorCode: null,
    content: res.content,
    lineCount: res.lineCount,
    truncated: res.truncated,
    sensitive: res.sensitive === true,
    lineBudget: state.lineBudget,
  };
}

export function useFilePreviewVm(
  file: FileEntry | null,
  contextOverride?: FilesContext | null
): FilePreviewVm {
  const root = useFilesStore((s) => s.activeWorkspaceRoot);
  const [state, setState] = useState<PreviewState>(LOADING_STATE);
  /** 请求序号（file 快速切换竞态防护） */
  const seqRef = useRef(0);

  const ctxOf = useCallback(
    () => contextOverride ?? getFilesContext(),
    [contextOverride]
  );

  const loadBudget = useCallback(
    async (target: FileEntry, budget: number): Promise<void> => {
      const ctx = ctxOf();
      if (!ctx) return; // 未接线：保持 loading（连接恢复后重试）
      const rootPath = filesStore.getState().activeWorkspaceRoot ?? '';
      const key = filePreviewCacheKey(rootPath, target.relPath, budget);
      const cached = ctx.previewCache.get(key);
      if (cached) {
        setState({
          status: 'loaded',
          errorCode: null,
          content: cached.content,
          lineCount: cached.lineCount,
          truncated: cached.truncated,
          sensitive: false,
          lineBudget: budget,
        });
        return;
      }
      const seq = ++seqRef.current;
      setState({ ...LOADING_STATE, lineBudget: budget });
      try {
        const res = await ctx.repository.readFile({
          path: target.relPath,
          ...(rootPath ? { workspaceRoot: rootPath } : {}),
          maxLines: budget,
        });
        if (seqRef.current !== seq) return; // 过期响应丢弃
        ctx.previewCache.set(key, res); // 敏感/超限 → 拒绝写入，占位由 UI 展示
        setState(applyResult({ ...LOADING_STATE, lineBudget: budget }, res));
      } catch (e) {
        if (seqRef.current !== seq) return;
        const code = errorCodeOf(e);
        setState({
          status: mapPreviewErrorCode(code),
          errorCode: code,
          content: '',
          lineCount: 0,
          truncated: false,
          sensitive: false,
          lineBudget: budget,
        });
      }
    },
    [ctxOf]
  );

  // file 变化 → 重置并按需加载（R2UX-06-02：进入详情才请求）
  useEffect(() => {
    seqRef.current += 1; // 使在途旧请求全部过期
    if (!file) {
      setState(LOADING_STATE);
      return;
    }
    void loadBudget(file, FILE_PREVIEW_CHUNK_LINES);
    // 依赖 file.relPath + root（工作区切换时预览目标失效重拉）
  }, [file?.relPath, root]);

  const loadMore = useCallback(() => {
    if (!file || !state.truncated) return;
    void loadBudget(file, nextLineBudget(state.lineBudget));
  }, [file, state.truncated, state.lineBudget, loadBudget]);

  const retry = useCallback(() => {
    if (!file) return;
    void loadBudget(file, state.lineBudget);
  }, [file, state.lineBudget, loadBudget]);

  return {
    file,
    status: state.status,
    errorCode: state.errorCode,
    content: state.content,
    lineCount: state.lineCount,
    truncated: state.truncated,
    sensitive: state.sensitive,
    lineBudget: state.lineBudget,
    atCap: state.truncated && state.lineBudget >= PREVIEW_LINES_HARD_CAP,
    loadMore,
    retry,
  };
}
