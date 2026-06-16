/**
 * ChartRenderer — SVG chart generation utilities.
 */
export const ChartRenderer = {
  renderLine(config) {
    const w = config.width || 280;
    const h = config.height || 100;
    const points = config.points || [];
    const color = config.color || '#3b82f6';
    const padX = config.padX || 0;
    const padY = config.padY || 10;
    const maxY = Math.max(...points.map(p => p.y), 1);
    if (points.length < 2) return '<svg></svg>';
    const scaleX = (w - 2 * padX) / (points.length - 1);
    const scaleY = (h - 2 * padY) / maxY;
    const pathD = 'M' + points.map((p, i) => {
      const x = padX + i * scaleX;
      const y = h - padY - p.y * scaleY;
      return i === 0 ? `${x},${y}` : ` Q${((x + padX + (i - 1) * scaleX) / 2)},${y} ${x},${y}`;
    }).join(' ');
    const fillD = `${pathD} L${padX + (points.length - 1) * scaleX},${h - padY} L${padX},${h - padY} Z`;
    return `<svg viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="lcg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
      <path d="${fillD}" fill="url(#lcg)" opacity="0.6"/>
    </svg>`;
  },

  renderBars(config) {
    const w = config.width || 400;
    const h = config.height || 100;
    const datasets = config.datasets || [];
    const padY = config.padY || 15;
    const maxVal = Math.max(...datasets.map(d => d.value), 1);
    const barW = Math.max(8, Math.floor((w - 20) / datasets.length - 4));
    const gap = Math.floor((w - 20 - barW * datasets.length) / (datasets.length + 1));
    const bars = datasets.map((d, i) => {
      const x = 10 + gap + i * (barW + gap);
      const barH = (h - padY) * d.value / maxVal;
      return `<rect x="${x}" y="${h - padY - barH}" width="${barW}" height="${barH}" rx="2" fill="${d.color || '#3b82f6'}" opacity="0.75"/>
        <text x="${x + barW / 2}" y="${h - 4}" font-size="6" fill="var(--text-muted)" text-anchor="middle">${d.label || ''}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}">${bars}</svg>`;
  }
};
