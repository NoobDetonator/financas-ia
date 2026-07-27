// Authentic PC-98 Pixel-Art Financial Chart Renderers (HTML5 Canvas)
// Shared chart language: CSS-var palette, hard bevels, chunky segments, no AA.
import type { MonthlyFlow, ProjectionPoint } from './data';
import { formatMoney } from './data';

export interface ChartPalette {
  bg: string;
  grid: string;
  axis: string;
  label: string;
  title: string;
  plot: string;
  plotFill: string;
  bevelHi: string;
  bevelLo: string;
  income: string;
  expense: string;
  warn: string;
  critical: string;
  info: string;
  ink: string;
  paper: string;
  series: string[];
}

interface ChartContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  p: ChartPalette;
}

const PX = (n: number) => Math.round(n);

function readCssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function readChartPalette(el: Element = document.documentElement): ChartPalette {
  return {
    bg: readCssVar(el, '--c-chart-bg', '#0A0A14'),
    grid: readCssVar(el, '--c-chart-grid', '#22224A'),
    axis: readCssVar(el, '--c-chart-axis', '#566C86'),
    label: readCssVar(el, '--c-chart-label', '#C0CBDC'),
    title: readCssVar(el, '--c-chart-title', '#73EFF7'),
    plot: readCssVar(el, '--c-chart-plot', '#73EFF7'),
    plotFill: readCssVar(el, '--c-chart-plot-fill', 'rgba(115,239,247,0.32)'),
    bevelHi: readCssVar(el, '--c-chart-bevel-hi', '#333C57'),
    bevelLo: readCssVar(el, '--c-chart-bevel-lo', '#566C86'),
    income: readCssVar(el, '--c-income', '#38B764'),
    expense: readCssVar(el, '--c-expense', '#E5537A'),
    warn: readCssVar(el, '--c-warn', '#F4B41B'),
    critical: readCssVar(el, '--c-critical', '#E5537A'),
    info: readCssVar(el, '--c-info', '#73EFF7'),
    ink: readCssVar(el, '--c-ink-fixed', '#0A0A14'),
    paper: readCssVar(el, '--c-paper-fixed', '#F2F0E5'),
    series: [
      readCssVar(el, '--c-series-1', '#73EFF7'),
      readCssVar(el, '--c-series-2', '#38B764'),
      readCssVar(el, '--c-series-3', '#F4B41B'),
      readCssVar(el, '--c-series-4', '#E5537A'),
      readCssVar(el, '--c-series-5', '#41A6F6'),
      readCssVar(el, '--c-series-6', '#A23E8C'),
    ],
  };
}


/**
 * Altura do canvas a partir da largura, com teto.
 *
 * Ler a altura do container para definir a altura do canvas e depois esticá-lo
 * com "height: 100%" cria um laço de realimentação: o canvas empurra a altura do
 * container, que na medição seguinte devolve um valor maior. No desktop o
 * container tem altura limitada e o laço não fecha; empilhado no celular, o
 * gráfico crescia a cada re-render até virar uma faixa preta de centenas de pixels.
 *
 * A altura passa a ser derivada da largura por proporção, com piso e teto — nunca
 * de uma medida que o próprio canvas influencia.
 */
function chartHeightFor(width: number, ratio: number, min: number, max: number): number {
  return PX(Math.min(max, Math.max(min, Math.round(width * ratio))));
}

function beginChart(
  canvas: HTMLCanvasElement,
  height: number,
  widthFallback = 600
): ChartContext | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const width = PX(canvas.parentElement?.clientWidth || widthFallback);
  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = false;
  const p = readChartPalette(document.documentElement);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx, width, height, p };
}

function setSummary(canvas: HTMLCanvasElement, text: string) {
  canvas.setAttribute('aria-label', text);
  const host = canvas.parentElement;
  if (!host) return;
  let sr = host.querySelector('.chart-sr-summary') as HTMLElement | null;
  if (!sr) {
    sr = document.createElement('div');
    sr.className = 'chart-sr-summary';
    sr.setAttribute('aria-live', 'polite');
    host.classList.add('chart-frame');
    host.appendChild(sr);
  }
  sr.textContent = text;
}

