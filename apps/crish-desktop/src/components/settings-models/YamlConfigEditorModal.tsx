/**
 * YamlConfigEditorModal.tsx
 * 模型配置文件 (models.yaml) 轻量内置代码编辑器弹窗
 *
 * 遵循系统 Design Tokens 规范与分层契约：
 * - 纯实点状态指示器（Tooltip 辅助说明，无冗余胶囊与文本）；
 * - 采用系统 Input 标准原子组件（variant="search"）；
 * - 接入系统代码字体与等宽特征（--md-code-font / --font-mono-features / --md-code-font-size）；
 * - 平整融入纸面，无冗余细分割线与激活外边框；
 * - 状态与副作用逻辑由 useYamlConfigEditor 权威驱动。
 */

import React from 'react';
import { Button, ConfirmDialog, Dialog, Input, Textarea, Tooltip } from '../ui';
import styles from './YamlConfigEditorModal.module.css';
import { AppIcon } from '../ui/icons/index';
import { useYamlConfigEditor } from './useYamlConfigEditor';

export interface YamlConfigEditorModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export const YamlConfigEditorModal: React.FC<YamlConfigEditorModalProps> = ({
  open,
  onClose,
  onSaved,
}) => {
  const ed = useYamlConfigEditor({ open, onClose, onSaved });

  return (
    <>
      <Dialog
        open={open}
        onClose={ed.handleRequestClose}
        size="lg"
        showCloseButton={true}
        title={
          <div className={styles.modalTitleRow}>
            <span className={styles.modalTitleText}>模型能力与参数配置</span>
            <Tooltip content={ed.dynamicStatusTooltip}>
              <span
                className={styles.dynamicStatusDot}
                data-status={ed.dynamicStatus}
                role="status"
                aria-label={ed.dynamicStatusLabel}
                onClick={ed.syntaxError ? ed.handleJumpToError : undefined}
              />
            </Tooltip>
          </div>
        }
        footer={
          <div className={styles.modalFooter}>
            <div className={styles.footerLeft}>
              <div className={styles.footerActionGroup}>
                <Tooltip content="撤回所有未保存的修改 (Revert)">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!ed.isDirty}
                    onClick={() => ed.setCode(ed.originalCode)}
                    icon={<AppIcon name="undo" size={13} aria-hidden />}
                    aria-label="撤回"
                    className={styles.footerBtn}
                  >
                    撤回
                  </Button>
                </Tooltip>
                <Tooltip content="从磁盘刷新 models.yaml 内容">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void ed.loadConfigFile()}
                    icon={<AppIcon name="refresh" size={13} aria-hidden />}
                    aria-label="刷新"
                    className={styles.footerBtn}
                  >
                    刷新
                  </Button>
                </Tooltip>
                <Tooltip
                  content={
                    !ed.template
                      ? '未获取到内置模板'
                      : ed.code === ed.template
                        ? '当前已是内置模板内容'
                        : '恢复为系统内置默认模板'
                  }
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!ed.template || ed.code === ed.template}
                    onClick={ed.handleRequestResetTemplate}
                    icon={<AppIcon name="rotate-ccw" size={13} aria-hidden />}
                    aria-label="恢复内置模板"
                    className={styles.footerBtn}
                  >
                    恢复内置模板
                  </Button>
                </Tooltip>
              </div>

              {ed.serviceError ? (
                <div
                  className={`${styles.errorBanner} ${styles.errorBannerStatic}`}
                  role="alert"
                >
                  <AppIcon name="unplug" size={13} aria-hidden />
                  <span className={styles.errorBannerText}>
                    {ed.serviceError}
                  </span>
                </div>
              ) : ed.syntaxError ? (
                <Tooltip content="点击直接跳转到错误行">
                  <div
                    className={styles.errorInlineTag}
                    onClick={ed.handleJumpToError}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ')
                        ed.handleJumpToError();
                    }}
                  >
                    <AppIcon name="alert-circle" size={12} aria-hidden />
                    <span>定位错误</span>
                  </div>
                </Tooltip>
              ) : null}
            </div>

            <div className={styles.footerRight}>
              {ed.saveSuccess && (
                <div className={styles.successIndicator}>
                  <AppIcon name="check" size={14} />
                  <span>已保存并生效</span>
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={ed.handleRequestClose}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void ed.handleSave()}
                loading={ed.saving}
                disabled={!ed.canSave}
                icon={<AppIcon name="save" size={13} aria-hidden />}
              >
                保存配置
              </Button>
            </div>
          </div>
        }
      >
        {/* 标题下方功能行 (主要为搜索框 + 辅助按钮) */}
        <div className={styles.editorToolbar}>
          {/* 搜索框 (轻量工具栏形态，未选中态融入纸面，展开时统一承载导航与清除操作) */}
          <Input
            ref={ed.searchInputRef}
            variant="search"
            size="sm"
            clearable={false}
            className={styles.searchBar}
            data-has-value={Boolean(ed.searchQuery.trim())}
            placeholder="在配置中查找 (Ctrl+F)..."
            value={ed.searchQuery}
            onChange={(e) => ed.setSearchQuery(e.target.value)}
            onKeyDown={ed.handleSearchKeyDown}
            aria-label="在配置中查找"
            suffix={
              ed.searchQuery.trim() ? (
                <div className={styles.searchSuffix}>
                  <span className={styles.searchCount}>
                    {ed.matchCount > 0
                      ? `${ed.searchIndex + 1} / ${ed.matchCount}`
                      : '无结果'}
                  </span>
                  <Tooltip content="上一个匹配项 (Shift+Enter)">
                    <Button
                      bare
                      type="button"
                      className={styles.searchNavBtn}
                      onClick={() => ed.jumpToMatch(ed.searchIndex - 1)}
                      disabled={ed.matchCount === 0}
                      aria-label="上一个匹配项"
                    >
                      <AppIcon name="chevron-up" size={12} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="下一个匹配项 (Enter)">
                    <Button
                      bare
                      type="button"
                      className={styles.searchNavBtn}
                      onClick={() => ed.jumpToMatch(ed.searchIndex + 1)}
                      disabled={ed.matchCount === 0}
                      aria-label="下一个匹配项"
                    >
                      <AppIcon name="chevron-down" size={12} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="清空搜索 (Esc)">
                    <Button
                      bare
                      type="button"
                      className={styles.searchNavBtn}
                      onClick={() => {
                        ed.setSearchQuery('');
                        ed.searchInputRef.current?.focus();
                      }}
                      aria-label="清空搜索"
                    >
                      <AppIcon name="x" size={12} />
                    </Button>
                  </Tooltip>
                </div>
              ) : null
            }
          />

          {/* 工具操作按钮 */}
          <div className={styles.toolbarRight}>
            <Tooltip
              content={ed.showLineNumbers ? '隐藏代码行数' : '显示代码行数'}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => ed.setShowLineNumbers((prev) => !prev)}
                className={
                  ed.showLineNumbers
                    ? styles.toolbarBtnActive
                    : styles.toolbarBtn
                }
                aria-label={
                  ed.showLineNumbers ? '隐藏代码行数' : '显示代码行数'
                }
                icon={<AppIcon name="list" size={13} aria-hidden />}
              >
                行号
              </Button>
            </Tooltip>

            <Tooltip content={ed.wordWrap ? '关闭自动换行' : '开启自动换行'}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => ed.setWordWrap((prev) => !prev)}
                className={
                  ed.wordWrap ? styles.toolbarBtnActive : styles.toolbarBtn
                }
                aria-label={ed.wordWrap ? '关闭自动换行' : '开启自动换行'}
                icon={<AppIcon name="wrap-text" size={13} aria-hidden />}
              >
                换行
              </Button>
            </Tooltip>

            <Tooltip content="复制全部 YAML 内容">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void ed.handleCopyAll()}
                className={styles.toolbarBtn}
                aria-label="复制全部内容"
                icon={
                  <AppIcon
                    name={ed.copied ? 'check' : 'copy'}
                    size={13}
                    aria-hidden
                  />
                }
              >
                {ed.copied ? '已复制' : '复制'}
              </Button>
            </Tooltip>
          </div>
        </div>

        {/* 双层同步编辑器核心舞台 */}
        <div className={styles.editorViewport}>
          {/* 行号栏 Gutter（默认不打开，由按钮控制；背景透明） */}
          {ed.showLineNumbers && (
            <div ref={ed.gutterRef} className={styles.gutter} aria-hidden>
              {Array.from({ length: ed.lineCount }).map((_, idx) => {
                const lineNum = idx + 1;
                const isErr = ed.syntaxError?.line === lineNum;
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
          )}

          {/* 双层重叠区 */}
          <div
            className={styles.editorStage}
            data-wrap={ed.wordWrap ? 'true' : 'false'}
          >
            {/* 背景语法高亮层 */}
            <pre ref={ed.preRef} className={styles.highlightLayer} aria-hidden>
              <code
                className={styles.highlightCode}
                dangerouslySetInnerHTML={{ __html: ed.highlightedHtml }}
              />
            </pre>

            {/* 前景文本输入捕获层 */}
            <Textarea
              bare
              ref={ed.textareaRef}
              className={styles.textareaInput}
              value={ed.code}
              onChange={(e) => ed.setCode(e.target.value)}
              onScroll={ed.handleScroll}
              onKeyDown={ed.handleKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              placeholder={
                ed.serviceError
                  ? '配置文件服务不可用'
                  : '请输入 models.yaml 配置内容...'
              }
              disabled={ed.loading}
            />
          </div>
        </div>
      </Dialog>

      {/* 恢复内置模板二次确认弹窗 */}
      <ConfirmDialog
        open={ed.showResetConfirm}
        title="恢复内置默认模板？"
        description="此操作将使用系统内置默认模板覆盖当前编辑器内容，未保存的修改将丢失。"
        confirmLabel="确认恢复模板"
        cancelLabel="取消"
        danger={true}
        onConfirm={() => {
          ed.setShowResetConfirm(false);
          if (ed.template) {
            ed.setCode(ed.template);
          }
        }}
        onCancel={() => ed.setShowResetConfirm(false)}
      />

      {/* 防丢失确认弹窗 */}
      <ConfirmDialog
        open={ed.showDiscardConfirm}
        title="放弃未保存的修改？"
        description="你对 models.yaml 的修改尚未保存，退出后更改将丢失。"
        confirmLabel="放弃修改并退出"
        cancelLabel="继续编辑"
        danger={true}
        onConfirm={() => {
          ed.setShowDiscardConfirm(false);
          ed.setCode(ed.originalCode);
          onClose();
        }}
        onCancel={() => ed.setShowDiscardConfirm(false)}
      />
    </>
  );
};
