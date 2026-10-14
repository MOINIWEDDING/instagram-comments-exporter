import { SENTIMENT_LABELS } from "./analysis";
import type { CommentAnalysis, CommentItem, CustomFilter, ScrapeResult } from "./types";

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

export async function downloadPdf(input: ExportInput) {
  const { renderPdfReport } = await import("./pdf-report");
  await renderPdfReport(input);
}
