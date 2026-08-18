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

  if (btnPlus) {
    btnPlus.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.togglePopover(btnPlus, 'plusPopover');
    });
  }

  if (menuAddFile && composerFileInput) {
    menuAddFile.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.closeAllPopovers();
      composerFileInput.click();
    });
    composerFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        if (window.handleFiles) window.handleFiles(e.target.files);
        e.target.value = '';
      }
    });
  }

  function positionSkillSubmenu() {
    if (!plusPopover || !skillSubmenu) return;
    const rect = plusPopover.getBoundingClientRect();
    let left = rect.right + 6;
    let top = rect.top;
    if (left + 180 > window.innerWidth - 16) {
      left = rect.left - 186;
    }
    skillSubmenu.style.left = `${Math.round(left)}px`;
    skillSubmenu.style.top = `${Math.round(top)}px`;
  }

  if (menuUseSkill && skillSubmenu) {
    menuUseSkill.addEventListener('mouseenter', () => {
      positionSkillSubmenu();
      skillSubmenu.classList.add('active');
    });
    menuUseSkill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      positionSkillSubmenu();
      skillSubmenu.classList.toggle('active');
    });
  }

  document.querySelectorAll('#skillListContainer .skill-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const skillName = item.getAttribute('data-name') || item.innerText.trim();
      if (skillName && window.insertRichInlineTag) {
        window.insertRichInlineTag(skillName, true);
      }
      window.closeAllPopovers();
    });
  });

  const skillSearchInput = document.getElementById('skillSearchInput');
  if (skillSearchInput) {
    skillSearchInput.addEventListener('input', () => {
      const q = skillSearchInput.value.toLowerCase().trim();
      document.querySelectorAll('#skillListContainer .skill-item').forEach(item => {
        const name = (item.getAttribute('data-name') || item.innerText).toLowerCase();
        item.style.display = q === '' || name.includes(q) ? 'flex' : 'none';
      });
    });
  }

  const btnSend = document.getElementById('btnSend');
  if (btnSend) {
    btnSend.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = composerEditable ? composerEditable.textContent.trim() : '';
      if (text && window.sendMessage) {
        window.sendMessage(text);
      }
    });
  }

  const btnModelTrigger = document.getElementById('btnModel');
  const btnThinkingTrigger = document.getElementById('btnThinking');
  const fusedBtn = btnModelTrigger ? btnModelTrigger.closest('.fused-model-thinking-btn') : null;

  // Click model text -> open model popover
  if (btnModelTrigger) {
    btnModelTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.togglePopover(fusedBtn || btnModelTrigger, 'modelPopover');
    });
  }

  // Click thinking text -> open dedicated thinkingPopover
  if (btnThinkingTrigger) {
    btnThinkingTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.togglePopover(fusedBtn || btnThinkingTrigger, 'thinkingPopover');
    });
  }

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

  const btnPermission = document.getElementById('btnPermission');
  if (btnPermission) {
    btnPermission.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.togglePopover(btnPermission, 'permissionPopover');
    });
  }

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
    const modelSpan = document.getElementById('btnModel');
    const thinkingSpan = document.getElementById('btnThinking');
    if (modelSpan) {
      modelSpan.innerText = activeModelName;
    }
    if (thinkingSpan) {
      thinkingSpan.innerText = activeEffortLevel;
    }
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
      const btnPerm = document.getElementById('btnPermission');
      if (btnPerm) {
        const labelSpan = btnPerm.querySelector('span');
        if (labelSpan) labelSpan.innerText = modeName;
        // Sync button color class (pure-mode-text-btn variants)
        allPermClasses.forEach(cls => btnPerm.classList.remove(cls));
        const newCls = permColorMap[modeName];
        if (newCls) btnPerm.classList.add(newCls);
      }

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
  const topShareBtn = document.getElementById('topShareBtn');
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

  if (topShareBtn) {
    topShareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      topShareBtn.style.color = 'var(--brand, #10b981)';
      setTimeout(() => {
        topShareBtn.style.color = '';
      }, 1200);
    });
  }

  // Toggle Right Workspace Panel
  function toggleSidePanel() {
    if (!chatAppLayout) return;
    chatAppLayout.classList.toggle('has-side-panel');
    
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
  const topSidebarBtn = document.getElementById('topSidebarBtn');
  const bcAgentCapsule = document.getElementById('bcAgentCapsule');

  function toggleSidebar(e) {
    if (e) e.stopPropagation();
    if (!chatAppLayout) return;
    chatAppLayout.classList.toggle('has-left-sidebar');
    if (window.syncComposerHorizontalAlignment) {
      setTimeout(window.syncComposerHorizontalAlignment, 50);
      setTimeout(window.syncComposerHorizontalAlignment, 230);
    }
    if (window.FlowTimelineRail && window.FlowTimelineRail.updateAll) {
      setTimeout(() => window.FlowTimelineRail.updateAll(document.body), 230);
    }
  }

  if (topSidebarBtn) topSidebarBtn.addEventListener('click', toggleSidebar);

  if (bcAgentCapsule) {
    bcAgentCapsule.addEventListener('click', (e) => {
      e.stopPropagation();
      bcAgentCapsule.classList.toggle('active');
      window.togglePopover(bcAgentCapsule, 'agentRuntimePopover');
    });
  }

  // ---- App Top Bar: Tab add/close & Window controls ----
  const topBarNewTabBtn = document.getElementById('topBarNewTabBtn');
  const tabCloseBtn = document.getElementById('tabCloseBtn');
  const tabsContainer = document.querySelector('.top-bar-tabs-container');

  if (topBarNewTabBtn && tabsContainer) {
    topBarNewTabBtn.addEventListener('click', () => {
      const tab = document.createElement('div');
      tab.className = 'session-tab-item active';
      tab.innerHTML = `
        <span class="tab-item-title">新对话</span>
        <button class="tab-item-close-btn" title="关闭标签页">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;
      // Deactivate siblings
      tabsContainer.querySelectorAll('.session-tab-item').forEach(t => t.classList.remove('active'));
      tabsContainer.insertBefore(tab, topBarNewTabBtn);

      tab.addEventListener('click', () => {
        tabsContainer.querySelectorAll('.session-tab-item').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      });

      tab.querySelector('.tab-item-close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        tab.remove();
        const remaining = tabsContainer.querySelectorAll('.session-tab-item');
        if (remaining.length > 0) remaining[remaining.length - 1].classList.add('active');
      });
    });
  }

  if (tabCloseBtn) {
    tabCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tab = document.getElementById('activeSessionTab');
      if (tab) tab.remove();
    });
  }

  // Window Controls Feedback
  const winMin = document.getElementById('winMinimizeBtn');
  const winMax = document.getElementById('winMaximizeBtn');
  const winClose = document.getElementById('winCloseBtn');
  if (winMin) winMin.addEventListener('click', () => console.log('Minimize window'));
  if (winMax) winMax.addEventListener('click', () => console.log('Toggle maximize window'));
  if (winClose) winClose.addEventListener('click', () => console.log('Close window'));
