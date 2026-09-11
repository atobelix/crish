/**
 * 笔记叶工厂（核心装配宿主）：Master-Detail 响应式装配 + 多笔记状态机闭环。
 * 宿主保持 flex-direction: column，内部嵌套水平行容器 workspaceRow：抽屉在左，主面板在右且绑定 key={activeDocId}。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProductStrictHydrateTransport } from '../../components/note-paper/hydrateProjection';
import { NotePaperStrictPanel } from '../../components/note-paper/NotePaperStrictPanel';
import { NoteSidebarDrawer } from '../../components/note-paper/NoteSidebarDrawer';
import { useNoteDocumentManager } from '../../components/note-paper/useNoteDocumentManager';
import type { ViewRenderContext } from '../../services/view-registry';
import { NOTE_LEAF_HONESTY_ATTRS } from './honesty';
import { useWorkspaceEmptyStateMirrorSlot } from './mirrorSlot';
import {
  buildPaperWriteConeDataAttrs,
  useWorkspaceEmptyStatePaperBindings,
} from './paperWriteCone';
import {
  loadRecentPersistedDocId,
  resolveExplicitNoteDocId,
  resolveNotePaperDoc,
} from './productLeafBindings';
import {
  resolveWorkspaceProductEmptyMirrorProps,
  WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE,
} from './productMirrorPolicy';
import { WORKSPACE_PRODUCT_ENABLE_PAPER_LIST } from './productPaperListPolicy';
import { buildStrictDocBindingDataAttrs } from './productStrictDoc';
import styles from './NoteLeafHost.module.css';

export function NoteLeafHost(ctx: ViewRenderContext): React.ReactElement {
  const explicit = resolveExplicitNoteDocId(ctx);
  const [recent, setRecent] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  useEffect(() => {
    if (explicit) {
      setRecent(null);
      return;
    }
    let live = true;
    void loadRecentPersistedDocId().then((id) => {
      if (live) setRecent(id);
    });
    return () => {
      live = false;
    };
  }, [explicit, ctx.panelId]);

  const resolution = resolveNotePaperDoc(ctx, recent);

  // 面板待落盘冲刷器注册（T8）：面板持有 pending 差量，宿主把冲刷器交给文档
  // 管理器，切换 / 新建文档前先冲刷，杜绝编辑丢失。
  const panelFlushRef = useRef<(() => Promise<void>) | null>(null);
  const registerPendingFlush = useCallback(
    (flush: (() => Promise<void>) | null) => {
      panelFlushRef.current = flush;
    },
    []
  );
  const flushPendingDraft = useCallback(async (): Promise<void> => {
    await panelFlushRef.current?.();
  }, []);

  // 接入多笔记综合管理状态机（防乱序、脏刷盘、冷启动自愈）
  const docManager = useNoteDocumentManager({
    initialDocId: explicit || resolution.docId,
    flushPendingDraft,
  });

  const activeDocId =
    !explicit && resolution.binding === 'recent-persisted' && docManager.activeDocId === resolution.syntheticFallback
      ? resolution.docId
      : (docManager.activeDocId || resolution.docId);

  useEffect(() => {
    if (!explicit && recent && resolution.binding === 'recent-persisted' && resolution.docId) {
      void docManager.switchDocument(resolution.docId);
    }
  }, [explicit, recent, resolution.binding, resolution.docId, docManager.switchDocument]);

  // 为当前激活的 docId 创建专属 Transport 实例
  const transport = useMemo(
    () => createProductStrictHydrateTransport(activeDocId),
    [activeDocId]
  );

  const paper = useWorkspaceEmptyStatePaperBindings({
    strictDocId: activeDocId,
    strictHydrateTransport: transport,
    enableProductPaperList: WORKSPACE_PRODUCT_ENABLE_PAPER_LIST === true,
  });

  const productMirror = useMemo(
    () => resolveWorkspaceProductEmptyMirrorProps(),
    []
  );

  // 产品叶无真实 unpushed 源（hydrate / IPC / collab 均未暴露计数）；保持 hook 默认 0
  const mirror = useWorkspaceEmptyStateMirrorSlot({
    strictDocId: activeDocId,
    enableMirrorDetectSchedule:
      WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE === true,
    mirrorIpc: productMirror.mirrorIpc,
  });

  return (
    <div
      data-note-leaf-host="true"
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, flex: '1 1 0%', maxWidth: '100%', overflow: 'hidden' }}
      {...NOTE_LEAF_HONESTY_ATTRS}
      {...buildStrictDocBindingDataAttrs(resolution)}
      data-active-doc-id={activeDocId}
      {...buildPaperWriteConeDataAttrs(
        paper.slashBinding,
        paper.mdPrefixBinding,
        true
      )}
      {...mirror.dataAttrs}
      data-product-paper-list={paper.productPaperListAttr}
    >
      {/* 水平行容器：左侧抽屉 + 右侧主视口 */}
      <div className={styles.workspaceRow}>
        <NoteSidebarDrawer
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
          documents={docManager.documents}
          activeDocId={activeDocId}
          onSelectDoc={docManager.switchDocument}
          onCreateDoc={() => void docManager.createDocument()}
          onRenameDoc={(id, title) => void docManager.renameDocument(id, title)}
          onDeleteDoc={(id) => void docManager.deleteDocument(id)}
          searchQuery={docManager.searchQuery}
          onSearchChange={docManager.setSearchQuery}
        />

        <div className={styles.editorPane}>
          <NotePaperStrictPanel
            key={activeDocId}
            docId={activeDocId}
            hydrateTransport={paper.resolvedStrictTransport}
            slashIntentSink={paper.slashBinding.sink}
            slashWriteMode={paper.slashBinding.mode}
            slashSinkSource={paper.slashBinding.source}
            turnIntoSink={paper.mdPrefixBinding.sink}
            mdPrefixWriteMode={paper.mdPrefixBinding.mode}
            mdPrefixSinkSource={paper.mdPrefixBinding.source}
            mdPrefixBinding={paper.mdPrefixBinding}
            paperList={WORKSPACE_PRODUCT_ENABLE_PAPER_LIST ? true : undefined}
            mirrorDriftReport={mirror.effectiveMirrorReport}
            mirrorWatchSource={mirror.resolvedWatchSource}
            showMirrorDriftBar={mirror.panelShowMirrorDriftBar}
            onMirrorThreeWay={mirror.resolvedOnMirrorThreeWay}
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
            documents={docManager.documents}
            onSelectDoc={docManager.switchDocument}
            onCreateDoc={() => void docManager.createDocument()}
            onRenameTitle={(title) => void docManager.renameDocument(activeDocId, title)}
            applyOps={paper.applyOps}
            registerPendingFlush={registerPendingFlush}
            onBlockChange={(_id, _text) => {
              docManager.touchDocument(activeDocId);
            }}
            onTextCommit={(_id, _text) => {
              docManager.touchDocument(activeDocId);
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default NoteLeafHost;
