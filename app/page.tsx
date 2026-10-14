"use client";

import { useMemo, useState } from "react";
import type {
  AiInsights,
  AnalyzeResponse,
  CommentAnalysis,
  CustomFilter,
  ScrapeResult,
  Sentiment,
} from "@/lib/types";
import { SENTIMENT_LABELS, percent, sentimentStats } from "@/lib/analysis";
import { downloadCsv, downloadPdf, toCsv, type ExportInput } from "@/lib/export";

type SentimentFilter = "all" | Sentiment;

const SENTIMENT_FILTER_OPTIONS: { value: SentimentFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "positive", label: "Positivos" },
  { value: "negative", label: "Negativos" },
  { value: "neutral", label: "Neutrales" },
];

const SENTIMENT_PLURAL_LABELS: Record<Sentiment, string> = {
  positive: "Positivos",
  negative: "Negativos",
  neutral: "Neutrales",
};

const FILTER_PRESETS: Omit<CustomFilter, "id">[] = [
  { name: "Precio", description: "preguntan por el precio, costos o cuánto sale" },
  { name: "Preguntas", description: "hacen una pregunta o piden información" },
  { name: "Quejas", description: "se quejan de un servicio, producto o mala experiencia" },
];

const AVATAR_COLORS = ["#405de6", "#833ab4", "#c13584", "#e1306c", "#fd8d1d", "#1a9e7a", "#0e8fd9"];

function avatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initials(username: string): string {
  return username.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function formatRelative(timestamp: number | null): string {
  if (!timestamp) return "—";
  const diffSec = Math.round(Date.now() / 1000 - timestamp);
  if (diffSec < 60) return "ahora";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `hace ${diffDay}d`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

const COMMENT_TRUNCATE_LENGTH = 220;

function CommentText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > COMMENT_TRUNCATE_LENGTH;
  const shown = expanded || !isLong ? text : text.slice(0, COMMENT_TRUNCATE_LENGTH).trimEnd() + "…";

  return (
    <span className="comment-text">
      {shown}
      {isLong && (
        <button type="button" className="comment-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "ver menos" : "ver más"}
        </button>
      )}
    </span>
  );
}

function IconCamera() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="15" rx="3" />
      <circle cx="12" cy="13.5" r="3.5" />
      <path d="M8 6l1.5-2.5h5L16 6" />
    </svg>
  );
}

function IconAlertTriangle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconAlertCircle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  );
}

