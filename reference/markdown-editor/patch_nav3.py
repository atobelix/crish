import os

file_path = 'src/components/HiddenInput.tsx'
with open(file_path, 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Remove updateActiveElements import
code = code.replace(
    "  getArrowNavigationIndex,\n  updateActiveElements,\n}",
    "  getArrowNavigationIndex,\n}"
)

# 2. Remove updateActiveElements call
code = code.replace(
    """    // Sync physical coordinates whenever cursor or text changes
    if (!containerRef.current) return;
    updateActiveElements(
      containerRef.current,
      cursorPos,
      selectionStart,
      selectionEnd
    );""",
    """    // Sync physical coordinates whenever cursor or text changes
    if (!containerRef.current) return;"""
)

# 3. Add handleTableNav before handleKeyDown
tableNavFunc = """
  const handleTableNav = (e: React.KeyboardEvent, direction: 'left' | 'right' | 'up' | 'down', text: string, cursorPos: number): boolean => {
      let lineStart = text.lastIndexOf('\\n', cursorPos - 1) + 1;
      let lineEnd = text.indexOf('\\n', cursorPos);
      if (lineEnd === -1) lineEnd = text.length;
      const lineStr = text.substring(lineStart, lineEnd);

      if (lineStr.trim().startsWith('|')) {
        const pipes: number[] = [];
        for (let i = lineStart; i <= lineEnd; i++) {
          if (text[i] === '|' && (i === 0 || text[i-1] !== '\\\\')) pipes.push(i);
        }

        if (pipes.length >= 2) {
          let currentCellIdx = -1;
          for (let i = 0; i < pipes.length - 1; i++) {
            if (cursorPos >= pipes[i] && cursorPos <= pipes[i+1]) {
              currentCellIdx = i;
              break;
            }
          }

          if (currentCellIdx !== -1) {
            e.preventDefault();
            let nextCellIdx = currentCellIdx;
            if (direction === 'left') nextCellIdx--;
            if (direction === 'right') nextCellIdx++;
            
            let targetLineStart = lineStart;
            let targetLineEnd = lineEnd;
            let targetPipes = pipes;

            if (nextCellIdx < 0 || direction === 'up') {
              if (lineStart > 0) {
                let prevLineEnd = lineStart - 1;
                let prevLineStart = text.lastIndexOf('\\n', prevLineEnd - 1) + 1;
                let prevLineStr = text.substring(prevLineStart, prevLineEnd);
                
                if (prevLineStr.replace(/[-:| ]/g, '').length === 0 && prevLineStart > 0) {
                  prevLineEnd = prevLineStart - 1;
                  prevLineStart = text.lastIndexOf('\\n', prevLineEnd - 1) + 1;
                  prevLineStr = text.substring(prevLineStart, prevLineEnd);
                }

                if (prevLineStr.trim().startsWith('|')) {
                  targetLineStart = prevLineStart;
                  targetLineEnd = prevLineEnd;
                  targetPipes = [];
                  for (let i = targetLineStart; i <= targetLineEnd; i++) {
                    if (text[i] === '|' && (i === 0 || text[i-1] !== '\\\\')) targetPipes.push(i);
                  }
                  if (direction === 'left') nextCellIdx = Math.max(0, targetPipes.length - 2);
                  if (direction === 'up') nextCellIdx = Math.min(nextCellIdx, targetPipes.length - 2);
                } else if (direction === 'left' || direction === 'right') {
                    return true;
                }
              }
            } else if (nextCellIdx >= pipes.length - 1 || direction === 'down') {
              if (lineEnd < text.length) {
                let nextLineStart = lineEnd + 1;
                let nextLineEnd = text.indexOf('\\n', nextLineStart);
                if (nextLineEnd === -1) nextLineEnd = text.length;
                let nextLineStr = text.substring(nextLineStart, nextLineEnd);

                if (nextLineStr.replace(/[-:| ]/g, '').length === 0 && nextLineEnd < text.length) {
                  nextLineStart = nextLineEnd + 1;
                  nextLineEnd = text.indexOf('\\n', nextLineStart);
                  if (nextLineEnd === -1) nextLineEnd = text.length;
                  nextLineStr = text.substring(nextLineStart, nextLineEnd);
                }

                if (nextLineStr.trim().startsWith('|')) {
                  targetLineStart = nextLineStart;
                  targetLineEnd = nextLineEnd;
                  targetPipes = [];
                  for (let i = targetLineStart; i <= targetLineEnd; i++) {
                    if (text[i] === '|' && (i === 0 || text[i-1] !== '\\\\')) targetPipes.push(i);
                  }
                  if (direction === 'right') nextCellIdx = 0;
                  if (direction === 'down') nextCellIdx = Math.min(nextCellIdx, targetPipes.length - 2);
                } else if (direction === 'left' || direction === 'right') {
                    return true;
                }
              }
            }

            if (nextCellIdx >= 0 && nextCellIdx < targetPipes.length - 1) {
              const cellStart = targetPipes[nextCellIdx] + 1;
              const cellEnd = targetPipes[nextCellIdx + 1];
              let selStart = cellStart;
              let selEnd = cellEnd;
              while (selStart < selEnd && text[selStart] === ' ') selStart++;
              while (selEnd > selStart && text[selEnd - 1] === ' ') selEnd--;
              
              const store = useEditorStore.getState();
              store.setSelection(selStart, selEnd);
            }
            return true;
          }
        }
      }
      return false;
    };
"""

code = code.replace(
    "const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {",
    tableNavFunc + "\n  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {"
)

# 4. Modify Enter
code = code.replace(
    "} else if (e.key === 'Enter') {\n      e.preventDefault();\n      if (isComposing) return;\n      insertText('\\n');",
    "} else if (e.key === 'Enter') {\n      e.preventDefault();\n      if (isComposing) return;\n      let lineStart = text.lastIndexOf('\\n', cursorPos - 1) + 1;\n      let lineEnd = text.indexOf('\\n', cursorPos);\n      if (lineEnd === -1) lineEnd = text.length;\n      const lineStr = text.substring(lineStart, lineEnd);\n      if (lineStr.trim().startsWith('|')) {\n        insertText('<br>');\n      } else {\n        insertText('\\n');\n      }"
)

# 5. Insert Tab handler before ArrowUp
tabHandler = """} else if (e.key === 'Tab') {
      if (handleTableNav(e, e.shiftKey ? 'left' : 'right', text, cursorPos)) return;
    """

code = code.replace("} else if (e.key === 'ArrowUp') {", tabHandler + "} else if (e.key === 'ArrowUp') {")

# 6. Modify ArrowUp and ArrowDown
code = code.replace(
    "} else if (e.key === 'ArrowUp') {\n      e.preventDefault();",
    "} else if (e.key === 'ArrowUp') {\n      if (!e.shiftKey && handleTableNav(e, 'up', text, cursorPos)) return;\n      e.preventDefault();"
)

code = code.replace(
    "} else if (e.key === 'ArrowDown') {\n      e.preventDefault();",
    "} else if (e.key === 'ArrowDown') {\n      if (!e.shiftKey && handleTableNav(e, 'down', text, cursorPos)) return;\n      e.preventDefault();"
)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(code)
