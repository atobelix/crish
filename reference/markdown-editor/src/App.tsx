import { useEffect } from 'react';
import { useEditorStore } from './core/EditorStore';
import { MarkdownEngine } from './components/MarkdownEngine';
import testDoc from './assets/test-document.md?raw';
import './index.css';

function App() {
  const textLength = useEditorStore(state => state.textLength);
  const setText = useEditorStore(state => state.setText);

  useEffect(() => {
    // Generate massive markdown by repeating the test document 100 times
    // This gives us roughly 15,000 lines for heavy performance testing
    const chunks = [];
    chunks.push(`# 高性能 Markdown 渲染引擎全面压力测试\n\n> 当前渲染规模: ${100} 个副本。本测试用例文档已全面穷举，覆盖 Markdown 所有基础语法与极端解析场景。\n\n---\n`);
    for (let i = 0; i < 100; i++) {
        chunks.push(testDoc);
    }
    const massiveDoc = chunks.join('\n');
    setText(massiveDoc);
  }, [setText]);

  return (
    <div className="grid-paper">
      {textLength > 0 ? (
        <MarkdownEngine />
      ) : (
        <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
          <h2>生成万行超大文档...</h2>
        </div>
      )}
    </div>
  );
}

export default App;
