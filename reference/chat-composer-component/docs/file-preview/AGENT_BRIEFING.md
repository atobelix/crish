# File Preview — Agent 简报

复制到子 agent 提示词开头。

---

## 你是谁

你在 `reference/chat-composer-component` 上实现 **文件预览系统**。  
真相源是 `docs/file-preview/`，尤其是 **CROSSCUTTING.md**。

---

## 硬规则

1. **先读** `docs/file-preview/CROSSCUTTING.md` 与本 Phase 对应文档。  
2. **不要**再往 `preview-modal.js` 无底堆逻辑；新代码进 `js/file-preview/`。  
3. **禁止**假 PDF / 假 Word 内容冒充解析成功。  
4. Markdown 查看态：**复用** `js/markdown-editor`，`readOnly`/`viewOnly`，界面 **不写**「只读」「预览模式」。  
5. 动效：完整弧线、略快（约 160–280ms）、无阴影动画、尊重 `prefers-reduced-motion`。  
6. 中文注释与 UI 字符串用安全写入（apply_patch / Write）；改完可抽查编码。  
7. 范围 crope：只做本 Phase 文件清单；不做 desktop 迁移除非 Phase 写明。  
8. 依赖按需加载；勿把 pdf.js 打进同步首屏。  

---

## 目录约定

```
js/file-preview/
  index.js              # openPreview / closePreview 公共 API
  shell/PreviewShell.js
  router/PreviewRouter.js
  model/types.js
  adapters/*.js
  viewers/*.js
  toolbar/Toolbar.js
  motion/transitions.js

css/file-preview/
  tokens.css
  shell.css
  toolbar.css
  viewers/*.css
  motion.css
```

旧 `js/preview-modal.js` / `css/preview-modal.css`：过渡期可 re-export，最终删除或变薄适配层。

---

## Definition of Done（单 Phase）

- [ ] 对应格式可打开真实/ fixture 文件  
- [ ] 失败有降级 UI  
- [ ] 无控制台 error  
- [ ] 动效不抖、不卡滚动  
- [ ] 与 CROSSCUTTING 无冲突  
- [ ] 中文无乱码  

---

## 不要做

- 不要加「预览 | 源码」硬切换  
- 不要给每个格式复制一套 modal 壳  
- 不要在对话流里嵌完整 IDE  
- 不要为了高级感加彩色大阴影  