function IconFileText() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconReply() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function IconInbox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </svg>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [results, setResults] = useState<ScrapeResult[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);

  const [filters, setFilters] = useState<CustomFilter[]>([]);
  const [newFilterName, setNewFilterName] = useState("");
  const [newFilterDescription, setNewFilterDescription] = useState("");
  const [analysis, setAnalysis] = useState<Record<string, CommentAnalysis> | null>(null);
  const [analysisEngine, setAnalysisEngine] = useState<AnalyzeResponse["engine"] | null>(null);
  const [analysisWarning, setAnalysisWarning] = useState<string | null>(null);
  const [insights, setInsights] = useState<AiInsights | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  // Filtros con los que se hizo el último análisis, para saber si quedó desactualizado.
  const [analyzedFilters, setAnalyzedFilters] = useState<CustomFilter[]>([]);
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>("all");
  const [topicFilter, setTopicFilter] = useState<string>("all");

  const lineCount = input.split("\n").map((l) => l.trim()).filter(Boolean).length;

  const totalComments = useMemo(
    () => results.reduce((sum, r) => sum + r.comments.length, 0),
    [results]
  );
  const okCount = results.filter((r) => r.ok).length;
  const errorCount = results.filter((r) => !r.ok).length;

  const analysisStale = analysis !== null && JSON.stringify(analyzedFilters) !== JSON.stringify(filters);
  // Filtros que tienen resultados válidos: los analizados que el usuario no quitó ni editó.
  const appliedFilters = useMemo(
    () =>
      analysis
        ? analyzedFilters.filter((af) =>
            filters.some((f) => f.id === af.id && f.name === af.name && f.description === af.description)
          )
        : [],
    [analysis, analyzedFilters, filters]
  );

  const filteredResults = useMemo(() => {
    const topic = appliedFilters.some((f) => f.id === topicFilter) ? topicFilter : "all";
    if (!analysis || (sentimentFilter === "all" && topic === "all")) return results;
    return results.map((r) => ({
      ...r,
      comments: r.comments.filter((c) => {
        const a = analysis[c.commentId];
        if (!a) return false;
        if (sentimentFilter !== "all" && a.sentiment !== sentimentFilter) return false;
        if (topic !== "all" && !a.filterIds.includes(topic)) return false;
        return true;
      }),
    }));
  }, [results, analysis, sentimentFilter, topicFilter, appliedFilters]);

  const filteredCount = useMemo(
    () => filteredResults.reduce((sum, r) => sum + r.comments.length, 0),
    [filteredResults]
  );

  const allComments = useMemo(() => results.flatMap((r) => r.comments), [results]);
  const overallStats = useMemo(
    () => (analysis ? sentimentStats(allComments, analysis) : null),
    [allComments, analysis]
  );
  const topicCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!analysis) return counts;
    for (const c of allComments) {
      for (const id of analysis[c.commentId]?.filterIds ?? []) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [allComments, analysis]);

  const activeFilterLabel = useMemo(() => {
    const parts: string[] = [];
    if (analysis && sentimentFilter !== "all") {
      parts.push(`Solo ${SENTIMENT_FILTER_OPTIONS.find((o) => o.value === sentimentFilter)?.label.toLowerCase()}`);
    }
    if (analysis && topicFilter !== "all") {
      const f = appliedFilters.find((x) => x.id === topicFilter);
      if (f) parts.push(`Tema: ${f.name}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [analysis, sentimentFilter, topicFilter, appliedFilters]);

  const exportInput: ExportInput = {
    allResults: results,
    results: filteredResults,
    analysis,
    filters: appliedFilters,
    activeFilterLabel,
    engine: analysisEngine,
    insights,
  };

  function addFilter(name: string, description: string) {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim() || trimmedName;
    if (!trimmedName) return;
    setFilters((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: trimmedName, description: trimmedDescription },
    ]);
    setNewFilterName("");
    setNewFilterDescription("");
  }

  function removeFilter(id: string) {
    setFilters((prev) => prev.filter((f) => f.id !== id));
    if (topicFilter === id) setTopicFilter("all");
  }

  async function handleAnalyze(): Promise<AnalyzeResponse | null> {
    if (allComments.length === 0) return null;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comments: allComments.map((c) => ({ id: c.commentId, text: c.text, likeCount: c.likeCount })),
          filters,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAnalysisError(data.error ?? "Error al analizar los comentarios.");
        return null;
      }
      const response = data as AnalyzeResponse;
      setAnalysis(response.analysis);
      setAnalysisEngine(response.engine);
      setAnalysisWarning(response.warning ?? null);
      setInsights(response.insights ?? null);
      setAnalyzedFilters(filters);
      if (topicFilter !== "all" && !filters.some((f) => f.id === topicFilter)) setTopicFilter("all");
      return response;
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Error de red.");
      return null;
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleSubmit() {
    const urls = input
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      setRequestError("Pega al menos una URL de un reel o video de Instagram.");
      return;
    }

    setLoading(true);
    setRequestError(null);
    setAnalysis(null);
    setAnalysisEngine(null);
    setAnalysisWarning(null);
    setInsights(null);
    setAnalysisError(null);
    setSentimentFilter("all");
    setTopicFilter("all");
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRequestError(data.error ?? "Error al procesar la solicitud.");
        setResults([]);
        return;
      }
      setResults(data.results as ScrapeResult[]);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Error de red.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePdfExport() {
    setPdfLoading(true);
    try {
      // El reporte siempre lleva el análisis de sentimiento: si falta o quedó desactualizado,
      // se analiza antes de generar el PDF.
      if (!analysis || analysisStale) {
        const fresh = await handleAnalyze();
        if (fresh) {
          await downloadPdf({
            ...exportInput,
            results: analysis ? filteredResults : results,
            analysis: fresh.analysis,
            filters,
            engine: fresh.engine,
            insights: fresh.insights ?? null,
          });
          return;
        }
      }
      await downloadPdf(exportInput);
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="topbar">
        <div className="mark">
          <IconCamera />
        </div>
        <div className="topbar-text">
          <h1>Comment Export</h1>
          <p>Exportador de comentarios de Instagram</p>
        </div>
      </div>

      <div className="hero">
        <h2>Pega tus videos, obtén los comentarios</h2>
        <p>
          Una o varias URLs de reels o videos públicos de Instagram, una por línea. Vas a ver los
          comentarios organizados por video y podrás exportarlos todos a CSV.
        </p>
      </div>

      <div className="notice">
        <IconAlertTriangle />
        <span>
          Este proyecto usa métodos no oficiales de Instagram, por lo que puede dejar de funcionar
          sin aviso o requerir una sesión autenticada. Para resultados confiables, configura{" "}
          <code>IG_SESSIONID</code> (y opcionalmente <code>IG_DS_USER_ID</code> /{" "}
          <code>IG_CSRFTOKEN</code>) con la cookie de sesión de una cuenta tuya de Instagram. Ver{" "}
          <code>README.md</code>.
        </span>
      </div>

      <div className="card">
        <div className="card-label-row">
          <label htmlFor="urls">URLs de Instagram</label>
          {lineCount > 0 && (
            <span className="line-count">
              {lineCount} {lineCount === 1 ? "video" : "videos"}
            </span>
          )}
        </div>
        <textarea
          id="urls"
          placeholder={"https://www.instagram.com/reel/XXXXXXXXXXX/\nhttps://www.instagram.com/p/YYYYYYYYYYY/"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="actions">
          <button className="btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading && <span className="spinner" />}
            {loading ? "Obteniendo comentarios…" : "Obtener comentarios"}
          </button>
          <button
            className="btn-secondary"
            disabled={filteredCount === 0}
            onClick={() => downloadCsv(toCsv(exportInput))}
          >
            <IconDownload />
            Descargar CSV ({filteredCount})
          </button>
          <button
            className="btn-secondary"
            disabled={filteredCount === 0 || pdfLoading}
            onClick={handlePdfExport}
          >
            {pdfLoading ? <span className="spinner spinner-dark" /> : <IconFileText />}
            {pdfLoading ? (analyzing ? "Analizando comentarios…" : "Generando PDF…") : "Exportar PDF"}
          </button>
        </div>
        {requestError && (
          <div className="request-error">
            <IconAlertCircle />
            <span>{requestError}</span>
          </div>
        )}
      </div>

      {loading && (
        <div>
          {[0, 1].map((i) => (
            <div className="skeleton-block" key={i}>
              <div className="skeleton-line" style={{ width: "40%" }} />
              <div className="skeleton-line" style={{ width: "90%" }} />
              <div className="skeleton-line" style={{ width: "70%" }} />
            </div>
          ))}
        </div>
      )}

      {!loading && results.length > 0 && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="value">{results.length}</div>
              <div className="label">Videos procesados</div>
            </div>
            <div className="stat stat--ok">
              <div className="value">{okCount}</div>
              <div className="label">Con comentarios</div>
            </div>
            <div className="stat stat--error">
              <div className="value">{errorCount}</div>
              <div className="label">Con error</div>
            </div>
            <div className="stat">
              <div className="value">{totalComments}</div>
              <div className="label">Comentarios totales</div>
            </div>
          </div>

          {totalComments > 0 && (
            <div className="card analysis-card">
              <div className="analysis-head">
                <div>
                  <h3>Análisis y filtros</h3>
                  <p>
                    Clasificá los comentarios en positivos, negativos y neutrales, y creá tus propios
                    filtros por tema. Los filtros activos se aplican al CSV y al PDF, y el PDF incluye
                    una página de estadísticas y una sección por cada tema.
                  </p>
                </div>
              </div>

              <div className="filter-builder">
                <label>Filtros personalizados por tema</label>
                <div className="filter-inputs">
                  <input
                    type="text"
                    placeholder="Nombre (ej. Precio)"
                    value={newFilterName}
                    maxLength={40}
                    onChange={(e) => setNewFilterName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addFilter(newFilterName, newFilterDescription);
                    }}
                  />
                  <input
                    type="text"
                    className="filter-description-input"
                    placeholder="¿De qué tratan? (ej. preguntan cuánto cuesta o por promociones)"
                    value={newFilterDescription}
                    maxLength={200}
                    onChange={(e) => setNewFilterDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addFilter(newFilterName, newFilterDescription);
                    }}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!newFilterName.trim() || filters.length >= 10}
                    onClick={() => addFilter(newFilterName, newFilterDescription)}
                  >
                    <IconPlus />
                    Agregar
                  </button>
                </div>
                {filters.length === 0 ? (
                  <div className="filter-presets">
                    <span>Sugerencias:</span>
                    {FILTER_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={preset.name}
                        className="chip chip-ghost"
                        onClick={() => addFilter(preset.name, preset.description)}
                      >
                        + {preset.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="filter-list">
                    {filters.map((f) => (
                      <span className="chip" key={f.id} title={f.description}>
                        <strong>{f.name}</strong>
                        <span className="chip-description">{f.description}</span>
                        {analysis && topicCounts[f.id] !== undefined && (
                          <span className="chip-count">{topicCounts[f.id]}</span>
                        )}
                        <button
                          type="button"
                          className="chip-remove"
                          aria-label={`Quitar filtro ${f.name}`}
                          onClick={() => removeFilter(f.id)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="actions">
                <button className="btn-primary" onClick={handleAnalyze} disabled={analyzing}>
                  {analyzing && <span className="spinner" />}
                  {analyzing
                    ? "Analizando comentarios…"
                    : analysis
                      ? "Volver a analizar"
                      : `Analizar ${totalComments} comentarios`}
                </button>
                {analysisStale && !analyzing && (
                  <span className="analysis-hint">
                    Cambiaste los filtros: volvé a analizar para aplicarlos.
                  </span>
                )}
                {analysisEngine && !analysisStale && !analyzing && (
                  <span className="analysis-hint">
                    {analysisEngine === "gemini" ? "Analizado con IA (Gemini)" : "Análisis local por palabras clave"}
                  </span>
                )}
              </div>
              {analysisWarning && (
                <div className="analysis-warning">
                  <IconAlertTriangle />
                  <span>{analysisWarning}</span>
                </div>
              )}
              {analysisError && (
                <div className="request-error">
                  <IconAlertCircle />
                  <span>{analysisError}</span>
                </div>
              )}
              {insights && !analysisStale && (
                <div className="insights">
                  <p className="insights-label">Análisis de la IA · se incluye en el PDF</p>
                  <p>{insights.summary}</p>
                  {insights.recurringThemes.length > 0 && (
                    <div className="topic-tags">
                      {insights.recurringThemes.map((t) => (
                        <span className="topic-tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {analysis && overallStats && (
                <>
                  <div className="sentiment-summary">
                    <div className="sentiment-bar" aria-hidden="true">
                      {(["positive", "neutral", "negative"] as Sentiment[]).map((key) =>
                        overallStats[key] > 0 ? (
                          <span
                            key={key}
                            className={`sentiment-bar-segment sentiment-bg--${key}`}
                            style={{ flexGrow: overallStats[key] }}
                          />
                        ) : null
                      )}
                    </div>
                    <div className="stats sentiment-stats">
                      {(["positive", "negative", "neutral"] as Sentiment[]).map((key) => (
                        <div className={`stat stat--${key}`} key={key}>
                          <div className="value">{overallStats[key]}</div>
                          <div className="label">
                            {SENTIMENT_PLURAL_LABELS[key]} · {percent(overallStats[key], overallStats.total)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="filter-controls">
                    <div className="segmented" role="group" aria-label="Filtrar por sentimiento">
                      {SENTIMENT_FILTER_OPTIONS.map((o) => (
                        <button
                          type="button"
                          key={o.value}
                          className={sentimentFilter === o.value ? "active" : undefined}
                          onClick={() => setSentimentFilter(o.value)}
                        >
                          {o.label}
                          <span className="segmented-count">
                            {o.value === "all" ? overallStats.total : overallStats[o.value]}
                          </span>
                        </button>
                      ))}
                    </div>
                    {appliedFilters.length > 0 && (
                      <select
                        value={appliedFilters.some((f) => f.id === topicFilter) ? topicFilter : "all"}
                        onChange={(e) => setTopicFilter(e.target.value)}
                        aria-label="Filtrar por tema"
                      >
                        <option value="all">Todos los temas</option>
                        {appliedFilters.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name} ({topicCounts[f.id] ?? 0})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {activeFilterLabel && (
                    <p className="analysis-hint">
                      Mostrando {filteredCount} de {totalComments} comentarios · {activeFilterLabel}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <p className="section-heading">Resultados por video</p>

          {filteredResults.map((result, index) => (
            <div className="result-block" key={result.url}>
              <div className="result-header">
                <div className="result-header-main">
                  <div className="result-thumb">
                    <IconCamera />
                  </div>
                  <a href={result.url} target="_blank" rel="noreferrer">
                    {result.url}
                  </a>
                </div>
                <span className={`badge ${result.ok ? "badge-ok" : "badge-error"}`}>
                  {!result.ok
                    ? "sin datos"
                    : result.comments.length === results[index].comments.length
                      ? `${result.comments.length} comentarios`
                      : `${result.comments.length} de ${results[index].comments.length} comentarios`}
                </span>
              </div>
              {result.error && (
                <div className="result-error">
                  <IconAlertCircle />
                  <span>{result.error}</span>
                </div>
              )}
              {result.ok && result.comments.length === 0 && (
                <p className="filter-empty">Ningún comentario de este video coincide con los filtros.</p>
              )}
              {result.comments.length > 0 && (
                <table className="comments-table">
                  <thead>
                    <tr>
                      <th className="col-user">Usuario</th>
                      <th>Comentario</th>
                      <th className="col-date">Fecha</th>
                      <th className="col-likes">Likes</th>
                      {analysis && <th className="col-sentiment">Sentimiento</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {result.comments.map((c) => (
                      <tr key={c.commentId} className={c.parentCommentId ? "reply-row" : undefined}>
                        <td className="col-user" data-label="Usuario">
                          <div className="user-cell">
                            {c.parentCommentId && <IconReply />}
                            <span className="avatar" style={{ background: avatarColor(c.username) }}>
                              {initials(c.username)}
                            </span>
                            <span className="username">@{c.username}</span>
                          </div>
                        </td>
                        <td data-label="Comentario">
                          <CommentText text={c.text} />
                          {analysis && (
                            <div className="topic-tags">
                              {appliedFilters
                                .filter((f) => analysis[c.commentId]?.filterIds.includes(f.id))
                                .map((f) => (
                                  <span className="topic-tag" key={f.id}>
                                    {f.name}
                                  </span>
                                ))}
                            </div>
                          )}
                        </td>
                        <td className="col-date" data-label="Fecha">
                          {formatRelative(c.timestamp)}
                        </td>
                        <td className="col-likes" data-label="Likes">
                          {c.likeCount ?? "—"}
                        </td>
                        {analysis && (
                          <td className="col-sentiment" data-label="Sentimiento">
                            {analysis[c.commentId] ? (
                              <span className={`sentiment-badge sentiment--${analysis[c.commentId].sentiment}`}>
                                {SENTIMENT_LABELS[analysis[c.commentId].sentiment]}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      )}

      {!loading && results.length === 0 && (
        <div className="empty-state">
          <IconInbox />
          <p>
            Todavía no pediste ningún comentario. Pega arriba una o más URLs de reels/videos y
            presioná “Obtener comentarios”.
          </p>
        </div>
      )}
    </div>
  );
}
