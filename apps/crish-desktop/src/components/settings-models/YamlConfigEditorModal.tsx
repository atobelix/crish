/**
 * YamlConfigEditorModal.tsx
 * 模型配置文件 (models.yaml) 轻量内置代码编辑器弹窗
 *
 * 真源接线（字典唯一写路径）：
 * - 读 = workbench_read_models_yaml（Rust 懒播种 + serde_yaml 单点解析），
 *   磁盘内容已损坏时原样返回 + 结构化诊断，编辑器修复后可保存；
 * - 校验 = workbench_validate_models_yaml（行/列诊断）；校验服务不可用 → fail-closed 禁存；
 * - 存 = workbench_save_models_yaml（conex-fs 原子写）；成功后强制重载字典镜像；
 * - 服务 missing / error 一律显式失败态，无任何本地回退轨（无 localStorage、无内置假数据）。
 *
 * 交互实现：
 * 1. 零新增 npm 依赖：基于现有 highlight.js + 原生 textarea 构建双层同步滚动高亮；
 * 2. 严格 20px 整数行高与等宽字体栈，杜绝亚像素偏移；
 * 3. 智能 Tab 键 2 空格缩进处理，刚性杜绝制表符 \t；
 * 4. 实时语法诊断、行号红底高亮与底栏错误横幅一键精准跳转；
 * 5. 脏状态检测与退出防丢确认对话框（ConfirmDialog）；
 * 6. 快捷键支持（Ctrl+S 保存 / Esc 退出拦截）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { Button, ConfirmDialog, Dialog, Tooltip } from '../ui';
import { highlightCode } from '../../api/codeHighlight';
import { invokeTyped } from '../../api/tauriInvoke';
import { ensureModelsCatalogLoaded, getModelsCatalogPath } from '../../api/modelsCatalogStore';
import styles from './YamlConfigEditorModal.module.css';

interface YamlConfigEditorModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

interface YamlSyntaxError {
  line: number;
  column?: number;
  message: string;
}

interface ReadModelsYamlWire {
  path: string;
  content: string;
  template: string;
  seeded: boolean;
  parseError?: { line?: number; column?: number; message: string } | null;
}

interface ValidateModelsYamlWire {
  valid: boolean;
  line?: number;
  column?: number;
  message?: string;
}

/** 从 Rust InvalidInput 消息中提取「第 L 行 第 C 列」结构化位置（单一错误文本协议） */
function parseLineColumnFromMessage(message: string): { line?: number; column?: number } {
  const m = /第\s*(\d+)\s*行(?:\s*第\s*(\d+)\s*列)?/.exec(message);
  if (!m) return {};
  return {
    line: m[1] ? Number(m[1]) : undefined,
    column: m[2] ? Number(m[2]) : undefined,
  };
}

