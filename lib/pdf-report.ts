import { SENTIMENT_LABELS, percent, type SentimentStats } from "./analysis";
import { computeReportStats, formatNumber, type ReportStats } from "./report-stats";
import type { CommentItem, Sentiment } from "./types";
import type { ExportInput } from "./export";

// Reporte PDF vertical con estética de dashboard de analítica: fondo lavanda claro, tarjetas
// blancas con sombra suave, degradados azul → cian, títulos en dos tonos y barras con degradado.

type Rgb = [number, number, number];

const W = 800;
const H = 1132;
const M = 40;
const CW = W - M * 2;
const TOP = 104;
const BOTTOM = H - 64;

const PAGE: Rgb = [241, 243, 252];
const CARD: Rgb = [255, 255, 255];
const SOFT: Rgb = [245, 247, 254];
const LINE: Rgb = [229, 232, 246];
const NAVY: Rgb = [34, 38, 82];
const TEXT: Rgb = [62, 66, 104];
const MUTED: Rgb = [128, 133, 166];
const FAINT: Rgb = [178, 183, 210];
const BLUE: Rgb = [82, 96, 232];
const CYAN: Rgb = [92, 210, 232];
const BLUE_SOFT: Rgb = [232, 235, 253];
const WHITE: Rgb = [255, 255, 255];

const SENTIMENT_COLOR: Record<Sentiment, Rgb> = {
  positive: [38, 178, 112],
  negative: [236, 84, 108],
  neutral: [172, 178, 206],
};
const SENTIMENT_SOFT: Record<Sentiment, Rgb> = {
  positive: [222, 245, 233],
  negative: [252, 228, 233],
  neutral: [236, 238, 247],
};
const SENTIMENT_PLURAL: Record<Sentiment, string> = {
  positive: "Positivos",
  negative: "Negativos",
  neutral: "Neutrales",
};

