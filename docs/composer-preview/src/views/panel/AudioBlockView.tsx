/**
 * AudioBlockView — 音频块 NodeView (V2)
 *
 * 空状态使用 InlineInput 跟随式输入。
 * 渲染态：自定义播放器（播放按钮 + 进度条 + 时间 + 音量）。
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import {
  FileAudio, Link2, Play, Pause, Volume2, VolumeX, Trash2, Upload,
} from 'lucide-react';
import { InlineInput } from '../../ui/InlineInput';
import { Tooltip } from '../../ui/Tooltip';

/* ────────────────────────────────────────────
 * AudioPlayer — 自定义播放器
 *
 * 进度条用 scaleX 而不是 width，每帧只走合成器。
 * 滑块仅在 hover 时以 spring 弹出，平时不占视觉。
 * ──────────────────────────────────────────── */

interface AudioPlayerProps {
  src: string;
  title: string;
  onDelete: () => void;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ src, title, onDelete }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onLoaded = () => setDuration(audio.duration || 0);
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    };
    const onEnded = () => setPlaying(false);

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
    };
  }, [src]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); } else { audio.play(); }
    setPlaying(!playing);
  }, [playing]);

  const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
  }, [duration]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="audio-block motion-affordance-host">
      <audio ref={audioRef} src={src} preload="metadata" muted={muted} />

      <button type="button" className="audio-block__play motion-tap" onClick={togglePlay}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>

      <div className="audio-block__body">
        <div className="audio-block__title">{title || '音频文件'}</div>
        <div className="audio-block__track" onClick={handleTrackClick}>
          <div className="audio-block__fill" style={{ transform: `scaleX(${progress})` }} />
          <div className="audio-block__thumb" style={{ left: `${progress * 100}%` }} />
        </div>
        <div className="audio-block__times">
          <span>{fmt(currentTime)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <div className="audio-block__volume">
        <button type="button" className="audio-block__mute motion-tap" onClick={() => setMuted(!muted)}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
      </div>

      <div className="block-shell__toolbar motion-affordance">
        <Tooltip content="删除">
          <button type="button" className="block-shell__action is-danger motion-tap" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────
 * AudioBlockView — 主组件
 * ──────────────────────────────────────────── */

export const AudioBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  selected,
}) => {
  const [showInput, setShowInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const src = (node.attrs.src as string) || '';
  const title = (node.attrs.title as string) || '';

  const handleUrlSubmit = useCallback((url: string) => {
    updateAttributes({ src: url, title: url.split('/').pop() || '音频' });
    setShowInput(false);
  }, [updateAttributes]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    updateAttributes({ src: URL.createObjectURL(file), title: file.name });
    e.target.value = '';
  }, [updateAttributes]);

  return (
    <NodeViewWrapper className={`audio-block-view ${selected ? 'is-selected' : ''}`}>
      <div contentEditable={false}>
        {!src && !showInput && (
          <div className="block-empty motion-fade-in">
            <div className="block-empty__icon"><FileAudio size={18} /></div>
            <div className="block-empty__text">
              <span className="block-empty__title">添加音频</span>
              <span className="block-empty__hint">上传文件或粘贴链接</span>
            </div>
            <div className="block-inline-form" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn--secondary btn--sm motion-tap" onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} /> 上传
              </button>
              <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={() => setShowInput(true)}>
                <Link2 size={13} /> 链接
              </button>
            </div>
            <input ref={fileInputRef} type="file" accept="audio/*" hidden onChange={handleFileChange} />
          </div>
        )}

        {!src && showInput && (
          <div style={{ padding: '4px 0' }}>
            <InlineInput
              placeholder="粘贴音频链接..."
              icon={<Link2 size={14} />}
              onSubmit={handleUrlSubmit}
              onClose={() => setShowInput(false)}
            />
          </div>
        )}

        {src && <AudioPlayer src={src} title={title} onDelete={deleteNode} />}
      </div>
    </NodeViewWrapper>
  );
};
