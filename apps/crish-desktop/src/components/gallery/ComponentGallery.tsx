import React, { useState } from 'react';
import { SegmentedControl } from '../ui';
import styles from './ComponentGallery.module.css';
import {
  ModernJsonToolCall,
  ModernTerminalToolCall,
  ModernApprovalCard,
  ModernCodeBlock,
} from '../chat-tool-call';

interface ComponentItem {
  id: string;
  category: string;
  title: string;
  desc: string;
  badge?: string;
  render: () => React.ReactNode;
  usage: string;
}

export const ComponentGallery: React.FC = () => {
  const [activeId, setActiveId] = useState<string>('code-block');
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('light');

  const items: Record<string, ComponentItem> = {
    'code-block': {
      id: 'code-block',
      category: 'Text Outputs',
      title: 'Code Block',
      desc: 'A code block with a language label and one-click copy button.',
      badge: '截图 3',
      render: () => (
        <ModernCodeBlock
          filename="utils.ts"
          code={`export const sum = (a: number, b: number) =>\n  a + b;\n\nexport const clamp = (n: number, min: number, max: number) =>\n  Math.min(Math.max(n, min), max);`}
        />
      ),
      usage: `import { ModernCodeBlock } from '@/components/chat-tool-call';\n\n<ModernCodeBlock\n  filename="utils.ts"\n  code={sourceCode}\n/>`,
    },

    'json-tool': {
      id: 'json-tool',
      category: 'Tool & Action States',
      title: 'Structured JSON Tool',
      desc: '结构化工具调用（搜索、读写文件等）：单行折叠头 + 参数胶囊 + 完成态绿勾，展开呈现 Request 与 Result。',
      badge: '截图 1',
      render: () => (
        <ModernJsonToolCall
          actionText="Searched the docs"
          paramPill="draft persistence"
          request={{ query: 'draft persistence' }}
          result="3 matches, best hit /docs/runtime/drafts"
          status="success"
          defaultOpen={true}
        />
      ),
      usage: `import { ModernJsonToolCall } from '@/components/chat-tool-call';\n\n<ModernJsonToolCall\n  actionText="Searched the docs"\n  paramPill="draft persistence"\n  request={{ query: "draft persistence" }}\n  result="3 matches, best hit /docs/runtime/drafts"\n  status="success"\n/>`,
    },

    'term-tool': {
      id: 'term-tool',
      category: 'Tool & Action States',
      title: 'Terminal Command',
      desc: '终端命令行工具：$ 命令行 + 细线 + 原始等宽日志流 + 底部渐变淡出遮罩。',
      badge: '截图 2',
      render: () => (
        <ModernTerminalToolCall
          command="cargo test -p conex-session-loop -- --nocapture"
          output={`running 12 tests\ntest batcher::tests::test_batch_flush_interval ... ok\ntest batcher::tests::test_ring_buffer_overflow ... ok\ntest batcher::tests::test_batcher_capacity_reclaim ... ok\ntest batcher::tests::test_concurrent_flushes ... ok\ntest loop::tests::test_session_lifecycle ... ok`}
          status="success"
        />
      ),
      usage: `import { ModernTerminalToolCall } from '@/components/chat-tool-call';\n\n<ModernTerminalToolCall\n  command="cargo test -p conex-session-loop -- --nocapture"\n  output={testLogs}\n  status="success"\n/>`,
    },

    'approval-card': {
      id: 'approval-card',
      category: 'Tool & Action States',
      title: 'Approval Card',
      desc: '敏感高危系统命令确认卡片：纯净单层无嵌套黑白灰，仅针对高危命令执行时进行最小化授权确认。',
      render: () => (
        <ModernApprovalCard
          command="rm -rf ./target/release"
          summary="高危命令执行确认"
          onAllow={() => alert('已允许执行')}
          onDeny={() => alert('已拒绝')}
        />
      ),
      usage: `import { ModernApprovalCard } from '@/components/chat-tool-call';\n\n<ModernApprovalCard\n  command="rm -rf ./target/release"\n  summary="高危命令执行确认"\n  onAllow={() => handleAllow()}\n  onDeny={() => handleDeny()}\n/>`,
    },

    'text-response': {
      id: 'text-response',
      category: 'Text Outputs',
      title: 'Text Response',
      desc: '助手主文字回复段落，通透呼吸感，字号 14px，行高 1.6。',
      render: () => (
        <div style={{ fontSize: 14, lineHeight: 1.6, color: 'inherit' }}>
          我已经为你重构了底层会话循环，消除了跨窗口高频消息下发时的掉帧问题。所有核心状态转移均通过纯逻辑自动化测试验证。
        </div>
      ),
      usage: `// 标准助手文字回复流渲染`,
    },
  };

  const defaultItem: ComponentItem = items['code-block']!;
  const activeItem: ComponentItem = items[activeId] ?? defaultItem;

  const handleNavClick = (id: string) => {
    // 保护选区：若用户正在划词框选文本进行复制，不打断选区、不触发跳转
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    setActiveId(id);
  };

  return (
    <div className={styles.galleryRoot}>
      {/* 左侧侧边栏 (文字 100% 允许选中复制) */}
      <aside className={styles.sidebar}>
        <div className={styles.groupBlock}>
          <div className={styles.groupHeading}>Text Outputs</div>
          <ul className={styles.navList}>
            <li
              className={`${styles.navItem} ${activeId === 'code-block' ? styles.active : ''}`}
              onClick={() => handleNavClick('code-block')}
            >
              <span>Code Block</span>
              <span className={styles.navBadge}>截图 3</span>
            </li>
            <li
              className={`${styles.navItem} ${activeId === 'text-response' ? styles.active : ''}`}
              onClick={() => handleNavClick('text-response')}
            >
              <span>Text Response</span>
            </li>
          </ul>
        </div>

        <div className={styles.groupBlock}>
          <div className={styles.groupHeading}>Tool & Action States</div>
          <ul className={styles.navList}>
            <li
              className={`${styles.navItem} ${activeId === 'json-tool' ? styles.active : ''}`}
              onClick={() => handleNavClick('json-tool')}
            >
              <span>Structured JSON Tool</span>
              <span className={styles.navBadge}>截图 1</span>
            </li>
            <li
              className={`${styles.navItem} ${activeId === 'term-tool' ? styles.active : ''}`}
              onClick={() => handleNavClick('term-tool')}
            >
              <span>Terminal Command</span>
              <span className={styles.navBadge}>截图 2</span>
            </li>
            <li
              className={`${styles.navItem} ${activeId === 'approval-card' ? styles.active : ''}`}
              onClick={() => handleNavClick('approval-card')}
            >
              <span>Approval Card</span>
            </li>
          </ul>
        </div>
      </aside>

      {/* 右侧展示台 */}
      <main className={styles.mainContent}>
        <div className={styles.crumbs}>
          <span>Components</span>
          <span>/</span>
          <span className={styles.crumbActive}>{activeItem.category}</span>
        </div>

        <h1 className={styles.title}>{activeItem.title}</h1>
        <p className={styles.desc}>{activeItem.desc}</p>

        {/* 预览控制条 */}
        <div className={styles.previewBar}>
          <span className={styles.previewLabel}>Preview</span>
          <SegmentedControl
            size="sm"
            value={themeMode}
            onChange={(val) => setThemeMode(val as 'light' | 'dark')}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            aria-label="主题切换"
          />
        </div>

        {/* 画布 */}
        <div
          className={`${styles.canvas} ${themeMode === 'light' ? styles.themeLight : styles.themeDark}`}
        >
          <div className={styles.canvasInner}>
            {activeItem.render()}
          </div>
        </div>

        {/* 用法代码 */}
        <div className={styles.usageWrap}>
          <div className={styles.usageLabel}>React Usage</div>
          <pre className={styles.codeBox}>
            <code>{activeItem.usage}</code>
          </pre>
        </div>
      </main>
    </div>
  );
};
