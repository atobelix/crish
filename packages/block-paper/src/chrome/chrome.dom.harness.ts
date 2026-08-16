/**
 * W3-F DOM 余量测夹具（仅测用，不进生产 barrel）。
 *
 * **≠ EL-01**；**≠** 占 SD-48。
 */

export const ID_A = 'block-dom-a';
export const ID_B = 'block-dom-b';
export const ID_C = 'block-dom-c';

export function requireDocument(): Document {
  if (typeof document === 'undefined' || !document.createElement) {
    throw new Error('jsdom document 不可用');
  }
  return document;
}
