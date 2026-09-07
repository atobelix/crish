import React from 'react';
import {
  ChevronRight,
  Copy,
  PanelRightOpen,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import styles from './ChatToolCallBlock.module.css';
import type { MessageToolCall } from '../../store/types';
import {
  toolCommandIcon,
  toolCommandType,
  extractToolCommand,
  toolCommandPreview,
  basename,
} from '../../api/toolPresentation';
import { isEditToolName, isShellToolName } from '../../api/toolFeedback';
import { Button, Tooltip } from '../ui';

export interface ToolCallHeaderProps {
  tc: MessageToolCall;
  human: string;
  statusZh: string;
  running: boolean;
  isOpen: boolean;
  canToggle: boolean;
  durationStr: string | null;
  diffStats: { add: number; del: number } | null;
  pathClickable: boolean;
  filePath: string;
  pathLabel: string;
  rowAriaLabel: string;
  bodyId: string;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
  onOpenPath?: ((filePath: string) => void) | undefined;
}

export interface ResolvedToolAction {
  actionText: string;
  paramText: string;
  isPath: boolean;
}

/**
 * 按照 DIM-04 规范将工具调用解析为人类友好动作与核心参数
 */
export function resolveToolActionAndParam(
  tc: MessageToolCall,
  human: string,
  filePath?: string,
  pathLabel?: string
): ResolvedToolAction {
  const name = (tc.name || '').toLowerCase().replace(/[\s-]+/g, '_');
  const args = tc.arguments || '';

  // 1. Shell 执行类
  if (
    isShellToolName(name) ||
    name.includes('bash') ||
    name.includes('powershell') ||
    name.includes('pwsh') ||
    name.includes('exec') ||
    name === 'run_command' ||
    name === 'terminal' ||
    name === 'shell'
  ) {
    const cmd = extractToolCommand(args) || toolCommandPreview(tc, 80);
    return {
      actionText: '执行命令',
      paramText: cmd || '',
      isPath: false,
    };
  }

  // 2. 文件读取类
  if (
    name === 'read_file' ||
    name === 'view_file' ||
    name === 'open_file' ||
    name === 'cat' ||
    (name.includes('read') && !name.includes('url') && !name.includes('resource')) ||
    (name.includes('view') && !name.includes('preview'))
  ) {
    const p = pathLabel || (filePath ? basename(filePath) : '');
    return {
      actionText: '读取文件',
      paramText: p,
      isPath: Boolean(filePath || p),
    };
  }

  // 3. 文件修改 / 代码替换类
  if (
    isEditToolName(name) ||
    name.includes('replace') ||
    name.includes('patch') ||
    name.includes('edit')
  ) {
    const p = pathLabel || (filePath ? basename(filePath) : '');
    return {
      actionText: '修改文件',
      paramText: p,
      isPath: Boolean(filePath || p),
    };
  }

  // 4. 文件写入 / 创建类
  if (
    name === 'write_file' ||
    name === 'write_to_file' ||
    name === 'create_file' ||
    (name.includes('write') && !name.includes('edit'))
  ) {
    const p = pathLabel || (filePath ? basename(filePath) : '');
    return {
      actionText: '写入文件',
      paramText: p,
      isPath: Boolean(filePath || p),
    };
  }

  // 5. 搜索与查询类
  if (name === 'web_search' || name === 'search_web') {
    let q = '';
    try {
      const p = JSON.parse(args);
      q = p.query || p.q || '';
    } catch {
      q = args;
    }
    return {
      actionText: '搜索网络',
      paramText: q ? `"${q}"` : '',
      isPath: false,
    };
  }

  if (name === 'grep_search') {
    let q = '';
    try {
      const p = JSON.parse(args);
      q = p.query || p.pattern || p.Query || '';
    } catch {
      q = args;
    }
    return {
      actionText: '代码检索',
      paramText: q || '',
      isPath: false,
    };
  }

  if (name === 'find_by_name') {
    let ptn = '';
    try {
      const p = JSON.parse(args);
      ptn = p.pattern || p.Pattern || '';
    } catch {
      ptn = args;
    }
    return {
      actionText: '查找文件',
      paramText: ptn || '',
      isPath: false,
    };
  }

  if (name === 'list_dir') {
    let dir = '';
    try {
      const p = JSON.parse(args);
      dir = p.directorypath || p.DirectoryPath || p.path || '';
    } catch {
      dir = args;
    }
    return {
      actionText: '列出目录',
      paramText: dir ? basename(dir) || dir : '',
      isPath: Boolean(dir),
    };
  }

  // 6. 网络访问类
  if (
    name === 'read_url_content' ||
    name.startsWith('read_url') ||
    name.includes('fetch') ||
    name.includes('browser') ||
    name === 'read_browser_page'
  ) {
    let u = '';
    try {
      const p = JSON.parse(args);
      u = p.url || p.uri || p.Url || '';
    } catch {
      u = args;
    }
    return {
      actionText: '访问网络',
      paramText: u || '',
      isPath: false,
    };
  }

  // 7. 后台任务管理
  if (name === 'manage_task' || name === 'background_task') {
    return {
      actionText: '管理任务',
      paramText: human !== '管理后台任务' ? human.replace(/^管理后台任务\s*/, '') : '',
      isPath: false,
    };
  }

  // 8. 智能回退：优先提取 human 中的人类友好动作前缀
  const verbMatch = human.match(/^(读取文件|查看文件|写入文件|修改文件|运行命令|执行命令|搜索网络|查找文件|代码检索|列出目录|管理任务|访问网络|读取资源|列出资源|查看|修改|写入|执行|运行|搜索|列出|调用|删除|访问)\s*(.*)$/);
  if (verbMatch) {
    let action = verbMatch[1] || '';
    if (action === '查看') action = '读取文件';
    else if (action === '修改') action = '修改文件';
    else if (action === '写入') action = '写入文件';
    else if (action === '运行' || action === '执行') action = '执行命令';
    else if (action === '搜索') action = '搜索网络';
    else if (action === '列出') action = '列出目录';
    return {
      actionText: action || human || '工具调用',
      paramText: verbMatch[2] || '',
      isPath: Boolean(filePath),
    };
  }

  return {
    actionText: human || name || '工具调用',
    paramText: '',
    isPath: Boolean(filePath),
  };
}

export const ToolCallHeader: React.FC<ToolCallHeaderProps> = ({
  tc,
  human,
  running,
  isOpen,
  canToggle,
  durationStr,
  diffStats,
  pathClickable,
  filePath,
  pathLabel,
  rowAriaLabel,
  bodyId,
  onToggleTool,
  onOpenPath,
}) => {
  const { actionText, paramText, isPath } = resolveToolActionAndParam(
    tc,
    human,
    filePath,
    pathLabel
  );

  const pathActions =
    pathClickable && filePath ? (
      <span
        className={styles.toolPathActions}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip content="在文件面板打开">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.toolPathAction}
            aria-label="在文件面板打开"
            onClick={() => onOpenPath?.(filePath)}
            icon={<PanelRightOpen size={12} aria-hidden />}
          />
        </Tooltip>
        <Tooltip content="复制路径">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.toolPathAction}
            aria-label="复制路径"
            onClick={() => {
              void navigator.clipboard.writeText(filePath);
            }}
            icon={<Copy size={12} aria-hidden />}
          />
        </Tooltip>
      </span>
    ) : null;

  const toolIcon = (() => {
    const sz = 14;
    const sw = 1.5;
    let inner: React.ReactNode;
    if (running) {
      inner = (
        <span className={styles.toolRowLive} aria-hidden>
          <span className={styles.toolLivePulseDot} />
        </span>
      );
    } else if (tc.status === 'error') {
      inner = (
        <XCircle
          size={sz}
          strokeWidth={sw}
          color="var(--color-error, var(--accent-red))"
        />
      );
    } else {
      // 严禁绿勾墙：非 error 均采用精细的中性/命令语义图标（完成态无彩），杜绝大面积刺眼绿勾
      const KindIcon = toolCommandIcon(toolCommandType(tc));
      inner = (
        <KindIcon
          size={sz}
          strokeWidth={sw}
          color="var(--text-tertiary)"
        />
      );
    }
    return (
      <span className={styles.toolRowIcoSlot} aria-hidden>
        {inner}
      </span>
    );
  })();

  const fullTooltip = filePath || tc.arguments || human || '';

  return (
    <div
      className={`${styles.toolRowHead}${canToggle ? '' : ' ' + styles.toolRowHeadStatic} tool-row-head${canToggle ? '' : ' tool-row-head-static'}`}
      role={canToggle ? 'button' : undefined}
      tabIndex={canToggle ? 0 : undefined}
      aria-expanded={canToggle ? isOpen : undefined}
      aria-controls={canToggle ? bodyId : undefined}
      aria-label={rowAriaLabel}
      style={canToggle ? undefined : { cursor: 'default' }}
      onClick={() => canToggle && onToggleTool(tc.id, isOpen)}
      onKeyDown={(e) => {
        if (!canToggle) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleTool(tc.id, isOpen);
          return;
        }
        if (e.key === 'Escape' && isOpen) {
          e.preventDefault();
          e.stopPropagation();
          onToggleTool(tc.id, true);
        }
      }}
    >
      <span className={styles.toolRowHeadMain}>
        {toolIcon}
        <span className={styles.toolRowText}>
          <span className={styles.toolRowSummary}>
            <Tooltip content={fullTooltip}>
              <span className={styles.toolActionText}>{actionText}</span>
            </Tooltip>
            {paramText ? (
              <>
                <span className={styles.dotSeparator} aria-hidden="true" />
                {isPath && pathClickable && filePath ? (
                  <span className={styles.toolPathWrap}>
                    <Tooltip content={filePath}>
                      <button
                        type="button"
                        className={styles.toolPathLink}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenPath?.(filePath);
                        }}
                      >
                        {paramText}
                      </button>
                    </Tooltip>
                    {pathActions}
                  </span>
                ) : (
                  <Tooltip content={fullTooltip}>
                    <span className={styles.toolParamText}>{paramText}</span>
                  </Tooltip>
                )}
              </>
            ) : null}
          </span>
        </span>
      </span>
      <span className={styles.toolRowHeadRight}>
        {diffStats ? (
          <span className={styles.diffStats}>
            <span className={styles.diffStatsAdd}>+{diffStats.add}</span>
            <span className={styles.diffStatsDel}>-{diffStats.del}</span>
          </span>
        ) : null}
        {durationStr ? (
          <span className={styles.duration}>{durationStr}</span>
        ) : null}
        {canToggle ? (
          <span className={styles.toolRowChevronSlot}>
            <ChevronRight
              size={12}
              className={`${styles.toolRowChevron} ${isOpen ? styles.rot : ''}`}
              aria-hidden
            />
          </span>
        ) : null}
      </span>
    </div>
  );
};