/** Quadro vazio — evita deixar o canvas com números de demonstração. */
function drawEmptyState(
  canvas: HTMLCanvasElement,
  title: string,
  message = 'SEM DADOS',
  height = 220,
): void {
  const c = beginChart(canvas, height);
  if (!c) return;
  const { ctx, width, height: h, p } = c;
  drawTitlePlate(ctx, p, title);
  ctx.fillStyle = p.label;
  ctx.font = '12px Silkscreen';
  ctx.textAlign = 'center';
  ctx.fillText(message, PX(width / 2), PX(h / 2));
  ctx.fillStyle = p.axis;
  ctx.font = '9px Silkscreen';
  ctx.fillText('nenhum valor real para plotar', PX(width / 2), PX(h / 2) + 18);
  setSummary(canvas, `${title}: ${message}`);
}

function drawBevelWell(
  ctx: CanvasRenderingContext2D,
  p: ChartPalette,
  x: number, y: number, w: number, h: number
) {
  ctx.fillStyle = p.bg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = p.bevelHi;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = p.bevelLo;
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x + w - 2, y, 2, h);
}

function drawTitlePlate(
  ctx: CanvasRenderingContext2D,
  p: ChartPalette,
  title: string,
  x = 8,
  y = 14
) {
  ctx.font = '10px Silkscreen';
  const tw = Math.ceil(ctx.measureText(title).width);
  ctx.fillStyle = p.bg;
  ctx.fillRect(x - 2, y - 10, tw + 8, 14);
  ctx.strokeStyle = p.bevelHi;
  ctx.strokeRect(x - 2, y - 10, tw + 8, 14);
  ctx.fillStyle = p.title;
  ctx.textAlign = 'left';
  ctx.fillText(title, x + 2, y);
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  p: ChartPalette,
  items: { color: string; label: string }[],
  x: number,
  y: number,
  align: 'left' | 'right' = 'left'
) {
  ctx.font = '9px Silkscreen';
  const gap = 12;
  const swatch = 8;
  const widths = items.map((item) => swatch + 4 + Math.ceil(ctx.measureText(item.label).width));
  const total = widths.reduce((s, w) => s + w, 0) + gap * (items.length - 1) + 12;
  const left = align === 'right' ? x - total : x;
  ctx.fillStyle = p.bg;
  ctx.fillRect(left, y - 10, total, 16);
  ctx.strokeStyle = p.bevelLo;
  ctx.strokeRect(left, y - 10, total, 16);

  let cursor = left + 6;
  items.forEach((item, i) => {
    ctx.fillStyle = item.color;
    ctx.fillRect(cursor, y - 6, swatch, swatch);
    ctx.fillStyle = p.paper;
    ctx.fillRect(cursor, y - 6, swatch, 2);
    ctx.fillStyle = p.label;
    ctx.textAlign = 'left';
    ctx.fillText(item.label, cursor + swatch + 4, y + 1);
    cursor += widths[i] + gap;
  });
}

