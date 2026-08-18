/**
 * file-preview/viewers/ImageViewer.js
 * 从 preview-modal 迁入：zoom / rotate / crop / brush
 */
(function () {
  'use strict';

  var MIN_ZOOM = 0.5;
  var MAX_ZOOM = 3.0;
  var ZOOM_STEP = 0.25;
  var WHEEL_STEP = 0.1;

  var BRUSH_COLORS = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#FFFFFF'];

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function pct(z) {
    return Math.round(z * 100) + '%';
  }

  /**
   * @param {HTMLElement} host
   * @param {object} model
   * @param {object} handlers
   */
  function mount(host, model, handlers) {
    handlers = handlers || {};
    host.innerHTML = '';

    var payload = (model && model.payload) || {};
    var objectUrl = payload.objectUrl || '';
    var revokeOnDestroy = !!payload.revokeOnDestroy;
    // 记录需要 revoke 的 URL（裁切/画笔烘焙后原 objectURL 仍要释放）
    var urlsToRevoke = [];
    if (revokeOnDestroy && objectUrl && objectUrl.indexOf('blob:') === 0) {
      urlsToRevoke.push(objectUrl);
    }

    var zoom = 1.0;
    var rotation = 0;
    var isCropActive = false;
    var isBrushActive = false;
    var dirty = false;
    var destroyed = false;
    var toolbarBridge = null;

    // —— DOM ——
    var root = document.createElement('div');
    root.className = 'fp-img fp-fade-in';

    var stage = document.createElement('div');
    stage.className = 'fp-img-stage';

    var img = document.createElement('img');
    img.className = 'fp-img-el';
    img.alt = (model && model.name) || '预览图片';
    img.draggable = false;
    if (objectUrl) {
      // 跨域 demo 图；本地 blob 不受影响
      try {
        img.crossOrigin = 'anonymous';
      } catch (e) {
        /* ignore */
      }
      img.src = objectUrl;
    }

    var brushCanvas = document.createElement('canvas');
    brushCanvas.className = 'fp-img-brush';
    brushCanvas.setAttribute('aria-hidden', 'true');

    var cropOverlay = document.createElement('div');
    cropOverlay.className = 'fp-img-crop';
    cropOverlay.hidden = true;
    cropOverlay.innerHTML =
      '<div class="fp-img-crop-box" data-crop-box>' +
      '  <span class="fp-img-crop-grid h1"></span>' +
      '  <span class="fp-img-crop-grid h2"></span>' +
      '  <span class="fp-img-crop-grid v1"></span>' +
      '  <span class="fp-img-crop-grid v2"></span>' +
      '  <i class="fp-img-crop-handle nw" data-handle="nw"></i>' +
      '  <i class="fp-img-crop-handle ne" data-handle="ne"></i>' +
      '  <i class="fp-img-crop-handle sw" data-handle="sw"></i>' +
      '  <i class="fp-img-crop-handle se" data-handle="se"></i>' +
      '  <div class="fp-img-crop-actions">' +
      '    <button type="button" class="fp-img-crop-btn cancel" data-crop-cancel>取消</button>' +
      '    <button type="button" class="fp-img-crop-btn apply" data-crop-apply>应用</button>' +
      '  </div>' +
      '</div>';

    stage.appendChild(img);
    stage.appendChild(brushCanvas);
    stage.appendChild(cropOverlay);
    root.appendChild(stage);
    host.appendChild(root);

    var cropBox = cropOverlay.querySelector('[data-crop-box]');
    var brushCtx = brushCanvas.getContext('2d');
    var brushColor = BRUSH_COLORS[0];
    var isDrawing = false;
    var historyStrokes = [];
    var bottomEl = null;
    var bottomApi = null;

    // crop 拖拽状态
    var cropDrag = {
      active: false,
      resize: false,
      handle: null,
      startX: 0,
      startY: 0,
      startLeft: 0,
      startTop: 0,
      startW: 0,
      startH: 0,
    };

    function setDirty(v) {
      dirty = !!v;
      if (handlers.onDirtyChange) handlers.onDirtyChange(dirty);
    }

    function emitToolbarState() {
      var st = getToolbarState();
      if (toolbarBridge && typeof toolbarBridge.updateState === 'function') {
        toolbarBridge.updateState(st);
      }
      if (handlers.onToolbarState) handlers.onToolbarState(st);
    }

    function getToolbarState() {
      return {
        zoomLabel: pct(zoom),
        crop: isCropActive,
        brush: isBrushActive,
      };
    }

    function applyTransform() {
      stage.style.transform =
        'scale(' + zoom + ') rotate(' + rotation + 'deg)';
      emitToolbarState();
    }

    function resizeBrushCanvas() {
      if (!img.naturalWidth) return;
      // 用自然像素，显示层 CSS 铺满 stage
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      if (brushCanvas.width !== w || brushCanvas.height !== h) {
        brushCanvas.width = w;
        brushCanvas.height = h;
        if (brushCtx) {
          brushCtx.strokeStyle = brushColor;
          brushCtx.lineWidth = Math.max(2, Math.round(w / 200));
          brushCtx.lineCap = 'round';
          brushCtx.lineJoin = 'round';
        }
      }
    }

    function resetCropBox() {
      if (!cropBox) return;
      cropBox.style.left = '15%';
      cropBox.style.top = '15%';
      cropBox.style.width = '70%';
      cropBox.style.height = '70%';
    }

    function openCrop() {
      closeBrush();
      isCropActive = true;
      cropOverlay.hidden = false;
      resetCropBox();
      emitToolbarState();
      syncBottomBar();
    }

    function closeCrop() {
      isCropActive = false;
      cropOverlay.hidden = true;
      cropDrag.active = false;
      cropDrag.resize = false;
      emitToolbarState();
      syncBottomBar();
    }

    function openBrush() {
      closeCrop();
      isBrushActive = true;
      stage.classList.add('is-brushing');
      resizeBrushCanvas();
      if (brushCtx) {
        brushCtx.strokeStyle = brushColor;
        brushCtx.lineWidth = Math.max(2, Math.round((img.naturalWidth || 800) / 200));
        brushCtx.lineCap = 'round';
        brushCtx.lineJoin = 'round';
      }
      emitToolbarState();
      syncBottomBar();
    }

    function closeBrush() {
      isBrushActive = false;
      stage.classList.remove('is-brushing');
      isDrawing = false;
      emitToolbarState();
      syncBottomBar();
    }

    function clearBrush() {
      if (!brushCtx) return;
      historyStrokes = [];
      brushCtx.clearRect(0, 0, brushCanvas.width, brushCanvas.height);
    }

    function saveBrushState() {
      if (!brushCtx) return;
      try {
        historyStrokes.push(
          brushCtx.getImageData(0, 0, brushCanvas.width, brushCanvas.height)
        );
        if (historyStrokes.length > 30) historyStrokes.shift();
      } catch (e) {
        /* 跨域 canvas 可能 tainted */
      }
    }

    function undoBrush() {
      if (!brushCtx || historyStrokes.length === 0) return;
      try {
        var prev = historyStrokes.pop();
        brushCtx.putImageData(prev, 0, 0);
      } catch (e) {
        /* ignore */
      }
    }

    function bakeBrush() {
      if (!img.naturalWidth) return;
      try {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var c = canvas.getContext('2d');
        c.drawImage(img, 0, 0, canvas.width, canvas.height);
        c.drawImage(brushCanvas, 0, 0, canvas.width, canvas.height);
        img.src = canvas.toDataURL('image/png');
        clearBrush();
        setDirty(true);
      } catch (err) {
        console.warn('[ImageViewer] bake brush failed', err);
      }
      closeBrush();
    }

    function applyCrop() {
      if (!cropBox || !img.naturalWidth) {
        closeCrop();
        return;
      }
      var cRect = cropOverlay.getBoundingClientRect();
      var bRect = cropBox.getBoundingClientRect();
      if (cRect.width <= 0 || cRect.height <= 0) {
        closeCrop();
        return;
      }

      var scaleX = img.naturalWidth / cRect.width;
      var scaleY = img.naturalHeight / cRect.height;
      var cropX = (bRect.left - cRect.left) * scaleX;
      var cropY = (bRect.top - cRect.top) * scaleY;
      var cropW = bRect.width * scaleX;
      var cropH = bRect.height * scaleY;

      cropX = clamp(cropX, 0, img.naturalWidth);
      cropY = clamp(cropY, 0, img.naturalHeight);
      cropW = clamp(cropW, 1, img.naturalWidth - cropX);
      cropH = clamp(cropH, 1, img.naturalHeight - cropY);

      try {
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(cropW));
        canvas.height = Math.max(1, Math.round(cropH));
        var c = canvas.getContext('2d');
        c.drawImage(
          img,
          cropX,
          cropY,
          cropW,
          cropH,
          0,
          0,
          canvas.width,
          canvas.height
        );
        img.src = canvas.toDataURL('image/png');
        img.onload = function () {
          resizeBrushCanvas();
          clearBrush();
        };
        setDirty(true);
      } catch (err) {
        console.warn('[ImageViewer] crop failed', err);
      }
      closeCrop();
    }

    // —— 事件：裁切 ——
    function onCropMouseDown(e) {
      if (!isCropActive || !cropBox) return;
      if (e.target.closest && e.target.closest('[data-crop-cancel],[data-crop-apply]')) {
        return;
      }
      var handle = e.target.getAttribute && e.target.getAttribute('data-handle');
      if (handle) {
        cropDrag.resize = true;
        cropDrag.handle = handle;
      } else if (e.target === cropBox || cropBox.contains(e.target)) {
        cropDrag.active = true;
        cropDrag.resize = false;
      } else {
        return;
      }
      cropDrag.startX = e.clientX;
      cropDrag.startY = e.clientY;
      var rect = cropBox.getBoundingClientRect();
      var parentRect = cropOverlay.getBoundingClientRect();
      cropDrag.startLeft = rect.left - parentRect.left;
      cropDrag.startTop = rect.top - parentRect.top;
      cropDrag.startW = rect.width;
      cropDrag.startH = rect.height;
      e.preventDefault();
      e.stopPropagation();
    }

    function onDocMouseMove(e) {
      if (!isCropActive || (!cropDrag.active && !cropDrag.resize)) return;
      var parentRect = cropOverlay.getBoundingClientRect();
      var dx = e.clientX - cropDrag.startX;
      var dy = e.clientY - cropDrag.startY;

      if (cropDrag.active) {
        var nl = clamp(
          cropDrag.startLeft + dx,
          0,
          parentRect.width - cropDrag.startW
        );
        var nt = clamp(
          cropDrag.startTop + dy,
          0,
          parentRect.height - cropDrag.startH
        );
        cropBox.style.left = nl + 'px';
        cropBox.style.top = nt + 'px';
        cropBox.style.width = cropDrag.startW + 'px';
        cropBox.style.height = cropDrag.startH + 'px';
        return;
      }

      if (cropDrag.resize && cropDrag.handle) {
        var left = cropDrag.startLeft;
        var top = cropDrag.startTop;
        var w = cropDrag.startW;
        var h = cropDrag.startH;
        var min = 40;
        var handle = cropDrag.handle;

        if (handle.indexOf('e') >= 0) {
          w = clamp(cropDrag.startW + dx, min, parentRect.width - left);
        }
        if (handle.indexOf('s') >= 0) {
          h = clamp(cropDrag.startH + dy, min, parentRect.height - top);
        }
        if (handle.indexOf('w') >= 0) {
          w = Math.max(min, cropDrag.startW - dx);
          left = cropDrag.startLeft + (cropDrag.startW - w);
          if (left < 0) {
            w += left;
            left = 0;
          }
        }
        if (handle.indexOf('n') >= 0) {
          h = Math.max(min, cropDrag.startH - dy);
          top = cropDrag.startTop + (cropDrag.startH - h);
          if (top < 0) {
            h += top;
            top = 0;
          }
        }
        cropBox.style.left = left + 'px';
        cropBox.style.top = top + 'px';
        cropBox.style.width = w + 'px';
        cropBox.style.height = h + 'px';
      }
    }

    function onDocMouseUp() {
      cropDrag.active = false;
      cropDrag.resize = false;
      cropDrag.handle = null;
      isDrawing = false;
    }

    cropOverlay.addEventListener('mousedown', onCropMouseDown);
    cropOverlay.querySelector('[data-crop-cancel]').addEventListener('click', function (e) {
      e.stopPropagation();
      closeCrop();
    });
    cropOverlay.querySelector('[data-crop-apply]').addEventListener('click', function (e) {
      e.stopPropagation();
      applyCrop();
    });

    // —— 事件：画笔 ——
    function brushPos(e) {
      var rect = brushCanvas.getBoundingClientRect();
      var sx = brushCanvas.width / (rect.width || 1);
      var sy = brushCanvas.height / (rect.height || 1);
      return {
        x: (e.clientX - rect.left) * sx,
        y: (e.clientY - rect.top) * sy,
      };
    }

    brushCanvas.addEventListener('mousedown', function (e) {
      if (!isBrushActive || !brushCtx) return;
      isDrawing = true;
      saveBrushState();
      var p = brushPos(e);
      brushCtx.strokeStyle = brushColor;
      brushCtx.beginPath();
      brushCtx.moveTo(p.x, p.y);
      e.preventDefault();
    });

    brushCanvas.addEventListener('mousemove', function (e) {
      if (!isDrawing || !brushCtx) return;
      var p = brushPos(e);
      brushCtx.lineTo(p.x, p.y);
      brushCtx.stroke();
    });

    brushCanvas.addEventListener('mouseup', function () {
      if (isDrawing) setDirty(true);
      isDrawing = false;
    });
    brushCanvas.addEventListener('mouseleave', function () {
      isDrawing = false;
    });

    // —— 滚轮缩放 ——
    function onWheel(e) {
      e.preventDefault();
      var delta = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
      zoom = clamp(zoom + delta, MIN_ZOOM, MAX_ZOOM);
      applyTransform();
    }
    root.addEventListener('wheel', onWheel, { passive: false });

    img.addEventListener('load', function () {
      if (destroyed) return;
      resizeBrushCanvas();
    });

    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);

    applyTransform();

    // —— 底栏：画笔颜色 / 清除 / 应用 ——
    function syncBottomBar() {
      if (!bottomEl) return;
      bottomEl.innerHTML = '';
      var bar = document.createElement('div');
      bar.className = 'fp-img-bottom';

      if (isBrushActive) {
        var palette = document.createElement('div');
        palette.className = 'fp-img-palette';
        BRUSH_COLORS.forEach(function (color) {
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.className =
            'fp-img-color' + (color === brushColor ? ' is-selected' : '');
          dot.style.background = color;
          dot.title = color;
          dot.setAttribute('aria-label', '画笔颜色 ' + color);
          if (color.toLowerCase() === '#ffffff') {
            dot.classList.add('is-light');
          }
          dot.addEventListener('click', function () {
            brushColor = color;
            if (brushCtx) brushCtx.strokeStyle = brushColor;
            syncBottomBar();
          });
          palette.appendChild(dot);
        });
        bar.appendChild(palette);

        var sep = document.createElement('div');
        sep.className = 'fp-img-bottom-sep';
        bar.appendChild(sep);

        var btnUndo = document.createElement('button');
        btnUndo.type = 'button';
        btnUndo.className = 'fp-tb-btn';
        btnUndo.title = '撤销';
        btnUndo.setAttribute('aria-label', '撤销');
        btnUndo.textContent = '撤销';
        btnUndo.style.width = 'auto';
        btnUndo.style.padding = '0 10px';
        btnUndo.style.fontSize = '12px';
        btnUndo.addEventListener('click', undoBrush);
        bar.appendChild(btnUndo);

        var btnClear = document.createElement('button');
        btnClear.type = 'button';
        btnClear.className = 'fp-tb-btn';
        btnClear.title = '清除';
        btnClear.setAttribute('aria-label', '清除涂鸦');
        btnClear.textContent = '清除';
        btnClear.style.width = 'auto';
        btnClear.style.padding = '0 10px';
        btnClear.style.fontSize = '12px';
        btnClear.addEventListener('click', clearBrush);
        bar.appendChild(btnClear);

        var btnApply = document.createElement('button');
        btnApply.type = 'button';
        btnApply.className = 'fp-img-bottom-primary';
        btnApply.textContent = '完成';
        btnApply.title = '将涂鸦合并到图片';
        btnApply.addEventListener('click', bakeBrush);
        bar.appendChild(btnApply);
      } else {
        var tip = document.createElement('span');
        tip.className = 'fp-img-bottom-tip';
        tip.textContent = isCropActive
          ? '拖动选框调整裁切区域'
          : '滚轮缩放 · 顶栏旋转 / 裁切 / 画笔';
        bar.appendChild(tip);
      }

      bottomEl.appendChild(bar);
    }

    function mountBottomBar(el) {
      bottomEl = el;
      if (bottomEl) {
        bottomEl.innerHTML = '';
        syncBottomBar();
      }
      return {
        destroy: function () {
          if (bottomEl) bottomEl.innerHTML = '';
          bottomEl = null;
        },
      };
    }

    function handleAction(id) {
      switch (id) {
        case 'zoomIn':
          zoom = clamp(zoom + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
          applyTransform();
          break;
        case 'zoomOut':
          zoom = clamp(zoom - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
          applyTransform();
          break;
        case 'zoomReset':
          zoom = 1.0;
          applyTransform();
          break;
        case 'rotateLeft':
          rotation = (rotation - 90 + 360) % 360;
          applyTransform();
          break;
        case 'rotateRight':
          rotation = (rotation + 90) % 360;
          applyTransform();
          break;
        case 'crop':
          if (isCropActive) closeCrop();
          else openCrop();
          break;
        case 'brush':
          if (isBrushActive) closeBrush();
          else openBrush();
          break;
        default:
          break;
      }
    }

    function setToolbarBridge(bridge) {
      toolbarBridge = bridge || null;
      emitToolbarState();
    }

    function destroy() {
      destroyed = true;
      document.removeEventListener('mousemove', onDocMouseMove);
      document.removeEventListener('mouseup', onDocMouseUp);
      root.removeEventListener('wheel', onWheel);
      if (bottomEl) {
        bottomEl.innerHTML = '';
        bottomEl = null;
      }
      // 释放 objectURL，避免泄漏
      urlsToRevoke.forEach(function (u) {
        try {
          URL.revokeObjectURL(u);
        } catch (e) {
          /* ignore */
        }
      });
      urlsToRevoke = [];
      if (brushCtx && brushCanvas) {
        try {
          brushCtx.clearRect(0, 0, brushCanvas.width, brushCanvas.height);
        } catch (e2) {
          /* ignore */
        }
      }
      brushCanvas.width = 0;
      brushCanvas.height = 0;
      img.removeAttribute('src');
      host.innerHTML = '';
      if (dirty && handlers.onDirtyChange) handlers.onDirtyChange(false);
    }

    // 初始尺寸
    if (img.complete && img.naturalWidth) {
      resizeBrushCanvas();
    }

    return {
      destroy: destroy,
      handleAction: handleAction,
      mountBottomBar: mountBottomBar,
      getToolbarState: getToolbarState,
      setToolbarBridge: setToolbarBridge,
    };
  }

  window.FilePreviewViewers = window.FilePreviewViewers || {};
  window.FilePreviewViewers.ImageViewer = { mount: mount };
})();
