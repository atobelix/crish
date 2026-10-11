export interface IncrementalMarkdownFenceState {
  fenceChar: '`' | '~' | null;
  fenceLineProbe: string;
  fenceLineStart: boolean;
  lineStart: boolean;
}

export interface IncrementalMarkdownFenceCallbacks {
  appendCodeText: (value: string) => void;
  closeCode: () => void;
}

/** 扫描围栏正文的增量状态机；正文按新增字符转义后立即交给当前 code 单元。 */
export function consumeIncrementalMarkdownFence(
  state: IncrementalMarkdownFenceState,
  input: string,
  start: number,
  callbacks: IncrementalMarkdownFenceCallbacks
): number | null {
  let index = start;
  while (index < input.length) {
    const current = input[index]!;
    if (state.fenceLineStart) {
      if (current === state.fenceChar) {
        state.fenceLineProbe += current;
        index += 1;
        continue;
      }
      if (state.fenceLineProbe.length > 0) {
        if (current === ' ' || current === '\t') {
          state.fenceLineProbe += current;
          index += 1;
          continue;
        }
        if (current === '\n') {
          if (state.fenceLineProbe.length >= 3) {
            callbacks.closeCode();
            state.fenceChar = null;
            state.lineStart = true;
            state.fenceLineStart = true;
            state.fenceLineProbe = '';
            index += 1;
            return index;
          }
          callbacks.appendCodeText(state.fenceLineProbe);
          state.fenceLineProbe = '';
          state.fenceLineStart = false;
          callbacks.appendCodeText('\n');
          state.fenceLineStart = true;
          index += 1;
          continue;
        }
        callbacks.appendCodeText(state.fenceLineProbe);
        state.fenceLineProbe = '';
        state.fenceLineStart = false;
        continue;
      }
      if (current === '\n') {
        callbacks.appendCodeText('\n');
        index += 1;
        continue;
      }
      state.fenceLineStart = false;
    }

    if (current === '\n') {
      callbacks.appendCodeText('\n');
      index += 1;
      state.fenceLineStart = true;
      state.fenceLineProbe = '';
      continue;
    }

    let end = index + 1;
    while (end < input.length && input[end] !== '\n') end += 1;
    callbacks.appendCodeText(input.slice(index, end));
    index = end;
    if (index < input.length && input[index] === '\n') {
      callbacks.appendCodeText('\n');
      index += 1;
      state.fenceLineStart = true;
      state.fenceLineProbe = '';
    }
  }
  return null;
}
