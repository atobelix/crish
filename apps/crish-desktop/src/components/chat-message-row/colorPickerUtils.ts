export interface PinColorOption {
  label: string;
  value: string;
}

export const DEFAULT_PIN_COLOR = '#10b981';

export const PRESET_PIN_COLORS: PinColorOption[] = [
  { label: '翡翠绿', value: '#10b981' },
  { label: '晴空蓝', value: '#0ea5e9' },
  { label: '珊瑚红', value: '#f43f5e' },
  { label: '琥珀金', value: '#f59e0b' },
  { label: '罗兰紫', value: '#8b5cf6' },
  { label: '玫瑰粉', value: '#ec4899' },
];

export function hsvToHex(h: number, s: number, v: number): string {
  const sNorm = Math.max(0, Math.min(100, s)) / 100;
  const vNorm = Math.max(0, Math.min(100, v)) / 100;
  const c = vNorm * sNorm;
  const hNorm = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hNorm / 60) % 2) - 1));
  const m = vNorm - c;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (hNorm < 60) {
    rPrime = c;
    gPrime = x;
    bPrime = 0;
  } else if (hNorm < 120) {
    rPrime = x;
    gPrime = c;
    bPrime = 0;
  } else if (hNorm < 180) {
    rPrime = 0;
    gPrime = c;
    bPrime = x;
  } else if (hNorm < 240) {
    rPrime = 0;
    gPrime = x;
    bPrime = c;
  } else if (hNorm < 300) {
    rPrime = x;
    gPrime = 0;
    bPrime = c;
  } else {
    rPrime = c;
    gPrime = 0;
    bPrime = x;
  }

  const r = Math.round((rPrime + m) * 255);
  const g = Math.round((gPrime + m) * 255);
  const b = Math.round((bPrime + m) * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const match = hex.replace(/^#/, '').match(/.{2}/g);
  if (!match || match.length < 3 || !match[0] || !match[1] || !match[2]) {
    return { h: 160, s: 91, v: 73 };
  }
  const r = parseInt(match[0], 16) / 255;
  const g = parseInt(match[1], 16) / 255;
  const b = parseInt(match[2], 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h = Math.round(h * 60);
  }

  const s = max === 0 ? 0 : Math.round((d / max) * 100);
  const v = Math.round(max * 100);

  return { h, s, v };
}

export function parseHexColor(raw: string): string | null {
  const clean = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return `#${clean[0]}${clean[0]}${clean[1]}${clean[1]}${clean[2]}${clean[2]}`.toLowerCase();
  }
  return null;
}
