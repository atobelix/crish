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
      const tab = { id: 'tab-' + Date.now(), title: '新会话 ' + (leaf.tabs.length + 1) };
      leaf.tabs.push(tab);
      leaf.activeTabId = tab.id;
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
      this._rmTab(this.tree, srcId, tab.id);
      this._prune(this.tree);

      if (region === 'center' || region === 'strip') {
        const target = this.findLeaf(this.tree, dstId) || this.firstLeaf();
        if (target) {
          const idx = (insertIdx >= 0 && insertIdx <= target.tabs.length) ? insertIdx : target.tabs.length;
          target.tabs.splice(idx, 0, tab);
          target.activeTabId = tab.id;
        }
      } else {
        const target = this.findLeaf(this.tree, dstId);
        if (target) {
          this._split(this.tree, dstId, tab, region);
        } else {
          const fallback = this.firstLeaf();
          if (fallback) { fallback.tabs.push(tab); fallback.activeTabId = tab.id; }
        }
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
      this._foreignStrip = null;
      this._cachedTabRects = null;
      this._lastStateKey = null;
      this._currentMode = null;
    }

    start(e, srcPaneId, tab, idx, srcStrip) {
      if (e.button !== 0 || e.target.closest('.tab-item-close-btn')) return;

      this._draggedTab = tab;
      const sx = e.clientX, sy = e.clientY;
      const allTabs = Array.from(srcStrip.querySelectorAll('.session-tab-item'));
      const dragged = allTabs[idx] || e.currentTarget;
      if (!dragged) return;

      const leaf = this.store.findLeaf(this.store.tree, srcPaneId);
      if (!leaf) return;

      let mode = 'idle';
      let cleaned = false;
      document.body.style.userSelect = 'none';

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        dragged.classList.remove('is-dragging');
        if (this._indicator) { this._indicator.remove(); this._indicator = null; }
        this._leaveStrip();
        this._target = null;
        this._lastStateKey = null;
        this._currentMode = null;
        this._draggedTab = null;
      };

      const onMove = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (mode === 'idle' && (Math.abs(dx) + Math.abs(dy)) < 4) return;

        if (mode === 'idle') {
          mode = 'drag';
          dragged.classList.add('is-dragging');
        }

        if (!this._indicator) this._indicator = this._createIndicator();
        this._updateTarget(ev.clientX, ev.clientY, srcStrip);
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
        if (paneId === srcPaneId && leaf.tabs.length <= 1 && region === 'center') {
          this.store.activateTab(srcPaneId, tab.id);
          return;
        }

        this.store.executeSplit(srcPaneId, tab, paneId, region, insertIdx);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    _createIndicator() {
      const d = document.createElement('div');
      d.className = 'tree-drop-indicator';
      document.body.appendChild(d);
      return d;
    }

    _enterStrip(strip) {
      if (this._foreignStrip === strip && this._cachedTabRects) return;
      this._leaveStrip();
      this._foreignStrip = strip;
      this._cachedTabRects = Array.from(strip.querySelectorAll('.session-tab-item:not(.is-dragging):not(.is-leaving)')).map(t => {
        const r = t.getBoundingClientRect();
        const tx = new WebKitCSSMatrix(getComputedStyle(t).transform).m41 || 0;
        return { left: r.left - tx, right: r.right - tx, width: r.width, el: t };
      });
    }

    _leaveStrip() {
      if (this._foreignStrip) {
        this._foreignStrip.querySelectorAll('.session-tab-item').forEach(t => {
          t.style.transform = '';
          t.style.transition = '';
        });
      }
      this._foreignStrip = null;
      this._cachedTabRects = null;
      this._lastStateKey = null;
    }

    _updateTarget(cx, cy, srcStrip) {
      const ind = this._indicator;
      if (!ind) return;

      const hit = document.elementFromPoint(cx, cy);
      const strip = hit ? hit.closest('.top-bar-tabs-container') : null;

      if (this._foreignStrip && this._foreignStrip !== strip) {
        this._leaveStrip();
      }

      if (strip && (strip.dataset.paneId || strip.closest('.app-top-bar'))) {
        const paneId = strip.dataset.paneId || 'pane-main';
        this._handleStripDrop(cx, strip, paneId, ind);
        return;
      }

      this._handlePaneDrop(cx, cy, ind);
    }

    _handleStripDrop(cx, strip, paneId, ind) {
      this._enterStrip(strip);
      const tabRects = this._cachedTabRects || [];
      const insertIdx = this._computeInsertIndex(tabRects, cx);
      const shiftW = 150;

      const stateKey = `strip:${paneId}:${insertIdx}`;
      if (this._lastStateKey !== stateKey) {
        this._lastStateKey = stateKey;
        tabRects.forEach((r, i) => {
          r.el.style.transition = 'transform 180ms cubic-bezier(.2,0,0,1)';
          r.el.style.transform = i >= insertIdx ? `translateX(${shiftW + 4}px)` : '';
        });
      }

      const scrollRect = strip.getBoundingClientRect();
      const indicatorW = 150;
      const minX = scrollRect.left + 2;
      const maxX = scrollRect.right - indicatorW - 2;
      const lineX = Math.max(minX, Math.min(cx - indicatorW / 2, maxX));

      const title = this._draggedTab ? this._draggedTab.title : '放置标签';
      ind.innerHTML = `<span style="font-size:12px;font-weight:500;color:var(--brand-primary,#10b981);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 8px;max-width:100%;pointer-events:none;">${title}</span>`;
      ind.style.display = 'flex';
      ind.style.alignItems = 'center';
      ind.style.justifyContent = 'flex-start';
      ind.style.borderRadius = '4px';

      const enteringStrip = this._currentMode !== 'strip';
      this._currentMode = 'strip';
      if (enteringStrip) {
        ind.style.transition = 'left 120ms cubic-bezier(.2,0,0,1), top 120ms cubic-bezier(.2,0,0,1), width 120ms cubic-bezier(.2,0,0,1), height 120ms cubic-bezier(.2,0,0,1), border-radius 100ms ease, opacity 80ms ease';
      } else {
        ind.style.transition = 'border-radius 100ms ease, opacity 80ms ease';
      }

      this._posInd(ind, lineX, scrollRect.top + (scrollRect.height - 26) / 2, indicatorW, 26);
      this._target = { paneId, region: 'center', insertIdx };
    }

    _handlePaneDrop(cx, cy, ind) {
      this._leaveStrip();
      const panes = Array.from(document.querySelectorAll('.tree-leaf-pane, #chatMainPane'));

      for (const pane of panes) {
        const r = pane.getBoundingClientRect();
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;

        const rx = (cx - r.left) / r.width;
        const ry = (cy - r.top) / r.height;
        let region = 'center';
        if (rx < 0.25) region = 'left';
        else if (rx > 0.75) region = 'right';
        else if (ry < 0.25) region = 'top';
        else if (ry > 0.75) region = 'bottom';

        const paneId = pane.dataset.paneId || 'pane-main';
        const stateKey = `pane:${paneId}:${region}`;
        if (this._lastStateKey === stateKey) return;
        this._lastStateKey = stateKey;

        this._target = { paneId, region, insertIdx: -1 };

        ind.style.display = 'flex';
        ind.style.alignItems = 'center';
        ind.style.justifyContent = 'center';
        ind.style.borderRadius = '6px';
        this._currentMode = 'pane';
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
        return;
      }

      this._target = null;
      this._lastStateKey = null;
      if (ind) ind.style.display = 'none';
    }

    _computeInsertIndex(tabRects, cx) {
      for (let i = 0; i < tabRects.length; i++) {
        const r = tabRects[i];
        const leftThird = r.left + r.width / 3;
        const rightThird = r.left + r.width * 2 / 3;
        if (cx < leftThird) return i;
        if (cx < rightThird) return cx < r.left + r.width / 2 ? i : i + 1;
      }
      return tabRects.length;
    }

    _posInd(el, l, t, w, h) {
      el.style.left = l + 'px';
      el.style.top = t + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
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

      if (window.syncComposerHorizontalAlignment) {
        setTimeout(window.syncComposerHorizontalAlignment, 50);
      }
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

      // 1. Header with Dynamic Tab Strip
      const hdr = document.createElement('div');
      hdr.className = 'tree-pane-header';

      // Reserve space for floating overlay controls on top row
      if (flags.topRow && flags.leftEdge) {
        const isCollapsed = document.getElementById('chatLeftSidebar')?.classList.contains('collapsed');
        hdr.style.paddingLeft = isCollapsed ? '38px' : '0px';
      }
      if (flags.topRow && flags.rightEdge) {
        hdr.style.paddingRight = '120px';
      }

      const strip = document.createElement('div');
      strip.className = 'top-bar-tabs-container';
      strip.dataset.paneId = node.id;

      node.tabs.forEach((tab, i) => {
        const tabEl = document.createElement('div');
        tabEl.className = 'session-tab-item' + (tab.id === node.activeTabId ? ' active' : '');
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
            this.store.removeTab(node.id, tab.id);
          } else {
            this.store.activateTab(node.id, tab.id);
          }
        });

        tabEl.addEventListener('mousedown', (e) => {
          this.drag.start(e, node.id, tab, i, strip);
        });

        strip.appendChild(tabEl);
      });

      const addBtn = document.createElement('button');
      addBtn.className = 'top-bar-new-tab-btn';
      addBtn.title = '新建标签页';
      addBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
      addBtn.addEventListener('click', () => this.store.addTab(node.id));
      strip.appendChild(addBtn);

      hdr.appendChild(strip);
      leafEl.appendChild(hdr);

      // 2. Content with Conversation View ("重构 IPC 缓冲通道")
      const content = document.createElement('div');
      content.className = 'tree-pane-content';

      if (node.id === 'pane-main' || !this.store.findLeaf(this.store.tree, 'pane-main')) {
        content.appendChild(mainPane);
        mainPane.style.display = 'flex';
        mainPane.style.flex = '1 1 0';
        mainPane.style.height = '100%';
      } else {
        const streamClone = mainPane.cloneNode(true);
        streamClone.id = 'paneChat-' + node.id;
        streamClone.style.display = 'flex';
        streamClone.style.flex = '1 1 0';
        streamClone.style.height = '100%';
        content.appendChild(streamClone);
      }
      leafEl.appendChild(content);

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
        document.body.style.userSelect = 'none';

        const isH = node.direction === 'horizontal';
        document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
        const rect = branchEl.getBoundingClientRect();

        const onMove = (ev) => {
          let raw = isH
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;

          raw = Math.max(0.12, Math.min(0.88, raw));
          leftEl.style.flex = String(raw);
          rightEl.style.flex = String(1 - raw);
          node.ratio = raw;

          if (window.syncComposerHorizontalAlignment) {
            window.syncComposerHorizontalAlignment();
          }
        };

        const onUp = (ev) => {
          handle.releasePointerCapture(ev.pointerId);
          handle.classList.remove('active');
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
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
  const expandSidebarBtn = document.getElementById('expandSidebarBtn');
  const collapsedToggleRail = document.getElementById('collapsedToggleRail');

  function toggleSidebar() {
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    if (chatAppLayout) {
      chatAppLayout.classList.toggle('has-left-sidebar', !isCollapsed);
    }
    if (collapsedToggleRail) {
      collapsedToggleRail.style.display = isCollapsed ? 'flex' : 'none';
    }
    const leftmostHdr = document.querySelector('.tree-leaf-pane.top-row.left-edge > .tree-pane-header');
    if (leftmostHdr) {
      leftmostHdr.style.paddingLeft = isCollapsed ? '44px' : '0px';
    }
    if (window.syncComposerHorizontalAlignment) {
      setTimeout(window.syncComposerHorizontalAlignment, 50);
    }
  }

  if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', toggleSidebar);
  if (expandSidebarBtn) expandSidebarBtn.addEventListener('click', toggleSidebar);
  const topSidebarBtn = document.getElementById('topSidebarBtn');
  if (topSidebarBtn) topSidebarBtn.addEventListener('click', toggleSidebar);

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

