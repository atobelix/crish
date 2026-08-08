import { create } from 'zustand';
import { createEditorStore } from '../../src/core/EditorStore';

const useStore = create(createEditorStore);

// Initialize store with some text
useStore.getState().setText('# 高性能 Markdown 渲染引擎全面压力测试\n> 当前渲染规模: 1000 行。');

console.log('--- Initial State ---');
console.log('cursor:', useStore.getState().cursorPos);
console.log('text:', useStore.getState().getText().substring(0, 50));

// Move cursor
useStore.getState().setCursorPos(5);
console.log('--- After setCursorPos(5) ---');
console.log('cursor:', useStore.getState().cursorPos);
console.log('selStart:', useStore.getState().selectionStart);
console.log('selEnd:', useStore.getState().selectionEnd);

// Insert text
console.log('--- Calling insertText("H") ---');
useStore.getState().insertText('H');
console.log('cursor:', useStore.getState().cursorPos);
console.log('selStart:', useStore.getState().selectionStart);
console.log('selEnd:', useStore.getState().selectionEnd);

console.log('--- Final Text ---');
console.log(useStore.getState().getText().substring(0, 50));
