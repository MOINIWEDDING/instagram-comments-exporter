import { SENTIMENT_LABELS, percent, sentimentStats } from "./analysis";
import type { CommentAnalysis, CommentItem, CustomFilter, ScrapeResult, Sentiment } from "./types";

export interface ExportInput {
  /** Todos los resultados obtenidos (base para las estadísticas). */
  allResults: ScrapeResult[];
  /** Resultados con los filtros activos ya aplicados (lo que se lista en el documento). */
  results: ScrapeResult[];
  analysis: Record<string, CommentAnalysis> | null;
  filters: CustomFilter[];
  /** Descripción legible de los filtros activos, p. ej. "Solo negativos · Tema: Precio". */
  activeFilterLabel: string | null;
}

function filterNames(c: CommentItem, input: ExportInput): string {
  const ids = input.analysis?.[c.commentId]?.filterIds ?? [];
  return input.filters
    .filter((f) => ids.includes(f.id))
    .map((f) => f.name)
    .join("; ");
}

export function toCsv(input: ExportInput): string {
  const withAnalysis = input.analysis !== null;
  const header = ["usuario", "comentario"];
  if (withAnalysis) header.push("sentimiento");
  if (withAnalysis && input.filters.length > 0) header.push("temas");
  const rows = [header.join(",")];

  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;

  for (const result of input.results) {
    for (const c of result.comments) {
      const row = [escape(c.username), escape(c.text)];
      if (withAnalysis) {
        const sentiment = input.analysis?.[c.commentId]?.sentiment;
        row.push(escape(sentiment ? SENTIMENT_LABELS[sentiment] : ""));
      }
      if (withAnalysis && input.filters.length > 0) row.push(escape(filterNames(c, input)));
      rows.push(row.join(","));
    }
  }

  return rows.join("\n");
}

