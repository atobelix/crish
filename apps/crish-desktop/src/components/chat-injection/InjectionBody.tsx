/**
 * InjectionBody —— 展开详情面板（Markdown 正文 + Diff 快捷跳转 + 失败诊断 + 路径 chips）。
 *
 * - Markdown 正文经 StreamingMarkdownView（Rust/Worker 异步渲染，XSS 净化由渲染链路承担）；
 * - failed 态展示 errorMessage 诊断；
 * - diffs 提供「查看 Diff」快捷按钮，targetPaths 提供「打开路径」chips；
 * - 正文以 id 锚定，配合 Header aria-controls。
 */
import React from 'react';
import styles from './ContextInjectionBlock.module.css';
import { StreamingMarkdownView } from '../chat-message-row/StreamingMarkdownView';
import { Priority } from '../../workers';
import { Tooltip } from '../ui';
import type { MessageContextInjection } from '../../store/types';
import type { InjectionBodyProps } from './contextInjectionTypes';

export const InjectionBody: React.FC<InjectionBodyProps> = React.memo(
  function InjectionBody({ injection, onOpenPath, onOpenDiff }) {
    const bodyId = `injection-body-${injection.id}`;
    return (
      <div
        id={bodyId}
        className={styles.rowBody}
        role="region"
        aria-label={`${injection.title} 详情`}
      >
        <div className={styles.bodyInner}>
          <StreamingMarkdownView
            text={injection.content || ''}
            isStreaming={false}
            priority={Priority.Normal}
            messageId={`inj-${injection.id}`}
          />
          {injection.status === 'failed' && injection.errorMessage ? (
            <div className={styles.errorBox} data-injection-error="true">
              {injection.errorMessage}
            </div>
          ) : null}
          {injection.targetPaths && injection.targetPaths.length > 0 ? (
            <div className={styles.pathGroup}>
              {injection.targetPaths.slice(0, 8).map((p) => (
                <Tooltip key={p} content={p}>
                  <button
                    type="button"
                    className={styles.pathChipBtn}
                    onClick={() => onOpenPath?.(p)}
                    data-injection-path={p}
                  >
                    {p}
                  </button>
                </Tooltip>
              ))}
              {injection.targetPaths.length > 8 ? (
                <span className={styles.pathMore}>
                  +{injection.targetPaths.length - 8}
                </span>
              ) : null}
            </div>
          ) : null}
          {injection.diffs && injection.diffs.length > 0 && onOpenDiff ? (
            <div className={styles.diffActionGroup}>
              {injection.diffs.map((d) => (
                <Tooltip key={d.filePath} content={`查看 ${d.filePath} 的改动`}>
                  <button
                    type="button"
                    className={styles.diffChipBtn}
                    onClick={() => onOpenDiff(d)}
                    data-injection-diff={d.filePath}
                  >
                    查看 Diff（{d.filePath}）
                  </button>
                </Tooltip>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
);

InjectionBody.displayName = 'InjectionBody';
