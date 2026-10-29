import { highlightCode } from '../api/codeHighlight';
import { StreamingCodeHighlighter } from '../api/streamingCodeHighlighter';
import type { WorkerRequest, WorkerResponse } from './types';

const streamingHighlighters = new Map<string, StreamingCodeHighlighter>();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = e.data;
  const t0 = performance.now();

  try {
    switch (type) {
      case 'highlight.code': {
        const { code, language } = payload as {
          code: string;
          language?: string;
        };
        const html = highlightCode(code, language);
        self.postMessage({
          id,
          type: 'success',
          payload: { html, language: language || '' },
          metrics: {
            wallTime: performance.now() - t0,
            cpuTime: 0,
            transferredBytes: html.length,
          },
        } as WorkerResponse);
        break;
      }

      case 'highlight.batch': {
        const { items } = payload as {
          items: Array<{ id: string; code: string; language?: string }>;
        };
        const results = items.map((item) => ({
          id: item.id,
          html: highlightCode(item.code, item.language),
        }));
        self.postMessage({
          id,
          type: 'success',
          payload: { results },
          metrics: {
            wallTime: performance.now() - t0,
            cpuTime: 0,
            transferredBytes: 0,
          },
        } as WorkerResponse);
        break;
      }

      case 'highlight.code.stream': {
        const { streamId, code, language } = payload as {
          streamId: string;
          code: string;
          language?: string;
        };
        let hl = streamingHighlighters.get(streamId);
        if (!hl) {
          hl = new StreamingCodeHighlighter(language || '');
          streamingHighlighters.set(streamId, hl);
        }
        const result = hl.push(code);
        self.postMessage({
          id,
          type: 'success',
          payload: { html: result, language: language || '' },
          metrics: {
            wallTime: performance.now() - t0,
            cpuTime: 0,
            transferredBytes: result.length,
          },
        } as WorkerResponse);
        break;
      }

      case 'highlight.code.stream.reset': {
        const { streamId } = payload as { streamId: string };
        streamingHighlighters.delete(streamId);
        self.postMessage({
          id,
          type: 'success',
          payload: null,
          metrics: {
            wallTime: performance.now() - t0,
            cpuTime: 0,
            transferredBytes: 0,
          },
        } as WorkerResponse);
        break;
      }

      case 'ping': {
        self.postMessage({
          id,
          type: 'success',
          payload: 'pong',
          metrics: {
            wallTime: performance.now() - t0,
            cpuTime: 0,
            transferredBytes: 0,
          },
        } as WorkerResponse);
        break;
      }

      default: {
        self.postMessage({
          id,
          type: 'error',
          payload: `Unknown render task type: ${type}`,
        } as WorkerResponse);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, type: 'error', payload: msg } as WorkerResponse);
  }
};
