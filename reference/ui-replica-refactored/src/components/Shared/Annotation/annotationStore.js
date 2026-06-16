/**
 * AnnotationStore — persistent annotation storage.
 * Supports file_line, chat_message annotations.
 * Backed by localStorage with structured JSON.
 */
const STORAGE_KEY = 'mycodex_annotations';

let annotations = [];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    annotations = raw ? JSON.parse(raw) : [];
  } catch { annotations = []; }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations)); } catch {}
}

load();

export const AnnotationStore = {
  getAll() { return [...annotations]; },

  getByTarget(target) {
    return annotations.filter(a => a.target === target);
  },

  add({ type, target, text, comment, source = 'user' }) {
    const annotation = {
      id: 'ann-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type,
      target,
      text,
      comment,
      source,
      timestamp: Date.now()
    };
    annotations.push(annotation);
    save();
    return annotation;
  },

  remove(id) {
    annotations = annotations.filter(a => a.id !== id);
    save();
  },

  update(id, updates) {
    const idx = annotations.findIndex(a => a.id === id);
    if (idx !== -1) {
      annotations[idx] = { ...annotations[idx], ...updates };
      save();
    }
  },

  getBySource(source) {
    return annotations.filter(a => a.source === source);
  }
};
