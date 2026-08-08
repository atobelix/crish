import * as fs from 'fs';

const file = 'src/components/HiddenInput.tsx';
let code = fs.readFileSync(file, 'utf8');

// Find the start of the Tab handler
const tabStart = code.indexOf("} else if (e.key === 'Tab') {");
const arrowUpStart = code.indexOf("} else if (e.key === 'ArrowUp') {");
const arrowDownStart = code.indexOf("} else if (e.key === 'ArrowDown') {");
const homeStart = code.indexOf("} else if (e.key === 'Home') {");

if (tabStart === -1 || arrowUpStart === -1 || arrowDownStart === -1 || homeStart === -1) {
    throw new Error("Could not find key handlers");
}

const tableHelper = `
    const handleTableNav = (e: React.KeyboardEvent, direction: 'left' | 'right' | 'up' | 'down') => {
      let lineStart = text.lastIndexOf('\\n', cursorPos - 1) + 1;
      let lineEnd = text.indexOf('\\n', cursorPos);
      if (lineEnd === -1) lineEnd = text.length;
      const lineStr = text.substring(lineStart, lineEnd);

      if (lineStr.trim().startsWith('|')) {
        // Find all pipe positions in the current line
        const pipes: number[] = [];
        for (let i = lineStart; i <= lineEnd; i++) {
          if (text[i] === '|' && (i === 0 || text[i-1] !== '\\\\')) {
            pipes.push(i);
          }
        }

        if (pipes.length >= 2) {
          // Find current cell index
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

            // Handle row wrapping
            if (nextCellIdx < 0 || direction === 'up') {
              // Go to previous row
              if (lineStart > 0) {
                let prevLineEnd = lineStart - 1;
                let prevLineStart = text.lastIndexOf('\\n', prevLineEnd - 1) + 1;
                let prevLineStr = text.substring(prevLineStart, prevLineEnd);
                
                // Skip separator row
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
              // Go to next row
              if (lineEnd < text.length) {
                let nextLineStart = lineEnd + 1;
                let nextLineEnd = text.indexOf('\\n', nextLineStart);
                if (nextLineEnd === -1) nextLineEnd = text.length;
                let nextLineStr = text.substring(nextLineStart, nextLineEnd);

                // Skip separator row
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
              
              // Select the text inside the cell, trimming whitespace
              let selStart = cellStart;
              let selEnd = cellEnd;
              while (selStart < selEnd && text[selStart] === ' ') selStart++;
              while (selEnd > selStart && text[selEnd - 1] === ' ') selEnd--;
              
              setSelection(selStart, selEnd);
            }
            return true;
          }
        }
      }
      return false;
    };
`;

const tabHandler = `} else if (e.key === 'Tab') {
      if (handleTableNav(e, e.shiftKey ? 'left' : 'right')) return;
`;

const arrowUpHandler = `} else if (e.key === 'ArrowUp') {
      if (!e.shiftKey && handleTableNav(e, 'up')) return;
      e.preventDefault();
`;

const arrowDownHandler = `} else if (e.key === 'ArrowDown') {
      if (!e.shiftKey && handleTableNav(e, 'down')) return;
      e.preventDefault();
`;

code = code.substring(0, tabStart) + 
       tableHelper + 
       tabHandler + 
       arrowUpHandler + 
       code.substring(arrowUpStart + 33, arrowDownStart) + 
       arrowDownHandler + 
       code.substring(arrowDownStart + 35);

fs.writeFileSync(file, code);
