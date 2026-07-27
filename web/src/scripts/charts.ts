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
  public static renderSankeyChart(canvas: HTMLCanvasElement) {
    const c = beginChart(canvas, 260);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'FLUXO · RECEITA → CONTAS → DESTINOS');
    drawLegend(ctx, p, [
      { color: p.income, label: 'RECEITA' },
      { color: p.series[4], label: 'CONTAS' },
      { color: p.expense, label: 'DESPESA' },
      { color: p.info, label: 'RESERVA' },
    ], width - 8, 14, 'right');

    const col1X = 16;
    const col2X = PX(width * 0.38);
    const col3X = width - 168;
    const nodeWidth = 20;

    const sources = [
      { name: 'SALÁRIO', amount: 7800, y: 48, height: 150, color: p.income },
    ];
    const accounts = [
      { name: 'BANCO DO BRASIL', amount: 5425, y: 48, height: 78, color: p.series[4] },
      { name: 'POUPANÇA BB', amount: 9200, y: 140, height: 58, color: p.warn },
    ];
    const destinations = [
      { name: 'ALIMENTAÇÃO', amount: 1843, y: 44, height: 30, color: p.expense },
      { name: 'MORADIA', amount: 1950, y: 80, height: 28, color: p.expense },
      { name: 'TRANSPORTE', amount: 318, y: 114, height: 16, color: p.expense },
      { name: 'RESERVA / METAS', amount: 2500, y: 140, height: 38, color: p.info },
      { name: 'OUTROS', amount: 1189, y: 188, height: 22, color: p.series[5] },
    ];

    const drawRibbon = (
      x0: number, y0: number, h0: number,
      x1: number, y1: number, h1: number,
      color: string
    ) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0 + 70, y0, x1 - 70, y1, x1, y1);
      ctx.lineTo(x1, y1 + h1);
      ctx.bezierCurveTo(x1 - 70, y1 + h1, x0 + 70, y0 + h0, x0, y0 + h0);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    sources.forEach((src) => {
      accounts.forEach((acc, i) => {
        const startY = src.y + 8 + i * 40;
        drawRibbon(col1X + nodeWidth, startY, acc.height * 0.55, col2X, acc.y + 6, acc.height * 0.7, acc.color);
      });
    });

    accounts.forEach((acc) => {
      destinations.forEach((dest) => {
        const isSavingsLink = acc.name.includes('POUPANÇA') && dest.name.includes('RESERVA');
        const isBankLink = acc.name.includes('BANCO') && !dest.name.includes('RESERVA');
        if (isSavingsLink || isBankLink) {
          drawRibbon(col2X + nodeWidth, acc.y + 8, Math.max(10, acc.height * 0.35), col3X, dest.y + 2, dest.height - 2, dest.color);
        }
      });
    });

    const drawNode = (x: number, y: number, w: number, h: number, color: string, label: string, amount: number) => {
      ctx.fillStyle = p.ink;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = color;
      ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
      ctx.fillStyle = p.paper;
      ctx.fillRect(x + 2, y + 2, w - 4, 2);
      const onLeft = x < width * 0.55;
      const labelX = onLeft ? x + w + 8 : x - 8;
      const align: CanvasTextAlign = onLeft ? 'left' : 'right';
      const midY = PX(y + h / 2);
      drawCallout(ctx, p, label, labelX, midY - 2, p.label, align);
      drawCallout(ctx, p, `R$ ${amount.toLocaleString('pt-BR')}`, labelX, midY + 12, color, align);
    };

    sources.forEach((s) => drawNode(col1X, s.y, nodeWidth, s.height, s.color, s.name, s.amount));
    accounts.forEach((a) => drawNode(col2X, a.y, nodeWidth, a.height, a.color, a.name, a.amount));
    destinations.forEach((d) => drawNode(col3X, d.y, nodeWidth, d.height, d.color, d.name, d.amount));

    setSummary(canvas, 'Fluxo Sankey: salário R$7800 para Banco do Brasil e Poupança BB, depois para categorias e reserva.');
  }

  // --- 2. WATERFALL BUDGET CASCADE ---
  public static renderWaterfallChart(canvas: HTMLCanvasElement) {
    const c = beginChart(canvas, 240);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'WATERFALL · CASCATA DE SALDO');
    drawLegend(ctx, p, [
      { color: p.series[4], label: 'BASE' },
      { color: p.income, label: 'ENTRADA' },
      { color: p.expense, label: 'SAÍDA' },
      { color: p.warn, label: 'TOTAL' },
    ], width - 8, 14, 'right');

    const steps = [
      { name: 'INICIAL', val: 14775, type: 'start' as const },
      { name: 'RECEITA', val: 7800, type: 'plus' as const },
      { name: 'MORADIA', val: -1950, type: 'minus' as const },
      { name: 'ALIMENT.', val: -1843, type: 'minus' as const },
      { name: 'TRANSP.', val: -318, type: 'minus' as const },
      { name: 'OUTROS', val: -3168, type: 'minus' as const },
      { name: 'SALDO', val: 15296, type: 'total' as const },
    ];

    const padT = 44;
    const padB = 36;
    const padL = 16;
    const plotH = height - padT - padB;
    const maxVal = 24000;
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
        color = p.series[4];
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

      const valTxt = `${step.val > 0 && step.type !== 'start' && step.type !== 'total' ? '+' : ''}${step.val.toLocaleString('pt-BR')}`;
      const calloutY = Math.max(padT + 12, barY - 6);
      drawCallout(ctx, p, valTxt, x + colWidth / 2, calloutY, color, 'center');
      drawCallout(ctx, p, step.name, x + colWidth / 2, height - 12, p.label, 'center');
    });

    setSummary(canvas, 'Waterfall: saldo inicial 14775, +receita 7800, despesas até saldo final 15296.');
  }

  // --- 3. DITHERED PIE / DONUT CHART ---
  public static renderDonutChart(canvas: HTMLCanvasElement) {
    const c = beginChart(canvas, 240, 280);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'CATEGORIAS · GASTOS');

    const slices = [
      { name: 'MORADIA', pct: 0.56, amount: 1825, color: p.series[3] },
      { name: 'ALIMENT.', pct: 0.22, amount: 717, color: p.series[4] },
      { name: 'TRANSP.', pct: 0.09, amount: 293, color: p.series[2] },
      { name: 'OUTROS', pct: 0.13, amount: 425, color: p.series[1] },
    ];

    const legendW = Math.min(120, Math.floor(width * 0.38));
    const cx = PX((width - legendW) / 2);
    const cy = PX(height / 2) + 8;
    const outerR = Math.min(70, Math.floor((width - legendW) * 0.34));
    const innerR = Math.floor(outerR * 0.58);
    let startAngle = -Math.PI / 2;

    slices.forEach((slice) => {
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
    ctx.fillText('R$ 3.260', cx, cy + 14);

    const legendX = width - legendW + 4;
    let ly = 40;
    slices.forEach((s) => {
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
      ctx.fillText(`${Math.round(s.pct * 100)}%  R$ ${s.amount}`, legendX + 14, ly + 12);
      ly += 28;
    });

    setSummary(canvas, 'Donut de categorias: Moradia 56%, Alimentação 22%, Transporte 9%, Outros 13%. Total R$3260.');
  }

  // --- 4. CANDLESTICK STOCK & CRYPTO CHART ---
  public static renderCandlestickChart(canvas: HTMLCanvasElement) {
    const c = beginChart(canvas, 200);
    if (!c) return;
    const { ctx, width, height, p } = c;

    drawTitlePlate(ctx, p, 'BTC/BRL · CANDLESTICK DIÁRIO');
    drawLegend(ctx, p, [
      { color: p.income, label: 'ALTA' },
      { color: p.expense, label: 'BAIXA' },
    ], width - 8, 14, 'right');

    const candles = [
      { open: 340, high: 360, low: 330, close: 355, vol: 80 },
      { open: 355, high: 375, low: 350, close: 370, vol: 110 },
      { open: 370, high: 380, low: 358, close: 362, vol: 95 },
      { open: 362, high: 368, low: 342, close: 348, vol: 130 },
      { open: 348, high: 372, low: 345, close: 368, vol: 90 },
      { open: 368, high: 395, low: 365, close: 390, vol: 160 },
      { open: 390, high: 410, low: 388, close: 405, vol: 190 },
      { open: 405, high: 415, low: 392, close: 398, vol: 120 },
      { open: 398, high: 425, low: 395, close: 420, vol: 210 },
    ];

    const minP = 320;
    const maxP = 430;
    const padL = 54;
    const padT = 34;
    const padB = 36;
    const plotH = height - padT - padB;
    const colW = Math.floor((width - padL - 12) / candles.length);

    drawHGrid(ctx, p, padL, width - 8, padT, padT + plotH, 3);
    drawYLabels(ctx, p, padL - 6, padT, padT + plotH, minP, maxP, 3, (v) => `R$${Math.round(v)}k`);

    candles.forEach((candle, i) => {
      const x = padL + i * colW + Math.floor(colW / 2);
      const isBull = candle.close >= candle.open;
      const color = isBull ? p.income : p.expense;
      const toY = (price: number) => PX(padT + plotH - ((price - minP) / (maxP - minP)) * plotH);

      const highY = toY(candle.high);
      const lowY = toY(candle.low);
      const openY = toY(candle.open);
      const closeY = toY(candle.close);

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      const bodyY = Math.min(openY, closeY);
      const bodyH = Math.max(4, Math.abs(openY - closeY));
      ctx.fillStyle = color;
      ctx.fillRect(x - 6, bodyY, 12, bodyH);
      ctx.fillStyle = p.paper;
      ctx.fillRect(x - 6, bodyY, 12, 2);

      const volH = Math.round((candle.vol / 250) * 18);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x - 5, height - volH - 4, 10, volH);
      ctx.globalAlpha = 1;
    });

    ctx.fillStyle = p.axis;
    ctx.font = '8px Silkscreen';
    ctx.textAlign = 'center';
    ctx.fillText('VOL', padL / 2, height - 6);

    const last = candles[candles.length - 1];
    setSummary(canvas, `Candlestick BTC/BRL: último close R$${last.close}k, ${last.close >= last.open ? 'alta' : 'baixa'}.`);
  }

  // --- 5. GOAL SEGMENTED METER ---
  public static renderGaugeChart(canvas: HTMLCanvasElement, pct: number = 74) {
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
    ctx.fillText('META ECONOMIA', cx, wellY + 16);

    ctx.fillStyle = fillColor;
    ctx.font = '34px VT323';
    ctx.fillText(`${clamped}%`, cx, wellY + 48);

    ctx.fillStyle = p.warn;
    ctx.font = '8px Silkscreen';
    ctx.fillText('SAVINGS GOAL', cx, wellY + 62);

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

    setSummary(canvas, `Medidor de meta de economia: ${clamped}% preenchido, status ${chip}, ${filledCount} de ${segments} segmentos.`);
  }

  // --- 6. RADIAL KPI RADAR CHART ---
  public static renderRadarChart(canvas: HTMLCanvasElement) {
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

    const metrics = [
      { label: 'POUPANÇA', val: 0.85 },
      { label: 'LIQUIDEZ', val: 0.90 },
      { label: 'INVEST.', val: 0.75 },
      { label: 'DÍVIDAS', val: 0.45 },
      { label: 'ORÇAM.', val: 0.80 },
    ];

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
      ctx.fillText(metrics[i].label, lx, ly);

      // Value tick callout
      const vx = cx + Math.cos(angle) * (maxR * metrics[i].val);
      const vy = cy + Math.sin(angle) * (maxR * metrics[i].val);
      ctx.fillStyle = p.plot;
      ctx.fillRect(PX(vx) - 2, PX(vy) - 2, 5, 5);
    }

    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const angle = (i * Math.PI * 2) / count - Math.PI / 2;
      const r = maxR * metrics[i].val;
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
    if (data.length === 0) return;
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
    const maxVal = Math.max(...allValues) * 1.08;
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

    // End-point value callouts (readable, no overlap with legend)
    const lastIdx = data.length - 1;
    const last = data[lastIdx];
    drawCallout(ctx, p, shortMoney(last.incomeCents), toX(lastIdx) - 4, toY(last.incomeCents) - 10, p.income, 'right');
    drawCallout(ctx, p, shortMoney(last.expenseCents), toX(lastIdx) - 4, toY(last.expenseCents) + 16, p.expense, 'right');

    const monthNames = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
    data.forEach((d, i) => {
      const monthIdx = parseInt(d.month.split('-')[1], 10) - 1;
      drawCallout(ctx, p, monthNames[monthIdx] || d.month, toX(i), height - 10, p.label, 'center');
    });

    setSummary(
      canvas,
      `Fluxo mensal: último mês receita ${formatMoney(last.incomeCents)}, despesa ${formatMoney(last.expenseCents)}.`
    );
  }

  // --- 9. BALANCE PROJECTION CHART ---
  public static renderProjectionChart(canvas: HTMLCanvasElement, data: ProjectionPoint[]) {
    if (data.length === 0) return;
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

    // Stepped area fill (blocky projection, not soft gradient)
    ctx.beginPath();
    ctx.moveTo(toX(0), zeroY);
    data.forEach((d, i) => {
      const x = toX(i);
      const y = toY(d.balanceCents);
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevY = toY(data[i - 1].balanceCents);
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
        const prevY = toY(data[i - 1].balanceCents);
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = p.series[4];
    ctx.lineWidth = 2;
    data.forEach((d, i) => {
      const x = toX(i);
      const y = toY(d.balanceCents);
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prevY = toY(data[i - 1].balanceCents);
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    data.forEach((d, i) => {
      const x = toX(i);
      const y = toY(d.balanceCents);
      const color = d.changeCents < 0 ? p.expense : d.changeCents > 0 ? p.income : p.series[4];
      ctx.fillStyle = color;
      ctx.fillRect(x - 3, y - 3, 7, 7);
    });

    // Numbered markers on plot + event rail (avoids overlapping callouts)
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
      const color = e.changeCents < 0 ? p.expense : e.changeCents > 0 ? p.income : p.series[4];
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
        const parts = data[i].date.split('-');
        drawCallout(ctx, p, `${parts[2]}/${parts[1]}`, toX(i), height - 10, p.label, 'center');
      }
    });

    const end = data[data.length - 1];
    drawCallout(
      ctx,
      p,
      shortMoney(end.balanceCents),
      toX(data.length - 1) - 4,
      toY(end.balanceCents) - 12,
      p.series[4],
      'right'
    );
    setSummary(canvas, `Projeção 30 dias: saldo final ${formatMoney(end.balanceCents)}.`);
  }
}
