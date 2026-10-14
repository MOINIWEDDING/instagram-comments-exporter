import { SENTIMENT_LABELS, percent, type SentimentStats } from "./analysis";
import { computeReportStats, formatNumber, type ReportStats } from "./report-stats";
import type { CommentItem, Sentiment } from "./types";
import type { ExportInput } from "./export";

// Reporte PDF con estética editorial: fondo gris cálido, tinta negra, tonos taupe, tarjetas
// blancas redondeadas, pills negras y acentos en serif itálica.

type Rgb = [number, number, number];

const W = 1280;
const H = 720;
const M = 56;
const CW = W - M * 2;

const BG: Rgb = [233, 230, 225];
const CARD: Rgb = [250, 249, 247];
const INK: Rgb = [22, 21, 20];
const MUTED: Rgb = [118, 113, 106];
const FAINT: Rgb = [165, 159, 151];
const LINE: Rgb = [218, 213, 206];
const TAUPE_DARK: Rgb = [140, 123, 102];
const TAUPE: Rgb = [181, 164, 143];
const TAUPE_LIGHT: Rgb = [214, 204, 191];
const ON_DARK: Rgb = [236, 233, 228];
const ON_DARK_MUTED: Rgb = [150, 146, 140];

const SENTIMENT_COLOR: Record<Sentiment, Rgb> = {
  positive: [111, 143, 94],
  negative: [181, 87, 75],
  neutral: [196, 188, 178],
};
const SENTIMENT_BG: Record<Sentiment, Rgb> = {
  positive: [221, 232, 214],
  negative: [242, 221, 216],
  neutral: [226, 222, 216],
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
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

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

export async function renderPdfReport(input: ExportInput) {
  const [{ default: JsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  const { analysis, filters, results } = input;
  const stats: ReportStats = computeReportStats(input.allResults, analysis, filters);
  const doc = new JsPDF({ unit: "px", format: [W, H], orientation: "landscape" });
  const footers = new Map<number, string>();
  let firstPage = true;
  let sectionNumber = 0;

  // ——— Primitivas ———

  function font(size: number, style: "normal" | "bold" | "italic" = "normal", family = "helvetica") {
    doc.setFont(family, style);
    doc.setFontSize(size);
  }

  function color(c: Rgb) {
    doc.setTextColor(...c);
  }

  function fill(c: Rgb) {
    doc.setFillColor(...c);
  }

  function stroke(c: Rgb, width = 1) {
    doc.setDrawColor(...c);
    doc.setLineWidth(width);
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

  function paragraph(text: string, x: number, y: number, width: number, lineHeight: number, maxLines = 99): number {
    const ls = lines(text, width, maxLines);
    ls.forEach((l, i) => doc.text(l, x, y + i * lineHeight));
    return y + ls.length * lineHeight;
  }

  function card(x: number, y: number, w: number, h: number, c: Rgb = CARD, r = 16) {
    fill(c);
    doc.roundedRect(x, y, w, h, r, r, "F");
  }

  /** Dibuja una pill y devuelve su ancho. `x` es el borde izquierdo (o el centro si center). */
  function pill(
    label: string,
    x: number,
    y: number,
    opts: { bg?: Rgb; fg?: Rgb; outline?: Rgb; size?: number; h?: number; w?: number; center?: boolean; bold?: boolean } = {}
  ): number {
    const size = opts.size ?? 10;
    const h = opts.h ?? size * 2.2;
    font(size, opts.bold ? "bold" : "normal");
    const w = opts.w ?? doc.getTextWidth(label) + size * 2.2;
    const left = opts.center ? x - w / 2 : x;
    if (opts.bg) {
      fill(opts.bg);
      doc.roundedRect(left, y, w, h, h / 2, h / 2, "F");
    }
    if (opts.outline) {
      stroke(opts.outline, 1);
      doc.roundedRect(left, y, w, h, h / 2, h / 2, "S");
    }
    color(opts.fg ?? INK);
    doc.text(label, left + w / 2, y + h / 2 + size * 0.36, { align: "center" });
    return w;
  }

  function asterisk(cx: number, cy: number, r: number, c: Rgb) {
    stroke(c, r * 0.42);
    doc.setLineCap("round");
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 4;
      doc.line(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    doc.setLineCap("butt");
  }

  function arrowBadge(cx: number, cy: number, c: Rgb = INK) {
    stroke(c, 1.2);
    doc.circle(cx, cy, 17, "S");
    doc.setLineCap("round");
    doc.line(cx + 5, cy - 5, cx - 5, cy + 5);
    doc.line(cx - 5, cy + 5, cx - 5, cy - 1);
    doc.line(cx - 5, cy + 5, cx + 1, cy + 5);
    doc.setLineCap("butt");
  }

  function icon(kind: "bubble" | "heart" | "user" | "reply" | "spark", cx: number, cy: number, c: Rgb = INK) {
    fill(c);
    stroke(c, 1.4);
    doc.setLineCap("round");
    switch (kind) {
      case "bubble":
        doc.roundedRect(cx - 7, cy - 6, 14, 10, 3, 3, "S");
        doc.triangle(cx - 4, cy + 3.5, cx - 1, cy + 3.5, cx - 4, cy + 7, "F");
        break;
      case "heart":
        doc.circle(cx - 3.1, cy - 1.8, 3.4, "F");
        doc.circle(cx + 3.1, cy - 1.8, 3.4, "F");
        doc.triangle(cx - 6.4, cy - 0.6, cx + 6.4, cy - 0.6, cx, cy + 6.2, "F");
        break;
      case "user":
        doc.circle(cx, cy - 3, 3.2, "F");
        doc.roundedRect(cx - 6, cy + 1.6, 12, 5.6, 2.8, 2.8, "F");
        break;
      case "reply":
        doc.line(cx + 6, cy + 5, cx + 6, cy + 1);
        doc.line(cx + 6, cy + 1, cx - 5, cy + 1);
        doc.line(cx - 5, cy + 1, cx - 1, cy - 3);
        doc.line(cx - 5, cy + 1, cx - 1, cy + 5);
        break;
      case "spark":
        doc.setLineCap("butt");
        asterisk(cx, cy, 6, c);
        break;
    }
    doc.setLineCap("butt");
  }

  function trendPill(label: string, x: number, y: number, tone: Sentiment, center = true) {
    const size = 9;
    font(size, "bold");
    const w = doc.getTextWidth(label) + 34;
    const left = center ? x - w / 2 : x;
    fill(SENTIMENT_BG[tone]);
    doc.roundedRect(left, y, w, 20, 10, 10, "F");
    fill(SENTIMENT_COLOR[tone]);
    if (tone === "positive") doc.triangle(left + 11, y + 13, left + 18, y + 13, left + 14.5, y + 7, "F");
    else if (tone === "negative") doc.triangle(left + 11, y + 7, left + 18, y + 7, left + 14.5, y + 13, "F");
    else doc.circle(left + 14.5, y + 10, 3, "F");
    color(tone === "neutral" ? MUTED : SENTIMENT_COLOR[tone]);
    doc.text(label, left + 24, y + 13.4);
  }

  function newPage(caption: string | null, dark = false) {
    if (firstPage) firstPage = false;
    else doc.addPage([W, H], "landscape");
    fill(dark ? INK : BG);
    doc.rect(0, 0, W, H, "F");
    if (caption) footers.set(doc.getNumberOfPages(), caption);
  }

  function header(title: string, tag?: string) {
    font(40);
    doc.setCharSpace(-0.8);
    color(INK);
    doc.text(title, M, 96);
    doc.setCharSpace(0);
    if (tag) {
      font(24, "italic", "times");
      color(INK);
      doc.text(tag, W - M - 52, 96, { align: "right" });
    }
    arrowBadge(W - M - 17, 87);
  }

  function sentimentBar(s: SentimentStats, x: number, y: number, w: number, h: number) {
    fill(LINE);
    doc.roundedRect(x, y, w, h, h / 2, h / 2, "F");
    if (s.total === 0) return;
    let cursor = x;
    const order: Sentiment[] = ["positive", "neutral", "negative"];
    const visible = order.filter((k) => s[k] > 0);
    visible.forEach((k, i) => {
      const sw = (s[k] / s.total) * w;
      fill(SENTIMENT_COLOR[k]);
      if (visible.length === 1) doc.roundedRect(cursor, y, sw, h, h / 2, h / 2, "F");
      else if (i === 0) {
        doc.roundedRect(cursor, y, sw, h, h / 2, h / 2, "F");
        doc.rect(cursor + Math.min(h / 2, sw / 2), y, sw - Math.min(h / 2, sw / 2), h, "F");
      } else if (i === visible.length - 1) {
        doc.roundedRect(cursor, y, sw, h, h / 2, h / 2, "F");
        doc.rect(cursor, y, sw - Math.min(h / 2, sw / 2), h, "F");
      } else doc.rect(cursor, y, sw, h, "F");
      cursor += sw;
    });
  }

  function legendDot(label: string, c: Rgb, x: number, y: number): number {
    fill(c);
    doc.circle(x + 4, y - 3.5, 4, "F");
    font(10);
    color(MUTED);
    doc.text(label, x + 14, y);
    return doc.getTextWidth(label) + 34;
  }

  function barChart(
    x: number,
    y: number,
    w: number,
    h: number,
    categories: string[],
    series: { name: string; color: Rgb; values: number[] }[]
  ) {
    const axisW = 36;
    const labelH = 28;
    const plotX = x + axisW;
    const plotW = w - axisW;
    const plotH = h - labelH;
    const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));

    font(9);
    for (let i = 0; i <= 4; i++) {
      const gy = y + plotH - (plotH * i) / 4;
      stroke(LINE, 0.8);
      doc.line(plotX, gy, x + w, gy);
      color(FAINT);
      doc.text(formatNumber(Math.round((max * i) / 4)), x + axisW - 10, gy + 3, { align: "right" });
    }

    const groupW = plotW / categories.length;
    const barW = Math.min(46, (groupW * 0.72) / series.length);
    const gap = Math.min(6, barW * 0.15);
    categories.forEach((cat, ci) => {
      const groupInner = series.length * barW + (series.length - 1) * gap;
      let bx = plotX + ci * groupW + (groupW - groupInner) / 2;
      series.forEach((s) => {
        const v = s.values[ci] ?? 0;
        const bh = (v / max) * plotH;
        if (bh > 0) {
          fill(s.color);
          const r = Math.min(barW / 2, 10, bh / 2);
          doc.roundedRect(bx, y + plotH - bh, barW, bh, r, r, "F");
          if (bh > r * 2) doc.rect(bx, y + plotH - bh / 2, barW, bh / 2, "F");
        }
        bx += barW + gap;
      });
      font(10, "bold");
      color(INK);
      doc.text(cat, plotX + ci * groupW + groupW / 2, y + plotH + 20, { align: "center" });
    });
  }

  function sectionDivider(title: string, quote: { text: string; by: string } | null, note?: string) {
    sectionNumber++;
    newPage(null, true);
    fill(TAUPE_LIGHT);
    doc.rect(W / 2, 0, W / 2, H, "F");

    asterisk(M + 6, 64, 6, ON_DARK);
    font(11);
    color(ON_DARK);
    doc.text("Comment Export", M + 22, 68);

    font(58);
    doc.setCharSpace(-1.4);
    color(ON_DARK);
    lines(title, W / 2 - M * 2, 4).forEach((l, i) => doc.text(l, M, 300 + i * 64));
    doc.setCharSpace(0);
    if (note) {
      font(12);
      color(ON_DARK_MUTED);
      paragraph(note, M, 300 + Math.min(4, lines(title, W / 2 - M * 2, 4).length) * 64 + 10, W / 2 - M * 2, 17, 3);
    }
    pill(`SECCIÓN ${sectionNumber}`, M, H - 92, { outline: ON_DARK_MUTED, fg: ON_DARK, size: 10, h: 28 });
    font(14);
    color(ON_DARK);
    doc.text(`(${sectionNumber})`, W / 2 - M, H - 72, { align: "right" });

    const rx = W / 2 + M + 10;
    const rw = W / 2 - M * 2 - 20;
    if (quote) {
      font(130, "italic", "times");
      color(TAUPE);
      doc.text("“", rx - 8, 250);
      font(30, "italic", "times");
      color(INK);
      const end = paragraph(quote.text, rx, 270, rw, 38, 6);
      font(12);
      color(MUTED);
      doc.text(quote.by, rx, end + 22);
    } else {
      font(240, "italic", "times");
      color(TAUPE);
      doc.text(String(sectionNumber).padStart(2, "0"), W * 0.75, H / 2 + 80, { align: "center" });
    }
  }

  const userLabel = (c: CommentItem) => `@${clean(c.username)}`;

  // ——— Portada ———

  newPage(null, true);
  fill(TAUPE_LIGHT);
  doc.rect(W / 2, 0, W / 2, H, "F");
  asterisk(M + 6, 64, 6, ON_DARK);
  font(11);
  color(ON_DARK);
  doc.text("Comment Export", M + 22, 68);

  font(66);
  doc.setCharSpace(-1.8);
  color(ON_DARK);
  doc.text("Reporte de", M, 300);
  doc.text("comentarios", M, 372);
  doc.setCharSpace(0);
  font(13);
  color(ON_DARK_MUTED);
  const exportedAt = new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
  paragraph(
    `Análisis de la conversación en ${stats.videos.length} ${stats.videos.length === 1 ? "video" : "videos"} de Instagram. Generado el ${exportedAt}.`,
    M,
    412,
    W / 2 - M * 2 - 40,
    19
  );
  pill("INSTAGRAM", M, H - 92, { outline: ON_DARK_MUTED, fg: ON_DARK, size: 10, h: 28 });

  const rx0 = W / 2 + M + 10;
  font(170);
  doc.setCharSpace(-6);
  color(INK);
  doc.text(formatNumber(stats.totalComments), rx0 - 8, 330);
  doc.setCharSpace(0);
  font(30, "italic", "times");
  color(INK);
  doc.text("comentarios analizados", rx0, 378);
  const coverFacts: [string, string][] = [
    [formatNumber(stats.uniqueUsers), "personas comentaron"],
    [formatNumber(stats.totalLikes), "likes en comentarios"],
  ];
  if (stats.sentiment && stats.sentiment.total > 0) {
    coverFacts.push([percent(stats.sentiment.positive, stats.sentiment.total), "de comentarios positivos"]);
  }
  coverFacts.forEach(([value, label], i) => {
    const fy = 462 + i * 52;
    stroke(TAUPE, 1);
    doc.line(rx0, fy - 30, W - M, fy - 30);
    font(22, "bold");
    color(INK);
    doc.text(value, rx0, fy);
    font(13);
    color(MUTED);
    doc.text(label, rx0 + 110, fy);
  });
  if (input.activeFilterLabel) {
    font(11);
    color(MUTED);
    doc.text(`Listados filtrados: ${clean(input.activeFilterLabel)}`, rx0, H - 72);
  }

  // ——— Resumen general ———

  newPage("Indicadores calculados sobre todos los comentarios obtenidos.");
  header("Resumen general", "Panorama");

  const kpis: { icon: "bubble" | "heart" | "user" | "reply" | "spark"; value: string; label: string; trend: [string, Sentiment] }[] = [
    {
      icon: "bubble",
      value: formatNumber(stats.totalComments),
      label: "Comentarios",
      trend: [`${stats.videos.length} ${stats.videos.length === 1 ? "video" : "videos"}`, "neutral"],
    },
    {
      icon: "heart",
      value: formatNumber(stats.totalLikes),
      label: "Likes en comentarios",
      trend: [`${stats.avgLikes.toFixed(1).replace(".", ",")} por comentario`, "neutral"],
    },
    {
      icon: "user",
      value: formatNumber(stats.uniqueUsers),
      label: "Personas alcanzadas",
      trend: [`${stats.repeatUsers} repiten`, stats.repeatUsers > 0 ? "positive" : "neutral"],
    },
    {
      icon: "reply",
      value: formatNumber(stats.replies),
      label: "Respuestas",
      trend: [`${percent(stats.replies, stats.totalComments)} del total`, stats.replyRate >= 0.15 ? "positive" : "neutral"],
    },
  ];
  if (stats.sentiment && stats.netSentiment !== null) {
    kpis.push({
      icon: "spark",
      value: `${stats.netSentiment > 0 ? "+" : ""}${stats.netSentiment}`,
      label: "Sentimiento neto",
      trend: [
        `${percent(stats.sentiment.positive, stats.sentiment.total)} positivos`,
        stats.netSentiment > 0 ? "positive" : stats.netSentiment < 0 ? "negative" : "neutral",
      ],
    });
  } else {
    kpis.push({
      icon: "spark",
      value: String(stats.unansweredQuestions),
      label: "Preguntas sin respuesta",
      trend: ["en comentarios", stats.unansweredQuestions > 0 ? "negative" : "positive"],
    });
  }

  const kGap = 16;
  const kW = (CW - kGap * (kpis.length - 1)) / kpis.length;
  kpis.forEach((k, i) => {
    const kx = M + i * (kW + kGap);
    const ky = 150;
    card(kx, ky, kW, 176);
    fill(BG);
    doc.circle(kx + kW / 2, ky + 34, 16, "F");
    icon(k.icon, kx + kW / 2, ky + 34);
    font(44);
    doc.setCharSpace(-1.2);
    color(INK);
    doc.text(k.value, kx + kW / 2, ky + 102, { align: "center" });
    doc.setCharSpace(0);
    font(11);
    color(MUTED);
    doc.text(k.label, kx + kW / 2, ky + 124, { align: "center" });
    trendPill(k.trend[0], kx + kW / 2, ky + 140, k.trend[1]);
  });

  // Puntos clave + distribución
  const colY = 352;
  font(13, "bold");
  color(INK);
  doc.text("Puntos clave", M, colY + 14);
  let ty = colY + 52;
  stats.takeaways.forEach((t) => {
    fill(INK);
    doc.circle(M + 3, ty - 5, 2.6, "F");
    font(15);
    color(INK);
    ty = paragraph(clean(t), M + 18, ty, 500, 21, 3) + 22;
  });

  const dx = M + 600;
  const dw = CW - 600;
  card(dx, colY, dw, 300);
  if (stats.sentiment && stats.sentiment.total > 0) {
    const s = stats.sentiment;
    font(13, "bold");
    color(INK);
    doc.text("Distribución del sentimiento", dx + 28, colY + 40);
    font(18, "italic", "times");
    color(MUTED);
    doc.text("Audiencia", dx + dw - 28, colY + 40, { align: "right" });
    const order: Sentiment[] = ["positive", "neutral", "negative"];
    const colW = (dw - 56) / 3;
    order.forEach((k, i) => {
      const cx = dx + 28 + i * colW;
      font(48);
      doc.setCharSpace(-1.2);
      color(k === "neutral" ? MUTED : SENTIMENT_COLOR[k]);
      doc.text(percent(s[k], s.total), cx, colY + 130);
      doc.setCharSpace(0);
      fill(SENTIMENT_COLOR[k]);
      doc.circle(cx + 4, colY + 156, 4, "F");
      font(11);
      color(MUTED);
      doc.text(`${SENTIMENT_LABELS[k]}s · ${s[k]}`.replace("Neutrals", "Neutrales"), cx + 14, colY + 160);
    });
    sentimentBar(s, dx + 28, colY + 200, dw - 56, 18);
    font(10);
    color(FAINT);
    paragraph(
      `Sobre ${s.total} comentarios clasificados. El sentimiento neto resta el porcentaje de negativos al de positivos.`,
      dx + 28,
      colY + 254,
      dw - 56,
      14,
      2
    );
  } else {
    font(13, "bold");
    color(INK);
    doc.text("Comentarios por video", dx + 28, colY + 40);
    const maxC = Math.max(1, ...stats.videos.map((v) => v.comments));
    stats.videos.slice(0, 6).forEach((v, i) => {
      const by = colY + 72 + i * 36;
      font(10, "bold");
      color(INK);
      doc.text(`#${v.index + 1}`, dx + 28, by + 11);
      fill(LINE);
      doc.roundedRect(dx + 64, by, dw - 160, 16, 8, 8, "F");
      fill(TAUPE_DARK);
      doc.roundedRect(dx + 64, by, Math.max(16, ((dw - 160) * v.comments) / maxC), 16, 8, 8, "F");
      font(10);
      color(MUTED);
      doc.text(String(v.comments), dx + dw - 28, by + 11, { align: "right" });
    });
  }

  // ——— Sección 1: rendimiento ———

  const allComments = input.allResults.flatMap((r) => r.comments);
  const byLikes = [...allComments].sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
  const topQuoteComment =
    (analysis ? byLikes.find((c) => analysis[c.commentId]?.sentiment === "positive") : undefined) ?? byLikes[0];
  const topQuote = topQuoteComment ? { comment: topQuoteComment } : undefined;
  sectionDivider(
    "Rendimiento de los videos",
    topQuote && (topQuote.comment.likeCount ?? 0) > 0
      ? {
          text: cleanComment(topQuote.comment.text),
          by: `${userLabel(topQuote.comment)} · ${formatNumber(topQuote.comment.likeCount ?? 0)} likes`,
        }
      : null
  );

  // Tabla de rendimiento por video (estilo pills)
  const perfCols: { label: string; icon: "bubble" | "heart" | "user" | "reply" | "spark"; value: (v: (typeof stats.videos)[number]) => string }[] = [
    { label: "Comentarios", icon: "bubble", value: (v) => formatNumber(v.comments) },
    { label: "Respuestas", icon: "reply", value: (v) => formatNumber(v.replies) },
    { label: "Likes", icon: "heart", value: (v) => formatNumber(v.likes) },
    { label: "Personas", icon: "user", value: (v) => formatNumber(v.uniqueUsers) },
  ];
  if (analysis) {
    perfCols.push(
      { label: "% Positivo", icon: "spark", value: (v) => (v.sentiment ? percent(v.sentiment.positive, v.sentiment.total) : "—") },
      { label: "% Negativo", icon: "spark", value: (v) => (v.sentiment ? percent(v.sentiment.negative, v.sentiment.total) : "—") }
    );
  } else {
    perfCols.push({ label: "Likes / com.", icon: "heart", value: (v) => (v.comments ? (v.likes / v.comments).toFixed(1).replace(".", ",") : "—") });
  }

  const ROWS_PER_PAGE = 9;
  for (let start = 0; start < Math.max(1, stats.videos.length); start += ROWS_PER_PAGE) {
    newPage("Comparativa de indicadores entre los videos analizados.");
    header("Rendimiento por video", start === 0 ? "Videos" : "continuación");
    const rowHeadW = 230;
    const cGap = 12;
    const colW = (CW - rowHeadW - cGap * perfCols.length) / perfCols.length;
    const hy = 140;
    perfCols.forEach((col, ci) => {
      const cx = M + rowHeadW + cGap + ci * (colW + cGap);
      card(cx, hy, colW, 32, CARD, 16);
      font(11);
      const tw = doc.getTextWidth(col.label);
      icon(col.icon, cx + colW / 2 - tw / 2 - 6, hy + 16, MUTED);
      color(INK);
      doc.text(col.label, cx + colW / 2 + 8, hy + 20, { align: "center" });
    });
    stats.videos.slice(start, start + ROWS_PER_PAGE).forEach((v, ri) => {
      const ry = hy + 50 + ri * 50;
      fill(INK);
      doc.roundedRect(M, ry, rowHeadW, 38, 19, 19, "F");
      fill(ON_DARK);
      doc.circle(M + 20, ry + 19, 11, "F");
      font(9, "bold");
      color(INK);
      doc.text(String(v.index + 1), M + 20, ry + 22.5, { align: "center" });
      font(11);
      color(ON_DARK);
      doc.text(lines(clean(v.shortcode), rowHeadW - 56, 1)[0], M + 40, ry + 23);
      perfCols.forEach((col, ci) => {
        const cx = M + rowHeadW + cGap + ci * (colW + cGap);
        card(cx, ry, colW, 38, CARD, 19);
        font(12);
        color(INK);
        doc.text(col.value(v), cx + colW / 2, ry + 23, { align: "center" });
      });
    });
  }

  // Resumen de interacción: gráfico de barras por video
  newPage(
    analysis
      ? "Gráfico comparando positivos, neutrales y negativos en cada video."
      : "Gráfico comparando comentarios, respuestas y personas en cada video."
  );
  header("Resumen de interacción", "Desempeño");
  {
    const leftW = 400;
    font(13, "bold");
    color(INK);
    doc.text("Lo más importante", M, 150);
    let y = 180;
    stats.takeaways.slice(0, 3).forEach((t) => {
      font(15);
      color(INK);
      y = paragraph(clean(t), M, y, leftW, 21, 3) + 16;
    });

    const featured = analysis
      ? stats.topComments.find((t) => analysis[t.comment.commentId]?.sentiment === "positive") ?? stats.topComments[0]
      : stats.topComments[0];
    if (featured) {
      const fy = Math.max(y + 16, 340);
      const fh = 640 - fy - 14;
      font(13, "bold");
      color(INK);
      doc.text("Comentario destacado", M, fy);
      card(M, fy + 14, leftW, fh);
      fill(TAUPE_LIGHT);
      doc.roundedRect(M + 16, fy + 30, 110, fh - 32, 12, 12, "F");
      font(90, "italic", "times");
      color(TAUPE_DARK);
      doc.text("“", M + 50, fy + 30 + (fh - 32) / 2 + 40);
      font(20, "italic", "times");
      color(INK);
      const quoteLines = Math.max(1, Math.floor((fh - 80) / 25));
      paragraph(cleanComment(featured.comment.text), M + 146, fy + 62, leftW - 166, 25, quoteLines);
      font(10);
      color(MUTED);
      doc.text(
        `${userLabel(featured.comment)} · ${formatNumber(featured.comment.likeCount ?? 0)} likes · video #${featured.videoIndex + 1}`,
        M + 146,
        fy + fh - 4
      );
    }

    const chartVideos = [...stats.videos].sort((a, b) => b.comments - a.comments).slice(0, 6).sort((a, b) => a.index - b.index);
    const cx = M + leftW + 60;
    const cw = W - M - cx;
    const series = analysis
      ? (["positive", "neutral", "negative"] as Sentiment[]).map((k) => ({
          name: `${SENTIMENT_LABELS[k]}s`.replace("Neutrals", "Neutrales"),
          color: k === "positive" ? TAUPE_DARK : k === "neutral" ? TAUPE_LIGHT : SENTIMENT_COLOR.negative,
          values: chartVideos.map((v) => v.sentiment?.[k] ?? 0),
        }))
      : [
          { name: "Comentarios", color: TAUPE_DARK, values: chartVideos.map((v) => v.comments) },
          { name: "Respuestas", color: TAUPE, values: chartVideos.map((v) => v.replies) },
          { name: "Personas", color: TAUPE_LIGHT, values: chartVideos.map((v) => v.uniqueUsers) },
        ];
    let lx = cx + cw - series.reduce((s, x) => s + (font(10), doc.getTextWidth(x.name) + 34), 0);
    series.forEach((s) => {
      lx += legendDot(s.name, s.color, lx, 152);
    });
    barChart(cx, 180, cw, 460, chartVideos.map((v) => `Video ${v.index + 1}`), series);
  }

  // ——— Sección 2: audiencia y temas ———

  const negQuote = analysis
    ? byLikes.find((c) => analysis[c.commentId]?.sentiment === "negative" && c !== topQuoteComment)
    : undefined;
  sectionDivider(
    "Audiencia y conversación",
    negQuote ? { text: cleanComment(negQuote.text), by: `${userLabel(negQuote)} · la crítica más apoyada` } : null
  );

  // Temas
  const topics = stats.topics;
  if (topics.length > 0) {
    for (let start = 0; start < topics.length; start += 4) {
      newPage("Temas definidos en los filtros personalizados y cómo se habla de cada uno.");
      header("Temas de conversación", "Filtros");
      topics.slice(start, start + 4).forEach((t, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const tw = (CW - 20) / 2;
        const tx = M + col * (tw + 20);
        const tyy = 140 + row * 250;
        card(tx, tyy, tw, 230);
        font(24);
        doc.setCharSpace(-0.6);
        color(INK);
        doc.text(lines(clean(t.filter.name), tw - 200, 1)[0], tx + 26, tyy + 46);
        doc.setCharSpace(0);
        pill(`${t.count} comentarios`, tx + tw - 26 - (font(10, "bold"), doc.getTextWidth(`${t.count} comentarios`) + 22), tyy + 26, { bg: INK, fg: ON_DARK, size: 10, bold: true });
        font(11);
        color(MUTED);
        paragraph(clean(t.filter.description), tx + 26, tyy + 70, tw - 52, 15, 2);
        const share = percent(t.count, stats.totalComments);
        font(36);
        const shareW = doc.getTextWidth(share);
        doc.setCharSpace(-1);
        color(INK);
        doc.text(share, tx + 26, tyy + 134);
        doc.setCharSpace(0);
        font(11);
        color(MUTED);
        doc.text("de la conversación", tx + 26 + shareW + 10, tyy + 134);
        sentimentBar(t.sentiment, tx + tw - 26 - 220, tyy + 122, 220, 12);
        font(9);
        color(MUTED);
        doc.text(
          `${t.sentiment.positive} pos · ${t.sentiment.neutral} neu · ${t.sentiment.negative} neg`,
          tx + tw - 26,
          tyy + 150,
          { align: "right" }
        );
        stroke(LINE, 1);
        doc.line(tx + 26, tyy + 166, tx + tw - 26, tyy + 166);
        if (t.topComment) {
          font(13, "italic", "times");
          color(INK);
          paragraph(`“${cleanComment(t.topComment.text)}”`, tx + 26, tyy + 190, tw - 52, 16, 2);
        } else {
          font(11);
          color(FAINT);
          doc.text("Ningún comentario trata este tema.", tx + 26, tyy + 192);
        }
      });
    }
  }

  // Comentarios destacados y usuarios más activos
  if (stats.topComments.length > 0) {
    newPage("Comentarios con más likes y personas que más participaron.");
    header("Comentarios destacados", "Top");
    const [first, ...rest] = stats.topComments;
    const fw = 700;
    card(M, 140, fw, 500);
    fill(TAUPE_LIGHT);
    doc.roundedRect(M + 24, 164, 200, 260, 14, 14, "F");
    font(160, "italic", "times");
    color(TAUPE_DARK);
    doc.text("“", M + 84, 340);
    pill("#1 más apoyado", M + 124, 392, { bg: INK, fg: ON_DARK, size: 9, center: true, bold: true });

    font(11);
    color(MUTED);
    doc.text("Comentario", M + 254, 184);
    doc.text("Video", M + 520, 184);
    doc.text("Fecha", M + 600, 184);
    font(12, "bold");
    color(INK);
    doc.text(userLabel(first.comment), M + 254, 204);
    doc.text(`#${first.videoIndex + 1}`, M + 520, 204);
    doc.text(formatDate(first.comment.timestamp), M + 600, 204);
    font(20, "italic", "times");
    color(INK);
    paragraph(cleanComment(first.comment.text), M + 254, 248, fw - 254 - 24, 25, 7);

    font(11);
    color(MUTED);
    doc.text("Métricas", M + 24, 462);
    const sentimentOf = analysis?.[first.comment.commentId]?.sentiment;
    const mets: [string, string, "heart" | "reply" | "spark" | "bubble"][] = [
      [formatNumber(first.comment.likeCount ?? 0), "Likes", "heart"],
      [String(first.replies), "Respuestas", "reply"],
      [sentimentOf ? SENTIMENT_LABELS[sentimentOf] : "—", "Sentimiento", "spark"],
      [String(clean(first.comment.text).length), "Caracteres", "bubble"],
    ];
    const mw = (fw - 48 - 36) / 4;
    mets.forEach(([value, label, ic], i) => {
      const mx = M + 24 + i * (mw + 12);
      card(mx, 478, mw, 136, BG, 14);
      icon(ic, mx + mw / 2, 506, MUTED);
      font(10);
      color(MUTED);
      doc.text(label, mx + mw / 2, 534, { align: "center" });
      font(value.length > 6 ? 22 : 30, "bold");
      color(INK);
      doc.text(value, mx + mw / 2, 576, { align: "center" });
    });

    const sx = M + fw + 24;
    const sw = W - M - sx;
    let sy = 140;
    rest.forEach((t, i) => {
      card(sx, sy, sw, 128);
      font(10, "bold");
      color(MUTED);
      doc.text(`#${i + 2}`, sx + 20, sy + 30);
      font(12, "bold");
      color(INK);
      doc.text(userLabel(t.comment), sx + 48, sy + 30);
      font(10);
      color(MUTED);
      doc.text(`${formatNumber(t.comment.likeCount ?? 0)} likes`, sx + sw - 20, sy + 30, { align: "right" });
      font(13, "italic", "times");
      color(INK);
      paragraph(cleanComment(t.comment.text), sx + 20, sy + 58, sw - 40, 17, 3);
      sy += 140;
    });
    card(sx, sy, sw, 640 - sy);
    font(13, "bold");
    color(INK);
    doc.text("Personas más activas", sx + 20, sy + 32);
    stats.topUsers.slice(0, Math.floor((640 - sy - 50) / 34)).forEach((u, i) => {
      const uy = sy + 52 + i * 34;
      fill(BG);
      doc.roundedRect(sx + 20, uy, sw - 40, 26, 13, 13, "F");
      font(11);
      color(INK);
      doc.text(`@${lines(clean(u.username), sw - 160, 1)[0]}`, sx + 34, uy + 17);
      pill(`${u.count} com.`, sx + sw - 24 - 70, uy + 3, { bg: INK, fg: ON_DARK, size: 9, h: 20, w: 70 });
    });
  }

  // Días de mayor actividad
  if (stats.peakDays.length > 0) {
    newPage("Fechas con más comentarios y evolución diaria de la conversación.");
    header("Días de mayor actividad", "Calendario");
    const dGap = 16;
    const dW = (CW - dGap * 3) / 4;
    const ranked = [...stats.peakDays].sort((a, b) => b.count - a.count);
    stats.peakDays.forEach((d, i) => {
      const dx2 = M + i * (dW + dGap);
      card(dx2, 136, dW, 250);
      fill(i % 2 === 0 ? TAUPE_LIGHT : TAUPE);
      doc.roundedRect(dx2 + 12, 148, dW - 24, 84, 12, 12, "F");
      font(26, "italic", "times");
      color(i % 2 === 0 ? TAUPE_DARK : CARD);
      doc.text(WEEKDAYS[d.date.getDay()], dx2 + dW / 2, 200, { align: "center" });
      font(42);
      doc.setCharSpace(-1.4);
      color(INK);
      doc.text(shortDate(d.date), dx2 + dW / 2, 290, { align: "center" });
      doc.setCharSpace(0);
      font(11);
      color(MUTED);
      doc.text(`${d.count} comentarios · ${percent(d.count, stats.totalComments)}`, dx2 + dW / 2, 316, { align: "center" });
      const rank = ranked.indexOf(d) + 1;
      pill(rank === 1 ? "Pico de actividad" : `${rank}º día más activo`, dx2 + dW / 2, 340, {
        bg: INK,
        fg: ON_DARK,
        size: 9,
        h: 24,
        w: dW - 40,
        center: true,
        bold: true,
      });
    });

    // Evolución diaria (o semanal si el período es largo)
    const first = stats.days[0].date;
    const last = stats.days[stats.days.length - 1].date;
    const spanDays = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
    const weekly = spanDays > 45;
    const buckets: { label: string; count: number }[] = [];
    const counts = new Map(stats.days.map((d) => [d.key, d.count]));
    const step = weekly ? 7 : 1;
    for (let t = first.getTime(); t <= last.getTime(); t += step * 86_400_000) {
      let count = 0;
      for (let k = 0; k < step; k++) {
        const d = new Date(t + k * 86_400_000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        count += counts.get(key) ?? 0;
      }
      buckets.push({ label: shortDate(new Date(t)), count });
    }
    const shown = buckets.slice(-60);
    card(M, 406, CW, 236);
    font(13, "bold");
    color(INK);
    doc.text(weekly ? "Comentarios por semana" : "Comentarios por día", M + 24, 436);
    const maxB = Math.max(1, ...shown.map((b) => b.count));
    const px = M + 24;
    const pw = CW - 48;
    const ph = 140;
    const pyBase = 600;
    const bw = pw / shown.length;
    shown.forEach((b, i) => {
      const bh = (b.count / maxB) * ph;
      fill(b.count === maxB ? INK : TAUPE);
      const barW2 = Math.max(2, bw * 0.62);
      if (bh > 0) doc.roundedRect(px + i * bw + (bw - barW2) / 2, pyBase - bh, barW2, bh, Math.min(barW2 / 2, 4), Math.min(barW2 / 2, 4), "F");
    });
    stroke(LINE, 1);
    doc.line(px, pyBase, px + pw, pyBase);
    font(9);
    color(FAINT);
    const labelEvery = Math.ceil(shown.length / 8);
    shown.forEach((b, i) => {
      if (i % labelEvery === 0 || i === shown.length - 1) doc.text(b.label, px + i * bw + bw / 2, pyBase + 18, { align: "center" });
    });
  }

  // Notas y recomendaciones
  newPage("Observaciones generadas automáticamente a partir de los datos del reporte.");
  header("Notas y recomendaciones", "Próximos pasos");
  {
    const colW2 = (CW - 32) / 2;
    const columns: [string, string[]][] = [
      ["Lo que funciona", stats.strengths.length ? stats.strengths : ["Todavía no hay suficientes datos para destacar fortalezas."]],
      ["Puntos a atender", stats.attention.length ? stats.attention : ["No se detectaron alertas en los comentarios analizados."]],
    ];
    columns.forEach(([title, items], ci) => {
      const cx = M + ci * (colW2 + 32);
      pill(title, cx + colW2 / 2, 146, { bg: INK, fg: ON_DARK, size: 12, h: 34, w: 260, center: true, bold: true });
      items.forEach((item, ii) => {
        const iy = 204 + ii * 132;
        card(cx, iy, colW2, 116);
        font(16);
        const itemLines = lines(clean(item), colW2 - 84, 4);
        const startY = iy + 58 - ((itemLines.length - 1) * 22) / 2 + 5;
        fill(ci === 0 ? SENTIMENT_COLOR.positive : SENTIMENT_COLOR.negative);
        doc.circle(cx + 30, startY - 5, 4.5, "F");
        color(INK);
        itemLines.forEach((l, li) => doc.text(l, cx + 52, startY + li * 22));
      });
    });
  }

  // ——— Sección 3: comentarios ———

  sectionDivider(
    "Todos los comentarios",
    null,
    input.activeFilterLabel ? `Filtro aplicado a los listados: ${clean(input.activeFilterLabel)}` : undefined
  );

  const tableBase = {
    theme: "plain" as const,
    margin: { left: M, right: M, top: 70, bottom: 64 },
    styles: {
      font: "helvetica",
      fontSize: 10,
      cellPadding: { top: 11, bottom: 11, left: 12, right: 12 },
      textColor: INK,
      fillColor: CARD,
      lineColor: BG,
      lineWidth: { bottom: 4 },
      overflow: "linebreak" as const,
      valign: "middle" as const,
    },
    headStyles: { fillColor: INK, textColor: ON_DARK, fontStyle: "bold" as const, fontSize: 10, lineWidth: 0 },
  };

  function tablePageHooks(caption: string) {
    const startPage = doc.getNumberOfPages();
    return {
      willDrawPage: () => {
        const current = doc.getNumberOfPages();
        if (current > startPage) {
          fill(BG);
          doc.rect(0, 0, W, H, "F");
          footers.set(current, caption);
        }
      },
    };
  }

  const sentimentCell = (columnIndex: number) => (data: {
    section: string;
    column: { index: number };
    cell: { raw: unknown; styles: { textColor: unknown; fontStyle: unknown } };
  }) => {
    if (data.section !== "body" || data.column.index !== columnIndex) return;
    const entry = (Object.entries(SENTIMENT_LABELS) as [Sentiment, string][]).find(([, l]) => l === data.cell.raw);
    if (entry) {
      data.cell.styles.textColor = entry[0] === "neutral" ? MUTED : SENTIMENT_COLOR[entry[0]];
      data.cell.styles.fontStyle = "bold";
    }
  };

  const replyCell = (data: { section: string; column: { index: number }; cell: { raw: unknown; styles: { textColor: unknown; fontStyle: unknown } } }) => {
    if (data.section === "body" && data.column.index === 0 && typeof data.cell.raw === "string" && data.cell.raw.startsWith("»")) {
      data.cell.styles.textColor = MUTED;
      data.cell.styles.fontStyle = "italic";
    }
  };

  const usedFilters = analysis ? filters : [];
  for (const f of usedFilters) {
    const rows: string[][] = [];
    results.forEach((r, videoIndex) => {
      for (const c of r.comments) {
        const a = analysis?.[c.commentId];
        if (!a?.filterIds.includes(f.id)) continue;
        rows.push([
          `${c.parentCommentId ? "» " : ""}@${clean(c.username)}`,
          cleanComment(c.text),
          `#${videoIndex + 1}`,
          SENTIMENT_LABELS[a.sentiment],
        ]);
      }
    });
    if (rows.length === 0) continue;
    const caption = `Comentarios del tema "${clean(f.name)}".`;
    newPage(caption);
    header(`Tema: ${clean(f.name)}`, `${rows.length} comentarios`);
    autoTable(doc, {
      ...tableBase,
      ...tablePageHooks(caption),
      head: [["Usuario", "Comentario", "Video", "Sentimiento"]],
      body: rows,
      startY: 136,
      columnStyles: {
        0: { cellWidth: 190 },
        1: { cellWidth: CW - 190 - 80 - 110 },
        2: { cellWidth: 80 },
        3: { cellWidth: 110 },
      },
      didParseCell: (data) => {
        replyCell(data);
        sentimentCell(3)(data);
      },
    });
  }

  const withTopics = analysis !== null && usedFilters.length > 0;
  results.forEach((result, videoIndex) => {
    if (result.comments.length === 0) return;
    const caption = `Comentarios del video #${videoIndex + 1} · ${clean(result.url)}`;
    newPage(caption);
    header(`Video #${videoIndex + 1}`, `${result.comments.length} comentarios`);
    font(11);
    color(MUTED);
    doc.text(clean(result.url), M, 120);

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
      ...tablePageHooks(caption),
      head: [head],
      body,
      startY: 140,
      columnStyles: {
        0: { cellWidth: 180 },
        1: { cellWidth: CW - 180 - 96 - 60 - (analysis ? 104 : 0) - (withTopics ? 150 : 0) },
        2: { cellWidth: 96 },
        3: { cellWidth: 60, halign: "right" },
        4: { cellWidth: 104 },
        5: { cellWidth: 150 },
      },
      didParseCell: (data) => {
        replyCell(data);
        if (analysis) sentimentCell(4)(data);
      },
    });
  });

  // Pies de página
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    const caption = footers.get(i);
    if (!caption) continue;
    doc.setPage(i);
    asterisk(M + 6, H - 34, 5, INK);
    font(10);
    color(MUTED);
    doc.text(lines(caption, CW - 160, 1)[0], M + 22, H - 30);
    color(INK);
    doc.text(`P.${String(i).padStart(3, "0")}`, W - M, H - 30, { align: "right" });
  }

  doc.save(`reporte-comentarios-instagram-${Date.now()}.pdf`);
}
