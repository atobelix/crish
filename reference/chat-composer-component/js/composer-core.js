/* ==========================================================================
   Composer Core Module (Input Auto-grow, Drag & Drop, Paste & Live File Store)
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const btnSend = document.getElementById('btnSend');
  const fileZone = document.getElementById('fileZone');
  const composerContainer = document.getElementById('composerContainer');
  const composerEditable = document.getElementById('composerEditable');
  const hiddenFileInput = document.getElementById('hiddenFileInput');
  const menuAddFile = document.getElementById('menuAddFile');

  if (!btnSend || !fileZone || !composerContainer) return;

  // Initialize In-Memory Live File Store
  window.liveFileStore = window.liveFileStore || new Map();

  // Unified Top File Cards Icon Hydration Engine
  function hydrateTopFileCardsIcons() {
    document.querySelectorAll('#fileZone .file-card').forEach(card => {
      const fileName = card.getAttribute('data-file-name');
      if (fileName && !card.classList.contains('type-image')) {
        const iconContainer = card.querySelector('.file-icon');
        if (iconContainer && window.getFileIconSvg) {
          iconContainer.innerHTML = window.getFileIconSvg(fileName);
        }
      }
    });
  }

  // Initial Hydration
  hydrateTopFileCardsIcons();

  let measureSpan = null;
  function measureTextWidth(text) {
    if (!measureSpan) {
      measureSpan = document.createElement('span');
      measureSpan.style.visibility = 'hidden';
      measureSpan.style.position = 'absolute';
      measureSpan.style.top = '-9999px';
      measureSpan.style.whiteSpace = 'nowrap';
      measureSpan.style.fontFamily = window.getComputedStyle(composerEditable).fontFamily || 'sans-serif';
      measureSpan.style.fontSize = window.getComputedStyle(composerEditable).fontSize || '14px';
      document.body.appendChild(measureSpan);
    }
    measureSpan.textContent = text;
    return measureSpan.getBoundingClientRect().width;
  }

  // 1. Send Button State Update & Intelligent Single-Line ↔ Multi-Line Mode Detection
  window.updateSendButtonState = function updateSendButtonState() {
    if (!composerEditable || !composerContainer) return;

    // Clean text: strip zero-width spaces, trailing <br>, whitespace
    let text = composerEditable.innerText || composerEditable.textContent || '';
    text = text.replace(/\u200B/g, '').replace(/\r?\n/g, '\n');
    
    // Sanitize trailing browser <br> artifacts when user deletes text
    if (composerEditable.innerHTML === '<br>' || composerEditable.innerHTML === '<div><br></div>') {
      composerEditable.innerHTML = '';
      text = '';
    }

    const cleanText = text.trim();
    const hasFiles = fileZone && fileZone.children.length > 0;
    const hasInlineTags = composerEditable.querySelectorAll('.rich-inline-tag, .chip-item').length > 0;
    const hasContent = cleanText.length > 0 || hasFiles || hasInlineTags;

    // 1. 发送按钮动画 show/hide
    if (btnSend) {
      if (hasContent) {
        btnSend.classList.add('active');
      } else {
        btnSend.classList.remove('active');
      }
    }

    // 2. 100% 对称即时切行引擎（无论单行/多行，容量计算 100% 恒等，删除第 1 个字符瞬间切回单行）
    const layoutEl = document.querySelector('.input-main-layout');
    const actionLeft = document.querySelector('.action-left');
    const permBtn = document.getElementById('btnPermission');
    const actionRight = document.querySelector('.action-right');

    const layoutW = layoutEl ? layoutEl.clientWidth : 800;
    const leftW = actionLeft ? actionLeft.offsetWidth : 30;
    const permW = permBtn ? permBtn.offsetWidth : 68;
    const rightW = actionRight ? actionRight.offsetWidth : 174;

    // 单行输入框在 Grid 布局中的物理精确可分配宽度（扣除左右两侧按钮与 Grid 间距 18px）
    // 无论当前处于单行还是多行模式，该容量数值 100% 恒等完全一致！
    const singleLineCapacity = Math.max(200, layoutW - (leftW + permW + rightW + 18));

    const isCurrentlyMulti = composerContainer.classList.contains('is-multiline');
    const hasExplicitNewline = cleanText.includes('\n');
    const unclippedTextWidth = measureTextWidth(cleanText);

    let isMultiLineNeeded = false;

    if (hasFiles || hasExplicitNewline) {
      isMultiLineNeeded = true;
    } else {
      // 100% 绝对对称即时判定：
      // 多打 1 个字符超出单行容量上限 -> 瞬间展开多行；
      // 按 Backspace 删除这第 1 个超出字符 -> 剩余文本瞬间满足单行容量，删除第 1 个字符即刻切回单行！零字符延迟！
      isMultiLineNeeded = unclippedTextWidth >= singleLineCapacity;
    }

    if (isMultiLineNeeded) {
      composerContainer.classList.add('is-multiline');
    } else {
      composerContainer.classList.remove('is-multiline');
    }
  };

  if (composerEditable) {
    ['input', 'keyup', 'keydown', 'cut', 'paste', 'blur', 'focus'].forEach(evt => {
      composerEditable.addEventListener(evt, () => {
        setTimeout(window.updateSendButtonState, 0);
      });
    });

    // Initial state sync
    window.updateSendButtonState();

    // Clipboard Paste Handler (Supports Image & File Pasting)
    composerEditable.addEventListener('paste', (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      let filePasted = false;

      for (let item of items) {
        if (item.kind === 'file') {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            window.handleFiles([file]);
            filePasted = true;
          }
        }
      }

      if (filePasted) {
        window.updateSendButtonState();
      }
    });
  }

  // File Input Change Listener for Plus Menu
  if (hiddenFileInput) {
    hiddenFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        window.handleFiles(e.target.files);
        hiddenFileInput.value = '';
      }
    });
  }

  // 3. Single-Source File Processing & Card Creation (Live File Registration & Entrance Animation)
  window.handleFiles = function handleFiles(files) {
    Array.from(files).forEach(file => {
      const fileId = Date.now() + Math.random().toString(36).substring(2, 5);
      const fileName = file.name;

      window.liveFileStore.set(fileId, file);

      if (file.type.startsWith('image/')) {
        // Image File Card with Entrance Micro-Animation
        const reader = new FileReader();
        reader.onload = function(evt) {
          const card = document.createElement('div');
          card.className = 'file-card type-image animate-entrance';
          card.setAttribute('data-file-type', 'image');
          card.setAttribute('data-file-id', fileId);
          card.setAttribute('data-file-name', fileName);
          card.onclick = () => window.openPreview(card);
          card.innerHTML = `
            <img src="${evt.target.result}" class="file-thumbnail" alt="thumb" id="cardImg_${fileId}">
            <div class="file-remove" onclick="event.stopPropagation(); window.removeFileCard(this)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </div>
          `;
          fileZone.appendChild(card);
          window.updateSendButtonState();
        };
        reader.readAsDataURL(file);
      } else {
        // Document / Code / Table / PDF Card with Official Extracted SVG Icons
        const card = document.createElement('div');
        card.className = 'file-card animate-entrance';
        card.setAttribute('data-file-type', 'document');
        card.setAttribute('data-file-id', fileId);
        card.setAttribute('data-file-name', fileName);
        card.onclick = () => window.openPreview(card);

        const iconSvg = window.getFileIconSvg ? window.getFileIconSvg(fileName) : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;

        card.innerHTML = `
          <div class="file-icon">
            ${iconSvg}
          </div>
          <div class="file-info">
            <div class="file-name">${fileName}</div>
          </div>
          <div class="file-remove" onclick="event.stopPropagation(); window.removeFileCard(this)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </div>
        `;
        fileZone.appendChild(card);
        window.updateSendButtonState();
      }
    });
  };

  window.removeFileCard = function removeFileCard(btn) {
    const card = btn.closest('.file-card, .skill-tag, .rich-inline-tag, .chip-item, .at-file-pill');
    if (card) {
      const fileId = card.getAttribute('data-file-id');
      if (fileId && window.liveFileStore) {
        window.liveFileStore.delete(fileId);
      }
      card.remove();
      window.updateSendButtonState();
    }
  };

  // Middle-Click (Mouse Wheel Click) Handler to Remove File Cards & Inline Chips
  document.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      const card = e.target.closest('.file-card, .skill-tag, .rich-inline-tag, .chip-item, .at-file-pill');
      if (card) {
        e.preventDefault();
      }
    }
  });

  document.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      const card = e.target.closest('.file-card, .skill-tag, .rich-inline-tag, .chip-item, .at-file-pill');
      if (card) {
        e.preventDefault();
        e.stopPropagation();
        window.removeFileCard(card);
      }
    }
  });

  /* ==========================================================================
     Plan Bar Interactivity & Stream Sync Controller
     ========================================================================== */
  function initPlanBar() {
    const hub = document.getElementById('planProgressBar') || document.getElementById('composerPlanHub');
    const trigger = document.getElementById('planExpandTrigger');
    const taskBox = document.getElementById('planActiveTaskBox');
    const badge = document.getElementById('planModeBadge');
    const pauseBtn = document.getElementById('planPauseToggleBtn');
    const durationEl = document.getElementById('planDuration');

    if (!hub) return;

    // 1. Expand / Collapse Drawer
    if (trigger) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        hub.classList.toggle('is-expanded');
      });
    }

    // 2. Click Plan Hub -> Action Removed (Per User Request: Disabled Scroll Positioning and Green Border Highlight)
    // Update counter based on active step and step items
    const stepItems = hub.querySelectorAll('.plan-expanded-step');
    const counterEl = hub.querySelector('#planStepCounter');
    if (counterEl && stepItems.length > 0) {
      let activeIdx = 1; // Default to step 2 (2/5)
      stepItems.forEach((item, idx) => {
        if (item.classList.contains('active')) activeIdx = idx;
      });
      counterEl.textContent = `${activeIdx + 1}/${stepItems.length}`;
    }

    // Step List Items click: Action Removed (Per User Request)


    // 3. Pause / Play Toggle
    let isPaused = false;
    if (pauseBtn) {
      const iconPause = pauseBtn.querySelector('.icon-pause');
      const iconPlay = pauseBtn.querySelector('.icon-play');
      pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isPaused = !isPaused;
        if (iconPause) iconPause.style.display = isPaused ? 'none' : 'block';
        if (iconPlay) iconPlay.style.display = isPaused ? 'block' : 'none';
        pauseBtn.title = isPaused ? '继续执行' : '暂停执行';
      });
    }

    // 4. Duration Timer
    let elapsedSeconds = 24;
    if (durationEl) {
      setInterval(() => {
        if (!isPaused) {
          elapsedSeconds++;
          const mins = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
          const secs = String(elapsedSeconds % 60).padStart(2, '0');
          durationEl.textContent = `${mins}:${secs}`;
        }
      }, 1000);
    }
  }

  initPlanBar();

  // 5. Scroll Clearance Coordinator
  // With native position: sticky; bottom: 0, the composer moves in 100% lockstep with
  // the chat pane at 60fps and docks cleanly 20px below the stream with zero empty gap.
  const layoutContainer = document.querySelector('.chat-main-pane') || document.querySelector('.chat-app-layout');
  const composerWrapper = document.querySelector('.composer-wrapper');
  
  if (layoutContainer && composerWrapper) {
    let isAtBottomBeforeResize = true;
    window.syncComposerHorizontalAlignment = function () {}; // No-op: handled natively by CSS sticky

    // Track if user is at the bottom during scroll events
    layoutContainer.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = layoutContainer;
      isAtBottomBeforeResize = (scrollHeight - scrollTop - clientHeight) < 10;
    }, { passive: true });
    
    const { scrollTop, scrollHeight, clientHeight } = layoutContainer;
    isAtBottomBeforeResize = (scrollHeight - scrollTop - clientHeight) < 10;
  }

});
