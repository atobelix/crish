/**
 * 笔记叶工厂（lazy 块）：H1 + 产品 hydrate + C2′/E2′ 默装 + 现成写锥。
 * jsdom 绿 ≠ 打开完成 ≠ 关 EL。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createProductStrictHydrateTransport } from '../../components/note-paper/hydrateProjection';
import { NotePaperStrictPanel } from '../../components/note-paper/NotePaperStrictPanel';
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

export function NoteLeafHost(ctx: ViewRenderContext): React.ReactElement {
  const explicit = resolveExplicitNoteDocId(ctx);
  const [recent, setRecent] = useState<string | null>(null);

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
  const transport = useMemo(
    () => createProductStrictHydrateTransport(resolution.docId),
    [resolution.docId]
  );
  const paper = useWorkspaceEmptyStatePaperBindings({
    strictDocId: resolution.docId,
    strictHydrateTransport: transport,
    enableProductPaperList: WORKSPACE_PRODUCT_ENABLE_PAPER_LIST === true,
  });
  const productMirror = useMemo(
    () => resolveWorkspaceProductEmptyMirrorProps(),
    []
  );
  // 产品叶无真实 unpushed 源（hydrate / IPC / collab 均未暴露计数）；保持 hook 默认 0
  const mirror = useWorkspaceEmptyStateMirrorSlot({
    strictDocId: resolution.docId,
    enableMirrorDetectSchedule:
      WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE === true,
    mirrorIpc: productMirror.mirrorIpc,
  });

  return (
    <div
      data-note-leaf-host="true"
      {...NOTE_LEAF_HONESTY_ATTRS}
      {...buildStrictDocBindingDataAttrs(resolution)}
      {...buildPaperWriteConeDataAttrs(
        paper.slashBinding,
        paper.mdPrefixBinding,
        true
      )}
      {...mirror.dataAttrs}
      data-product-paper-list={paper.productPaperListAttr}
    >
      <NotePaperStrictPanel
        docId={resolution.docId}
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
      />
    </div>
  );
}

export default NoteLeafHost;