function drawCallout(
  ctx: CanvasRenderingContext2D,
  p: ChartPalette,
  text: string,
  x: number,
  y: number,
  color = p.label,
  align: CanvasTextAlign = 'center'
) {
  ctx.font = '8px Silkscreen';
  ctx.textAlign = align;
  const tw = Math.ceil(ctx.measureText(text).width);
  const left =
    align === 'left' ? x : align === 'right' ? x - tw : x - Math.floor(tw / 2);
  ctx.fillStyle = p.bg;
  ctx.fillRect(left - 3, y - 9, tw + 6, 12);
  ctx.strokeStyle = p.bevelHi;
  ctx.strokeRect(left - 3, y - 9, tw + 6, 12);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawHGrid(
  ctx: CanvasRenderingContext2D,
  p: ChartPalette,
  x0: number, x1: number, y0: number, y1: number, lines: number
) {
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= lines; i++) {
    const y = PX(y0 + ((y1 - y0) / lines) * i);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
}

function drawYLabels(
  ctx: CanvasRenderingContext2D,
  p: ChartPalette,
  x: number,
  y0: number,
  y1: number,
  minVal: number,
  maxVal: number,
  lines: number,
  format: (v: number) => string
) {
  const range = maxVal - minVal || 1;
  ctx.fillStyle = p.axis;
  ctx.font = '9px Silkscreen';
  ctx.textAlign = 'right';
  for (let i = 0; i <= lines; i++) {
    const y = PX(y0 + ((y1 - y0) / lines) * i);
    const val = maxVal - (range / lines) * i;
    ctx.fillText(format(val), x, y + 3);
  }
}

function shortMoney(cents: number): string {
  const abs = Math.abs(cents);
  if (abs >= 100000) return `R$${(cents / 100000).toFixed(0)}k`;
  return formatMoney(Math.round(cents));
}

function drawSegmentTrack(
  ctx: CanvasRenderingContext2D,
  p: ChartPalette,
  x: number, y: number, w: number, h: number,
  segments: number, filled: number, fillColor: string
) {
  const gap = 2;
  const segW = Math.max(2, Math.floor((w - gap * (segments - 1)) / segments));
  ctx.fillStyle = p.grid;
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.fillStyle = p.bevelHi;
  ctx.fillRect(x - 3, y - 3, w + 6, 2);
  ctx.fillRect(x - 3, y - 3, 2, h + 6);

  for (let i = 0; i < segments; i++) {
    const sx = x + i * (segW + gap);
    const active = i < filled;
    ctx.fillStyle = active ? fillColor : p.bevelHi;
    ctx.fillRect(sx, y, segW, h);
    if (active) {
      ctx.fillStyle = p.paper;
      ctx.fillRect(sx, y, segW, 3);
      ctx.fillStyle = p.ink;
      ctx.fillRect(sx, y + h - 3, segW, 3);
    }
  }
}

function statusColor(p: ChartPalette, pct: number): string {
  if (pct >= 100) return p.income;
  if (pct >= 70) return p.info;
  if (pct >= 40) return p.warn;
  return p.critical;
}

function statusChip(pct: number): string {
  if (pct >= 100) return '[COMPLETE]';
  if (pct >= 70) return '[ON TRACK]';
  if (pct >= 40) return '[AT RISK]';
  return '[BEHIND]';
}

export class PC98ChartSuite {

  // --- 1. SANKEY MONEY FLOW DIAGRAM ---
  public static renderSankeyChart(canvas: HTMLCanvasElement, hasData = false) {
    // Sem grafo agregado no backend — nunca inventar faixas de demonstração.
    drawEmptyState(
      canvas,
      'FLUXO · RECEITA → CONTAS → DESTINOS',
      hasData ? 'SEM GRAFO' : 'SEM DADOS',
      260,
    );
  }

  // --- 2. WATERFALL BUDGET CASCADE ---
  public static renderWaterfallChart(
    canvas: HTMLCanvasElement,
    steps: Array<{ name: string; val: number; type: 'start' | 'plus' | 'minus' | 'total' }> = [],
  ) {
    if (steps.length === 0) {
      drawEmptyState(canvas, 'WATERFALL · CASCATA DO MÊS', 'SEM DADOS', 240);
      return;
    }

    const c = beginChart(canvas, 240);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'WATERFALL · CASCATA DO MÊS');
    drawLegend(ctx, p, [
      { color: p.series[4], label: 'BASE' },
      { color: p.income, label: 'ENTRADA' },
      { color: p.expense, label: 'SAÍDA' },
      { color: p.warn, label: 'TOTAL' },
    ], width - 8, 14, 'right');

    const padT = 44;
    const padB = 36;
    const padL = 16;
    const plotH = height - padT - padB;
    const absPeak = Math.max(...steps.map((s) => Math.abs(s.val)), 1);
    const maxVal = absPeak * 1.2;
    const colWidth = Math.floor((width - padL - 12) / steps.length);
    let cumulative = 0;

    drawHGrid(ctx, p, padL, width - 8, padT, padT + plotH, 4);

    steps.forEach((step, i) => {
      const x = padL + i * colWidth;
      let startY = 0;
      let endY = 0;
      let color = p.income;

      if (step.type === 'start') {
        cumulative = step.val;
        startY = padT + plotH;
        endY = padT + plotH - (step.val / maxVal) * plotH;
        color = p.series[4]!;
      } else if (step.type === 'plus') {
        startY = padT + plotH - (cumulative / maxVal) * plotH;
        cumulative += step.val;
        endY = padT + plotH - (cumulative / maxVal) * plotH;
        color = p.income;
      } else if (step.type === 'minus') {
        startY = padT + plotH - (cumulative / maxVal) * plotH;
        cumulative += step.val;
        endY = padT + plotH - (cumulative / maxVal) * plotH;
        color = p.expense;
      } else {
        startY = padT + plotH;
        endY = padT + plotH - (step.val / maxVal) * plotH;
        color = p.warn;
        cumulative = step.val;
      }

      const barY = Math.min(startY, endY);
      const barH = Math.max(3, Math.abs(startY - endY));
      const barW = colWidth - 10;

      ctx.fillStyle = color;
      ctx.fillRect(x + 4, barY, barW, barH);
      ctx.fillStyle = p.paper;
      ctx.fillRect(x + 4, barY, barW, 2);
      ctx.fillStyle = p.ink;
      ctx.fillRect(x + 4, barY + barH - 2, barW, 2);

      if (i < steps.length - 1 && step.type !== 'total') {
        ctx.strokeStyle = p.axis;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(x + colWidth - 6, endY);
        ctx.lineTo(x + colWidth + 4, endY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const valTxt = `${step.val > 0 && step.type !== 'start' && step.type !== 'total' ? '+' : ''}${Math.round(step.val).toLocaleString('pt-BR')}`;
      const calloutY = Math.max(padT + 12, barY - 6);
      drawCallout(ctx, p, valTxt, x + colWidth / 2, calloutY, color, 'center');
      drawCallout(ctx, p, step.name, x + colWidth / 2, height - 12, p.label, 'center');
    });

    const last = steps[steps.length - 1]!;
    setSummary(canvas, `Waterfall do mês: saldo ${Math.round(last.val).toLocaleString('pt-BR')}.`);
  }

  // --- 3. DONUT CHART ---
  public static renderDonutChart(
    canvas: HTMLCanvasElement,
    slices: Array<{ name: string; pct: number; amountCents: number }> = [],
  ) {
    if (slices.length === 0) {
      drawEmptyState(canvas, 'CATEGORIAS · GASTOS', 'SEM DADOS', 240);
      return;
    }

    const c = beginChart(canvas, 240, 280);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'CATEGORIAS · GASTOS');

    const colored = slices.map((slice, i) => ({
      ...slice,
      color: p.series[i % p.series.length]!,
    }));

    const legendW = Math.min(120, Math.floor(width * 0.38));
    const cx = PX((width - legendW) / 2);
    const cy = PX(height / 2) + 8;
    const outerR = Math.min(70, Math.floor((width - legendW) * 0.34));
    const innerR = Math.floor(outerR * 0.58);
    let startAngle = -Math.PI / 2;
    const totalCents = colored.reduce((sum, s) => sum + s.amountCents, 0);

    colored.forEach((slice) => {
      const angle = slice.pct * Math.PI * 2;
      const endAngle = startAngle + angle;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, endAngle);
      ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = slice.color;
      ctx.fill();
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      startAngle = endAngle;
    });

    ctx.fillStyle = p.bg;
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = p.label;
    ctx.font = '10px Silkscreen';
    ctx.textAlign = 'center';
    ctx.fillText('TOTAL', cx, cy - 6);
    ctx.fillStyle = p.title;
    ctx.font = '18px VT323';
    ctx.fillText(formatMoney(totalCents), cx, cy + 14);

    const legendX = width - legendW + 4;
    let ly = 40;
    colored.forEach((s) => {
      ctx.fillStyle = s.color;
      ctx.fillRect(legendX, ly - 8, 10, 10);
      ctx.fillStyle = p.paper;
      ctx.fillRect(legendX, ly - 8, 10, 2);
      ctx.fillStyle = p.label;
      ctx.font = '9px Silkscreen';
      ctx.textAlign = 'left';
      ctx.fillText(s.name, legendX + 14, ly);
      ctx.fillStyle = s.color;
      ctx.font = '10px VT323';
      ctx.fillText(`${Math.round(s.pct * 100)}%  ${formatMoney(s.amountCents)}`, legendX + 14, ly + 12);
      ly += 28;
    });

    setSummary(
      canvas,
      `Donut de categorias: ${colored.map((s) => `${s.name} ${Math.round(s.pct * 100)}%`).join(', ')}. Total ${formatMoney(totalCents)}.`,
    );
  }

  // --- 4. CANDLESTICK ---
  public static renderCandlestickChart(canvas: HTMLCanvasElement) {
    // Sem série OHLC no backend — nunca inventar velas de demonstração.
    drawEmptyState(canvas, 'COTAÇÕES · CANDLESTICK', 'SEM COTAÇÕES', 200);
  }

  // --- 5. GOAL SEGMENTED METER ---
  public static renderGaugeChart(
    canvas: HTMLCanvasElement,
    pct: number | null,
    title = 'META ECONOMIA',
  ) {
    if (pct == null) {
      drawEmptyState(canvas, title, 'SEM META', 160);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const host = canvas.parentElement;
    const width = PX(Math.max(host?.clientWidth || 160, 132));
    const height = chartHeightFor(width, 0.92, 148, 220);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = '100%';
    canvas.style.height = height + 'px';
    ctx.imageSmoothingEnabled = false;
    const p = readChartPalette();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, width, height);

    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const segments = 16;
    const filledCount = Math.round((clamped / 100) * segments);
    const fillColor = statusColor(p, clamped);

    const inset = 6;
    const wellX = inset;
    const wellY = inset;
    const wellW = width - inset * 2;
    const wellH = height - inset * 2;
    drawBevelWell(ctx, p, wellX, wellY, wellW, wellH);

    const padX = wellX + 8;
    const innerW = wellW - 16;
    const cx = PX(width / 2);

    ctx.fillStyle = p.title;
    ctx.font = '9px Silkscreen';
    ctx.textAlign = 'center';
    ctx.fillText(title.slice(0, 18).toUpperCase(), cx, wellY + 16);

    ctx.fillStyle = fillColor;
    ctx.font = '34px VT323';
    ctx.fillText(`${clamped}%`, cx, wellY + 48);

    ctx.fillStyle = p.warn;
    ctx.font = '8px Silkscreen';
    ctx.fillText('PROGRESSO REAL', cx, wellY + 62);

    const trackY = wellY + 72;
    const trackH = 18;
    drawSegmentTrack(ctx, p, padX, trackY, innerW, trackH, segments, filledCount, fillColor);

    ctx.fillStyle = p.label;
    ctx.font = '8px Silkscreen';
    ctx.textAlign = 'left';
    ctx.fillText('0%', padX, trackY + trackH + 14);
    ctx.textAlign = 'center';
    ctx.fillText('50%', cx, trackY + trackH + 14);
    ctx.textAlign = 'right';
    ctx.fillText('100%', padX + innerW, trackY + trackH + 14);

    const chip = statusChip(clamped);
    const chipLabel = `${chip} ${filledCount}/${segments}`;
    ctx.font = '8px Silkscreen';
    const chipTextW = Math.ceil(ctx.measureText(chipLabel).width);
    const chipPad = 8;
    const chipW = Math.min(innerW, chipTextW + chipPad * 2);
    const chipH = 14;
    const chipX = PX(cx - chipW / 2);
    const chipY = wellY + wellH - chipH - 8;

    ctx.strokeStyle = fillColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(chipX, chipY, chipW, chipH);
    ctx.fillStyle = fillColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chipLabel, cx, chipY + chipH / 2 + 1);
    ctx.textBaseline = 'alphabetic';

    setSummary(canvas, `Medidor de meta: ${clamped}% preenchido, status ${chip}, ${filledCount} de ${segments} segmentos.`);
  }

  // --- 6. RADIAL KPI RADAR CHART ---
  public static renderRadarChart(
    canvas: HTMLCanvasElement,
    metrics: Array<{ label: string; val: number }> | null = null,
  ) {
    if (!metrics || metrics.length === 0) {
      drawEmptyState(canvas, 'RADAR KPI · SAÚDE', 'SEM DADOS', 180);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const host = canvas.parentElement;
    const width = PX(Math.max(host?.clientWidth || 220, 180));
    const height = chartHeightFor(width, 0.85, 160, 260);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = '100%';
    canvas.style.height = height + 'px';
    ctx.imageSmoothingEnabled = false;
    const p = readChartPalette();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, width, height);

    drawTitlePlate(ctx, p, 'RADAR KPI · SAÚDE');

    const cx = PX(width / 2);
    const cy = PX(height / 2) + 6;
    const maxR = Math.max(48, Math.min(PX(Math.min(width, height) * 0.32), 96));
    const count = metrics.length;

    [0.33, 0.66, 1].forEach((factor) => {
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const angle = (i * Math.PI * 2) / count - Math.PI / 2;
        const x = cx + Math.cos(angle) * (maxR * factor);
        const y = cy + Math.sin(angle) * (maxR * factor);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = p.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    for (let i = 0; i < count; i++) {
      const angle = (i * Math.PI * 2) / count - Math.PI / 2;
      const x = cx + Math.cos(angle) * maxR;
      const y = cy + Math.sin(angle) * maxR;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = p.axis;
      ctx.stroke();

      const lx = cx + Math.cos(angle) * (maxR + 20);
      const ly = cy + Math.sin(angle) * (maxR + 16);
      ctx.fillStyle = p.label;
      ctx.font = '8px Silkscreen';
      ctx.textAlign = 'center';
      ctx.fillText(metrics[i]!.label, lx, ly);

      const vx = cx + Math.cos(angle) * (maxR * metrics[i]!.val);
      const vy = cy + Math.sin(angle) * (maxR * metrics[i]!.val);
      ctx.fillStyle = p.plot;
      ctx.fillRect(PX(vx) - 2, PX(vy) - 2, 5, 5);
    }

    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const angle = (i * Math.PI * 2) / count - Math.PI / 2;
      const r = maxR * metrics[i]!.val;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = p.plotFill;
    ctx.fill();
    ctx.strokeStyle = p.ink;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = p.plot;
    ctx.lineWidth = 2;
    ctx.stroke();

    const avg = Math.round((metrics.reduce((s, m) => s + m.val, 0) / count) * 100);
    ctx.fillStyle = p.warn;
    ctx.font = '9px Silkscreen';
    ctx.textAlign = 'left';
    ctx.fillText(`AVG ${avg}%`, 8, height - 8);

    const summary = metrics.map((m) => `${m.label} ${Math.round(m.val * 100)}%`).join(', ');
    setSummary(canvas, `Radar KPI: ${summary}. Média ${avg}%.`);
  }

  // --- 8. MONTHLY FLOW LINE CHART ---
  public static renderFlowLineChart(canvas: HTMLCanvasElement, data: MonthlyFlow[]) {
    if (data.length === 0) {
      drawEmptyState(canvas, 'FLUXO MENSAL · RECEITA vs DESPESA', 'SEM DADOS', 260);
      return;
    }
    const c = beginChart(canvas, 260);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'FLUXO MENSAL · RECEITA vs DESPESA');
    drawLegend(ctx, p, [
      { color: p.income, label: 'RECEITA' },
      { color: p.expense, label: 'DESPESA' },
    ], width - 8, 14, 'right');

    const padL = 70;
    const padR = 18;
    const padT = 42;
    const padB = 32;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;
    const allValues = data.flatMap((d) => [d.incomeCents, d.expenseCents]);
    const maxVal = Math.max(...allValues, 1) * 1.08;
    const minVal = 0;
    const range = maxVal - minVal || 1;
    const toX = (i: number) => PX(padL + (i / Math.max(1, data.length - 1)) * chartW);
    const toY = (v: number) => PX(padT + chartH - ((v - minVal) / range) * chartH);

    drawHGrid(ctx, p, padL, width - padR, padT, padT + chartH, 4);
    drawYLabels(ctx, p, padL - 6, padT, padT + chartH, minVal, maxVal, 4, shortMoney);

    const drawSeries = (key: 'incomeCents' | 'expenseCents', color: string) => {
      ctx.beginPath();
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'miter';
      data.forEach((d, i) => {
        const x = toX(i);
        const y = toY(d[key]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      data.forEach((d, i) => {
        const x = toX(i);
        const y = toY(d[key]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      data.forEach((d, i) => {
        const x = toX(i);
        const y = toY(d[key]);
        ctx.fillStyle = color;
        ctx.fillRect(x - 3, y - 3, 7, 7);
        ctx.fillStyle = p.paper;
        ctx.fillRect(x - 3, y - 3, 7, 2);
        ctx.fillStyle = p.ink;
        ctx.fillRect(x - 3, y + 4, 7, 2);
      });
    };

    drawSeries('incomeCents', p.income);
    drawSeries('expenseCents', p.expense);

    const lastIdx = data.length - 1;
    const last = data[lastIdx]!;
    drawCallout(ctx, p, shortMoney(last.incomeCents), toX(lastIdx) - 4, toY(last.incomeCents) - 10, p.income, 'right');
    drawCallout(ctx, p, shortMoney(last.expenseCents), toX(lastIdx) - 4, toY(last.expenseCents) + 16, p.expense, 'right');

    const monthNames = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
    data.forEach((d, i) => {
      const monthIdx = parseInt(d.month.split('-')[1]!, 10) - 1;
      drawCallout(ctx, p, monthNames[monthIdx] || d.month, toX(i), height - 10, p.label, 'center');
    });

    setSummary(
      canvas,
      `Fluxo mensal: último mês receita ${formatMoney(last.incomeCents)}, despesa ${formatMoney(last.expenseCents)}.`,
    );
  }

  // --- 9. BALANCE PROJECTION CHART ---
  public static renderProjectionChart(canvas: HTMLCanvasElement, data: ProjectionPoint[]) {
    if (data.length === 0) {
      drawEmptyState(canvas, 'PROJEÇÃO DE SALDO · 30 DIAS', 'SEM DADOS', 260);
      return;
    }
    const c = beginChart(canvas, 260);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'PROJEÇÃO DE SALDO · 30 DIAS');
    drawLegend(ctx, p, [
      { color: p.series[4], label: 'SALDO' },
      { color: p.income, label: 'ENTRADA' },
      { color: p.expense, label: 'SAÍDA' },
    ], width - 8, 14, 'right');

    const events = data
      .map((d, i) => ({ ...d, i }))
      .filter((d) => !!d.label);
    const eventRail = Math.min(168, Math.max(120, Math.floor(width * 0.22)));
    const padL = 70;
    const padR = 12 + eventRail;
    const padT = 42;
    const padB = 28;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;
    const allBalances = data.map((d) => d.balanceCents);
    const maxVal = Math.max(...allBalances) * 1.1;
    const minVal = Math.min(0, Math.min(...allBalances) * 1.1);
    const range = maxVal - minVal || 1;
    const toX = (i: number) => PX(padL + (i / Math.max(1, data.length - 1)) * chartW);
    const toY = (v: number) => PX(padT + chartH - ((v - minVal) / range) * chartH);

    drawHGrid(ctx, p, padL, width - padR, padT, padT + chartH, 4);
    drawYLabels(ctx, p, padL - 6, padT, padT + chartH, minVal, maxVal, 4, shortMoney);

    const zeroY = toY(0);
    ctx.strokeStyle = p.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(width - padR, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(toX(0), zeroY);
    data.forEach((d, i) => {
      const x = toX(i);
      const y = toY(d.balanceCents);
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevY = toY(data[i - 1]!.balanceCents);
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
    });
    ctx.lineTo(toX(data.length - 1), zeroY);
    ctx.closePath();
    ctx.fillStyle = p.plotFill;
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = p.ink;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'miter';
    data.forEach((d, i) => {
      const x = toX(i);
      const y = toY(d.balanceCents);
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prevY = toY(data[i - 1]!.balanceCents);
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = p.series[4]!;
    ctx.lineWidth = 2;
    data.forEach((d, i) => {
      const x = toX(i);
      const y = toY(d.balanceCents);
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prevY = toY(data[i - 1]!.balanceCents);
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    data.forEach((d, i) => {
      const x = toX(i);
      const y = toY(d.balanceCents);
      const color = d.changeCents < 0 ? p.expense : d.changeCents > 0 ? p.income : p.series[4]!;
      ctx.fillStyle = color;
      ctx.fillRect(x - 3, y - 3, 7, 7);
    });

    const railX = width - eventRail + 4;
    ctx.fillStyle = p.bg;
    ctx.fillRect(railX - 4, padT - 4, eventRail, chartH + 8);
    ctx.strokeStyle = p.bevelHi;
    ctx.strokeRect(railX - 4, padT - 4, eventRail, chartH + 8);
    ctx.fillStyle = p.title;
    ctx.font = '8px Silkscreen';
    ctx.textAlign = 'left';
    ctx.fillText('EVENTOS', railX, padT + 8);

    events.forEach((e, idx) => {
      const n = idx + 1;
      const x = toX(e.i);
      const y = toY(e.balanceCents);
      const color = e.changeCents < 0 ? p.expense : e.changeCents > 0 ? p.income : p.series[4]!;
      ctx.fillStyle = p.bg;
      ctx.fillRect(x - 6, y - 7, 12, 12);
      ctx.strokeStyle = color;
      ctx.strokeRect(x - 6, y - 7, 12, 12);
      ctx.fillStyle = color;
      ctx.font = '9px VT323';
      ctx.textAlign = 'center';
      ctx.fillText(String(n), x, y + 3);

      const parts = e.date.split('-');
      const rowY = padT + 22 + idx * 22;
      if (rowY > padT + chartH - 4) return;
      ctx.fillStyle = color;
      ctx.fillRect(railX, rowY - 8, 8, 8);
      ctx.fillStyle = p.label;
      ctx.font = '8px Silkscreen';
      ctx.textAlign = 'left';
      const short = (e.label || '').toUpperCase().slice(0, 14);
      ctx.fillText(`${n} ${parts[2]}/${parts[1]}`, railX + 12, rowY - 1);
      ctx.fillStyle = color;
      ctx.fillText(short, railX + 12, rowY + 10);
    });

    [0, Math.floor(data.length / 2), data.length - 1].forEach((i) => {
      if (data[i]) {
        const parts = data[i]!.date.split('-');
        drawCallout(ctx, p, `${parts[2]}/${parts[1]}`, toX(i), height - 10, p.label, 'center');
      }
    });

    const end = data[data.length - 1]!;
    drawCallout(
      ctx,
      p,
      shortMoney(end.balanceCents),
      toX(data.length - 1) - 4,
      toY(end.balanceCents) - 12,
      p.series[4]!,
      'right',
    );
    setSummary(canvas, `Projeção 30 dias: saldo final ${formatMoney(end.balanceCents)}.`);
  }
}
