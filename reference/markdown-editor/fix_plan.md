# Editor Snappiness & Click Fix Plan

## Issue 1: Empty Line Clicks
**Root Cause**: `caretRangeFromPoint` returns the container node when clicking an empty line, which our `while` loop fails to match to a `[data-token-start]`.
**Fix**: 
In `handleContainerClick`:
1. Use `caretRangeFromPoint` to find the exact character offset if clicking on text.
2. If it misses or hits the line container `[data-index]`, we look at `e.target`. We traverse up to find `[data-index]`.
3. Once we have the `lineIndex`, we calculate the absolute text index for the start of that line.
4. If clicking on an empty space at the end of the line, we set cursor to `lineStart + line.length`.

## Issue 2: Cursor Latency ("Sluggishness")
**Root Cause**: 
Typing -> Updates `text` -> Posts to Web Worker -> Worker parses 100,000 lines -> Posts back AST -> React renders -> Cursor measures DOM.
This async roundtrip takes 30-80ms, causing noticeable input lag.

**Fix (Synchronous Viewport Parsing)**:
Since we are virtualizing, we only render ~40 lines.
1. Remove the Web Worker! It's overkill and adds async IPC latency.
2. `MarkdownParser` should parse a *single line* instantly on the main thread.
3. In `MarkdownEngine`, we split the `text` into `lines = text.split('\n')`.
4. We pass `lines.length` to the virtualizer.
5. In the virtualizer loop, for each visible `virtualRow`, we take `lines[virtualRow.index]`. We call `MarkdownParser.parseNormalLine` *synchronously*.
6. This takes <1ms for 40 lines. The DOM updates instantly in the same React render cycle.
7. To handle multi-line contexts (like Code Blocks), we pre-compute an array `codeBlockState: boolean[]` for all lines. Scanning 100,000 lines for ```` takes <2ms on the main thread.

## Issue 3: Cursor React State Lag
**Root Cause**: `CursorLayer` relies on React `useEffect` to move the physical cursor, adding a 1-frame (16ms) delay after the DOM commits.
**Fix**:
In `HiddenInput.tsx`, attach a raw `ref` to the cursor DOM element. When Arrow Keys are pressed, update `cursorPos` in store AND synchronously mutate the cursor DOM style (`cursorRef.current.style.left = ...`) using `measure.ts`. This provides 0ms latency for cursor navigation.
