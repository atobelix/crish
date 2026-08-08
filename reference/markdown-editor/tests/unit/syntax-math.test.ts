import { LineOffsetTree } from '../../src/core/SegmentTree';
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/core/EditorStore';
import { MarkdownParser } from '../../src/core/parser';

describe('Math Syntax State Cross-Test', () => {
  beforeEach(() => {
    useEditorStore.setState({
      lines: [''],
      lineOffsets: new LineOffsetTree([0]),
      codeBlockState: [],
      textLength: 0,
      cursorPos: 0,
      selectionStart: 0,
      selectionEnd: 0,
      undoStack: [],
      redoStack: [],
    });
  });

  it('should not parse markdown inside math block', () => {
    const store = useEditorStore.getState();
    store.insertText('$$\n# Heading in Math\n$$');

    const state = useEditorStore.getState();
    // L1 is `# Heading in Math`
    // According to EditorStore, is it code?
    const isCode = state.codeBlockState[1];

    // Parse it using the engine's exact call
    const lineNode = MarkdownParser.parseLine(
      state.lines[1],
      state.lineOffsets.getOffset(1),
      isCode
    );

    // If it was parsed as a heading, then we have a bug! Math blocks should NOT have markdown formatting inside them.
    expect(lineNode.type).not.toBe('heading');
  });
});