export function downloadCsv(csv: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `comentarios-instagram-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type Rgb = [number, number, number];

const PDF_WIDTH = 1280;
const PDF_HEIGHT = 720;
const PDF_MARGIN = 48;
const PDF_PURPLE: Rgb = [88, 60, 172];
const PDF_PINK: Rgb = [193, 53, 132];
const PDF_TEXT: Rgb = [26, 26, 32];
const PDF_MUTED: Rgb = [110, 110, 125];
const SENTIMENT_COLORS: Record<Sentiment, Rgb> = {
  positive: [26, 127, 55],
  negative: [208, 52, 44],
  neutral: [150, 150, 165],
};

function formatPdfDate(timestamp: number | null): string {
  if (!timestamp) return "—";
  const d = new Date(timestamp * 1000);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export async function downloadPdf(input: ExportInput) {
  const [{ default: JsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  type Doc = InstanceType<typeof JsPDF>;

  const { results, analysis, filters } = input;
  const doc = new JsPDF({ unit: "px", format: [PDF_WIDTH, PDF_HEIGHT], orientation: "landscape" });
  const contentWidth = PDF_WIDTH - PDF_MARGIN * 2;
  const allComments = input.allResults.flatMap((r) => r.comments);
  const exportedComments = results.flatMap((r) => r.comments);
  const totalReplies = exportedComments.filter((c) => c.parentCommentId).length;

  const tableStyles = {
    theme: "striped" as const,
    margin: { left: PDF_MARGIN, right: PDF_MARGIN, bottom: 40 },
    styles: {
      fontSize: 9.5,
      cellPadding: 8,
      textColor: PDF_TEXT,
      lineColor: [235, 235, 242] as Rgb,
      overflow: "linebreak" as const,
      valign: "top" as const,
    },
    headStyles: {
      fillColor: PDF_PURPLE,
      textColor: 255,
      fontStyle: "bold" as const,
      fontSize: 10.5,
    },
    alternateRowStyles: { fillColor: [247, 247, 251] as Rgb },
  };

  function sectionHeader(title: string, subtitle: string, color: Rgb = PDF_PINK) {
    doc.addPage([PDF_WIDTH, PDF_HEIGHT], "landscape");
    doc.setFillColor(...color);
    doc.roundedRect(PDF_MARGIN, 40, 6, 32, 3, 3, "F");
    doc.setTextColor(...PDF_TEXT);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(doc.splitTextToSize(title, PDF_WIDTH - PDF_MARGIN * 2 - 20)[0], PDF_MARGIN + 22, 64);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...PDF_MUTED);
    doc.text(subtitle, PDF_MARGIN + 22, 84);
  }

  function statCards(d: Doc, cards: [string, string, Rgb][], y: number) {
    const cardWidth = 220;
    const cardGap = 24;
    cards.forEach(([value, label, color], i) => {
      const x = PDF_MARGIN + i * (cardWidth + cardGap);
      d.setDrawColor(225, 225, 235);
      d.setLineWidth(1);
      d.roundedRect(x, y, cardWidth, 110, 12, 12, "S");
      d.setTextColor(...color);
      d.setFont("helvetica", "bold");
      d.setFontSize(30);
      d.text(value, x + 20, y + 55);
      d.setTextColor(...PDF_MUTED);
      d.setFont("helvetica", "normal");
      d.setFontSize(11);
      d.text(label, x + 20, y + 82);
    });
  }

  // Colorea la celda de sentimiento según su valor.
  const sentimentCellHook =
    (columnIndex: number) =>
    (data: { section: string; column: { index: number }; cell: { raw: unknown; styles: { textColor: unknown; fontStyle: unknown } } }) => {
      if (data.section !== "body" || data.column.index !== columnIndex) return;
      const entry = (Object.entries(SENTIMENT_LABELS) as [Sentiment, string][]).find(
        ([, label]) => label === data.cell.raw
      );
      if (entry) {
        data.cell.styles.textColor = SENTIMENT_COLORS[entry[0]];
        data.cell.styles.fontStyle = "bold";
      }
    };

  // Portada
  doc.setFillColor(...PDF_PURPLE);
  doc.roundedRect(PDF_MARGIN, 90, PDF_WIDTH - PDF_MARGIN * 2, 8, 4, 4, "F");

  doc.setTextColor(...PDF_TEXT);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(34);
  doc.text("Comentarios de Instagram", PDF_MARGIN, 160);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(13);
  doc.setTextColor(...PDF_MUTED);
  const exportedAt = new Date().toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  doc.text(`Exportado el ${exportedAt}`, PDF_MARGIN, 188);
  if (input.activeFilterLabel) {
    doc.text(`Filtros aplicados: ${input.activeFilterLabel}`, PDF_MARGIN, 210);
  }

  statCards(
    doc,
    [
      [String(results.length), "Videos", PDF_PURPLE],
      [String(exportedComments.length), "Comentarios exportados", PDF_PURPLE],
      [String(totalReplies), "Respuestas", PDF_PURPLE],
    ],
    250
  );

  if (analysis) {
    const s = sentimentStats(exportedComments, analysis);
    statCards(
      doc,
      [
        [String(s.positive), `Positivos (${percent(s.positive, s.total)})`, SENTIMENT_COLORS.positive],
        [String(s.negative), `Negativos (${percent(s.negative, s.total)})`, SENTIMENT_COLORS.negative],
        [String(s.neutral), `Neutrales (${percent(s.neutral, s.total)})`, SENTIMENT_COLORS.neutral],
      ],
      390
    );
  }

  doc.setTextColor(...PDF_MUTED);
  doc.setFontSize(10);
  doc.text(
    "Generado con Comment Export — instagram-comments-exporter.vercel.app",
    PDF_MARGIN,
    PDF_HEIGHT - 40
  );

  // Estadísticas (sobre todos los comentarios obtenidos, sin filtros)
  if (analysis) {
    const overall = sentimentStats(allComments, analysis);
    sectionHeader(
      "Estadísticas de sentimiento",
      `Sobre los ${overall.total} comentarios obtenidos (sin aplicar filtros)`,
      PDF_PURPLE
    );

    // Barra apilada
    const barX = PDF_MARGIN;
    const barY = 120;
    const barW = contentWidth;
    const barH = 26;
    let cursor = barX;
    (["positive", "neutral", "negative"] as Sentiment[]).forEach((key) => {
      if (overall.total === 0 || overall[key] === 0) return;
      const w = (overall[key] / overall.total) * barW;
      doc.setFillColor(...SENTIMENT_COLORS[key]);
      doc.rect(cursor, barY, w, barH, "F");
      cursor += w;
    });

    let legendX = barX;
    doc.setFontSize(11);
    (["positive", "neutral", "negative"] as Sentiment[]).forEach((key) => {
      doc.setFillColor(...SENTIMENT_COLORS[key]);
      doc.roundedRect(legendX, barY + barH + 14, 10, 10, 2, 2, "F");
      doc.setTextColor(...PDF_TEXT);
      const label = `${SENTIMENT_LABELS[key]}: ${overall[key]} (${percent(overall[key], overall.total)})`;
      doc.text(label, legendX + 16, barY + barH + 23);
      legendX += doc.getTextWidth(label) + 48;
    });

    autoTable(doc, {
      ...tableStyles,
      head: [["Video", "Comentarios", "Positivos", "Negativos", "Neutrales", "% positivo", "% negativo"]],
      body: input.allResults
        .filter((r) => r.comments.length > 0)
        .map((r) => {
          const s = sentimentStats(r.comments, analysis);
          return [
            r.url,
            String(s.total),
            String(s.positive),
            String(s.negative),
            String(s.neutral),
            percent(s.positive, s.total),
            percent(s.negative, s.total),
          ];
        }),
      startY: barY + barH + 50,
      columnStyles: {
        0: { cellWidth: contentWidth - 90 - 80 * 5 },
        1: { cellWidth: 90, halign: "right" },
        2: { cellWidth: 80, halign: "right" },
        3: { cellWidth: 80, halign: "right" },
        4: { cellWidth: 80, halign: "right" },
        5: { cellWidth: 80, halign: "right" },
        6: { cellWidth: 80, halign: "right" },
      },
    });

    if (filters.length > 0) {
      const lastY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
      autoTable(doc, {
        ...tableStyles,
        head: [["Filtro", "Descripción", "Comentarios", "% del total", "Positivos", "Negativos"]],
        body: filters.map((f) => {
          const matching = allComments.filter((c) =>
            analysis[c.commentId]?.filterIds.includes(f.id)
          );
          const s = sentimentStats(matching, analysis);
          return [
            f.name,
            f.description,
            String(matching.length),
            percent(matching.length, overall.total),
            String(s.positive),
            String(s.negative),
          ];
        }),
        startY: lastY + 30,
        columnStyles: {
          0: { cellWidth: 160, fontStyle: "bold" },
          1: { cellWidth: contentWidth - 160 - 90 - 80 * 3 },
          2: { cellWidth: 90, halign: "right" },
          3: { cellWidth: 80, halign: "right" },
          4: { cellWidth: 80, halign: "right" },
          5: { cellWidth: 80, halign: "right" },
        },
      });
    }

    // Una sección por cada filtro personalizado con los comentarios que tratan ese tema
    for (const f of filters) {
      const rows: string[][] = [];
      results.forEach((r, videoIndex) => {
        for (const c of r.comments) {
          const a = analysis[c.commentId];
          if (!a?.filterIds.includes(f.id)) continue;
          rows.push([
            c.parentCommentId ? `↳ ${c.username}` : c.username,
            c.text,
            `#${videoIndex + 1}`,
            SENTIMENT_LABELS[a.sentiment],
          ]);
        }
      });
      if (rows.length === 0) continue;

      sectionHeader(`Tema: ${f.name}`, `${rows.length} comentarios · ${f.description}`);
      autoTable(doc, {
        ...tableStyles,
        head: [["Usuario", "Comentario", "Video", "Sentimiento"]],
        body: rows,
        startY: 110,
        columnStyles: {
          0: { cellWidth: 170 },
          1: { cellWidth: contentWidth - 170 - 60 - 90 },
          2: { cellWidth: 60 },
          3: { cellWidth: 90 },
        },
        didParseCell: sentimentCellHook(3),
      });
    }
  }

  // Comentarios por video
  const withTopics = analysis !== null && filters.length > 0;
  results.forEach((result, videoIndex) => {
    if (result.comments.length === 0) return;

    const replyCount = result.comments.filter((c) => c.parentCommentId).length;
    sectionHeader(
      `#${videoIndex + 1} · ${result.url}`,
      `${result.comments.length} comentarios${replyCount ? ` · ${replyCount} respuestas` : ""}`
    );

    const head = ["Usuario", "Comentario", "Fecha", "Likes"];
    if (analysis) head.push("Sentimiento");
    if (withTopics) head.push("Temas");

    const body = result.comments.map((c) => {
      const row = [
        c.parentCommentId ? `↳ ${c.username}` : c.username,
        c.text,
        formatPdfDate(c.timestamp),
        c.likeCount != null ? String(c.likeCount) : "—",
      ];
      if (analysis) {
        const sentiment = analysis[c.commentId]?.sentiment;
        row.push(sentiment ? SENTIMENT_LABELS[sentiment] : "—");
      }
      if (withTopics) row.push(filterNames(c, input) || "—");
      return row;
    });

    const sentimentHook = sentimentCellHook(4);
    autoTable(doc, {
      ...tableStyles,
      head: [head],
      body,
      startY: 110,
      columnStyles: {
        0: { cellWidth: 170 },
        1: { cellWidth: contentWidth - 170 - 90 - 55 - (analysis ? 90 : 0) - (withTopics ? 140 : 0) },
        2: { cellWidth: 90 },
        3: { cellWidth: 55, halign: "right" },
        4: { cellWidth: 90 },
        5: { cellWidth: 140 },
      },
      didParseCell: (data) => {
        if (data.section === "body" && data.column.index === 0) {
          const raw = data.cell.raw;
          if (typeof raw === "string" && raw.startsWith("↳")) {
            data.cell.styles.textColor = PDF_MUTED;
            data.cell.styles.fontStyle = "italic";
          }
        }
        if (analysis) sentimentHook(data);
      },
    });
  });

  const pageCount = doc.getNumberOfPages();
  for (let i = 2; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...PDF_MUTED);
    doc.text(`Página ${i - 1} de ${pageCount - 1}`, PDF_WIDTH - PDF_MARGIN - 70, PDF_HEIGHT - 20);
  }

  doc.save(`comentarios-instagram-${Date.now()}.pdf`);
}
