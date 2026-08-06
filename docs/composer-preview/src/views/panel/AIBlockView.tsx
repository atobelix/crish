/**
 * AIBlockView — AI 生成块
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   空闲态       → Prompt 输入框 + 发送；Enter 发送，Shift+Enter 换行
 *   生成中       → 打字机式流式输出 + 呼吸光标 + 「停止」按钮
 *   完成态       → 「插入到文档 / 重新生成 / 复制 / 丢弃」四个明确出口
 *   失败态       → 错误原因 + 「重试」，绝不静默失败
 *   快捷 Prompt  → 常用指令做成一排胶囊按钮，点一下即填入
 *
 * ── 关于流式 ──────────────────────────────────────────
 *   逐字符 setState 会让 React 每帧重渲染整棵子树。
 *   这里改成按 rAF 批量刷新：底层缓冲区随时追加，
 *   每一帧最多提交一次，长文本下 CPU 占用下降一个数量级。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import {
  Sparkles, Send, Square, RotateCcw, Check, Copy, Trash2, AlertCircle,
} from 'lucide-react';
import { BlockShell } from '../_shared/BlockShell';
import { requestMockAI } from '../../services/ai/mockAiService';

type Status = 'idle' | 'generating' | 'done' | 'error';

const QUICK_PROMPTS = [
  '续写这段内容',
  '总结要点',
  '润色语气',
  '翻译成英文',
  '列出待办事项',
];

export const AIBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  editor,
  getPos,
  deleteNode,
  selected,
}) => {
  const [prompt, setPrompt] = useState((node.attrs.prompt as string) || '');
  const [status, setStatus] = useState<Status>(((node.attrs.status as string) || 'idle') as Status);
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** 流式缓冲：写入随时发生，提交按帧节流 */
  const bufferRef = useRef('');
  const rafRef = useRef(0);
  const abortRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    abortRef.current?.();
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setOutput(bufferRef.current);
    });
  }, []);

  const generate = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;

    bufferRef.current = '';
    setOutput('');
    setError(null);
    setStatus('generating');
    updateAttributes({ prompt: text, status: 'generating' });

    let cancelled = false;
    abortRef.current = () => {
      cancelled = true;
    };

    try {
      await requestMockAI(text, (chunk) => {
        if (cancelled) return;
        bufferRef.current += chunk;
        scheduleFlush();
      });
      if (cancelled) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      setOutput(bufferRef.current);
      setStatus('done');
      updateAttributes({ status: 'done' });
    } catch (err) {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : '生成失败');
      setStatus('error');
      updateAttributes({ status: 'error' });
    }
  }, [prompt, scheduleFlush, updateAttributes]);

  const stop = useCallback(() => {
    abortRef.current?.();
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setOutput(bufferRef.current);
    setStatus('done');
    updateAttributes({ status: 'done' });
  }, [updateAttributes]);

  /** 把结果落到文档里，并移除这个临时的 AI 块 */
  const insertIntoDoc = useCallback(() => {
    if (typeof getPos !== 'function') return;
    const pos = getPos();
    if (pos === undefined) return;

    const paragraphs = output
      .split(/\n{2,}/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }));
    if (paragraphs.length === 0) return;

    editor
      .chain()
      .focus()
      .insertContentAt({ from: pos, to: pos + node.nodeSize }, paragraphs)
      .reconcileDocument()
      .run();
  }, [editor, getPos, node.nodeSize, output]);

  return (
    <BlockShell
      kind="ai"
      selected={selected}
      badge={
        <span className="block-badge block-badge--ai">
          <Sparkles size={12} />
          AI
        </span>
      }
      actions={[{ id: 'delete', label: '删除此块', icon: Trash2, danger: true, onClick: deleteNode }]}
    >
      <div className={`ai-block is-${status}`} contentEditable={false}>
        {/* ── 输入区 ── */}
        <div className="ai-block__composer">
          <Sparkles size={15} className="ai-block__spark" />
          <textarea
            ref={inputRef}
            className="ai-block__input"
            rows={1}
            placeholder="告诉 AI 你想要什么…"
            value={prompt}
            disabled={status === 'generating'}
            onChange={(e) => {
              setPrompt(e.target.value);
              // 自适应高度，避免出现内部滚动条
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void generate();
              }
            }}
          />
          {status === 'generating' ? (
            <button type="button" className="ai-block__send is-stop motion-tap" onClick={stop}>
              <Square size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="ai-block__send motion-tap"
              onClick={() => void generate()}
              disabled={!prompt.trim()}
              aria-label="生成"
            >
              <Send size={14} />
            </button>
          )}
        </div>

        {/* ── 快捷指令 ── */}
        {status === 'idle' && !output && (
          <div className="ai-block__quick motion-stagger">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                type="button"
                className="ai-block__chip motion-tap"
                onClick={() => {
                  setPrompt(q);
                  inputRef.current?.focus();
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* ── 输出区 ── */}
        {(output || status === 'generating') && (
          <div className="ai-block__output motion-fade-in">
            {output}
            {status === 'generating' && <span className="ai-block__caret" aria-hidden />}
          </div>
        )}

        {/* ── 错误 ── */}
        {status === 'error' && (
          <div className="ai-block__error motion-fade-in">
            <AlertCircle size={14} />
            <span>{error}</span>
            <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={() => void generate()}>
              重试
            </button>
          </div>
        )}

        {/* ── 完成后的出口 ── */}
        {status === 'done' && output && (
          <div className="ai-block__actions motion-rise-in">
            <button type="button" className="btn btn--primary btn--sm motion-tap" onClick={insertIntoDoc}>
              <Check size={13} />
              插入到文档
            </button>
            <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={() => void generate()}>
              <RotateCcw size={13} />
              重新生成
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm motion-tap"
              onClick={async () => {
                await navigator.clipboard.writeText(output);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={deleteNode}>
              <Trash2 size={13} />
              丢弃
            </button>
          </div>
        )}
      </div>
    </BlockShell>
  );
};