export const YamlConfigEditorModal: React.FC<YamlConfigEditorModalProps> = ({
  open,
  onClose,
  onSaved,
}) => {
  const [code, setCode] = useState<string>('');
  const [originalCode, setOriginalCode] = useState<string>('');
  const [template, setTemplate] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string>(getModelsCatalogPath());
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [syntaxError, setSyntaxError] = useState<YamlSyntaxError | null>(null);
  /** 服务面失败（missing / error）：与内容语法错误分开呈现，统一 fail-closed 禁存 */
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const isDirty = useMemo(() => code !== originalCode, [code, originalCode]);

  // 计算行数
  const lineCount = useMemo(() => {
    return Math.max(1, code.split('\n').length);
  }, [code]);

  // 语法高亮 HTML（走现有 highlightCode）
  const highlightedHtml = useMemo(() => {
    // 结尾换行补全，避免 pre 在末尾少算一行高度
    const safeCode = code.endsWith('\n') ? code + ' ' : code;
    return highlightCode(safeCode, 'yaml');
  }, [code]);

  // 1. 读取配置文件（缺文件由 Rust 播种内置模板）
  const loadConfigFile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invokeTyped<ReadModelsYamlWire>('workbench_read_models_yaml', {});

      if (res.status === 'ok') {
        setFilePath(res.data.path || getModelsCatalogPath());
        setTemplate(res.data.template ?? null);
        setCode(res.data.content);
        setOriginalCode(res.data.content);
        setServiceError(null);
        const pe = res.data.parseError;
        setSyntaxError(
          pe ? { line: pe.line ?? 1, column: pe.column ?? 1, message: pe.message } : null
        );
        return;
      }

      setServiceError(
        res.status === 'missing'
          ? '配置文件服务未接线（workbench_read_models_yaml），请重启应用'
          : res.message
      );
      setSyntaxError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadConfigFile();
      setSaveSuccess(false);
      setSyntaxError(null);
      setServiceError(null);
    }
  }, [open, loadConfigFile]);

  // 2. 实时语法诊断（Rust serde_yaml 校验；服务不可用 → fail-closed 禁存）
  useEffect(() => {
    if (!open || serviceError || loading) return;
    const timer = setTimeout(async () => {
      const res = await invokeTyped<ValidateModelsYamlWire>('workbench_validate_models_yaml', {
        content: code,
      });

      if (res.status === 'missing') {
        setServiceError('配置校验服务未接线（workbench_validate_models_yaml），保存已禁用');
        return;
      }
      if (res.status === 'error') {
        setServiceError(res.message);
        return;
      }

      setServiceError(null);
      setSyntaxError(
        res.data.valid
          ? null
          : {
              line: res.data.line ?? 1,
              column: res.data.column ?? 1,
              message: res.data.message || 'YAML 语法格式错误',
            }
      );
    }, 200);

    return () => clearTimeout(timer);
  }, [code, open, serviceError, loading]);

  // 3. 滚动单向同步处理
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop;
    }
  };

  // 4. Tab 键缩进与快捷键处理
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab 键处理
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const { selectionStart, selectionEnd, value } = textarea;

      if (selectionStart === selectionEnd) {
        // 单光标插入 2 空格
        const next = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd);
        setCode(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = selectionStart + 2;
        });
      } else {
        // 多行选中缩进/反缩进
        const startLineIdx = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const endLineIdx = value.indexOf('\n', selectionEnd);
        const sliceEnd = endLineIdx === -1 ? value.length : endLineIdx;
        const targetBlock = value.slice(startLineIdx, sliceEnd);
        const blockLines = targetBlock.split('\n');

        let nextBlock = '';
        let diff = 0;

        if (e.shiftKey) {
          // 反缩进
          const processed = blockLines.map((l) => {
            if (l.startsWith('  ')) {
              diff -= 2;
              return l.slice(2);
            }
            if (l.startsWith(' ')) {
              diff -= 1;
              return l.slice(1);
            }
            return l;
          });
          nextBlock = processed.join('\n');
        } else {
          // 正向缩进 2 空格
          const processed = blockLines.map((l) => {
            diff += 2;
            return '  ' + l;
          });
          nextBlock = processed.join('\n');
        }

        const next = value.slice(0, startLineIdx) + nextBlock + value.slice(sliceEnd);
        setCode(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = startLineIdx;
          textarea.selectionEnd = Math.max(startLineIdx, selectionEnd + diff);
        });
      }
      return;
    }

    // Ctrl+S / Cmd+S 保存
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void handleSave();
    }
  };

  // 5. 保存（Rust 侧先校验后原子写；成功后强制重载字典镜像）
  const handleSave = async () => {
    if (syntaxError || serviceError || saving) return;
    setSaving(true);
    try {
      const res = await invokeTyped<{ path: string }>('workbench_save_models_yaml', {
        content: code,
      });

      if (res.status === 'missing') {
        setServiceError('配置保存服务未接线（workbench_save_models_yaml）');
        return;
      }
      if (res.status === 'error') {
        // 校验失败等后端拒绝：消息文本携带「第 L 行 第 C 列」，解析后精准定位
        const pos = parseLineColumnFromMessage(res.message);
        setSyntaxError({ line: pos.line ?? 1, column: pos.column ?? 1, message: res.message });
        return;
      }

      setOriginalCode(code);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      await ensureModelsCatalogLoaded(true);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  // 6. 一键跳转至错误行
  const handleJumpToError = () => {
    if (!syntaxError || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const targetLine = syntaxError.line;
    const targetCol = syntaxError.column || 1;

    const lines = code.split('\n');
    let charOffset = 0;
    for (let i = 0; i < targetLine - 1 && i < lines.length; i++) {
      charOffset += (lines[i]?.length ?? 0) + 1;
    }

    const pos = Math.min(code.length, charOffset + Math.max(0, targetCol - 1));
    textarea.focus();
    textarea.setSelectionRange(pos, pos);

    // 垂直滚动定位
    const targetScrollTop = Math.max(0, (targetLine - 1) * 20 - 100);
    textarea.scrollTop = targetScrollTop;
  };

  // 7. 关闭请求（防丢失检查）
  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  };

  const canSave = !syntaxError && !serviceError && isDirty && !loading && !saving;

  return (
    <>
      <Dialog
        open={open}
        onClose={handleRequestClose}
        size="lg"
        variant="modal"
        showCloseButton={true}
        title={
          <div className={styles.modalTitleRow}>
            <Lucide.FileCode2 size={16} className={styles.modalTitleIcon} aria-hidden />
            <span>模型能力与参数配置 (models.yaml)</span>
            {isDirty && (
              <Tooltip content="有未保存修改">
                <span className={styles.dirtyDot} aria-label="有未保存修改">●</span>
              </Tooltip>
            )}
          </div>
        }
        description={
          // span + flex：Dialog 的 description 渲染在 <p> 内，块级 div 属非法嵌套
          <span className={styles.modalSubHeader}>
            <Tooltip content={filePath}>
              <span className={styles.filePathBadge}>{filePath}</span>
            </Tooltip>
          </span>
        }
        footer={
          <div className={styles.modalFooter}>
            {serviceError ? (
              <div className={`${styles.errorBanner} ${styles.errorBannerStatic}`} role="alert">
                <Lucide.Unplug size={14} aria-hidden />
                <span className={styles.errorBannerText}>{serviceError}</span>
              </div>
            ) : syntaxError ? (
              <Tooltip content="点击直接跳转到错误行">
                <div
                  className={styles.errorBanner}
                  onClick={handleJumpToError}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleJumpToError();
                  }}
                >
                  <Lucide.AlertCircle size={14} aria-hidden />
                  <span className={styles.errorBannerText}>
                    第 {syntaxError.line} 行: {syntaxError.message} (点击定位)
                  </span>
                </div>
              </Tooltip>
            ) : saveSuccess ? (
              <div className={styles.successIndicator}>
                <Lucide.Check size={14} />
                <span>已保存并生效</span>
              </div>
            ) : (
              <div className={styles.toolbarInfo}>
                共 {lineCount} 行 ⏐ Tab 为 2 空格 ⏐ Ctrl+S 保存
              </div>
            )}

            <div className={styles.footerActions}>
              <Button type="button" variant="ghost" size="sm" onClick={handleRequestClose}>
                取消
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void handleSave()}
                loading={saving}
                disabled={!canSave}
                icon={<Lucide.Save size={13} aria-hidden />}
              >
                保存并热重载
              </Button>
            </div>
          </div>
        }
      >
        {/* 顶部轻量工具栏 */}
        <div className={styles.editorToolbar}>
          <div className={styles.toolbarLeft}>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={!template}
              onClick={() => template && setCode(template)}
              icon={<Lucide.FileText size={12} aria-hidden />}
            >
              恢复标准模版
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => void loadConfigFile()}
              icon={<Lucide.RefreshCw size={12} aria-hidden />}
            >
              重载磁盘
            </Button>
          </div>
          <div className={styles.toolbarRight}>
            <span className={styles.toolbarInfo}>
              {isDirty ? '已修改' : '已同步'}
            </span>
          </div>
        </div>

        {/* 双层同步编辑器核心舞台 */}
        <div className={styles.editorViewport}>
          {/* 行号栏 Gutter */}
          <div ref={gutterRef} className={styles.gutter} aria-hidden>
            {Array.from({ length: lineCount }).map((_, idx) => {
              const lineNum = idx + 1;
              const isErr = syntaxError?.line === lineNum;
              return (
                <div
                  key={lineNum}
                  className={`${styles.gutterLine} ${isErr ? styles.gutterLineError : ''}`}
                >
                  {lineNum}
                </div>
              );
            })}
          </div>

          {/* 双层重叠区 */}
          <div className={styles.editorStage}>
            {/* 背景语法高亮层 */}
            <pre ref={preRef} className={styles.highlightLayer} aria-hidden>
              <code
                className={styles.highlightCode}
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            </pre>

            {/* 前景文本输入捕获层 */}
            <textarea
              ref={textareaRef}
              className={styles.textareaInput}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onScroll={handleScroll}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              placeholder={
                serviceError ? '配置文件服务不可用' : '请输入 models.yaml 配置...'
              }
              disabled={loading}
            />
          </div>
        </div>
      </Dialog>

      {/* 防丢失确认弹窗 */}
      <ConfirmDialog
        open={showDiscardConfirm}
        title="放弃未保存的修改？"
        description="你对 models.yaml 的修改尚未保存，退出后更改将丢失。"
        confirmLabel="放弃修改退出"
        cancelLabel="继续编辑"
        danger={true}
        onConfirm={() => {
          setShowDiscardConfirm(false);
          setCode(originalCode);
          onClose();
        }}
        onCancel={() => setShowDiscardConfirm(false)}
      />
    </>
  );
};
