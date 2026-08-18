/**
 * selection/model.js — 跨块选区纯模型（U1）
 * 无 DOM。状态：idle | multi；selectedIds 按文档顺序。
 * Prefix: MdxSelectionModel
 */
(function () {
  'use strict';

  function create() {
    return {
      mode: 'idle', // idle | multi | dragging
      anchorId: null,
      focusId: null,
      selectedIds: [],
    };
  }

  function clone(state) {
    return {
      mode: state.mode,
      anchorId: state.anchorId,
      focusId: state.focusId,
      selectedIds: (state.selectedIds || []).slice(),
    };
  }

  function indexOfId(orderedIds, id) {
    for (var i = 0; i < orderedIds.length; i++) {
      if (orderedIds[i] === id) return i;
    }
    return -1;
  }

  /**
   * 从 anchor 到 focus（含）取文档顺序 id 列表
   * @param {string[]} orderedIds 文档顺序 block id
   */
  function rangeIds(orderedIds, anchorId, focusId) {
    if (!orderedIds || !orderedIds.length) return [];
    var a = indexOfId(orderedIds, anchorId);
    var b = indexOfId(orderedIds, focusId);
    if (a < 0 && b < 0) return [];
    if (a < 0) a = b;
    if (b < 0) b = a;
    var lo = Math.min(a, b);
    var hi = Math.max(a, b);
    return orderedIds.slice(lo, hi + 1);
  }

  function setSingle(state, id) {
    state.mode = 'idle';
    state.anchorId = id || null;
    state.focusId = id || null;
    state.selectedIds = id ? [id] : [];
    return state;
  }

  function setRange(state, orderedIds, anchorId, focusId) {
    state.anchorId = anchorId;
    state.focusId = focusId;
    state.selectedIds = rangeIds(orderedIds, anchorId, focusId);
    state.mode = state.selectedIds.length > 1 ? 'multi' : state.selectedIds.length === 1 ? 'idle' : 'idle';
    // 单块 range 仍算 idle 语义（交给 enterEdit）；仅 length>1 为 multi
    if (state.selectedIds.length > 1) state.mode = 'multi';
    else if (state.selectedIds.length === 1) {
      state.mode = 'idle';
    } else {
      state.mode = 'idle';
      state.anchorId = null;
      state.focusId = null;
    }
    return state;
  }

  function beginDrag(state, id) {
    state.mode = 'dragging';
    state.anchorId = id;
    state.focusId = id;
    state.selectedIds = id ? [id] : [];
    return state;
  }

  function extendDrag(state, orderedIds, focusId) {
    if (!state.anchorId) return setSingle(state, focusId);
    state.focusId = focusId;
    state.selectedIds = rangeIds(orderedIds, state.anchorId, focusId);
    state.mode = 'dragging';
    return state;
  }

  function endDrag(state) {
    if (state.selectedIds.length > 1) state.mode = 'multi';
    else state.mode = 'idle';
    return state;
  }

  function toggle(state, orderedIds, id) {
    var ids = state.selectedIds.slice();
    var idx = indexOfId(ids, id);
    if (idx >= 0) {
      ids.splice(idx, 1);
    } else {
      ids.push(id);
      // 按文档序重排
      ids = orderedIds.filter(function (x) {
        return indexOfId(ids, x) >= 0;
      });
    }
    state.selectedIds = ids;
    if (!ids.length) {
      state.mode = 'idle';
      state.anchorId = null;
      state.focusId = null;
    } else if (ids.length === 1) {
      state.mode = 'idle';
      state.anchorId = ids[0];
      state.focusId = ids[0];
    } else {
      state.mode = 'multi';
      state.anchorId = ids[0];
      state.focusId = ids[ids.length - 1];
    }
    return state;
  }

  function clear(state) {
    state.mode = 'idle';
    state.anchorId = null;
    state.focusId = null;
    state.selectedIds = [];
    return state;
  }

  function isMulti(state) {
    return state && state.mode === 'multi' && state.selectedIds && state.selectedIds.length > 1;
  }

  function isSelected(state, id) {
    return state && state.selectedIds && indexOfId(state.selectedIds, id) >= 0;
  }

  function count(state) {
    return (state && state.selectedIds && state.selectedIds.length) || 0;
  }

  window.MdxSelectionModel = {
    create: create,
    clone: clone,
    rangeIds: rangeIds,
    setSingle: setSingle,
    setRange: setRange,
    beginDrag: beginDrag,
    extendDrag: extendDrag,
    endDrag: endDrag,
    toggle: toggle,
    clear: clear,
    isMulti: isMulti,
    isSelected: isSelected,
    count: count,
    indexOfId: indexOfId,
  };
})();
