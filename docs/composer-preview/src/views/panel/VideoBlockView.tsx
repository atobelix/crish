/**
 * VideoBlockView — 视频块 NodeView 组件 (V2 重构)
 *
 * 设计原则：
 * - 空状态：干净的灰色虚线框 + 居中图标，克制而非喧宾夺主
 * - 输入：点击空状态 → 弹出跟随式 InlineInput（非内嵌表单）
 * - 渲染：aspect-ratio 16:9 + 圆角裁切 + 骨架屏加载
 * - 工具栏：hover 时通过 motion-affordance 浮现
 *
 * 组件拆分：
 * - VideoBlockView (主组件)
 * - VideoEmptyState (空状态)
 * - VideoPlayer (播放器，按 provider 选择渲染)
 * - VideoToolbar (悬浮操作栏)
 */

import React, { useState, useCallback, useMemo } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Video, ExternalLink, Trash2, Link2 } from 'lucide-react';
import { InlineInput } from '../../ui/InlineInput';
import { Tooltip } from '../../ui/Tooltip';

/* ────────────────────────────────────────────
 * URL 解析
 * ──────────────────────────────────────────── */

interface ParsedVideo {
  provider: 'youtube' | 'bilibili' | 'vimeo' | 'mp4';
  embedUrl: string;
}

/** 从 URL 解析视频源和嵌入地址 */
function parseVideoUrl(url: string): ParsedVideo {
  const ytMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  );
  if (ytMatch) {
    return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}` };
  }

  const biliMatch = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
  if (biliMatch) {
    return {
      provider: 'bilibili',
      embedUrl: `https://player.bilibili.com/player.html?bvid=${biliMatch[1]}&high_quality=1`,
    };
  }

  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) {
    return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${vimeoMatch[1]}` };
  }

  return { provider: 'mp4', embedUrl: url };
}

/* ────────────────────────────────────────────
 * VideoEmptyState — 空状态（灰色虚线框 + 图标）
 * ──────────────────────────────────────────── */

interface VideoEmptyStateProps {
  onClick: () => void;
}

const VideoEmptyState: React.FC<VideoEmptyStateProps> = ({ onClick }) => (
  <div
    className="block-empty motion-fade-in"
    onClick={onClick}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => e.key === 'Enter' && onClick()}
  >
    <div className="block-empty__icon">
      <Video size={18} />
    </div>
    <div className="block-empty__text">
      <span className="block-empty__title">嵌入视频</span>
      <span className="block-empty__hint">
        点击粘贴 YouTube、Bilibili、Vimeo 或 MP4 链接
      </span>
    </div>
  </div>
);

/* ────────────────────────────────────────────
 * VideoPlayer — 视频播放器
 * ──────────────────────────────────────────── */

interface VideoPlayerProps {
  provider: string;
  embedUrl: string;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ provider, embedUrl }) => {
  const [loaded, setLoaded] = useState(false);

  if (provider === 'mp4') {
    return (
      <video
        className="video-block__native"
        src={embedUrl}
        controls
        preload="metadata"
      >
        <track kind="captions" />
      </video>
    );
  }

  return (
    <div className="video-block__iframe-container">
      {/* 加载骨架 */}
      {!loaded && (
        <div className="video-block__skeleton">
          <div className="video-block__skeleton-shimmer" />
        </div>
      )}
      <iframe
        className="video-block__iframe"
        src={embedUrl}
        title="嵌入视频"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        loading="lazy"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
};

/* ────────────────────────────────────────────
 * VideoToolbar — 悬浮工具栏
 * ──────────────────────────────────────────── */

interface VideoToolbarProps {
  onOpenExternal: () => void;
  onDelete: () => void;
}

const VideoToolbar: React.FC<VideoToolbarProps> = ({ onOpenExternal, onDelete }) => (
  <div className="block-shell__toolbar motion-affordance">
    <Tooltip content="新标签打开">
      <button
        type="button"
        className="block-shell__action motion-tap"
        onClick={onOpenExternal}
      >
        <ExternalLink size={14} />
      </button>
    </Tooltip>
    <Tooltip content="删除">
      <button
        type="button"
        className="block-shell__action is-danger motion-tap"
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </Tooltip>
  </div>
);

/* ────────────────────────────────────────────
 * VideoBlockView — 主组件
 * ──────────────────────────────────────────── */

export const VideoBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  selected,
}) => {
  const [showInput, setShowInput] = useState(false);
  const src = (node.attrs.src as string) || '';

  /** 解析视频 URL */
  const parsed = useMemo(() => (src ? parseVideoUrl(src) : null), [src]);

  /** 提交 URL */
  const handleUrlSubmit = useCallback((url: string) => {
    const result = parseVideoUrl(url);
    updateAttributes({ src: url, provider: result.provider });
    setShowInput(false);
  }, [updateAttributes]);

  /** 点击空状态 → 显示跟随式输入 */
  const handleEmptyClick = useCallback(() => {
    setShowInput(true);
  }, []);

  /** 关闭输入 */
  const handleCloseInput = useCallback(() => {
    setShowInput(false);
  }, []);

  /** 删除视频块 */
  const handleDelete = useCallback(() => {
    deleteNode();
  }, [deleteNode]);

  /** 新标签打开原链接 */
  const handleOpenExternal = useCallback(() => {
    if (src) window.open(src, '_blank', 'noopener,noreferrer');
  }, [src]);

  return (
    <NodeViewWrapper
      className={`video-block-view motion-affordance-host ${
        selected ? 'is-selected' : ''
      }`}
    >
      <div contentEditable={false}>
        {/* 空状态 */}
        {!src && !showInput && (
          <VideoEmptyState onClick={handleEmptyClick} />
        )}

        {/* 跟随式输入 */}
        {!src && showInput && (
          <div className="video-block-view__input-anchor">
            <InlineInput
              placeholder="粘贴视频链接..."
              icon={<Link2 size={14} />}
              onSubmit={handleUrlSubmit}
              onClose={handleCloseInput}
            />
          </div>
        )}

        {/* 有视频：播放器 + 悬浮工具栏 */}
        {src && parsed && (
          <div className="video-block-view__player-wrap">
            <VideoPlayer provider={parsed.provider} embedUrl={parsed.embedUrl} />
            <VideoToolbar
              onOpenExternal={handleOpenExternal}
              onDelete={handleDelete}
            />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
};
