/**
 * ButtonBlockView — 按钮块
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   点击按钮       → 执行配置的动作（打开链接 / 复制文本 / 触发命令）
 *   悬浮块         → 右上角出现「配置」
 *   点击配置       → 就地展开设置面板（不弹窗，避免上下文跳丢）
 *   动作执行成功   → 按钮短暂切成成功态并脉冲一次
 *   未配置 URL     → 按钮置灰并给出提示，而不是点了没反应
 */

import React, { useCallback, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import { MousePointerClick, Settings2, Check, ExternalLink, Copy, Terminal } from 'lucide-react';
import { BlockShell } from '../_shared/BlockShell';

type ButtonAction = 'open_url' | 'copy_text' | 'run_command';

const ACTION_META: Record<ButtonAction, { label: string; icon: React.FC<{ size?: number }> }> = {
  open_url: { label: '打开链接', icon: ExternalLink },
  copy_text: { label: '复制文本', icon: Copy },
  run_command: { label: '运行命令', icon: Terminal },
};

const VARIANTS = ['primary', 'secondary', 'outline', 'ghost'] as const;
const SIZES = ['sm', 'md', 'lg'] as const;

export const ButtonBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
}) => {
  const [configOpen, setConfigOpen] = useState(false);
  const [fired, setFired] = useState(false);

  const label = (node.attrs.label as string) || '按钮';
  const action = ((node.attrs.action as string) || 'open_url') as ButtonAction;
  const url = (node.attrs.url as string) || '';
  const variant = (node.attrs.variant as string) || 'primary';
  const size = (node.attrs.size as string) || 'md';

  const ready = action === 'run_command' ? Boolean(url) : Boolean(url.trim());
  const ActionIcon = ACTION_META[action].icon;

  const run = useCallback(async () => {
    if (!ready) return;
    if (action === 'open_url') {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else if (action === 'copy_text') {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        /* 剪贴板不可用时静默降级 */
      }
    }
    setFired(true);
    window.setTimeout(() => setFired(false), 1400);
  }, [action, ready, url]);

  return (
    <BlockShell
      kind="button"
      selected={selected}
      badge={
        <span className="block-badge">
          <MousePointerClick size={12} />
          按钮
        </span>
      }
      actions={[
        {
          id: 'config',
          label: '配置按钮',
          icon: Settings2,
          active: configOpen,
          onClick: () => setConfigOpen((v) => !v),
        },
      ]}
    >
      <div className="button-block" contentEditable={false}>
        <button
          type="button"
          className={[
            'button-block__btn',
            `button-block__btn--${variant}`,
            `button-block__btn--${size}`,
            fired ? 'is-fired' : '',
            !ready ? 'is-disabled' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={run}
          disabled={!ready}
          title={ready ? ACTION_META[action].label : '尚未配置目标，点击右上角设置'}
        >
          {fired ? <Check size={15} className="motion-pulse" /> : <ActionIcon size={15} />}
          <span>{fired ? '已执行' : label}</span>
        </button>

        {!ready && <span className="button-block__hint">未配置目标</span>}
      </div>

      {configOpen && (
        <div className="button-block__config motion-rise-in" contentEditable={false}>
          <label className="field">
            <span className="field__label">按钮文字</span>
            <input
              className="field__input"
              value={label}
              onChange={(e) => updateAttributes({ label: e.target.value })}
              placeholder="点击执行"
            />
          </label>

          <label className="field">
            <span className="field__label">动作</span>
            <div className="segmented">
              {(Object.keys(ACTION_META) as ButtonAction[]).map((key) => {
                const Icon = ACTION_META[key].icon;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`segmented__item motion-tap ${action === key ? 'is-active' : ''}`}
                    onClick={() => updateAttributes({ action: key })}
                  >
                    <Icon size={13} />
                    {ACTION_META[key].label}
                  </button>
                );
              })}
            </div>
          </label>

          <label className="field">
            <span className="field__label">
              {action === 'open_url' ? '链接地址' : action === 'copy_text' ? '要复制的文本' : '命令'}
            </span>
            <input
              className="field__input"
              value={url}
              onChange={(e) => updateAttributes({ url: e.target.value })}
              placeholder={action === 'open_url' ? 'https://…' : '…'}
            />
          </label>

          <div className="field field--row">
            <div className="field__group">
              <span className="field__label">样式</span>
              <div className="segmented segmented--compact">
                {VARIANTS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`segmented__item motion-tap ${variant === v ? 'is-active' : ''}`}
                    onClick={() => updateAttributes({ variant: v })}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <div className="field__group">
              <span className="field__label">尺寸</span>
              <div className="segmented segmented--compact">
                {SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`segmented__item motion-tap ${size === s ? 'is-active' : ''}`}
                    onClick={() => updateAttributes({ size: s })}
                  >
                    {s.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </BlockShell>
  );
};
