/**
 * LR-H1 · 产品 Strict 打开 docId 解析（夹具 re-export）
 *
 * 实现住在 `extensions/note-paper/productStrictDoc`。
 * 本文件只 re-export，符号名不变。
 *
 * 打开面不再只有死合成 `strict-${wsId}`：
 * 无绑定 → 仍回退诚实空（binding=`synthetic-unbound`，不得删）
 *
 * ≠ 打开完成（G-HYD 产品句）· ≠ EL-01 / EL-04 / EL-08
 */

export {
  bindWorkspacePersistedStrictDoc,
  buildStrictDocBindingDataAttrs,
  peekWorkspacePersistedStrictDoc,
  resetWorkspacePersistedStrictDocBindings,
  resolveProductStrictDocId,
  syntheticStrictDocId,
  unbindWorkspacePersistedStrictDoc,
  type ProductStrictDocBindingKind,
  type ProductStrictDocResolution,
  type ResolveProductStrictDocIdInput,
} from '../../extensions/note-paper/productStrictDoc';
