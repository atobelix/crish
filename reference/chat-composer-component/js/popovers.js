/* ==========================================================================
   Popover Menus & Dynamic Range Slider Engine with Micro-Glow Effects
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const composerEditable = document.getElementById('composerEditable');
  let savedRange = null;

  function saveComposerSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (composerEditable && composerEditable.contains(range.commonAncestorContainer)) {
        savedRange = range.cloneRange();
      }
    }
  }

  if (composerEditable) {
    ['keyup', 'mouseup', 'input', 'focus', 'click'].forEach(evtName => {
      composerEditable.addEventListener(evtName, saveComposerSelection);
    });
  }

  document.querySelectorAll('.popover-menu, .cascade-submenu').forEach(menu => {
    menu.addEventListener('mousedown', (e) => {
      if (e.target.closest('input, textarea, select, .thinking-range-input, .thinking-stop-mark')) {
        return;
      }
      e.preventDefault();
    });
  });

  window.closeAllPopovers = function closeAllPopovers() {
    document.querySelectorAll('.popover-menu, .cascade-submenu').forEach(p => {
      p.classList.remove('active');
    });
  };

  window.togglePopover = function togglePopover(btn, popoverId) {
    const popover = document.getElementById(popoverId);
    if (!btn || !popover) return;

    const isAlreadyActive = popover.classList.contains('active');
    window.closeAllPopovers();

    if (!isAlreadyActive) {
      const rect = btn.getBoundingClientRect();
      const popoverHeight = popover.offsetHeight || 160;
      const popoverWidth = popover.offsetWidth || 260;

      let left = rect.left;
      // Smart positioning: if button is in right half of viewport, align popover to right edge of button
      if (rect.left > window.innerWidth / 2 || left + popoverWidth > window.innerWidth - 16) {
        left = rect.right - popoverWidth;
      }
      if (left < 16) {
        left = 16;
      }

      // Check vertical space: if fits above, anchor natively to bottom to eliminate dynamic layout shift
      const fitsAbove = rect.top - popoverHeight - 8 >= 16;
      if (fitsAbove) {
        popover.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
        popover.style.top = 'auto';
      } else {
        popover.style.top = `${Math.round(rect.bottom + 8)}px`;
        popover.style.bottom = 'auto';
      }

      popover.style.left = `${Math.round(left)}px`;
      popover.style.right = 'auto';

      requestAnimationFrame(() => {
        popover.classList.add('active');
      });
    }
  };

  const REAL_FILE_MAP = {
    'design_system.md': `# Crish Desktop - Chat Composer 设计规范 (Design System Guidelines)\n\n这份规范提炼了我们在重构 \`chat-composer-component\` 时确立的核心 UI/UX 原则，供后续移植与全量开发时严格遵守，确保整体风格一致。\n\n## 一、 核心设计哲学\n\n1. **绝对极简与高级感 (Minimalist & Premium)**\n   - 界面应当保持极致的克制，避免任何多余的修饰。\n   - 拒绝大面积色块堆砌，使用大面积留白与呼吸感。\n   - UI 元素必须显得精致、轻盈，不能有“笨重感”或“廉价感”。\n\n2. **绝对零蓝色原则 (Zero-Blue Policy)**\n   - 整个界面（包括字体、边框、背景、高亮、Focus 状态）**绝对不允许出现任何蓝色的痕迹**。\n   - 超链接、活动状态、选中状态等通常使用蓝色的地方，一律改用中性色（灰色系）、黑白反差色，或符合全局主题的特定高级色调。\n\n3. **优雅的微动效 (Elegant Micro-Animations)**\n   - 所有状态切换（Hover、Focus、Active）必须伴随平滑、柔和的过渡动画（如 \`transition: all 150ms ease\` 或 \`cubic-bezier\`）。\n   - 动效应当克制，不能喧宾夺主。例如滚动条悬浮、刻度放大、复制按钮图标切换，都需要行云流水般的细腻感。`,
    'conversation_flow_spec.md': `# Conex 对话流组件规格（Conversation Flow Spec）\n\n> **文档性质**：\`reference/chat-composer-component\` 的权威设计与实现规格。  \n> **用途**：在此 reference 上做完 → 迁回 \`apps/crish-desktop\`。  \n> **关系**：综合 \`conversation_flow_design.md\`（效果意图，偏旧）、当前 reference 实现、desktop 真实后端模型，以及历史产品反馈的收敛版。  \n> **原则**：优雅、简洁、高级；组件化；不照抄竞品截图；不半成品交付。\n\n---\n\n## 0. 文档导航\n\n| 章节 | 内容 |\n|------|------|\n| 1 | 目标与非目标 |\n| 2 | 问题总账（为何「总是做一半」） |\n| 3 | 设计哲学与质感基准 |\n| 4 | 信息架构：叙事层级（核心） |\n| 5 | 数据模型（对齐后端 + 前端编排层） |`,
    'sample.csv': `接口,方法,并发数,QPS,平均延迟(ms),P99(ms),错误率,状态\n/api/v1/login,POST,100,852,42,118,0.10%,通过\n/api/v1/login,POST,200,1240,68,210,0.35%,通过\n/api/v1/orders,GET,100,2103,18,55,0.02%,通过\n/api/v1/orders,GET,500,3890,46,162,0.12%,通过\n/api/v1/orders,POST,100,640,95,280,0.80%,关注\n/api/v1/search,GET,200,1560,52,190,0.05%,通过\n/api/v1/search,GET,1000,4200,88,340,1.20%,降级\n/api/v1/upload,POST,50,120,410,980,2.10%,失败\n/api/v1/profile,GET,300,3050,22,70,0.01%,通过\n/api/v1/notes,GET,150,1880,28,90,0.00%,通过`,
    'extract-icons.js': `const fs = require('fs');\nconst path = require('path');\n\nconst targetDir = path.join(__dirname, 'assets', 'icons');\nif (!fs.existsSync(targetDir)) {\n  fs.mkdirSync(targetDir, { recursive: true });\n}\n\n// 提取与构建 icon-assets 数据字典\nconsole.log('Icon assets extraction pipeline initialized.');`,
    'chinese-encoding-guard': `---\nname: chinese-encoding-guard\ndescription: 在包含中文注释、中文字符串或历史编码问题的项目中工作时使用。首次进入项目、准备写入中文、需要排查乱码、或需要统一中文注释时，先用此技能确认编码状态、选择安全写入方式，并在修改后回读校验。\n---\n\n# 中文编码护栏 (chinese-encoding-guard/SKILL.md)\n\n## 适用时机\n- 首次进入包含中文源码的项目。\n- 准备新增或修改中文注释、中文文档字符串、中文提示语。\n- 仓库里出现“终端显示像乱码”和“文件内容真的坏了”难以区分的情况。\n- 需要统一中文注释规范，避免中英混写。\n\n## 首次检查流程\n1. 先运行 \`scripts/check_chinese_text.py <路径>\`，检查文件是否能按 \`utf-8\` 正常解码。\n2. 对可疑文件，优先读取原始字节再判断。\n\n## 安全写入方式\n- 首选 \`apply_patch\` 修改源码中的中文内容。\n- 不要用 shell 重定向写入中文源码。`,
    'skill.md': `---\nname: chinese-encoding-guard\ndescription: 在包含中文注释、中文字符串或历史编码问题的项目中工作时使用。\n---\n\n# 中文编码护栏 (SKILL.md)\n\n路径：C:\\Users\\orange\\.claude\\skills\\chinese-encoding-guard\\SKILL.md`
  };
  window.REAL_FILE_MAP = REAL_FILE_MAP;

  window.locateOrPreviewFile = function locateOrPreviewFile(fileName) {
    if (!fileName) return;
    const lowerName = fileName.toLowerCase().trim();
    const realText = REAL_FILE_MAP[lowerName] || `# ${fileName}\n\n这是 ${fileName} 的真实文件解析内容与架构规格数据。`;
    const isMd = lowerName.endsWith('.md') || lowerName.includes('skill') || lowerName.includes('guard') || lowerName === 'chinese-encoding-guard';

    if (window.FilePreview && typeof window.FilePreview.open === 'function') {
      window.FilePreview.open({
        type: isMd ? 'markdown' : 'text',
        name: fileName.endsWith('.md') ? fileName : (isMd ? fileName + '.md' : fileName),
        text: realText
      });
    }
  };

  window.getFileIconSvg = function getFileIconSvg(name, isSkill = false) {
    if (isSkill) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path fill="#10B981" d="M16 2L12 14H20L16 30L26 16H18L22 2H16Z"/></svg>`;
    }
    const lname = name.toLowerCase().trim();

    if (lname.endsWith('.ppt') || lname.endsWith('.pptx') || lname.endsWith('.pot') || lname.endsWith('.pps')) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path fill="#C43E1C" d="M16 3A13 13 0 1 0 29 16 13 13 0 0 0 16 3zm0 2a11 11 0 0 1 11 11H16z"/><path fill="#E85C33" d="M16 16h11a11 11 0 0 1-11 11z"/><path fill="#D24726" d="M16 16v11A11 11 0 0 1 5 16z"/><path fill="#F06B43" d="M5 16A11 11 0 0 1 16 5v11z"/><rect fill="#B73516" x="3" y="9" width="15" height="14" rx="2.5"/><path fill="#FFFFFF" d="M7 12.5h4a2.5 2.5 0 0 1 0 5H8.5v2H7v-7zm1.5 1.5v2h2.5a1 1 0 0 0 0-2H8.5z"/></svg>`;
    }
    if (lname.endsWith('.doc') || lname.endsWith('.docx') || lname.endsWith('.dot')) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path fill="#185ABD" d="M20 3H10a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7L20 3z"/><path fill="#2B7CD3" d="M20 3v4a1 1 0 0 0 1 1h3L20 3z"/><rect fill="#104A9E" x="3" y="9" width="15" height="14" rx="2.5"/><path fill="#FFFFFF" d="M6.5 12.5h2l1.2 4.8 1.3-4.8h1.8l1.3 4.8 1.2-4.8h2l-2.2 7h-2l-1.3-4.5-1.3 4.5h-2l-2.2-7z"/></svg>`;
    }
    if (lname.endsWith('.csv') || lname.endsWith('.xlsx') || lname.endsWith('.xls') || lname.endsWith('.xlsm')) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path fill="#107C41" d="M20 3H10a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7L20 3z"/><path fill="#33995D" d="M20 3v4a1 1 0 0 0 1 1h3L20 3z"/><rect fill="#0E5C2F" x="3" y="9" width="15" height="14" rx="2.5"/><path fill="#FFFFFF" d="M7 12.5h2.2l1.8 3.5 1.8-3.5H15l-2.8 4.8L15 22.5h-2.2l-1.8-3.6-1.8 3.6H7l2.8-5.2L7 12.5z"/></svg>`;
    }
    if (lname.endsWith('.pdf')) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path fill="#E23528" d="M20 3H10a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7L20 3z"/><path fill="#F15D52" d="M20 3v4a1 1 0 0 0 1 1h3L20 3z"/><rect fill="#B31D12" x="3" y="9" width="16" height="14" rx="2.5"/><path fill="#FFFFFF" d="M6.5 12.5h3a2 2 0 0 1 0 4h-1.5v3h-1.5v-7zm1.5 1.5v1h1.5a0.5 0.5 0 0 0 0-1h-1.5zm6-1.5h2.5a2.5 2.5 0 0 1 0 5h-1v2h-1.5v-7zm1.5 1.5v2h1a1 1 0 0 0 0-2h-1z"/></svg>`;
    }

    const parts = lname.split('.');
    const ext = parts.length > 1 ? parts.pop() : lname;
    if (window.COMPREHENSIVE_FILE_ICON_MAP && window.COMPREHENSIVE_FILE_ICON_MAP[ext]) {
      return window.COMPREHENSIVE_FILE_ICON_MAP[ext];
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
  };

  window.hydrateAllFileIcons = function hydrateAllFileIcons() {
    document.querySelectorAll('#fileZone .file-card').forEach(card => {
      const fileName = card.getAttribute('data-file-name');
      if (fileName && !card.classList.contains('type-image')) {
        const iconBox = card.querySelector('.file-icon');
        if (iconBox) iconBox.innerHTML = window.getFileIconSvg(fileName);
      }
      if (!card.querySelector('.file-remove')) {
        const removeBtn = document.createElement('div');
        removeBtn.className = 'file-remove';
        removeBtn.onclick = function(e) {
          e.stopPropagation();
          if (window.removeFileCard) window.removeFileCard(card);
          else card.remove();
        };
        removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        card.appendChild(removeBtn);
      }
    });

    document.querySelectorAll('#composerEditable .rich-inline-tag').forEach(tag => {
      const textNode = tag.querySelector('.tag-text');
      const isSkill = tag.classList.contains('skill-type');
      let fileName = '';
      if (textNode) {
        fileName = textNode.innerText.trim();
        const iconBox = tag.querySelector('.tag-icon-box');
        if (iconBox) iconBox.innerHTML = window.getFileIconSvg(fileName, isSkill);
      }
      if (!tag.querySelector('.tag-remove-btn')) {
        const removeBtn = document.createElement('span');
        removeBtn.className = 'tag-remove-btn';
        removeBtn.title = '删除标记';
        removeBtn.onclick = function(e) {
          e.stopPropagation();
          tag.remove();
          if (window.updateSendButtonState) window.updateSendButtonState();
        };
        removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        tag.appendChild(removeBtn);
      }

      if (fileName && !tag.hasAttribute('data-preview-bound')) {
        tag.setAttribute('data-preview-bound', 'true');
        tag.addEventListener('click', function(e) {
          if (e.target.closest('.tag-remove-btn')) return;
          e.preventDefault();
          e.stopPropagation();
          window.locateOrPreviewFile(fileName);
        });
      }
    });
  };

  window.hydrateAllFileIcons();

  window.insertRichInlineTag = function insertRichInlineTag(name, isSkill = false) {
    if (!composerEditable) return;

    composerEditable.focus();

    const sel = window.getSelection();
    let range = null;

    if (sel && sel.rangeCount > 0) {
      const liveRange = sel.getRangeAt(0);
      if (composerEditable.contains(liveRange.commonAncestorContainer)) {
        range = liveRange;
      }
    }

    if (!range && savedRange) {
      range = savedRange.cloneRange();
    }

    if (!range) {
      range = document.createRange();
      const lastChild = composerEditable.lastChild;
      if (lastChild) {
        if (lastChild.nodeType === Node.TEXT_NODE) {
          range.setStart(lastChild, lastChild.nodeValue.length);
        } else {
          range.setStartAfter(lastChild);
        }
      } else {
        range.setStart(composerEditable, 0);
      }
      range.collapse(true);
    }

    sel.removeAllRanges();
    sel.addRange(range);

    const container = range.startContainer;
    if (container && container.nodeType === Node.TEXT_NODE) {
      const textVal = container.nodeValue || '';
      const match = textVal.match(/(@@|@|\/)$/);
      if (match) {
        const newText = textVal.slice(0, textVal.length - match[0].length);
        container.nodeValue = newText;
        range.setStart(container, newText.length);
        range.collapse(true);
      }
    }

    const tagSpan = document.createElement('span');
    tagSpan.className = isSkill ? 'rich-inline-tag skill-type animate-entrance' : 'rich-inline-tag animate-entrance';
    tagSpan.contentEditable = 'false';
    if (!isSkill) {
      tagSpan.setAttribute('onclick', `window.locateOrPreviewFile('${name}')`);
    }

    const iconSvg = window.getFileIconSvg(name, isSkill);

    tagSpan.innerHTML = `
      <span class="tag-icon-box">${iconSvg}</span>
      <span class="tag-text">${name}</span>
      <span class="tag-remove-btn" title="删除标记" onclick="event.stopPropagation(); this.parentElement.remove(); if(window.updateSendButtonState)window.updateSendButtonState();">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </span>
    `;

    range.insertNode(tagSpan);

    const spaceNode = document.createTextNode(' ');
    tagSpan.after(spaceNode);

    range.setStartAfter(spaceNode);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    saveComposerSelection();

    setTimeout(() => {
      tagSpan.classList.remove('animate-entrance');
    }, 300);

    if (window.updateSendButtonState) window.updateSendButtonState();
  };

  const btnPlus = document.getElementById('btnPlus');
  const plusPopover = document.getElementById('plusPopover');
  const skillSubmenu = document.getElementById('skillSubmenu');
  const menuAddFile = document.getElementById('menuAddFile');
  const menuUseSkill = document.getElementById('menuUseSkill');
  const composerFileInput = document.getElementById('composerFileInput');

  // ---- Universal Delegated Event Handlers for Composer Controls (Works for 100% of Single Pane & Cloned Split Panes!) ----
  document.addEventListener('click', (e) => {
    // 1. Plus Button
    const plusBtn = e.target.closest('.icon-btn-plus, #btnPlus');
    if (plusBtn) {
      e.preventDefault();
      e.stopPropagation();
      window.togglePopover(plusBtn, 'plusPopover');
      return;
    }

    // 2. Model Button
    const modelBtn = e.target.closest('.fused-sub-trigger--model, #btnModel');
    if (modelBtn) {
      e.preventDefault();
      e.stopPropagation();
      const fused = modelBtn.closest('.fused-model-thinking-btn') || modelBtn;
      window.togglePopover(fused, 'modelPopover');
      return;
    }

    // 3. Thinking Button
    const thinkingBtn = e.target.closest('.fused-sub-trigger--thinking, #btnThinking');
    if (thinkingBtn) {
      e.preventDefault();
      e.stopPropagation();
      const fused = thinkingBtn.closest('.fused-model-thinking-btn') || thinkingBtn;
      window.togglePopover(fused, 'thinkingPopover');
      return;
    }

    // 4. Permission Button
    const permBtn = e.target.closest('.pure-mode-text-btn, #btnPermission');
    if (permBtn) {
      e.preventDefault();
      e.stopPropagation();
      window.togglePopover(permBtn, 'permissionPopover');
      return;
    }

    // 5. Send Button
    const sendBtn = e.target.closest('.send-btn-circle, #btnSend');
    if (sendBtn) {
      e.preventDefault();
      e.stopPropagation();
      const wrapper = sendBtn.closest('.composer-wrapper');
      const editable = wrapper ? wrapper.querySelector('.composer-editable') : document.getElementById('composerEditable');
      const text = editable ? (editable.innerText || editable.textContent || '').trim() : '';
      if (text && window.sendMessage) {
        window.sendMessage(text);
        if (editable) {
          editable.innerHTML = '';
          if (window.updateSendButtonState) window.updateSendButtonState();
        }
      }
      return;
    }

    // 6. Plan Mode Badge Click (Toggle steps drawer)
    const planBadge = e.target.closest('.plan-mode-badge, #planModeBadge');
    if (planBadge) {
      e.preventDefault();
      e.stopPropagation();
      const planBarEl = planBadge.closest('.plan-progress-bar') || document.getElementById('planProgressBar');
      if (planBarEl) {
        const wasOpen = planBarEl.classList.contains('expanded-steps');
        planBarEl.classList.remove('expanded-goal');
        planBarEl.classList.toggle('expanded-steps', !wasOpen);
      }
      return;
    }

    // 7. Plan Active Task Box Click (Toggle steps drawer)
    const planActiveBox = e.target.closest('.plan-active-task-box, #planActiveTaskBox');
    if (planActiveBox) {
      e.preventDefault();
      e.stopPropagation();
      const planBarEl = planActiveBox.closest('.plan-progress-bar') || document.getElementById('planProgressBar');
      if (planBarEl) {
        const wasOpen = planBarEl.classList.contains('expanded-steps');
        planBarEl.classList.remove('expanded-goal');
        planBarEl.classList.toggle('expanded-steps', !wasOpen);
      }
      return;
    }

    // 8. Plan Edit Quick Button (Toggle goal edit panel)
    const planEditBtn = e.target.closest('#planEditQuickBtn, .plan-action-btn[title*="编辑"]');
    if (planEditBtn) {
      e.preventDefault();
      e.stopPropagation();
      const planBarEl = planEditBtn.closest('.plan-progress-bar') || document.getElementById('planProgressBar');
      if (planBarEl) {
        const wasGoal = planBarEl.classList.contains('expanded-goal');
        planBarEl.classList.remove('expanded-steps');
        planBarEl.classList.toggle('expanded-goal', !wasGoal);
      }
      return;
    }

    // 9. Plan Pause Toggle Button
    const planPauseBtn = e.target.closest('#planPauseToggleBtn, .plan-action-btn[title*="暂停"]');
    if (planPauseBtn) {
      e.preventDefault();
      e.stopPropagation();
      const iconPause = planPauseBtn.querySelector('.icon-pause');
      const iconPlay = planPauseBtn.querySelector('.icon-play');
      if (iconPause && iconPlay) {
        const isPaused = iconPlay.style.display !== 'none';
        iconPlay.style.display = isPaused ? 'none' : 'block';
        iconPause.style.display = isPaused ? 'block' : 'none';
      }
      return;
    }

    // 10. Plan Stop Button
    const planStopBtn = e.target.closest('#planStopQuickBtn, .plan-action-btn[title*="终止"]');
    if (planStopBtn) {
      e.preventDefault();
      e.stopPropagation();
      const planBarEl = planStopBtn.closest('.plan-progress-bar') || document.getElementById('planProgressBar');
      if (planBarEl) {
        planBarEl.classList.remove('expanded-steps', 'expanded-goal');
      }
      return;
    }

    // 11. File card remove button
    const removeBtn = e.target.closest('.file-remove');
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = removeBtn.closest('.file-card');
      if (card) {
        card.remove();
        if (window.updateSendButtonState) window.updateSendButtonState();
      }
      return;
    }

    // 12. Inline tag remove button
    const tagRemove = e.target.closest('.tag-remove-btn');
    if (tagRemove) {
      e.preventDefault();
      e.stopPropagation();
      const tag = tagRemove.closest('.rich-inline-tag');
      if (tag) {
        tag.remove();
        if (window.updateSendButtonState) window.updateSendButtonState();
      }
      return;
    }
  });

  // Thinking Popover Selection Handler
  document.querySelectorAll('#thinkingPopover .thinking-option').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const val = item.getAttribute('data-val');
      if (val !== null) updateThinkingEffort(val);
      window.closeAllPopovers();
    });
  });

  const modelSearchInput = document.getElementById('modelSearchInput');

  function filterModels() {
    const query = modelSearchInput ? modelSearchInput.value.toLowerCase().trim() : '';

    let currentGroupHeader = null;
    let groupHasVisibleItems = false;

    const items = document.querySelectorAll('#modelListContainer > *');
    items.forEach(el => {
      if (el.classList.contains('provider-group-header')) {
        if (currentGroupHeader && !groupHasVisibleItems && query !== '') {
          currentGroupHeader.style.display = 'none';
        }
        currentGroupHeader = el;
        groupHasVisibleItems = false;
        el.style.display = 'block';
      } else if (el.classList.contains('model-card-item')) {
        const cardProvider = (el.getAttribute('data-provider') || '').toLowerCase();
        const cardModel = (el.getAttribute('data-model') || '').toLowerCase();
        const headerText = currentGroupHeader ? currentGroupHeader.innerText.toLowerCase() : '';

        const matchesSearch = query === '' || cardModel.includes(query) || cardProvider.includes(query) || headerText.includes(query);

        if (matchesSearch) {
          el.style.display = 'flex';
          groupHasVisibleItems = true;
          if (currentGroupHeader) currentGroupHeader.style.display = 'block';
        } else {
          el.style.display = 'none';
        }
      }
    });

    if (currentGroupHeader && !groupHasVisibleItems && query !== '') {
      currentGroupHeader.style.display = 'none';
    }
  }

  if (modelSearchInput) {
    modelSearchInput.addEventListener('input', filterModels);
  }

  const btnModelConfig = document.getElementById('btnModelConfig');
  if (btnModelConfig) {
    btnModelConfig.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.locateOrPreviewFile('DESIGN_SYSTEM.md');
    });
  }

  let activeModelName = 'Claude 3.7 Sonnet';
  let activeEffortLevel = '中';

  function updateModelButtonDisplay() {
    document.querySelectorAll('.fused-sub-trigger--model, #btnModel').forEach(modelSpan => {
      modelSpan.innerText = activeModelName;
    });
    document.querySelectorAll('.fused-sub-trigger--thinking, #btnThinking').forEach(thinkingSpan => {
      thinkingSpan.innerText = activeEffortLevel;
    });
  }

  // 6-Level Discrete Thinking Effort System (Off, Low, Medium, High, X-High, Max)
  const effortLevelsMap = ['Off', 'Low', 'Medium', 'High', 'X-High', 'Max'];

  function updateThinkingEffort(val) {
    val = parseInt(val, 10);
    if (isNaN(val) || val < 0 || val >= effortLevelsMap.length) val = 3;

    activeEffortLevel = effortLevelsMap[val] || 'High';

    const currentEffortValSpan = document.getElementById('currentEffortVal');
    if (currentEffortValSpan) currentEffortValSpan.innerText = activeEffortLevel;

    // Sync segmented pill buttons in model popover
    document.querySelectorAll('#thinkingSegGroup .thinking-seg-btn').forEach(btn => {
      const btnVal = parseInt(btn.getAttribute('data-val'), 10);
      btn.classList.toggle('active', btnVal === val);
    });

    // Sync dedicated thinkingPopover selection
    document.querySelectorAll('#thinkingPopover .thinking-option').forEach(opt => {
      const optVal = parseInt(opt.getAttribute('data-val'), 10);
      opt.classList.toggle('selected', optVal === val);
    });

    updateModelButtonDisplay();
  }

  // Click segmented pill button in model popover
  document.querySelectorAll('#thinkingSegGroup .thinking-seg-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = btn.getAttribute('data-val');
      if (val !== null) updateThinkingEffort(val);
    });
  });

  // Thinking Effort Section Collapsible Toggle (Native Bottom-Anchored Expansion, Zero Coordinate Jank)
  const thinkingToggleBtn = document.getElementById('thinkingEffortToggle');
  const thinkingBodyEl = document.getElementById('thinkingEffortBody');
  const thinkingSectionEl = document.getElementById('thinkingEffortSection');

  if (thinkingToggleBtn && thinkingBodyEl && thinkingSectionEl) {
    thinkingToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isExpanded = thinkingSectionEl.classList.toggle('expanded');
      thinkingBodyEl.style.display = isExpanded ? 'flex' : 'none';
    });
  }

  document.querySelectorAll('#modelListContainer .model-card-item').forEach(modelCard => {
    modelCard.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('#modelListContainer .model-card-item').forEach(m => m.classList.remove('selected'));
      modelCard.classList.add('selected');

      activeModelName = modelCard.getAttribute('data-model') || 'Claude 3.7 Sonnet';
      updateModelButtonDisplay();
    });
  });

  // Permission mode color mapping
  const permColorMap = {
    '只读模式': 'perm-readonly',
    '计划模式': 'perm-plan',
    '目标模式': 'perm-goal',
    '权限询问': 'perm-ask',
    '完全访问': 'perm-full'
  };
  const allPermClasses = Object.values(permColorMap);

  document.querySelectorAll('#permissionPopover .permission-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('#permissionPopover .permission-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');

      const modeName = opt.getAttribute('data-mode') || opt.innerText.trim();
      document.querySelectorAll('.pure-mode-text-btn, #btnPermission').forEach(btnPerm => {
        const labelSpan = btnPerm.querySelector('span');
        if (labelSpan) labelSpan.innerText = modeName;
        // Sync button color class (pure-mode-text-btn variants)
        allPermClasses.forEach(cls => btnPerm.classList.remove(cls));
        const newCls = permColorMap[modeName];
        if (newCls) btnPerm.classList.add(newCls);
      });

      if (modeName === '计划模式' || modeName === '目标模式') {
        window.setPlanActive(true);
        window.setPlanMode(modeName === '目标模式' ? 'goal' : 'plan');
      }

      window.closeAllPopovers();
    });
  });

  const composerContainer = document.getElementById('composerContainer');
  const dragDropOverlay = document.getElementById('dragDropOverlay');
  let dragCounter = 0;

  if (composerContainer && dragDropOverlay) {
    composerContainer.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      dragDropOverlay.style.display = 'flex';
    });

    composerContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    composerContainer.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dragDropOverlay.style.display = 'none';
      }
    });

    composerContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      dragDropOverlay.style.display = 'none';

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        if (window.handleFiles) window.handleFiles(files);
      }
    });
  }

  // ---- Composite Plan & Goal Progress Hub ----
  const planBar = document.getElementById('planProgressBar');
  const planTrack = document.getElementById('planRollerTrack');
  const planCounter = document.getElementById('planStepCounter');
  const planDurationEl = document.getElementById('planDuration');
  const planModeBadge = document.getElementById('planModeBadge');
  const planActiveTaskBox = document.getElementById('planActiveTaskBox');
  const planEditQuickBtn = document.getElementById('planEditQuickBtn');
  const planPauseToggleBtn = document.getElementById('planPauseToggleBtn');
  const planStopQuickBtn = document.getElementById('planStopQuickBtn');
  const planExpandTrigger = document.getElementById('planExpandTrigger');
  const planGoalPanelClose = document.getElementById('planGoalPanelClose');
  const goalSaveBtn = document.getElementById('goalSaveBtn');

  const STEP_HEIGHT = 24;
  let planCurrentStep = 1;
  let planTotalSteps = 0;
  let planDemoTimer = null;
  let planStartTime = Date.now();
  let planDurationTimer = null;
  let isPlanPaused = false;

  function initPlanSteps() {
    if (!planTrack) return;
    const steps = planTrack.querySelectorAll('.plan-step');
    planTotalSteps = steps.length;
    if (planTotalSteps > 0) setPlanStep(1); // Start at step 2 (index 1) for demo
  }

  function setPlanStep(index) {
    if (!planTrack || planTotalSteps === 0) return;
    index = Math.max(0, Math.min(index, planTotalSteps - 1));
    planCurrentStep = index;
    planTrack.style.transform = `translateY(-${index * STEP_HEIGHT}px)`;
    if (planCounter) planCounter.textContent = `${index + 1}/${planTotalSteps}`;

    // Sync expanded step drawer statuses
    document.querySelectorAll('.plan-expanded-step').forEach((step, i) => {
      step.classList.remove('completed', 'active', 'pending');
      if (i < index) {
        step.classList.add('completed');
      } else if (i === index) {
        step.classList.add('active');
      } else {
        step.classList.add('pending');
      }
    });
  }

  // Duration Timer
  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function startDurationTimer() {
    planStartTime = Date.now();
    if (planDurationTimer) clearInterval(planDurationTimer);
    planDurationTimer = setInterval(() => {
      if (!isPlanPaused && planDurationEl) {
        planDurationEl.textContent = formatDuration(Date.now() - planStartTime);
      }
    }, 1000);
  }

  // Public APIs for AI / External Triggering
  window.setPlanStep = setPlanStep;
  window.setPlanActive = (active) => {
    if (planBar) {
      if (active) {
        planBar.classList.add('active');
        planBar.style.display = '';
        startDurationTimer();
      } else {
        planBar.classList.remove('active', 'expanded-steps', 'expanded-goal');
        planBar.style.display = 'none';
        if (planDurationTimer) {
          clearInterval(planDurationTimer);
          planDurationTimer = null;
        }
      }
    }
  };
  window.setPlanMode = (mode) => {
    if (!planBar) return;
    planBar.setAttribute('data-mode', mode);
    if (planModeBadge) {
      const modeText = planModeBadge.querySelector('.mode-text');
      if (modeText) modeText.textContent = mode === 'goal' ? '目标模式' : '计划模式';
    }
  };
  window.toggleGoalPanel = toggleGoalPanel;
  window.toggleStepsDrawer = toggleStepsDrawer;

  // Toggle Upward Goal Management Panel
  function toggleGoalPanel(show) {
    if (!planBar) return;
    if (show === undefined) show = !planBar.classList.contains('expanded-goal');
    if (show) {
      planBar.classList.remove('expanded-steps'); // Close steps drawer if open
      planBar.classList.add('expanded-goal');
    } else {
      planBar.classList.remove('expanded-goal');
    }
  }

  // Toggle Upward Step List Drawer
  function toggleStepsDrawer(show) {
    if (!planBar) return;
    if (show === undefined) show = !planBar.classList.contains('expanded-steps');
    if (show) {
      planBar.classList.remove('expanded-goal'); // Close goal panel if open
      planBar.classList.add('expanded-steps');
    } else {
      planBar.classList.remove('expanded-steps');
    }
  }

  // Click [目标模式] Badge -> Opens Goal Panel
  if (planModeBadge) {
    planModeBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGoalPanel();
    });
  }

  // Quick Edit Button -> Toggles Goal Panel & Focuses Editor if opened
  if (planEditQuickBtn) {
    planEditQuickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !planBar.classList.contains('expanded-goal');
      toggleGoalPanel();
      if (willOpen) {
        const editor = document.getElementById('goalEditField');
        if (editor) editor.focus();
      }
    });
  }

  if (planGoalPanelClose) {
    planGoalPanelClose.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGoalPanel(false);
    });
  }

  if (goalSaveBtn) {
    goalSaveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGoalPanel(false);
    });
  }

  // Click anywhere on single-line planCollapsed (non-button area) -> Toggles Step Drawer Upward IN PLACE without scrolling/jumping position
  const planCollapsed = document.getElementById('planCollapsed');
  if (planCollapsed) {
    planCollapsed.addEventListener('click', (e) => {
      // Do not toggle if clicking interactive buttons (badge, action buttons)
      if (e.target.closest('.plan-action-btn, .plan-mode-badge, button, input, a')) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      toggleStepsDrawer();
    });
  }

  // Pause / Resume Toggle Button
  if (planPauseToggleBtn) {
    planPauseToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isPlanPaused = !isPlanPaused;
      const pauseIcon = planPauseToggleBtn.querySelector('.icon-pause');
      const playIcon = planPauseToggleBtn.querySelector('.icon-play');
      if (pauseIcon && playIcon) {
        pauseIcon.style.display = isPlanPaused ? 'none' : 'block';
        playIcon.style.display = isPlanPaused ? 'block' : 'none';
      }
    });
  }

  // Quick Stop Button -> Open Centered Modal Overlay (5% Black Backdrop)
  const stopTaskModalOverlay = document.getElementById('stopTaskModalOverlay');
  const stopTaskPopoverEl = document.getElementById('stopTaskPopover');

  window.openStopTaskModal = function openStopTaskModal() {
    if (stopTaskModalOverlay) stopTaskModalOverlay.classList.add('active');
    if (stopTaskPopoverEl) stopTaskPopoverEl.classList.add('active');
  };

  window.closeStopTaskModal = function closeStopTaskModal() {
    if (stopTaskModalOverlay) stopTaskModalOverlay.classList.remove('active');
    if (stopTaskPopoverEl) stopTaskPopoverEl.classList.remove('active');
  };

  if (planStopQuickBtn) {
    planStopQuickBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.openStopTaskModal();
    });
  }

  if (stopTaskModalOverlay) {
    stopTaskModalOverlay.addEventListener('click', (e) => {
      if (e.target === stopTaskModalOverlay) {
        window.closeStopTaskModal();
      }
    });
  }

  const stopTaskCancelBtn = document.getElementById('stopTaskCancelBtn');
  if (stopTaskCancelBtn) {
    stopTaskCancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.closeStopTaskModal();
    });
  }

  const stopTaskConfirmBtn = document.getElementById('stopTaskConfirmBtn');
  if (stopTaskConfirmBtn) {
    stopTaskConfirmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.setPlanActive(false);
      window.closeStopTaskModal();
    });
  }

  initPlanSteps();
  if (planBar && planBar.classList.contains('active') && planTotalSteps > 0) {
    setPlanStep(1); // Set directly to active Step 2 (2/5)
    startDurationTimer();
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover-menu') &&
        !e.target.closest('.cascade-submenu') &&
        !e.target.closest('.action-pill-btn') &&
        !e.target.closest('.plan-action-btn') &&
        !e.target.closest('.plan-mode-badge') &&
        !e.target.closest('.pure-mode-text-btn') &&
        !e.target.closest('.fused-model-thinking-btn') &&
        !e.target.closest('.icon-btn-plus') &&
        !e.target.closest('.icon-btn') &&
        !e.target.closest('#composerEditable')) {
      window.closeAllPopovers();
    }
  });
});

  // Model Advanced Toggle
  const btnModelAdvanced = document.getElementById('btnModelAdvanced');
  const modelAdvancedContent = document.getElementById('modelAdvancedContent');
  if (btnModelAdvanced && modelAdvancedContent) {
    btnModelAdvanced.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent closing popover
      btnModelAdvanced.classList.toggle('is-expanded');
      modelAdvancedContent.classList.toggle('is-expanded');
    });
  }

  // Avant-Garde Thinking Track Logic
  function setupThinkingTrack(trackId, thumbId, textUpdateIds) {
    const track = document.getElementById(trackId);
    const thumb = document.getElementById(thumbId);
    if (!track || !thumb) return;

    const items = track.querySelectorAll('.thinking-seg-item');
    items.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(item.getAttribute('data-idx'));
        const val = item.getAttribute('data-val');

        // Update Thumb Position & Track Level
        thumb.style.transform = `translateX(${idx * 100}%)`;
        track.setAttribute('data-level', idx);

        // Update Active Class
        items.forEach(i => i.classList.remove('is-active'));
        item.classList.add('is-active');

        // Sync Text in UI
        textUpdateIds.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.textContent = val;
        });

        // If clicking standalone, sync model advanced too and vice versa
        syncThinkingTracks(idx);
      });
    });
  }

  function syncThinkingTracks(idx) {
    ['modelThinkingTrack', 'standaloneThinkingTrack'].forEach(trackId => {
      const track = document.getElementById(trackId);
      if (track) {
        track.setAttribute('data-level', idx);
        const items = track.querySelectorAll('.thinking-seg-item');
        items.forEach(i => i.classList.remove('is-active'));
        if (items[idx]) items[idx].classList.add('is-active');
        const thumbId = trackId.replace('Track', 'Thumb');
        const thumb = document.getElementById(thumbId);
        if (thumb) thumb.style.transform = `translateX(${idx * 100}%)`;
      }
    });
  }

  setupThinkingTrack('modelThinkingTrack', 'modelThinkingThumb', ['inlineThinkingStatus', 'standaloneThinkingStatus', 'btnThinking']);
  setupThinkingTrack('standaloneThinkingTrack', 'standaloneThinkingThumb', ['inlineThinkingStatus', 'standaloneThinkingStatus', 'btnThinking']);

  // Update Model Selection Logic
  document.querySelectorAll('.model-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't close if clicking advanced toggle
      if (e.target.closest('.model-advanced-toggle') || e.target.closest('.model-advanced-content')) return;

      e.stopPropagation();
      const modelName = item.getAttribute('data-model');

      document.querySelectorAll('.model-item').forEach(i => i.classList.remove('is-selected'));
      item.classList.add('is-selected');

      const btnModel = document.getElementById('btnModel');
      if (btnModel) {
        let alias = modelName;
        if (alias.includes('3.5 Sonnet')) alias = '3.5 Sonnet';
        else if (alias.includes('3.7 Sonnet')) alias = '3.7 Sonnet';
        else if (alias.includes('V4 Flash')) alias = 'DS V4';
        else if (alias.includes('4o Mini')) alias = '4o Mini';
        btnModel.textContent = alias;
      }

      window.closeAllPopovers();
    });
  });


  // Apply smart alias on load for the default model
  const defaultModelBtn = document.getElementById('btnModel');
  if (defaultModelBtn) {
    let name = defaultModelBtn.textContent.trim();
    if (name.includes('3.5 Sonnet')) name = '3.5 Sonnet';
    else if (name.includes('3.7 Sonnet')) name = '3.7 Sonnet';
    else if (name.includes('V4 Flash')) name = 'DS V4';
    else if (name.includes('R1')) name = 'DS R1';
    else if (name.includes('4o Mini')) name = '4o Mini';
    defaultModelBtn.textContent = name;
  }

  // ---- Top Header Actions & Split Workspace Panel ----
  const topMoreBtn = document.getElementById('topMoreBtn');
  const topMoreMenu = document.getElementById('topMoreMenu');
  const topMoveOption = document.getElementById('topMoveOption');
  const topProjectSubmenu = document.getElementById('topProjectSubmenu');
  const topQuickPreviewBtn = document.getElementById('topQuickPreviewBtn');
  const topQuickArtifactsBtn = document.getElementById('topQuickArtifactsBtn');
  const topPanelBtn = document.getElementById('topPanelBtn');
  const chatAppLayout = document.getElementById('chatAppLayout');

  if (topMoreBtn && topMoreMenu) {
    topMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.togglePopover(topMoreBtn, 'topMoreMenu');
    });
  }

  if (topMoveOption && topProjectSubmenu) {
    topMoveOption.addEventListener('mouseenter', () => {
      const rect = topMoveOption.getBoundingClientRect();
      const subWidth = topProjectSubmenu.offsetWidth || 150;
      topProjectSubmenu.style.top = `${rect.top}px`;
      topProjectSubmenu.style.left = `${Math.max(10, rect.left - subWidth - 6)}px`;
      topProjectSubmenu.classList.add('active');
    });
    if (topMoreMenu) {
      topMoreMenu.addEventListener('mouseleave', (e) => {
        if (!topProjectSubmenu.contains(e.relatedTarget)) {
          topProjectSubmenu.classList.remove('active');
        }
      });
    }
    topProjectSubmenu.addEventListener('mouseleave', () => {
      topProjectSubmenu.classList.remove('active');
    });
  }

  function openSidePanelCapability(type, btnEl) {
    const leafEl = btnEl?.closest('.tree-leaf-pane')
                || document.querySelector('.tree-leaf-pane.active')
                || document.querySelector('.tree-leaf-pane');

    if (leafEl) {
      if (!leafEl.classList.contains('has-side-panel')) {
        leafEl.classList.add('has-side-panel');
        const sidePanelBtn = leafEl.querySelector('.top-side-panel-btn');
        if (sidePanelBtn) sidePanelBtn.classList.add('active');
        if (window.syncComposerHorizontalAlignment) {
          setTimeout(window.syncComposerHorizontalAlignment, 50);
        }
      }
      if (leafEl._sidePanelTabManager) {
        leafEl._sidePanelTabManager.openCapability(type);
      }
    } else if (chatAppLayout) {
      if (!chatAppLayout.classList.contains('has-side-panel')) {
        chatAppLayout.classList.add('has-side-panel');
        if (topPanelBtn) topPanelBtn.classList.add('active');
        if (window.syncComposerHorizontalAlignment) {
          setTimeout(window.syncComposerHorizontalAlignment, 50);
        }
      }
    }
  }

  if (topQuickPreviewBtn) {
    topQuickPreviewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSidePanelCapability('preview', topQuickPreviewBtn);
    });
  }

  if (topQuickArtifactsBtn) {
    topQuickArtifactsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSidePanelCapability('artifacts', topQuickArtifactsBtn);
    });
  }

  // Toggle Right Workspace Panel
  function toggleSidePanel() {
    if (!chatAppLayout) return;
    chatAppLayout.classList.toggle('has-side-panel');
    const isOpen = chatAppLayout.classList.contains('has-side-panel');
    if (topPanelBtn) topPanelBtn.classList.toggle('active', isOpen);

    // Sync composer horizontal alignment and timeline rails
    if (window.syncComposerHorizontalAlignment) {
      setTimeout(window.syncComposerHorizontalAlignment, 50);
      setTimeout(window.syncComposerHorizontalAlignment, 230);
    }
    if (window.FlowTimelineRail && window.FlowTimelineRail.updateAll) {
      setTimeout(() => window.FlowTimelineRail.updateAll(document.body), 230);
    }
  }

  if (topPanelBtn) {
    topPanelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSidePanel();
    });
  }
  // ---- Left Sidebar & Breadcrumbs Subagent Monitor ----
  const bcAgentCapsule = document.getElementById('bcAgentCapsule');

  if (bcAgentCapsule) {
    bcAgentCapsule.addEventListener('click', (e) => {
      e.stopPropagation();
      bcAgentCapsule.classList.toggle('active');
      window.togglePopover(bcAgentCapsule, 'agentRuntimePopover');
    });
  }

  // ---- Genuine Binary Tree Tiling Split Workspace Engine (Ported from Conex Prototype) ----
  const topBarNewTabBtn = document.getElementById('topBarNewTabBtn');
  const tabsContainer = document.querySelector('.top-bar-tabs-container');

  class TreeStore {
    constructor() {
      this.tree = {
        type: 'leaf',
        id: 'pane-main',
        isMain: true,
        tabs: [
          { id: 'tab-1', title: 'adobe illustrator 教程' },
          { id: 'tab-2', title: '重构 IPC 缓冲通道' }
        ],
        activeTabId: 'tab-1'
      };
      this._uid = 100;
      this._subs = new Set();
    }

    subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
    _emit(type, data) { this._subs.forEach(fn => fn(type, data)); }

    firstLeaf(n = this.tree) {
      return n.type === 'leaf' ? n : this.firstLeaf(n.left);
    }

    findLeaf(n, id) {
      if (!n) return null;
      if (n.type === 'leaf') return n.id === id ? n : null;
      return this.findLeaf(n.left, id) || this.findLeaf(n.right, id);
    }

    nextId() { return 'pane-' + (++this._uid); }

    addTab(pid) {
      const leaf = this.findLeaf(this.tree, pid);
      if (!leaf) return;
      this._tabUid = (this._tabUid || leaf.tabs.length) + 1;
      const tab = { id: 'tab-' + Date.now(), title: '新会话 ' + this._tabUid };
      leaf.tabs.push(tab);
      leaf.activeTabId = tab.id;
      this._enteringTabId = tab.id;
      this._emit('rebuild');
    }

    removeTab(pid, tid) {
      this._rmTab(this.tree, pid, tid);
      this._prune(this.tree);
      this._emit('rebuild');
    }

    activateTab(pid, tid) {
      const leaf = this.findLeaf(this.tree, pid);
      if (leaf) {
        leaf.activeTabId = tid;
        this._emit('rebuild');
      }
    }

    executeSplit(srcId, tab, dstId, region, insertIdx = -1) {
      const srcLeaf = this.findLeaf(this.tree, srcId);
      const dstLeaf = this.findLeaf(this.tree, dstId);

      // 1. In-place reorder in the SAME pane (NO tree pruning!)
      if (srcId === dstId && (region === 'center' || region === 'strip') && srcLeaf) {
        const fromIdx = srcLeaf.tabs.findIndex(t => t.id === tab.id);
        if (fromIdx !== -1) {
          srcLeaf.tabs.splice(fromIdx, 1);
          let toIdx = insertIdx;
          if (toIdx < 0 || toIdx > srcLeaf.tabs.length) {
            toIdx = srcLeaf.tabs.length;
          }
          srcLeaf.tabs.splice(toIdx, 0, tab);
          srcLeaf.activeTabId = tab.id;
          this._emit('rebuild');
          return;
        }
      }

      // 2. Cross-pane move into existing pane tabs
      if ((region === 'center' || region === 'strip') && dstLeaf) {
        this._rmTab(this.tree, srcId, tab.id);
        const idx = (insertIdx >= 0 && insertIdx <= dstLeaf.tabs.length) ? insertIdx : dstLeaf.tabs.length;
        dstLeaf.tabs.splice(idx, 0, tab);
        dstLeaf.activeTabId = tab.id;
        this._prune(this.tree);
        this._emit('rebuild');
        return;
      }

      // 3. Binary Split (left / right / top / bottom)
      if (dstLeaf && (region === 'left' || region === 'right' || region === 'top' || region === 'bottom')) {
        this._rmTab(this.tree, srcId, tab.id);
        this._split(this.tree, dstId, tab, region);
        this._prune(this.tree);
        this._emit('rebuild');
        return;
      }

      // Fallback
      this._rmTab(this.tree, srcId, tab.id);
      const fallback = this.firstLeaf();
      if (fallback) {
        fallback.tabs.push(tab);
        fallback.activeTabId = tab.id;
      }
      this._prune(this.tree);
      this._emit('rebuild');
    }

    _rmTab(node, pid, tid) {
      if (!node) return;
      if (node.type === 'leaf') {
        if (node.id === pid) {
          node.tabs = node.tabs.filter(t => t.id !== tid);
          if (node.tabs.length && node.activeTabId === tid) {
            node.activeTabId = node.tabs[0].id;
          }
        }
      } else {
        this._rmTab(node.left, pid, tid);
        this._rmTab(node.right, pid, tid);
      }
    }

    _prune(node) {
      if (!node || node.type !== 'branch') return;
      this._prune(node.left);
      this._prune(node.right);
      let survivor = null;
      if (node.left.type === 'leaf' && !node.left.tabs.length) survivor = node.right;
      if (node.right.type === 'leaf' && !node.right.tabs.length) survivor = node.left;
      if (!survivor) return;
      for (const k of Object.keys(node)) delete node[k];
      Object.assign(node, JSON.parse(JSON.stringify(survivor)));
    }

    _split(node, targetId, tab, region) {
      if (!node) return;
      if (node.type === 'leaf') {
        if (node.id !== targetId) return;
        const original = JSON.parse(JSON.stringify(node));
        const fresh = {
          type: 'leaf',
          id: this.nextId(),
          isMain: false,
          tabs: [tab],
          activeTabId: tab.id
        };
        const isHorizontal = region === 'left' || region === 'right';
        const newFirst = region === 'left' || region === 'top';
        for (const k of Object.keys(node)) delete node[k];
        node.type = 'branch';
        node.direction = isHorizontal ? 'horizontal' : 'vertical';
        node.ratio = 0.5;
        node.left = newFirst ? fresh : original;
        node.right = newFirst ? original : fresh;
      } else {
        this._split(node.left, targetId, tab, region);
        this._split(node.right, targetId, tab, region);
      }
    }
  }

  class DragController {
    constructor(store, rerender) {
      this.store = store;
      this.rerender = rerender;
      this._target = null;
      this._draggedTab = null;
      this._indicator = null;
      this._card = null;
      this._activeStrip = null;
      this._tabElements = [];
      this._tabOriginalRects = [];
      this._srcIdx = -1;
      this._srcPaneId = null;
      this._draggedEl = null;
      this._lastTargetIdx = -1;
      this._lastStateKey = null;
    }

    start(e, srcPaneId, tab, idx, srcStrip) {
      if (e.button !== 0 || e.target.closest('.tab-item-close-btn')) return;

      this._draggedTab = tab;
      this._srcPaneId = srcPaneId;
      this._srcIdx = idx;
      const sx = e.clientX, sy = e.clientY;

      const tabsList = srcStrip.querySelector('.top-bar-tabs-list') || srcStrip;
      const allTabs = Array.from(tabsList.querySelectorAll('.session-tab-item:not(.is-leaving)'));
      const dragged = allTabs[idx] || e.currentTarget;
      if (!dragged) return;
      this._draggedEl = dragged;

      const leaf = this.store.findLeaf(this.store.tree, srcPaneId);
      if (!leaf) return;

      const rect = dragged.getBoundingClientRect();
      const grabOffsetX = Math.max(10, Math.min(e.clientX - rect.left, rect.width - 10));
      const grabOffsetY = Math.max(5, Math.min(e.clientY - rect.top, rect.height - 5));

      let mode = 'idle';
      let cleaned = false;
      document.body.style.userSelect = 'none';
      document.body.classList.add('is-tab-dragging');

      // Measure source strip layout
      this._initSrcStrip(srcStrip);

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        document.body.classList.remove('is-tab-dragging');

        if (dragged) {
          dragged.classList.remove('is-dragging');
        }
        if (this._card) {
          this._card.remove();
          this._card = null;
        }
        if (this._indicator) {
          this._indicator.remove();
          this._indicator = null;
        }
        this._leaveStrip();
        this._target = null;
        this._lastStateKey = null;
        this._draggedTab = null;
        this._draggedEl = null;
      };

      const onMove = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (mode === 'idle' && (Math.abs(dx) + Math.abs(dy)) < 3) return;

        if (mode === 'idle') {
          mode = 'drag';
          dragged.classList.add('is-dragging');
          this._createCard(tab.title, rect.width);
        }

        // Real-time 0ms direct hardware cursor tracking in global viewport space
        if (this._card) {
          this._card.style.transform = `translate3d(${ev.clientX - grabOffsetX}px, ${ev.clientY - grabOffsetY}px, 0)`;
        }

        this._onDragMove(ev.clientX, ev.clientY);
      };

      const onUp = (ev) => {
        if (cleaned) return;
        const target = this._target;
        const wasDrag = mode === 'drag';
        cleanup();

        if (!wasDrag || !target) {
          this.store.activateTab(srcPaneId, tab.id);
          return;
        }

        const { paneId, region, insertIdx } = target;
        if (paneId === srcPaneId && leaf.tabs.length <= 1 && (region === 'center' || region === 'strip')) {
          this.store.activateTab(srcPaneId, tab.id);
          return;
        }

        this.store.executeSplit(srcPaneId, tab, paneId, region, insertIdx);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    _createCard(title, width) {
      if (this._card) this._card.remove();
      const c = document.createElement('div');
      c.className = 'tree-drag-card';
      c.style.width = width ? width + 'px' : '150px';
      c.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;">${title}</span>`;
      document.body.appendChild(c);
      this._card = c;
    }

    _initSrcStrip(strip) {
      this._activeStrip = strip;
      const tabsList = strip.querySelector('.top-bar-tabs-list') || strip;
      this._tabElements = Array.from(tabsList.querySelectorAll('.session-tab-item:not(.is-leaving)'));
      this._tabOriginalRects = this._tabElements.map(el => {
        const r = el.getBoundingClientRect();
        const tx = new WebKitCSSMatrix(getComputedStyle(el).transform).m41 || 0;
        const baseLeft = r.left - tx;
        return {
          left: baseLeft,
          right: baseLeft + r.width,
          width: r.width,
          midX: baseLeft + r.width / 2,
          el: el
        };
      });
      this._lastTargetIdx = this._srcIdx;
    }

    _leaveStrip() {
      if (this._tabElements) {
        this._tabElements.forEach(el => {
          el.style.transform = '';
          el.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
        });
      }
      if (this._activeStrip) {
        const inFlowAdd = this._activeStrip.querySelector('.top-bar-new-tab-btn.in-flow');
        if (inFlowAdd) {
          inFlowAdd.style.transform = '';
          inFlowAdd.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
        }
      }
      this._activeStrip = null;
      this._tabElements = [];
      this._tabOriginalRects = [];
      this._lastTargetIdx = -1;
      this._lastStateKey = null;
    }

    _createIndicator() {
      if (this._indicator) return this._indicator;
      const d = document.createElement('div');
      d.className = 'tree-drop-indicator';
      document.body.appendChild(d);
      this._indicator = d;
      return d;
    }

    _onDragMove(cx, cy) {
      const hit = document.elementFromPoint(cx, cy);

      // Robust header / tab strip detection (handles header padding, tab items, tabsList, etc.)
      const header = hit ? hit.closest('.tree-pane-header') : null;
      const strip = header ? (header.querySelector('.top-bar-tabs-container') || header) : (hit ? hit.closest('.top-bar-tabs-container') : null);

      if (strip) {
        // Mode 1: Inside Tab Strip (Chrome-grade Physical Card Reordering)
        this._handleStripMove(cx, strip);
      } else {
        // Mode 2: Detached into Workspace Panes (Green Drop Zone Preview)
        this._handleWorkspaceMove(cx, cy, hit);
      }
    }

    _handleStripMove(cx, strip) {
      if (this._card) {
        this._card.classList.remove('is-detached');
      }

      // Hide workspace drop indicator when inside tab strip
      if (this._indicator) {
        this._indicator.style.display = 'none';
      }

      const paneId = strip.dataset.paneId || strip.closest('.tree-leaf-pane')?.dataset?.paneId || this._srcPaneId || 'pane-main';
      const isSameStrip = (paneId === this._srcPaneId);

      if (isSameStrip) {
        if (this._activeStrip !== strip || !this._tabOriginalRects || this._tabOriginalRects.length === 0) {
          this._initSrcStrip(strip);
        }
        const rects = this._tabOriginalRects;
        const srcIdx = this._srcIdx;
        const shiftW = (rects[srcIdx]?.width || 150) + 4;

        // Determine target slot by comparing cursor position against neighbor midpoints
        let targetIdx = srcIdx;
        for (let i = 0; i < rects.length; i++) {
          if (i === srcIdx) continue;
          const r = rects[i];
          if (i < srcIdx) {
            if (cx < r.midX) {
              targetIdx = Math.min(targetIdx, i);
            }
          } else {
            if (cx > r.midX) {
              targetIdx = Math.max(targetIdx, i);
            }
          }
        }

        if (targetIdx !== this._lastTargetIdx) {
          this._lastTargetIdx = targetIdx;
          rects.forEach((r, i) => {
            if (i === srcIdx) return;
            r.el.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
            if (srcIdx < targetIdx && i > srcIdx && i <= targetIdx) {
              r.el.style.transform = `translateX(-${shiftW}px)`;
            } else if (srcIdx > targetIdx && i >= targetIdx && i < srcIdx) {
              r.el.style.transform = `translateX(${shiftW}px)`;
            } else {
              r.el.style.transform = '';
            }
          });
        }

        this._target = { paneId, region: 'strip', insertIdx: targetIdx };
      } else {
        // Cross-window drag to another strip!
        if (this._activeStrip !== strip) {
          this._leaveStrip();
          this._activeStrip = strip;
          const tabsList = strip.querySelector('.top-bar-tabs-list') || strip;
          this._tabElements = Array.from(tabsList.querySelectorAll('.session-tab-item:not(.is-leaving)'));
          this._tabOriginalRects = this._tabElements.map(el => {
            const r = el.getBoundingClientRect();
            const tx = new WebKitCSSMatrix(getComputedStyle(el).transform).m41 || 0;
            const baseLeft = r.left - tx;
            return { left: baseLeft, right: baseLeft + r.width, width: r.width, midX: baseLeft + r.width / 2, el: el };
          });
        }

        const rects = this._tabOriginalRects;
        const shiftW = 154;
        let targetIdx = rects.length;
        for (let i = 0; i < rects.length; i++) {
          if (cx < rects[i].midX) {
            targetIdx = i;
            break;
          }
        }

        const stateKey = `cross:${paneId}:${targetIdx}`;
        if (this._lastStateKey !== stateKey) {
          this._lastStateKey = stateKey;
          rects.forEach((r, i) => {
            r.el.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
            r.el.style.transform = i >= targetIdx ? `translateX(${shiftW}px)` : '';
          });
          const inFlowAdd = strip.querySelector('.top-bar-new-tab-btn.in-flow');
          if (inFlowAdd) {
            inFlowAdd.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
            inFlowAdd.style.transform = `translateX(${shiftW}px)`;
          }
        }

        this._target = { paneId, region: 'strip', insertIdx: targetIdx };
      }
    }

    _handleWorkspaceMove(cx, cy, hit) {
      if (this._card) {
        this._card.classList.add('is-detached');
      }

      // Reset tab strip displacements when dragging out into the workspace
      if (this._activeStrip) {
        this._leaveStrip();
      }

      const ind = this._createIndicator();
      const pane = hit ? hit.closest('.tree-leaf-pane') : null;

      if (!pane) {
        ind.style.display = 'none';
        this._target = null;
        this._lastStateKey = null;
        return;
      }

      const r = pane.getBoundingClientRect();
      const rx = (cx - r.left) / r.width;
      const ry = (cy - r.top) / r.height;
      let region = 'center';
      if (rx < 0.22) region = 'left';
      else if (rx > 0.78) region = 'right';
      else if (ry < 0.22) region = 'top';
      else if (ry > 0.78) region = 'bottom';

      const paneId = pane.dataset.paneId || 'pane-main';
      const stateKey = `pane:${paneId}:${region}`;
      if (this._lastStateKey === stateKey) return;
      this._lastStateKey = stateKey;

      this._target = { paneId, region, insertIdx: -1 };

      ind.style.display = 'flex';
      ind.style.alignItems = 'center';
      ind.style.justifyContent = 'center';
      ind.style.borderRadius = '6px';
      ind.style.transition = 'left 120ms cubic-bezier(.2,0,0,1), top 120ms cubic-bezier(.2,0,0,1), width 120ms cubic-bezier(.2,0,0,1), height 120ms cubic-bezier(.2,0,0,1), border-radius 100ms ease, opacity 80ms ease';

      const title = this._draggedTab ? this._draggedTab.title : '';
      ind.innerHTML = title ? `<span style="font-size:13px;font-weight:500;color:var(--brand-primary,#10b981);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80%;pointer-events:none;">${title}</span>` : '';

      switch (region) {
        case 'left':   this._posInd(ind, r.left + 2, r.top + 2, r.width * .5 - 4, r.height - 4); break;
        case 'right':  this._posInd(ind, r.left + r.width * .5 + 2, r.top + 2, r.width * .5 - 4, r.height - 4); break;
        case 'top':    this._posInd(ind, r.left + 2, r.top + 2, r.width - 4, r.height * .5 - 4); break;
        case 'bottom': this._posInd(ind, r.left + 2, r.top + r.height * .5 + 2, r.width - 4, r.height * .5 - 4); break;
        default:       this._posInd(ind, r.left + 2, r.top + 2, r.width - 4, r.height - 4); break;
      }
    }

    _posInd(el, l, t, w, h) {
      el.style.left = l + 'px';
      el.style.top = t + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    }
  }

  // ---- Side Panel Tab & View Controller (Row 1: Tabs + Row 2: Toolbar + Launcher Hub) ----
  class SidePanelTabManager {
    constructor(sidePanelEl, leafEl = null) {
      this.sidePanelEl = sidePanelEl;
      this.leafEl = leafEl;
      this.tabs = [
        { id: 'tab-preview', type: 'preview', title: '应用预览', icon: 'preview', closable: true },
        { id: 'tab-artifacts', type: 'artifacts', title: '代码产物', icon: 'artifacts', closable: true }
      ];
      this.activeTabId = 'tab-preview';
      this.isMaximized = false;
      this._tabCounter = this.tabs.length;

      this._initDOM();
      this.render();
    }

    _initDOM() {
      this.sidePanelEl.innerHTML = `
        <header class="side-panel-tab-header">
          <div class="side-panel-tabs-track">
            <div class="side-panel-tabs-list"></div>
            <button class="side-panel-add-btn in-flow" title="新建标签页">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
          </div>
          <div class="side-panel-tab-fixed-cluster">
            <button class="side-panel-add-btn pinned" title="新建标签页">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
            <button class="side-panel-btn side-panel-btn-maximize" title="最大化面板">
              <svg class="icon-maximize" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
              <svg class="icon-restore" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
            </button>
          </div>
        </header>

        <div class="side-panel-toolbar">
          <div class="side-panel-toolbar-nav">
            <button class="side-panel-btn" title="后退"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg></button>
            <button class="side-panel-btn" title="前进"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></button>
            <button class="side-panel-btn" title="刷新"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg></button>
          </div>
          <div class="side-panel-toolbar-actions">
            <button class="side-panel-btn" title="在浏览器中打开"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></button>
          </div>
        </div>

        <div class="side-panel-body"></div>
      `;

      this.tabHeader = this.sidePanelEl.querySelector('.side-panel-tab-header');
      this.tabsTrack = this.sidePanelEl.querySelector('.side-panel-tabs-track');
      this.tabsList = this.sidePanelEl.querySelector('.side-panel-tabs-list');
      this.inFlowAddBtn = this.sidePanelEl.querySelector('.side-panel-add-btn.in-flow');
      this.pinnedAddBtn = this.sidePanelEl.querySelector('.side-panel-add-btn.pinned');
      this.maxBtn = this.sidePanelEl.querySelector('.side-panel-btn-maximize');
      this.bodyEl = this.sidePanelEl.querySelector('.side-panel-body');

      this.inFlowAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addTab();
      });
      this.pinnedAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addTab();
      });

      this.maxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMaximize();
      });

      this.tabsTrack.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          this.tabsTrack.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }, { passive: false });

      if (window.ResizeObserver) {
        this._resizeObserver = new ResizeObserver(() => this.checkOverflow());
        this._resizeObserver.observe(this.tabsTrack);
      }
    }

    _getIconSvg(iconType) {
      if (iconType === 'artifacts') {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><polyline points="10 13 8 15 10 17"></polyline><polyline points="14 13 16 15 14 17"></polyline></svg>`;
      }
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10z"></path></svg>`;
    }

    render(enteringTabId = null) {
      this.tabsList.innerHTML = '';
      const isEmpty = this.tabs.length === 0;
      this.sidePanelEl.classList.toggle('is-empty', isEmpty);

      if (isEmpty) {
        this.renderLauncherHub();
        this.checkOverflow();
        return;
      }

      this.tabs.forEach((tab) => {
        const tabEl = document.createElement('div');
        tabEl.className = 'side-panel-tab-item' + (tab.id === this.activeTabId ? ' active' : '');
        if (tab.id === enteringTabId) {
          tabEl.classList.add('is-entering');
        }
        tabEl.dataset.id = tab.id;
        tabEl.title = tab.title;
        tabEl.innerHTML = `
          <span class="side-panel-tab-icon">${this._getIconSvg(tab.icon)}</span>
          <span class="tab-item-title">${tab.title}</span>
          ${tab.closable ? `
          <button class="tab-item-close-btn" title="关闭标签页">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>` : ''}
        `;

        tabEl.addEventListener('click', (e) => {
          if (e.target.closest('.tab-item-close-btn')) {
            e.stopPropagation();
            this.closeTab(tab.id, tabEl);
          } else {
            this.activateTab(tab.id);
          }
        });

        // Middle click to close tab
        tabEl.addEventListener('auxclick', (e) => {
          if (e.button === 1) { // Middle mouse button
            e.preventDefault();
            e.stopPropagation();
            if (tab.closable) {
              this.closeTab(tab.id, tabEl);
            }
          }
        });

        tabEl.addEventListener('mousedown', (e) => {
          if (e.button === 1) {
            e.preventDefault(); // Prevent default auto-scroll icon on middle click
          }
        });

        this.tabsList.appendChild(tabEl);
      });

      this.updateBodyView();
      this.checkOverflow();
    }

    renderLauncherHub() {
      if (!this.bodyEl) return;
      this.bodyEl.innerHTML = `
        <div class="side-panel-launcher-hub">
          <div class="launcher-cards-group">
            <button class="side-panel-launcher-card" data-capability="preview">
              <div class="launcher-card-icon-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10z"></path>
                </svg>
              </div>
              <span class="launcher-card-title">应用预览</span>
            </button>

            <button class="side-panel-launcher-card" data-capability="artifacts">
              <div class="launcher-card-icon-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <polyline points="10 13 8 15 10 17"></polyline><polyline points="14 13 16 15 14 17"></polyline>
                </svg>
              </div>
              <span class="launcher-card-title">代码产物与文件</span>
            </button>
          </div>
        </div>
      `;

      this.bodyEl.querySelectorAll('.side-panel-launcher-card').forEach(card => {
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          const cap = card.dataset.capability;
          this.openCapability(cap);
        });
      });
    }

    openCapability(type, customTitle = null) {
      const existingTab = this.tabs.find(t => t.type === type);
      if (existingTab) {
        this.activateTab(existingTab.id);
        return existingTab.id;
      }

      this._tabCounter++;
      const newId = 'tab-' + type + '-' + Date.now();
      const defaultTitle = type === 'artifacts' ? '代码产物' : '应用预览';
      const newTab = {
        id: newId,
        type: type,
        title: customTitle || defaultTitle,
        icon: type,
        closable: true
      };
      this.tabs.push(newTab);
      this.activeTabId = newId;
      this.render(newId);

      setTimeout(() => {
        if (this.tabsTrack) {
          this.tabsTrack.scrollTo({ left: this.tabsTrack.scrollWidth, behavior: 'smooth' });
          this.checkOverflow();
        }
      }, 50);
      return newId;
    }

    activateTab(tabId) {
      if (this.activeTabId === tabId) return;
      this.activeTabId = tabId;
      this.tabsList.querySelectorAll('.side-panel-tab-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === tabId);
      });
      const activeEl = this.tabsList.querySelector(`.side-panel-tab-item[data-id="${tabId}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
      this.updateBodyView();
    }

    updateBodyView() {
      if (!this.bodyEl || this.tabs.length === 0) return;
      const activeTab = this.tabs.find(t => t.id === this.activeTabId);
      if (!activeTab) return;
      if (activeTab.icon === 'artifacts') {
        this.bodyEl.innerHTML = `
          <div class="side-panel-empty-state">
            <div class="side-empty-title">代码产物与文件</div>
            <div class="side-empty-desc" style="color: var(--text-secondary); font-size: 13px; line-height: 1.6;">在此查看与管理当前会话生成的代码产物、文档及导出文件。</div>
          </div>
        `;
      } else {
        this.bodyEl.innerHTML = `
          <div class="side-panel-empty-state">
            <div class="side-empty-title">Create apps with Build Mode</div>
            <div class="side-empty-desc" style="color: var(--text-secondary); font-size: 13px; line-height: 1.6;">In Build Mode, create websites, games, apps, and interactive dashboards, and preview them right here.</div>
          </div>
        `;
      }
    }

    addTab() {
      this._tabCounter++;
      const newId = 'tab-custom-' + Date.now() + '-' + this._tabCounter;
      const isArtifact = this._tabCounter % 2 === 0;
      const newTab = {
        id: newId,
        type: isArtifact ? 'artifacts' : 'preview',
        title: isArtifact ? `代码产物 ${this._tabCounter}` : `应用预览 ${this._tabCounter}`,
        icon: isArtifact ? 'artifacts' : 'preview',
        closable: true
      };
      this.tabs.push(newTab);
      this.activeTabId = newId;
      this.render(newId);

      setTimeout(() => {
        if (this.tabsTrack) {
          this.tabsTrack.scrollTo({ left: this.tabsTrack.scrollWidth, behavior: 'smooth' });
          this.checkOverflow();
        }
      }, 50);
    }

    closeTab(tabId, tabEl) {
      const tabIdx = this.tabs.findIndex(t => t.id === tabId);
      if (tabIdx === -1) return;

      // Immediately activate neighbor so there is zero visual lag
      if (this.activeTabId === tabId && this.tabs.length > 1) {
        const nextActive = this.tabs[tabIdx === 0 ? 1 : tabIdx - 1];
        if (nextActive) {
          this.activeTabId = nextActive.id;
          const nextEl = this.tabsList.querySelector(`.side-panel-tab-item[data-id="${nextActive.id}"]`);
          if (nextEl) nextEl.classList.add('active');
          this.updateBodyView();
        }
      }

      tabEl.classList.remove('active');
      tabEl.classList.add('is-leaving');
      tabEl.style.pointerEvents = 'none';

      setTimeout(() => {
        const idx = this.tabs.findIndex(t => t.id === tabId);
        if (idx !== -1) {
          this.tabs.splice(idx, 1);
        }
        if (this.tabs.length === 0) {
          this.activeTabId = null;
        }
        this.render();
      }, 220);
    }

    toggleMaximize() {
      this.isMaximized = !this.isMaximized;
      this.sidePanelEl.classList.toggle('is-maximized', this.isMaximized);
      const iconMax = this.maxBtn.querySelector('.icon-maximize');
      const iconRestore = this.maxBtn.querySelector('.icon-restore');
      if (iconMax && iconRestore) {
        iconMax.style.display = this.isMaximized ? 'none' : '';
        iconRestore.style.display = this.isMaximized ? '' : 'none';
      }
      this.maxBtn.title = this.isMaximized ? '恢复面板' : '最大化面板';
      if (window.syncComposerHorizontalAlignment) {
        setTimeout(window.syncComposerHorizontalAlignment, 50);
      }
    }

    checkOverflow() {
      if (!this.tabsTrack || !this.tabHeader) return;
      const isOverflowing = this.tabsTrack.scrollWidth > this.tabsTrack.clientWidth + 2;
      this.tabHeader.classList.toggle('has-overflow', isOverflowing);
    }
  }

  // ---- Workspace Split Renderer (Clones real "重构 IPC 缓冲通道" chat stream across splits) ----
  // ---- Workspace Split Renderer (Position-Aware Peer Binary Tree, Ported from Conex Prototype) ----
  class WorkspaceSplitRenderer {
    constructor(store) {
      this.store = store;
      this.drag = new DragController(this.store, () => this.render());
      this.store.subscribe(() => this.render());
      this.render();
    }

    render() {
      const container = document.getElementById('binaryTreeWorkspaceContainer');
      const mainPane = document.getElementById('chatMainPane');
      if (!container || !mainPane) return;

      // Save mainPane from being destroyed when re-rendering
      if (mainPane.parentElement) {
        mainPane.remove();
      }

      container.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'tree-workspace-root';
      root.appendChild(this._buildNode(this.store.tree, mainPane, { topRow: true, leftEdge: true, rightEdge: true }));
      container.appendChild(root);

      this.store._enteringTabId = null;

      if (window.syncComposerHorizontalAlignment) {
        setTimeout(window.syncComposerHorizontalAlignment, 50);
      }
    }

    _handleCloseTab(node, tab, tabEl) {
      if (node.activeTabId === tab.id && node.tabs.length > 1) {
        const curIdx = node.tabs.findIndex(t => t.id === tab.id);
        const nextTab = node.tabs[curIdx === 0 ? 1 : curIdx - 1];
        if (nextTab) {
          node.activeTabId = nextTab.id;
          const nextEl = tabEl.parentElement?.querySelector(`.session-tab-item[data-id="${nextTab.id}"]`);
          if (nextEl) nextEl.classList.add('active');
        }
      }

      tabEl.classList.remove('active');
      tabEl.classList.add('is-leaving');
      tabEl.style.pointerEvents = 'none';

      setTimeout(() => {
        this.store.removeTab(node.id, tab.id);
      }, 220);
    }

    _buildLeaf(node, mainPane, flags) {
      const leafEl = document.createElement('div');
      leafEl.className = 'tree-leaf-pane';
      leafEl.dataset.paneId = node.id;

      if (flags.topRow) {
        leafEl.classList.add('top-row');
        if (flags.leftEdge) leafEl.classList.add('left-edge');
        if (flags.rightEdge) leafEl.classList.add('right-edge');
      }

      // 1. Header with Dynamic Tab Strip (Contained inside card island)
      const hdr = document.createElement('div');
      hdr.className = 'tree-pane-header';

      const strip = document.createElement('div');
      strip.className = 'top-bar-tabs-container';
      strip.dataset.paneId = node.id;

      const tabsList = document.createElement('div');
      tabsList.className = 'top-bar-tabs-list';

      node.tabs.forEach((tab, i) => {
        const tabEl = document.createElement('div');
        tabEl.className = 'session-tab-item' + (tab.id === node.activeTabId ? ' active' : '');
        if (tab.id === this.store._enteringTabId) {
          tabEl.classList.add('is-entering');
        }
        tabEl.dataset.id = tab.id;
        tabEl.title = tab.title;
        tabEl.innerHTML = `
          <span class="tab-item-title">${tab.title}</span>
          <button class="tab-item-close-btn" title="关闭标签页">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        `;

        tabEl.addEventListener('click', (e) => {
          if (e.target.closest('.tab-item-close-btn')) {
            e.stopPropagation();
            this._handleCloseTab(node, tab, tabEl);
          } else {
            this.store.activateTab(node.id, tab.id);
          }
        });

        // Middle click to close tab
        tabEl.addEventListener('auxclick', (e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            this._handleCloseTab(node, tab, tabEl);
          }
        });

        tabEl.addEventListener('mousedown', (e) => {
          if (e.button === 1) {
            e.preventDefault(); // prevent scroll cursor on middle click
          } else {
            this.drag.start(e, node.id, tab, i, strip);
          }
        });

        tabsList.appendChild(tabEl);
      });

      strip.appendChild(tabsList);

      const addBtnInFlow = document.createElement('button');
      addBtnInFlow.className = 'top-bar-new-tab-btn in-flow';
      addBtnInFlow.title = '新建标签页';
      addBtnInFlow.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
      addBtnInFlow.addEventListener('click', () => this.store.addTab(node.id));
      strip.appendChild(addBtnInFlow);

      // Pinned cluster before win-controls / right boundary
      const fixedCluster = document.createElement('div');
      fixedCluster.className = 'top-bar-fixed-cluster';
      const addBtnPinned = document.createElement('button');
      addBtnPinned.className = 'top-bar-new-tab-btn pinned';
      addBtnPinned.title = '新建标签页';
      addBtnPinned.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
      addBtnPinned.addEventListener('click', () => this.store.addTab(node.id));
      fixedCluster.appendChild(addBtnPinned);

      // Horizontal wheel scrolling support on strip
      strip.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          strip.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }, { passive: false });

      // Overflow observer to toggle smart pinning
      const checkHdrOverflow = () => {
        const isOverflow = strip.scrollWidth > strip.clientWidth + 2;
        hdr.classList.toggle('has-overflow', isOverflow);
      };
      if (window.ResizeObserver) {
        new ResizeObserver(checkHdrOverflow).observe(strip);
      }
      setTimeout(checkHdrOverflow, 30);

      hdr.appendChild(strip);
      hdr.appendChild(fixedCluster);
      leafEl.appendChild(hdr);

      // 2. Content with Conversation View and Per-Pane Right Side Panel
      const content = document.createElement('div');
      content.className = 'tree-pane-content';

      const isMainPane = (node.id === 'pane-main' || !this.store.findLeaf(this.store.tree, 'pane-main'));
      const chatPane = isMainPane ? mainPane : mainPane.cloneNode(true);
      if (!isMainPane) {
        chatPane.id = 'paneChat-' + node.id;
      }
      chatPane.style.display = 'flex';
      chatPane.style.flex = '1 1 0';
      chatPane.style.height = '100%';

      // Side Panel Resizer
      const panelResizer = document.createElement('div');
      panelResizer.className = 'layout-resizer layout-resizer-panel';
      panelResizer.title = '拖拽调整右侧面板宽度';

      // Side Panel DOM matching prototype (Tab Strip + Functional Toolbar)
      const sidePanel = document.createElement('div');
      sidePanel.className = 'chat-side-panel';
      const sidePanelTabManager = new SidePanelTabManager(sidePanel, leafEl);
      leafEl._sidePanelTabManager = sidePanelTabManager;

      content.appendChild(chatPane);
      content.appendChild(panelResizer);
      content.appendChild(sidePanel);
      leafEl.appendChild(content);

      // Mount Per-Leaf Side Panel Toggle Button (Relative to leaf outer container)
      const sidePanelBtn = document.createElement('button');
      sidePanelBtn.className = 'top-action-btn top-side-panel-btn';
      sidePanelBtn.title = '切换右侧工作区 (Cmd/Ctrl + J)';
      sidePanelBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="3.25" stroke="currentColor" stroke-width="1.4"></rect><path d="M9.75 2.5v11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
      `;

      sidePanelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        leafEl.classList.toggle('has-side-panel');
        const isOpen = leafEl.classList.contains('has-side-panel');
        sidePanelBtn.classList.toggle('active', isOpen);
        if (window.syncComposerHorizontalAlignment) {
          setTimeout(window.syncComposerHorizontalAlignment, 50);
        }
      });

      // Bind Per-Leaf Chat Pane Quick Launchers
      const qPreview = chatPane.querySelector('#topQuickPreviewBtn') || chatPane.querySelector('[title="打开应用预览"]');
      const qArtifacts = chatPane.querySelector('#topQuickArtifactsBtn') || chatPane.querySelector('[title="打开代码产物与文件"]');
      if (qPreview) {
        qPreview.onclick = (e) => {
          e.stopPropagation();
          if (!leafEl.classList.contains('has-side-panel')) {
            leafEl.classList.add('has-side-panel');
            sidePanelBtn.classList.add('active');
            if (window.syncComposerHorizontalAlignment) {
              setTimeout(window.syncComposerHorizontalAlignment, 50);
            }
          }
          sidePanelTabManager.openCapability('preview');
        };
      }
      if (qArtifacts) {
        qArtifacts.onclick = (e) => {
          e.stopPropagation();
          if (!leafEl.classList.contains('has-side-panel')) {
            leafEl.classList.add('has-side-panel');
            sidePanelBtn.classList.add('active');
            if (window.syncComposerHorizontalAlignment) {
              setTimeout(window.syncComposerHorizontalAlignment, 50);
            }
          }
          sidePanelTabManager.openCapability('artifacts');
        };
      }

      leafEl.appendChild(sidePanelBtn);



      // Bind Per-Pane Resizer
      let isDraggingPanel = false;
      let startPanelX = 0;
      let startPanelWidth = 360;

      panelResizer.addEventListener('mousedown', (e) => {
        isDraggingPanel = true;
        startPanelX = e.clientX;
        startPanelWidth = sidePanel.getBoundingClientRect().width || 360;
        panelResizer.classList.add('is-dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDraggingPanel) return;
        const deltaX = startPanelX - e.clientX;
        const newWidth = Math.max(200, Math.min(leafEl.clientWidth * 0.7, startPanelWidth + deltaX));
        leafEl.style.setProperty('--panel-width', `${newWidth}px`);
        if (window.syncComposerHorizontalAlignment) {
          window.syncComposerHorizontalAlignment();
        }
      });

      window.addEventListener('mouseup', () => {
        if (isDraggingPanel) {
          isDraggingPanel = false;
          panelResizer.classList.remove('is-dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });

      return leafEl;
    }

    _buildBranch(node, mainPane, flags) {
      const el = document.createElement('div');
      el.className = 'tree-branch ' + node.direction;

      let lf, rf;
      if (node.direction === 'horizontal') {
        lf = { topRow: flags.topRow, leftEdge: flags.leftEdge, rightEdge: false };
        rf = { topRow: flags.topRow, leftEdge: false, rightEdge: flags.rightEdge };
      } else {
        lf = { topRow: flags.topRow, leftEdge: flags.leftEdge, rightEdge: flags.rightEdge };
        rf = { topRow: false, leftEdge: flags.leftEdge, rightEdge: flags.rightEdge };
      }

      const L = this._buildNode(node.left, mainPane, lf);
      L.style.flex = String(node.ratio || 0.5);
      L.style.minWidth = '0';
      L.style.minHeight = '0';

      const R = this._buildNode(node.right, mainPane, rf);
      R.style.flex = String(1 - (node.ratio || 0.5));
      R.style.minWidth = '0';
      R.style.minHeight = '0';

      const resizer = document.createElement('div');
      resizer.className = 'tree-split-resizer';
      resizer.title = '拖拽调整分屏比例，双击重置';
      this._bindResizer(resizer, el, node, L, R);

      el.appendChild(L);
      el.appendChild(resizer);
      el.appendChild(R);
      return el;
    }

    _buildNode(node, mainPane, flags) {
      if (!flags) flags = { topRow: true, leftEdge: true, rightEdge: true };
      return node.type === 'leaf'
        ? this._buildLeaf(node, mainPane, flags)
        : this._buildBranch(node, mainPane, flags);
    }

    _bindResizer(handle, branchEl, node, leftEl, rightEl) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('active');
        document.body.classList.add('is-resizing-split');
        document.body.style.userSelect = 'none';

        const isH = node.direction === 'horizontal';
        document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
        const rect = branchEl.getBoundingClientRect();

        let rafId = null;
        let pendingRaw = null;

        const onMove = (ev) => {
          let raw = isH
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;

          raw = Math.max(0.12, Math.min(0.88, raw));
          pendingRaw = raw;

          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = null;
              if (pendingRaw === null) return;
              leftEl.style.flex = String(pendingRaw);
              rightEl.style.flex = String(1 - pendingRaw);
              node.ratio = pendingRaw;
            });
          }
        };

        const onUp = (ev) => {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          handle.releasePointerCapture(ev.pointerId);
          handle.classList.remove('active');
          document.body.classList.remove('is-resizing-split');
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);

          if (window.syncComposerHorizontalAlignment) {
            window.syncComposerHorizontalAlignment();
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });

      handle.addEventListener('dblclick', () => {
        node.ratio = 0.5;
        leftEl.style.flex = '0.5';
        rightEl.style.flex = '0.5';
        if (window.syncComposerHorizontalAlignment) {
          setTimeout(window.syncComposerHorizontalAlignment, 50);
        }
      });
    }
  }

  // Initialize Split Workspace Engine
  const treeStore = new TreeStore();
  window.treeStore = treeStore;
  window.__workbenchStore = treeStore;
  const workspaceSplitEngine = new WorkspaceSplitRenderer(treeStore);
  window.workspaceSplitEngine = workspaceSplitEngine;

  // Sidebar Collapse / Expand Toggle
  const sidebar = document.getElementById('chatLeftSidebar');
  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');

  function toggleSidebar() {
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    if (chatAppLayout) {
      chatAppLayout.classList.toggle('has-left-sidebar', !isCollapsed);
    }
    if (sidebarToggleBtn) {
      sidebarToggleBtn.title = isCollapsed ? '展开左侧历史栏 (Cmd/Ctrl + B)' : '收起左侧历史栏 (Cmd/Ctrl + B)';
    }
    if (window.syncComposerHorizontalAlignment) {
      setTimeout(window.syncComposerHorizontalAlignment, 50);
    }
  }

  if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', toggleSidebar);

  // Window Controls Feedback
  const winMin = document.getElementById('winMinimizeBtn');
  const winMax = document.getElementById('winMaximizeBtn');
  const winClose = document.getElementById('winCloseBtn');
  if (winMin) winMin.addEventListener('click', () => console.log('Minimize window'));
  if (winMax) winMax.addEventListener('click', () => console.log('Toggle maximize window'));
  if (winClose) winClose.addEventListener('click', () => console.log('Close window'));

  // Sidebar Resizer
  const sidebarResizer = document.getElementById('sidebarResizer');
  const leftSidebar = document.getElementById('chatLeftSidebar');

  if (sidebarResizer && leftSidebar && chatAppLayout) {
    let isDragging = false;
    let startX = 0;
    let startWidth = 240;

    sidebarResizer.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startWidth = leftSidebar.getBoundingClientRect().width || 240;
      sidebarResizer.classList.add('is-dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - startX;
      let newWidth = startWidth + deltaX;

      if (newWidth < 120) {
        if (!leftSidebar.classList.contains('collapsed')) {
          toggleSidebar();
        }
      } else {
        if (leftSidebar.classList.contains('collapsed')) {
          toggleSidebar();
        }
        newWidth = Math.max(160, Math.min(480, newWidth));
        chatAppLayout.style.setProperty('--sidebar-width', `${newWidth}px`);
      }

      if (window.syncComposerHorizontalAlignment) {
        window.syncComposerHorizontalAlignment();
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        sidebarResizer.classList.remove('is-dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (window.syncComposerHorizontalAlignment) {
          setTimeout(window.syncComposerHorizontalAlignment, 50);
        }
      }
    });

    sidebarResizer.addEventListener('dblclick', () => {
      chatAppLayout.style.setProperty('--sidebar-width', '240px');
      if (leftSidebar.classList.contains('collapsed')) {
        toggleSidebar();
      }
      if (window.syncComposerHorizontalAlignment) {
        setTimeout(window.syncComposerHorizontalAlignment, 50);
      }
    });
  }
