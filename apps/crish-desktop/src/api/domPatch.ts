export function chunkUpdatesToDomPatches(container: HTMLElement, updates: any[], isInitial: boolean): any[] {
  const patches: any[] = [];
  for (const u of updates) {
    const existing = container.querySelector(`[data-chunk-id="${u.id}"]`);
    if (existing) {
      patches.push({ type: 'replace', selector: `[data-chunk-id="${u.id}"]`, html: u.html, id: u.id });
    } else {
      patches.push({ type: 'append', html: u.html, id: u.id });
    }
  }
  return patches;
}

export function applyDomPatches(container: HTMLElement, patches: any[]): void {
  for (const p of patches) {
    if (p.type === 'replace') {
      const el = container.querySelector(p.selector);
      if (el) el.outerHTML = `<span data-chunk-id="${p.id}">${p.html}</span>`;
    } else if (p.type === 'append') {
      container.insertAdjacentHTML('beforeend', `<span data-chunk-id="${p.id}">${p.html}</span>`);
    }
  }
}