// Las fuentes estándar de PDF solo cubren WinAnsi: se quitan emojis y otros símbolos para no
// imprimir caracteres basura.
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function clean(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WINANSI_EXTRA.includes(ch)) {
      out += ch;
    } else if (/\s/.test(ch)) {
      out += " ";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function cleanComment(text: string): string {
  return clean(text) || "(solo emojis)";
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function shortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
}

type IconKind = "bubble" | "heart" | "user" | "reply" | "spark" | "question" | "calendar";

export async function renderPdfReport(input: ExportInput) {
  const [{ default: JsPDF, GState }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  const { analysis, filters, results } = input;
  const stats: ReportStats = computeReportStats(input.allResults, analysis, filters);
  const doc = new JsPDF({ unit: "px", format: [W, H], orientation: "portrait" });
  const exportedAt = new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
  let y = TOP;

  // ——— Primitivas ———

  function font(size: number, style: "normal" | "bold" | "italic" | "bolditalic" = "normal") {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
  }
  const color = (c: Rgb) => doc.setTextColor(...c);
  const fill = (c: Rgb) => doc.setFillColor(...c);
  function stroke(c: Rgb, width = 1) {
    doc.setDrawColor(...c);
    doc.setLineWidth(width);
  }

  function withOpacity(opacity: number, draw: () => void) {
    doc.saveGraphicsState();
    doc.setGState(new GState({ opacity }));
    draw();
    doc.restoreGraphicsState();
  }

  /** Rectángulo (redondeado) relleno con degradado lineal, recortado a su forma. */
  function gradient(
    x: number,
    gy: number,
    w: number,
    h: number,
    r: number,
    from: Rgb,
    to: Rgb,
    direction: "horizontal" | "vertical" | "diagonal" = "diagonal"
  ) {
    if (w <= 0 || h <= 0) return;
    doc.saveGraphicsState();
    if (r > 0) doc.roundedRect(x, gy, w, h, r, r, null);
    else doc.rect(x, gy, w, h, null);
    doc.clip();
    doc.discardPath();
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      fill(mix(from, to, i / (steps - 1)));
      if (direction === "vertical") doc.rect(x, gy + (h * i) / steps, w, h / steps + 1, "F");
      else if (direction === "horizontal") doc.rect(x + (w * i) / steps, gy, w / steps + 1, h, "F");
      else {
        // Diagonal: franjas inclinadas que cubren el rectángulo.
        const span = w + h;
        const x0 = x - h + (span * i) / steps;
        const x1 = x0 + span / steps + 1;
        doc.triangle(x0, gy + h, x1, gy + h, x1 + h, gy, "F");
        doc.triangle(x0, gy + h, x0 + h, gy, x1 + h, gy, "F");
      }
    }
    doc.restoreGraphicsState();
  }

  function card(x: number, cy: number, w: number, h: number, r = 14, c: Rgb = CARD) {
    withOpacity(0.06, () => {
      fill(BLUE);
      doc.roundedRect(x - 1, cy + 4, w + 2, h + 4, r + 2, r + 2, "F");
    });
    withOpacity(0.05, () => {
      fill(BLUE);
      doc.roundedRect(x, cy + 2, w, h + 1, r, r, "F");
    });
    fill(c);
    doc.roundedRect(x, cy, w, h, r, r, "F");
  }

  function lines(text: string, width: number, maxLines: number): string[] {
    const all: string[] = doc.splitTextToSize(text, width);
    if (all.length <= maxLines) return all;
    const kept = all.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 0 && doc.getTextWidth(`${last}…`) > width) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }

  function paragraph(text: string, x: number, py: number, width: number, lineHeight: number, maxLines = 99): number {
    const ls = lines(text, width, maxLines);
    ls.forEach((l, i) => doc.text(l, x, py + i * lineHeight));
    return py + ls.length * lineHeight;
  }

  function pill(label: string, x: number, py: number, bg: Rgb, fg: Rgb, size = 8.5, h = 18): number {
    font(size, "bold");
    const w = doc.getTextWidth(label) + 18;
    fill(bg);
    doc.roundedRect(x, py, w, h, h / 2, h / 2, "F");
    color(fg);
    doc.text(label, x + 9, py + h / 2 + size * 0.36);
    return w;
  }

  function gradientPill(label: string, x: number, py: number, w?: number, size = 9, h = 22): number {
    font(size, "bold");
    const pw = w ?? doc.getTextWidth(label) + 22;
    gradient(x, py, pw, h, h / 2, BLUE, CYAN, "horizontal");
    color(WHITE);
    doc.text(label, x + pw / 2, py + h / 2 + size * 0.36, { align: "center" });
    return pw;
  }

  function icon(kind: IconKind, cx: number, cy: number, c: Rgb) {
    fill(c);
    stroke(c, 1.3);
    doc.setLineCap("round");
    switch (kind) {
      case "bubble":
        doc.roundedRect(cx - 6, cy - 5, 12, 8.5, 2.5, 2.5, "S");
        doc.triangle(cx - 3.5, cy + 3, cx - 0.5, cy + 3, cx - 3.5, cy + 6, "F");
        break;
      case "heart":
        doc.circle(cx - 2.7, cy - 1.5, 3, "F");
        doc.circle(cx + 2.7, cy - 1.5, 3, "F");
        doc.triangle(cx - 5.6, cy - 0.5, cx + 5.6, cy - 0.5, cx, cy + 5.4, "F");
        break;
      case "user":
        doc.circle(cx, cy - 2.6, 2.8, "F");
        doc.roundedRect(cx - 5.2, cy + 1.4, 10.4, 4.8, 2.4, 2.4, "F");
        break;
      case "reply":
        doc.line(cx + 5, cy + 4.5, cx + 5, cy + 1);
        doc.line(cx + 5, cy + 1, cx - 4.5, cy + 1);
        doc.line(cx - 4.5, cy + 1, cx - 1, cy - 2.5);
        doc.line(cx - 4.5, cy + 1, cx - 1, cy + 4.5);
        break;
      case "question":
        font(11, "bold");
        color(c);
        doc.text("?", cx, cy + 4, { align: "center" });
        break;
      case "calendar":
        doc.roundedRect(cx - 5.5, cy - 4.5, 11, 10, 2, 2, "S");
        doc.line(cx - 5.5, cy - 1, cx + 5.5, cy - 1);
        doc.line(cx - 2.5, cy - 6.5, cx - 2.5, cy - 3.5);
        doc.line(cx + 2.5, cy - 6.5, cx + 2.5, cy - 3.5);
        break;
      case "spark":
        doc.setLineWidth(1.6);
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 4;
          doc.line(cx - Math.cos(a) * 5, cy - Math.sin(a) * 5, cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
        }
        break;
    }
    doc.setLineCap("butt");
  }

  function iconBadge(kind: IconKind, x: number, by: number, size = 24, onGradient = false) {
    if (onGradient) {
      withOpacity(0.22, () => {
        fill(WHITE);
        doc.roundedRect(x, by, size, size, 7, 7, "F");
      });
      icon(kind, x + size / 2, by + size / 2, WHITE);
    } else {
      fill(BLUE_SOFT);
      doc.roundedRect(x, by, size, size, 7, 7, "F");
      icon(kind, x + size / 2, by + size / 2, BLUE);
    }
  }

  function trend(label: string, x: number, ty: number, tone: Sentiment, onGradient = false) {
    const c = onGradient ? WHITE : tone === "neutral" ? MUTED : SENTIMENT_COLOR[tone];
    fill(c);
    if (tone === "positive") doc.triangle(x, ty, x + 8, ty, x + 4, ty - 7, "F");
    else if (tone === "negative") doc.triangle(x, ty - 7, x + 8, ty - 7, x + 4, ty, "F");
    else doc.circle(x + 4, ty - 3.5, 3, "F");
    font(8.5, "bold");
    color(c);
    doc.text(label, x + 13, ty);
  }

  function logo(x: number, ly: number, light = false) {
    if (light) {
      withOpacity(0.25, () => {
        fill(WHITE);
        doc.roundedRect(x, ly, 22, 22, 7, 7, "F");
      });
    } else {
      gradient(x, ly, 22, 22, 7, BLUE, CYAN);
    }
    icon("bubble", x + 11, ly + 11, WHITE);
    font(11, "bold");
    color(light ? WHITE : NAVY);
    doc.text("Comment Export", x + 30, ly + 15);
  }

  function startPage() {
    doc.addPage([W, H], "portrait");
    fill(PAGE);
    doc.rect(0, 0, W, H, "F");
    withOpacity(0.5, () => gradient(W - 260, -160, 420, 320, 160, BLUE_SOFT, PAGE));
    logo(M, 34);
    font(9);
    color(MUTED);
    doc.text(`Reporte de comentarios · ${exportedAt}`, W - M, 49, { align: "right" });
    y = TOP;
  }

  function need(h: number) {
    if (y + h > BOTTOM) startPage();
  }

  /** Título en dos tonos, como "Resumen general" con la segunda parte en azul. */
  /** `next` es el alto del primer bloque que sigue, para no dejar el título solo al pie. */
  function heading(main: string, accent: string, subtitle?: string, next = 120) {
    need((subtitle ? 90 : 70) + next);
    font(26, "bold");
    color(NAVY);
    doc.text(main, M, y + 26);
    const mw = doc.getTextWidth(`${main} `);
    color(BLUE);
    doc.text(accent, M + mw, y + 26);
    y += 36;
    if (subtitle) {
      font(10);
      color(MUTED);
      y = paragraph(subtitle, M, y + 6, CW - 120, 14, 2) + 4;
    }
    y += 16;
  }

  function cardTitle(title: string, x: number, ty: number, kind?: IconKind) {
    let tx = x;
    if (kind) {
      iconBadge(kind, x, ty - 16, 22);
      tx += 30;
    }
    font(12, "bold");
    color(NAVY);
    doc.text(title, tx, ty);
  }

  function sentimentBar(s: SentimentStats, x: number, by: number, w: number, h: number) {
    fill(LINE);
    doc.roundedRect(x, by, w, h, h / 2, h / 2, "F");
    if (s.total === 0) return;
    doc.saveGraphicsState();
    doc.roundedRect(x, by, w, h, h / 2, h / 2, null);
    doc.clip();
    doc.discardPath();
    let cursor = x;
    (["positive", "neutral", "negative"] as Sentiment[]).forEach((k) => {
      if (s[k] === 0) return;
      const sw = (s[k] / s.total) * w;
      fill(SENTIMENT_COLOR[k]);
      doc.rect(cursor, by, sw + 0.5, h, "F");
      cursor += sw;
    });
    doc.restoreGraphicsState();
  }

  function barChart(
    x: number,
    cy: number,
    w: number,
    h: number,
    categories: string[],
    series: { name: string; colors: [Rgb, Rgb]; values: number[] }[],
    opts: { valueLabels?: boolean; highlightMax?: boolean; labelEvery?: number } = {}
  ) {
    const axisW = 30;
    const labelH = 22;
    const plotX = x + axisW;
    const plotW = w - axisW;
    const plotH = h - labelH;
    const all = series.flatMap((s) => s.values);
    const max = niceMax(Math.max(1, ...all));
    const maxValue = Math.max(...all);

    font(8);
    for (let i = 0; i <= 4; i++) {
      const gy = cy + plotH - (plotH * i) / 4;
      stroke(LINE, 0.8);
      doc.setLineDashPattern(i === 0 ? [] : [3, 3], 0);
      doc.line(plotX, gy, x + w, gy);
      color(FAINT);
      doc.text(formatNumber(Math.round((max * i) / 4)), plotX - 8, gy + 3, { align: "right" });
    }
    doc.setLineDashPattern([], 0);

    const groupW = plotW / categories.length;
    const barW = Math.max(3, Math.min(30, (groupW * 0.66) / series.length));
    const gap = series.length > 1 ? Math.min(4, barW * 0.18) : 0;
    let peak: { x: number; y: number; value: number } | null = null;
    categories.forEach((cat, ci) => {
      const inner = series.length * barW + (series.length - 1) * gap;
      let bx = plotX + ci * groupW + (groupW - inner) / 2;
      series.forEach((s) => {
        const v = s.values[ci] ?? 0;
        const bh = (v / max) * plotH;
        if (bh > 0) {
          gradient(bx, cy + plotH - bh, barW, bh, Math.min(barW / 2, 5, bh / 2), s.colors[0], s.colors[1], "vertical");
          if (opts.valueLabels) {
            font(8, "bold");
            color(TEXT);
            doc.text(formatNumber(v), bx + barW / 2, cy + plotH - bh - 6, { align: "center" });
          }
          if (opts.highlightMax && v === maxValue && !peak) peak = { x: bx + barW / 2, y: cy + plotH - bh, value: v };
        }
        bx += barW + gap;
      });
      if (!opts.labelEvery || ci % opts.labelEvery === 0 || ci === categories.length - 1) {
        font(8.5, series.length > 1 ? "bold" : "normal");
        color(series.length > 1 ? TEXT : MUTED);
        doc.text(cat, plotX + ci * groupW + groupW / 2, cy + plotH + 15, { align: "center" });
      }
    });

    const p = peak as { x: number; y: number; value: number } | null;
    if (p) {
      const bw = 70;
      const bh = 34;
      const bx = Math.min(Math.max(p.x - bw / 2, plotX), x + w - bw);
      const by = Math.max(cy - 6, p.y - bh - 12);
      card(bx, by, bw, bh, 8);
      fill(CARD);
      doc.triangle(p.x - 5, by + bh - 0.5, p.x + 5, by + bh - 0.5, p.x, by + bh + 6, "F");
      font(13, "bold");
      color(BLUE);
      doc.text(String(p.value), bx + 10, by + 17);
      font(7.5);
      color(MUTED);
      doc.text("Pico", bx + 10, by + 28);
    }
  }

  function legend(items: { name: string; color: Rgb }[], rightX: number, ly: number) {
    font(8.5);
    let x = rightX - items.reduce((s, it) => s + doc.getTextWidth(it.name) + 26, 0);
    items.forEach((it) => {
      fill(it.color);
      doc.roundedRect(x, ly - 7, 9, 9, 2.5, 2.5, "F");
      color(MUTED);
      doc.text(it.name, x + 13, ly);
      x += doc.getTextWidth(it.name) + 26;
    });
  }

  const userLabel = (c: CommentItem) => `@${clean(c.username)}`;

  // ——— Portada ———

  gradient(0, 0, W, H, 0, [72, 84, 226], [86, 206, 232], "diagonal");
  withOpacity(0.1, () => {
    fill(WHITE);
    doc.circle(W - 90, 260, 230, "F");
    doc.circle(W - 40, 860, 160, "F");
    doc.circle(80, 1040, 120, "F");
  });
  // Ilustración: monitor con una burbuja de comentario, en líneas finas.
  withOpacity(0.32, () => {
    stroke(WHITE, 2);
    doc.roundedRect(430, 440, 300, 200, 16, 16, "S");
    doc.line(560, 640, 550, 690);
    doc.line(600, 640, 610, 690);
    doc.line(520, 690, 640, 690);
    doc.roundedRect(470, 480, 130, 80, 14, 14, "S");
    doc.line(500, 560, 492, 584);
    doc.line(492, 584, 520, 560);
    doc.line(620, 500, 700, 500);
    doc.line(620, 520, 690, 520);
    doc.line(620, 540, 670, 540);
    for (let i = 0; i < 6; i++) doc.roundedRect(474 + i * 38, 600 - i * 6 - 10, 20, 20 + i * 6, 4, 4, "S");
  });
  logo(M + 8, 60, true);
  font(54, "bold");
  color(WHITE);
  doc.text("Reporte de", M + 8, 300);
  doc.text("comentarios", M + 8, 360);
  font(14);
  withOpacity(0.85, () => {
    color(WHITE);
    paragraph(
      `Análisis de la conversación en ${stats.videos.length} ${stats.videos.length === 1 ? "video" : "videos"} de Instagram: sentimiento, temas, actividad y comentarios destacados.`,
      M + 8,
      398,
      340,
      20
    );
  });

  // Tarjetas "de vidrio" con los números principales
  const coverStats: [string, string][] = [
    [formatNumber(stats.totalComments), "Comentarios"],
    [formatNumber(stats.uniqueUsers), "Personas"],
    [stats.sentiment && stats.sentiment.total > 0 ? percent(stats.sentiment.positive, stats.sentiment.total) : formatNumber(stats.totalLikes), stats.sentiment ? "Positivos" : "Likes"],
  ];
  coverStats.forEach(([value, label], i) => {
    const gx = M + 8 + i * 118;
    withOpacity(0.18, () => {
      fill(WHITE);
      doc.roundedRect(gx, 780, 106, 84, 14, 14, "F");
    });
    font(24, "bold");
    color(WHITE);
    doc.text(value, gx + 14, 822);
    font(9.5);
    doc.text(label, gx + 14, 844);
  });

  withOpacity(0.16, () => {
    fill(WHITE);
    doc.rect(0, H - 120, W, 120, "F");
  });
  font(9);
  color(WHITE);
  doc.text("Preparado con", M + 8, H - 74);
  doc.text("Fecha", W - M - 8, H - 74, { align: "right" });
  font(12, "bold");
  doc.text("Comment Export", M + 8, H - 54);
  doc.text(exportedAt, W - M - 8, H - 54, { align: "right" });
  if (input.activeFilterLabel) {
    font(9);
    doc.text(`Listados filtrados: ${clean(input.activeFilterLabel)}`, W / 2, H - 54, { align: "center" });
  }

  // ——— Resumen general ———

  startPage();
  heading("Resumen", "general", "Indicadores calculados sobre todos los comentarios obtenidos.");

  const kpis: { icon: IconKind; label: string; value: string; trend: [string, Sentiment]; note: string }[] = [
    {
      icon: "bubble",
      label: "Comentarios",
      value: formatNumber(stats.totalComments),
      trend: [`${stats.videos.length} ${stats.videos.length === 1 ? "video" : "videos"}`, "neutral"],
      note: `${stats.topLevel} principales y ${stats.replies} respuestas.`,
    },
    {
      icon: "heart",
      label: "Likes en comentarios",
      value: formatNumber(stats.totalLikes),
      trend: [`${stats.avgLikes.toFixed(1).replace(".", ",")} por comentario`, "positive"],
      note: "Suma de likes que recibieron los comentarios.",
    },
    {
      icon: "user",
      label: "Personas alcanzadas",
      value: formatNumber(stats.uniqueUsers),
      trend: [`${stats.repeatUsers} repiten`, stats.repeatUsers > 0 ? "positive" : "neutral"],
      note: "Cuentas distintas que comentaron.",
    },
    {
      icon: "reply",
      label: "Respuestas",
      value: formatNumber(stats.replies),
      trend: [`${percent(stats.replies, stats.totalComments)} del total`, stats.replyRate >= 0.15 ? "positive" : "neutral"],
      note: "Comentarios que responden a otro comentario.",
    },
    {
      icon: "question",
      label: "Preguntas sin respuesta",
      value: String(stats.unansweredQuestions),
      trend: [stats.unansweredQuestions > 0 ? "a responder" : "al día", stats.unansweredQuestions > 0 ? "negative" : "positive"],
      note: "Comentarios con \"?\" que nadie respondió.",
    },
  ];
  const highlight =
    stats.sentiment && stats.netSentiment !== null
      ? {
          icon: "spark" as IconKind,
          label: "Sentimiento neto",
          value: `${stats.netSentiment > 0 ? "+" : ""}${stats.netSentiment}`,
          trend: [
            `${percent(stats.sentiment.positive, stats.sentiment.total)} positivos`,
            stats.netSentiment > 0 ? "positive" : stats.netSentiment < 0 ? "negative" : "neutral",
          ] as [string, Sentiment],
          note: "% de positivos menos % de negativos.",
        }
      : {
          icon: "heart" as IconKind,
          label: "Promedio de likes",
          value: stats.avgLikes.toFixed(1).replace(".", ","),
          trend: ["por comentario", "neutral"] as [string, Sentiment],
          note: "Analizá los comentarios para sumar sentimiento.",
        };

  const kGap = 14;
  const kW = (CW - kGap * 2) / 3;
  const kH = 136;
  [...kpis, highlight].forEach((k, i) => {
    const kx = M + (i % 3) * (kW + kGap);
    const ky = y + Math.floor(i / 3) * (kH + kGap);
    const isHighlight = i === 5;
    if (isHighlight) {
      card(kx, ky, kW, kH);
      gradient(kx, ky, kW, kH, 14, BLUE, CYAN);
      withOpacity(0.12, () => {
        fill(WHITE);
        doc.circle(kx + kW - 20, ky + 10, 46, "F");
      });
    } else {
      card(kx, ky, kW, kH);
    }
    iconBadge(k.icon, kx + 16, ky + 16, 24, isHighlight);
    font(9.5, "bold");
    color(isHighlight ? WHITE : MUTED);
    doc.text(k.label, kx + 48, ky + 32);
    font(k.value.length > 6 ? 26 : 32, "bold");
    color(isHighlight ? WHITE : NAVY);
    doc.text(k.value, kx + 16, ky + 84);
    trend(k.trend[0], kx + 16, ky + 104, k.trend[1], isHighlight);
    font(8);
    color(isHighlight ? WHITE : FAINT);
    doc.text(lines(k.note, kW - 32, 1)[0], kx + 16, ky + 122);
  });
  y += kH * 2 + kGap + 24;

  // Puntos clave
  {
    font(10.5);
    const bodies = stats.takeaways.map((t) => lines(clean(t), CW - 72, 3));
    const h = 58 + bodies.reduce((s, b) => s + b.length * 15 + 10, 0);
    need(h);
    card(M, y, CW, h);
    cardTitle("Puntos clave", M + 20, y + 34, "spark");
    let ty = y + 64;
    bodies.forEach((b) => {
      gradient(M + 22, ty - 8, 8, 8, 4, BLUE, CYAN);
      font(10.5);
      color(TEXT);
      b.forEach((l, li) => doc.text(l, M + 40, ty + li * 15));
      ty += b.length * 15 + 10;
    });
    y += h + 20;
  }

  // Distribución del sentimiento
  if (stats.sentiment && stats.sentiment.total > 0) {
    const s = stats.sentiment;
    need(190);
    card(M, y, CW, 172);
    cardTitle("Distribución del sentimiento", M + 20, y + 34, "spark");
    font(9);
    color(MUTED);
    doc.text(`${s.total} comentarios clasificados`, W - M - 20, y + 34, { align: "right" });
    const colW = (CW - 40) / 3;
    (["positive", "neutral", "negative"] as Sentiment[]).forEach((k, i) => {
      const cx = M + 20 + i * colW;
      fill(SENTIMENT_SOFT[k]);
      doc.roundedRect(cx, y + 54, colW - 14, 66, 12, 12, "F");
      font(26, "bold");
      color(k === "neutral" ? TEXT : SENTIMENT_COLOR[k]);
      doc.text(percent(s[k], s.total), cx + 14, y + 90);
      font(9);
      color(MUTED);
      doc.text(`${SENTIMENT_PLURAL[k]} · ${s[k]}`, cx + 14, y + 108);
    });
    sentimentBar(s, M + 20, y + 140, CW - 40, 10);
    y += 192;
  }

  // ——— Rendimiento por video ———

  heading("Rendimiento", "por video", "Comparativa de indicadores entre los videos analizados.", 300);
  {
    const chartVideos = stats.videos.slice(0, 12);
    need(300);
    card(M, y, CW, 280);
    cardTitle("Comentarios por video", M + 20, y + 34, "bubble");
    legend([{ name: "Comentarios", color: BLUE }], W - M - 20, y + 32);
    barChart(
      M + 20,
      y + 62,
      CW - 40,
      200,
      chartVideos.map((v) => `Video ${v.index + 1}`),
      [{ name: "Comentarios", colors: [BLUE, CYAN], values: chartVideos.map((v) => v.comments) }],
      { valueLabels: true }
    );
    y += 300;

    // Tabla en tarjetas
    const cols: { label: string; value: (v: (typeof stats.videos)[number]) => string }[] = [
      { label: "Comentarios", value: (v) => formatNumber(v.comments) },
      { label: "Respuestas", value: (v) => formatNumber(v.replies) },
      { label: "Likes", value: (v) => formatNumber(v.likes) },
      { label: "Personas", value: (v) => formatNumber(v.uniqueUsers) },
    ];
    if (analysis) {
      cols.push({ label: "% Positivo", value: (v) => (v.sentiment ? percent(v.sentiment.positive, v.sentiment.total) : "—") });
      cols.push({ label: "% Negativo", value: (v) => (v.sentiment ? percent(v.sentiment.negative, v.sentiment.total) : "—") });
    }
    const nameW = 190;
    const colW = (CW - 40 - nameW) / cols.length;
    const drawHead = () => {
      font(8.5, "bold");
      color(MUTED);
      doc.text("VIDEO", M + 20, y + 4);
      cols.forEach((c, ci) => doc.text(c.label.toUpperCase(), M + 20 + nameW + ci * colW + colW / 2, y + 4, { align: "center" }));
      y += 14;
    };
    need(70);
    drawHead();
    stats.videos.forEach((v) => {
      if (y + 50 > BOTTOM) {
        startPage();
        drawHead();
      }
      card(M, y, CW, 44, 12);
      gradient(M + 14, y + 10, 24, 24, 8, BLUE, CYAN);
      font(10, "bold");
      color(WHITE);
      doc.text(String(v.index + 1), M + 26, y + 26, { align: "center" });
      font(10, "bold");
      color(NAVY);
      doc.text(lines(clean(v.shortcode), nameW - 50, 1)[0], M + 48, y + 26);
      cols.forEach((c, ci) => {
        const isNeg = c.label === "% Negativo";
        const isPos = c.label === "% Positivo";
        font(11, isPos || isNeg ? "bold" : "normal");
        color(isPos ? SENTIMENT_COLOR.positive : isNeg ? SENTIMENT_COLOR.negative : TEXT);
        doc.text(c.value(v), M + 20 + nameW + ci * colW + colW / 2, y + 26, { align: "center" });
      });
      y += 52;
    });
    y += 14;

    // Sentimiento por video (o respuestas y personas sin análisis)
    const series = analysis
      ? (["positive", "neutral", "negative"] as Sentiment[]).map((k) => ({
          name: SENTIMENT_PLURAL[k],
          colors: (k === "positive" ? [BLUE, CYAN] : k === "neutral" ? [[196, 202, 236], [226, 230, 248]] : [[236, 84, 108], [248, 160, 176]]) as [Rgb, Rgb],
          values: chartVideos.map((v) => v.sentiment?.[k] ?? 0),
        }))
      : [
          { name: "Respuestas", colors: [BLUE, CYAN] as [Rgb, Rgb], values: chartVideos.map((v) => v.replies) },
          { name: "Personas", colors: [[160, 168, 236], [214, 219, 250]] as [Rgb, Rgb], values: chartVideos.map((v) => v.uniqueUsers) },
        ];
    need(300);
    card(M, y, CW, 280);
    cardTitle(analysis ? "Sentimiento por video" : "Respuestas y personas por video", M + 20, y + 34, analysis ? "spark" : "reply");
    legend(series.map((s) => ({ name: s.name, color: s.colors[0] })), W - M - 20, y + 32);
    barChart(M + 20, y + 62, CW - 40, 200, chartVideos.map((v) => `Video ${v.index + 1}`), series);
    y += 300;
  }

  // ——— Temas ———

  if (stats.topics.length > 0) {
    heading("Temas de", "conversación", "Filtros personalizados y cómo se habla de cada uno.", 212);
    const tW = (CW - 16) / 2;
    const tH = 196;
    stats.topics.forEach((t, i) => {
      const col = i % 2;
      if (col === 0) need(tH + 16);
      const tx = M + col * (tW + 16);
      card(tx, y, tW, tH);
      font(15, "bold");
      color(NAVY);
      doc.text(lines(clean(t.filter.name), tW - 130, 1)[0], tx + 18, y + 34);
      font(9, "bold");
      const label = `${t.count} comentarios`;
      gradientPill(label, tx + tW - 18 - (doc.getTextWidth(label) + 22), y + 20);
      font(9);
      color(MUTED);
      paragraph(clean(t.filter.description), tx + 18, y + 54, tW - 36, 12, 2);
      const share = percent(t.count, stats.totalComments);
      font(28, "bold");
      color(BLUE);
      doc.text(share, tx + 18, y + 108);
      const sw = doc.getTextWidth(share);
      font(9);
      color(MUTED);
      doc.text("de la conversación", tx + 24 + sw, y + 108);
      sentimentBar(t.sentiment, tx + 18, y + 122, tW - 36, 8);
      font(8);
      color(MUTED);
      doc.text(`${t.sentiment.positive} positivos · ${t.sentiment.neutral} neutrales · ${t.sentiment.negative} negativos`, tx + 18, y + 144);
      fill(SOFT);
      doc.roundedRect(tx + 12, y + 154, tW - 24, 32, 10, 10, "F");
      font(9, "italic");
      color(t.topComment ? TEXT : FAINT);
      doc.text(
        lines(t.topComment ? `"${cleanComment(t.topComment.text)}"` : "Ningún comentario trata este tema.", tW - 48, 1)[0],
        tx + 24,
        y + 174
      );
      if (col === 1 || i === stats.topics.length - 1) y += tH + 16;
    });
    y += 8;
  }

  // ——— Comentarios destacados ———

  if (stats.topComments.length > 0) {
    heading("Comentarios", "destacados", "Los comentarios con más likes y las personas que más participaron.", 260);
    const [first, ...rest] = stats.topComments;
    need(260);
    card(M, y, CW, 240);
    doc.saveGraphicsState();
    doc.roundedRect(M, y, CW, 240, 14, 14, null);
    doc.clip();
    doc.discardPath();
    gradient(M, y, 200, 240, 0, BLUE, CYAN);
    withOpacity(0.15, () => {
      fill(WHITE);
      doc.circle(M + 40, y + 200, 60, "F");
    });
    doc.restoreGraphicsState();
    font(90, "bold");
    color(WHITE);
    doc.text("“", M + 30, y + 110);
    font(10, "bold");
    doc.text("#1 MÁS APOYADO", M + 24, y + 150);
    font(30, "bold");
    doc.text(formatNumber(first.comment.likeCount ?? 0), M + 24, y + 196);
    font(9);
    doc.text("likes", M + 24, y + 214);

    const rx = M + 222;
    const rw = CW - 222 - 20;
    font(12, "bold");
    color(NAVY);
    doc.text(userLabel(first.comment), rx, y + 34);
    font(9);
    color(MUTED);
    doc.text(`Video #${first.videoIndex + 1} · ${formatDate(first.comment.timestamp)}`, W - M - 20, y + 34, { align: "right" });
    font(13, "italic");
    color(TEXT);
    paragraph(cleanComment(first.comment.text), rx, y + 62, rw, 18, 4);
    const sentimentOf = analysis?.[first.comment.commentId]?.sentiment;
    const mets: [string, string, IconKind][] = [
      [formatNumber(first.comment.likeCount ?? 0), "Likes", "heart"],
      [String(first.replies), "Respuestas", "reply"],
      [sentimentOf ? SENTIMENT_LABELS[sentimentOf] : "—", "Sentimiento", "spark"],
    ];
    const mw = (rw - 20) / 3;
    mets.forEach(([value, label, ic], i) => {
      const mx = rx + i * (mw + 10);
      fill(SOFT);
      doc.roundedRect(mx, y + 152, mw, 68, 12, 12, "F");
      iconBadge(ic, mx + 12, y + 164, 20);
      font(8.5);
      color(MUTED);
      doc.text(label, mx + 40, y + 178);
      font(value.length > 6 ? 13 : 18, "bold");
      color(ic === "spark" && sentimentOf ? (sentimentOf === "neutral" ? TEXT : SENTIMENT_COLOR[sentimentOf]) : NAVY);
      doc.text(value, mx + 12, y + 208);
    });
    y += 260;

    if (rest.length > 0) {
      const sW = (CW - 16) / 2;
      need(140);
      rest.forEach((t, i) => {
        const sx = M + i * (sW + 16);
        card(sx, y, sW, 124);
        gradientPill(`#${i + 2}`, sx + 16, y + 16, 34, 9, 20);
        font(11, "bold");
        color(NAVY);
        doc.text(userLabel(t.comment), sx + 58, y + 30);
        trend(`${formatNumber(t.comment.likeCount ?? 0)} likes`, sx + sW - 80, y + 31, "positive");
        font(10, "italic");
        color(TEXT);
        paragraph(cleanComment(t.comment.text), sx + 16, y + 60, sW - 32, 15, 4);
      });
      y += 144;
    }

    // Personas más activas
    const users = stats.topUsers;
    if (users.length > 0) {
      const h = 66 + users.length * 34;
      need(h + 20);
      card(M, y, CW, h);
      cardTitle("Personas más activas", M + 20, y + 34, "user");
      const maxCount = Math.max(...users.map((u) => u.count));
      users.forEach((u, i) => {
        const uy = y + 56 + i * 34;
        font(10, "bold");
        color(NAVY);
        doc.text(lines(`@${clean(u.username)}`, 170, 1)[0], M + 20, uy + 14);
        const bx = M + 210;
        const bw = CW - 210 - 150;
        fill(SOFT);
        doc.roundedRect(bx, uy + 4, bw, 12, 6, 6, "F");
        gradient(bx, uy + 4, Math.max(12, (bw * u.count) / maxCount), 12, 6, BLUE, CYAN, "horizontal");
        font(9.5);
        color(TEXT);
        doc.text(`${u.count} comentarios · ${formatNumber(u.likes)} likes`, W - M - 20, uy + 14, { align: "right" });
      });
      y += h + 20;
    }
  }

  // ——— Actividad ———

  if (stats.peakDays.length > 0) {
    heading("Días de mayor", "actividad", "Fechas con más comentarios y evolución de la conversación.", 150);
    const dGap = 12;
    const dW = (CW - dGap * 3) / 4;
    const ranked = [...stats.peakDays].sort((a, b) => b.count - a.count);
    need(150);
    stats.peakDays.forEach((d, i) => {
      const dx = M + i * (dW + dGap);
      const top = ranked[0] === d;
      card(dx, y, dW, 132);
      if (top) gradient(dx, y, dW, 132, 14, BLUE, CYAN);
      iconBadge("calendar", dx + 14, y + 14, 22, top);
      font(9, "bold");
      color(top ? WHITE : MUTED);
      doc.text(WEEKDAYS[d.date.getDay()], dx + 44, y + 29);
      font(26, "bold");
      color(top ? WHITE : NAVY);
      doc.text(shortDate(d.date), dx + 14, y + 76);
      trend(`${d.count} comentarios`, dx + 14, y + 98, top ? "positive" : "neutral", top);
      font(8);
      color(top ? WHITE : FAINT);
      doc.text(top ? "Pico de actividad" : `${ranked.indexOf(d) + 1}º día más activo · ${percent(d.count, stats.totalComments)}`, dx + 14, y + 118);
    });
    y += 150;

    // Evolución diaria (o semanal si el período es largo)
    const firstDay = stats.days[0].date;
    const lastDay = stats.days[stats.days.length - 1].date;
    const spanDays = Math.round((lastDay.getTime() - firstDay.getTime()) / 86_400_000) + 1;
    const weekly = spanDays > 45;
    const counts = new Map(stats.days.map((d) => [d.key, d.count]));
    const step = weekly ? 7 : 1;
    const buckets: { label: string; count: number }[] = [];
    for (let t = firstDay.getTime(); t <= lastDay.getTime(); t += step * 86_400_000) {
      let count = 0;
      for (let k = 0; k < step; k++) {
        const d = new Date(t + k * 86_400_000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        count += counts.get(key) ?? 0;
      }
      buckets.push({ label: shortDate(new Date(t)), count });
    }
    const shown = buckets.slice(-40);
    need(300);
    card(M, y, CW, 280);
    cardTitle(weekly ? "Comentarios por semana" : "Comentarios por día", M + 20, y + 34, "calendar");
    barChart(
      M + 20,
      y + 70,
      CW - 40,
      192,
      shown.map((b) => b.label),
      [{ name: "Comentarios", colors: [BLUE, CYAN], values: shown.map((b) => b.count) }],
      { highlightMax: true, labelEvery: Math.ceil(shown.length / 8) }
    );
    y += 300;
  }

  // ——— Notas y recomendaciones ———

  {
    const colW = (CW - 16) / 2;
    const columns: [string, string[], Sentiment][] = [
      ["Lo que funciona", stats.strengths.length ? stats.strengths : ["Todavía no hay suficientes datos para destacar fortalezas."], "positive"],
      ["Puntos a atender", stats.attention.length ? stats.attention : ["No se detectaron alertas en los comentarios analizados."], "negative"],
    ];
    font(10.5);
    const heights = columns.map(([, items]) => 60 + items.reduce((s, it) => s + lines(clean(it), colW - 70, 4).length * 15 + 30, 0));
    const h = Math.max(...heights);
    heading("Notas y", "recomendaciones", "Observaciones generadas automáticamente a partir de los datos.", h + 20);
    columns.forEach(([title, items, tone], ci) => {
      const cx = M + ci * (colW + 16);
      card(cx, y, colW, h);
      if (ci === 0) gradientPill(title, cx + 18, y + 18, undefined, 10, 26);
      else pill(title, cx + 18, y + 18, SENTIMENT_SOFT.negative, SENTIMENT_COLOR.negative, 10, 26);
      let iy = y + 64;
      items.forEach((item) => {
        font(10.5);
        const ls = lines(clean(item), colW - 70, 4);
        const ih = ls.length * 15 + 18;
        fill(SOFT);
        doc.roundedRect(cx + 14, iy, colW - 28, ih, 10, 10, "F");
        fill(SENTIMENT_COLOR[tone]);
        if (tone === "positive") doc.triangle(cx + 26, iy + 19, cx + 34, iy + 19, cx + 30, iy + 12, "F");
        else doc.triangle(cx + 26, iy + 12, cx + 34, iy + 12, cx + 30, iy + 19, "F");
        color(TEXT);
        font(10.5);
        ls.forEach((l, li) => doc.text(l, cx + 44, iy + 19 + li * 15));
        iy += ih + 12;
      });
    });
    y += h + 20;
  }

  // ——— Listados de comentarios ———

  const tableBase = {
    theme: "plain" as const,
    margin: { left: M, right: M, top: TOP, bottom: H - BOTTOM },
    styles: {
      font: "helvetica",
      fontSize: 8.5,
      cellPadding: { top: 8, bottom: 8, left: 9, right: 9 },
      textColor: TEXT,
      fillColor: CARD,
      lineColor: LINE,
      lineWidth: { bottom: 1 },
      overflow: "linebreak" as const,
      valign: "middle" as const,
    },
    headStyles: { fillColor: BLUE, textColor: WHITE, fontStyle: "bold" as const, fontSize: 8.5, lineWidth: 0 },
  };

  function tableHooks() {
    const startPageNo = doc.getNumberOfPages();
    return {
      willDrawPage: () => {
        if (doc.getNumberOfPages() > startPageNo) {
          fill(PAGE);
          doc.rect(0, 0, W, H, "F");
          logo(M, 34);
          font(9);
          color(MUTED);
          doc.text(`Reporte de comentarios · ${exportedAt}`, W - M, 49, { align: "right" });
        }
      },
    };
  }

  type CellData = {
    section: string;
    column: { index: number };
    cell: { raw: unknown; styles: { textColor: unknown; fontStyle: unknown } };
  };
  const styleCells = (sentimentColumn: number | null) => (data: CellData) => {
    if (data.section !== "body") return;
    if (data.column.index === 0 && typeof data.cell.raw === "string" && data.cell.raw.startsWith("»")) {
      data.cell.styles.textColor = MUTED;
      data.cell.styles.fontStyle = "italic";
    }
    if (sentimentColumn !== null && data.column.index === sentimentColumn) {
      const entry = (Object.entries(SENTIMENT_LABELS) as [Sentiment, string][]).find(([, l]) => l === data.cell.raw);
      if (entry) {
        data.cell.styles.textColor = entry[0] === "neutral" ? MUTED : SENTIMENT_COLOR[entry[0]];
        data.cell.styles.fontStyle = "bold";
      }
    }
  };
  const finalY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  const usedFilters = analysis ? filters : [];
  for (const f of usedFilters) {
    const rows: string[][] = [];
    results.forEach((r, videoIndex) => {
      for (const c of r.comments) {
        const a = analysis?.[c.commentId];
        if (!a?.filterIds.includes(f.id)) continue;
        rows.push([`${c.parentCommentId ? "» " : ""}@${clean(c.username)}`, cleanComment(c.text), `#${videoIndex + 1}`, SENTIMENT_LABELS[a.sentiment]]);
      }
    });
    if (rows.length === 0) continue;
    heading("Tema:", clean(f.name), `${rows.length} comentarios · ${clean(f.description)}`, 90);
    autoTable(doc, {
      ...tableBase,
      ...tableHooks(),
      head: [["Usuario", "Comentario", "Video", "Sentimiento"]],
      body: rows,
      startY: y,
      columnStyles: {
        0: { cellWidth: 130 },
        1: { cellWidth: CW - 130 - 50 - 80 },
        2: { cellWidth: 50 },
        3: { cellWidth: 80 },
      },
      didParseCell: styleCells(3),
    });
    y = finalY() + 30;
  }

  const withTopics = analysis !== null && usedFilters.length > 0;
  results.forEach((result, videoIndex) => {
    if (result.comments.length === 0) return;
    heading("Comentarios del", `video #${videoIndex + 1}`, `${result.comments.length} comentarios · ${clean(result.url)}`, 90);
    const head = ["Usuario", "Comentario", "Fecha", "Likes"];
    if (analysis) head.push("Sentimiento");
    if (withTopics) head.push("Temas");
    const body = result.comments.map((c) => {
      const row = [
        `${c.parentCommentId ? "» " : ""}@${clean(c.username)}`,
        cleanComment(c.text),
        formatDate(c.timestamp),
        c.likeCount != null ? String(c.likeCount) : "—",
      ];
      if (analysis) {
        const s = analysis[c.commentId]?.sentiment;
        row.push(s ? SENTIMENT_LABELS[s] : "—");
      }
      if (withTopics) {
        const ids = analysis?.[c.commentId]?.filterIds ?? [];
        row.push(usedFilters.filter((f) => ids.includes(f.id)).map((f) => clean(f.name)).join(", ") || "—");
      }
      return row;
    });
    autoTable(doc, {
      ...tableBase,
      ...tableHooks(),
      head: [head],
      body,
      startY: y,
      columnStyles: {
        0: { cellWidth: 112 },
        1: { cellWidth: CW - 112 - 70 - 38 - (analysis ? 70 : 0) - (withTopics ? 90 : 0) },
        2: { cellWidth: 70 },
        3: { cellWidth: 38, halign: "right" },
        4: { cellWidth: 70 },
        5: { cellWidth: 90 },
      },
      didParseCell: styleCells(analysis ? 4 : null),
    });
    y = finalY() + 30;
  });

  // Pies de página
  const total = doc.getNumberOfPages();
  for (let i = 2; i <= total; i++) {
    doc.setPage(i);
    stroke(LINE, 1);
    doc.line(M, H - 44, W - M, H - 44);
    font(8.5);
    color(MUTED);
    doc.text("Comment Export · Reporte de comentarios de Instagram", M, H - 26);
    font(8.5, "bold");
    color(BLUE);
    doc.text(`${String(i - 1).padStart(2, "0")} / ${String(total - 1).padStart(2, "0")}`, W - M, H - 26, { align: "right" });
  }

  doc.save(`reporte-comentarios-instagram-${Date.now()}.pdf`);
}
