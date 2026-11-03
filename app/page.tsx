"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  AiInsights,
  AnalyzeResponse,
  CommentItem,
  CommentsChunkResponse,
  RepliesChunkResponse,
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

const MAX_URLS = 10;
// Tope de seguridad por video para no quedar en un bucle infinito si Instagram repite el cursor.
const MAX_COMMENTS_PER_VIDEO = 20_000;

const REPLY_PARENTS_PER_REQUEST = 40;

/** Ordena para que cada respuesta quede debajo de su comentario, como en Instagram. */
function groupReplies(comments: CommentItem[]): CommentItem[] {
  const byParent = new Map<string, CommentItem[]>();
  const topLevel: CommentItem[] = [];
  for (const c of comments) {
    if (c.parentCommentId) {
      const list = byParent.get(c.parentCommentId) ?? [];
      list.push(c);
      byParent.set(c.parentCommentId, list);
    } else {
      topLevel.push(c);
    }
  }
  const out: CommentItem[] = [];
  for (const c of topLevel) {
    out.push(c);
    const replies = byParent.get(c.commentId);
    if (replies) {
      out.push(...replies.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)));
      byParent.delete(c.commentId);
    }
  }
  for (const orphans of byParent.values()) out.push(...orphans);
  return out;
}

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

interface IgProfile {
  userId: string;
  username: string;
  name: string | null;
  accountType: string | null;
  profilePictureUrl: string | null;
  mediaCount: number | null;
}

interface IgMedia {
  id: string;
  caption: string | null;
  mediaType: string;
  thumbnailUrl: string | null;
  permalink: string;
  timestamp: string | null;
  commentsCount: number | null;
  likeCount: number | null;
}

interface IgStatus {
  configured: boolean;
  connected: boolean;
  profile?: IgProfile;
  error?: string;
}

const ACCOUNT_NOTICES: Record<string, { tone: "ok" | "error"; text: string }> = {
  conectada: { tone: "ok", text: "Tu cuenta de Instagram quedó conectada." },
  cancelada: { tone: "error", text: "Cancelaste la conexión con Instagram." },
  error: { tone: "error", text: "No se pudo conectar la cuenta. Revisá la configuración de la app de Meta y volvé a intentar." },
  "sin-configurar": { tone: "error", text: "Falta configurar INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET (ver README.md)." },
};

const MAX_SELECTED_MEDIA = 10;

function IconUserCircle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.2 18.4a7 7 0 0 1 11.6 0" />
    </svg>
  );
}

function IconLink() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ video: number; videos: number; fetched: number } | null>(null);
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

  // Cuenta propia conectada con la API oficial de Instagram
  const [source, setSource] = useState<"links" | "account">("links");
  const [igStatus, setIgStatus] = useState<IgStatus | null>(null);
  const [accountNotice, setAccountNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [media, setMedia] = useState<IgMedia[]>([]);
  const [mediaNext, setMediaNext] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [selectedMedia, setSelectedMedia] = useState<string[]>([]);

  async function loadMedia(after: string | null) {
    setMediaLoading(true);
    setMediaError(null);
    try {
      const res = await fetch(`/api/ig/media${after ? `?after=${encodeURIComponent(after)}` : ""}`);
      const data = await res.json();
      if (!res.ok) {
        setMediaError(data.error ?? "No se pudieron cargar tus publicaciones.");
        return;
      }
      setMedia((prev) => (after ? [...prev, ...data.media] : data.media));
      setMediaNext(data.next);
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : "Error de red.");
    } finally {
      setMediaLoading(false);
    }
  }

  async function loadAccount() {
    try {
      const res = await fetch("/api/ig/me");
      const status = (await res.json()) as IgStatus;
      setIgStatus(status);
      if (status.connected) await loadMedia(null);
    } catch {
      setIgStatus({ configured: false, connected: false });
    }
  }

  useEffect(() => {
    // Al volver de Instagram, la URL trae ?cuenta=… con el resultado de la conexión.
    const params = new URLSearchParams(window.location.search);
    const notice = params.get("cuenta");
    if (notice) {
      setSource("account");
      setAccountNotice(ACCOUNT_NOTICES[notice] ?? null);
      window.history.replaceState(null, "", window.location.pathname);
    }
    void loadAccount();
  }, []);

  async function handleDisconnect() {
    await fetch("/api/ig/logout", { method: "POST" });
    setIgStatus((prev) => (prev ? { ...prev, connected: false, profile: undefined } : prev));
    setMedia([]);
    setMediaNext(null);
    setSelectedMedia([]);
    setAccountNotice(null);
  }

  function toggleMedia(id: string) {
    setSelectedMedia((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : prev.length >= MAX_SELECTED_MEDIA ? prev : [...prev, id]
    );
  }

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

  function startLoading() {
    setLoading(true);
    setRequestError(null);
    setAnalysis(null);
    setAnalysisEngine(null);
    setAnalysisWarning(null);
    setInsights(null);
    setAnalysisError(null);
    setSentimentFilter("all");
    setTopicFilter("all");
  }

  // Comentarios de publicaciones propias con la API oficial (incluye los ocultos).
  async function handleAccountSubmit() {
    const chosen = media.filter((m) => selectedMedia.includes(m.id));
    if (chosen.length === 0) {
      setRequestError("Elegí al menos una publicación.");
      return;
    }
    startLoading();
    try {
      const collected: ScrapeResult[] = [];
      for (const [index, item] of chosen.entries()) {
        const result: ScrapeResult = {
          url: item.permalink,
          shortcode: item.permalink.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? null,
          ok: false,
          mode: "account",
          comments: [],
          reportedCount: item.commentsCount,
        };
        const seen = new Set<string>();
        let after: string | null = null;
        setProgress({ video: index + 1, videos: chosen.length, fetched: 0 });
        do {
          const res: Response = await fetch("/api/ig/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mediaId: item.id, permalink: item.permalink, after }),
          });
          const data: { comments?: CommentItem[]; next?: string | null; error?: string } = await res.json();
          if (!res.ok) {
            result.error = data.error ?? "No se pudieron leer los comentarios.";
            break;
          }
          for (const c of data.comments ?? []) {
            if (seen.has(c.commentId)) continue;
            seen.add(c.commentId);
            result.comments.push(c);
          }
          after = data.next && data.next !== after ? data.next : null;
          setProgress({ video: index + 1, videos: chosen.length, fetched: result.comments.length });
        } while (after && result.comments.length < MAX_COMMENTS_PER_VIDEO);
        result.comments = groupReplies(result.comments);
        result.ok = result.comments.length > 0;
        collected.push(result);
      }
      setResults(collected);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Error de red.");
    } finally {
      setLoading(false);
      setProgress(null);
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
    if (urls.length > MAX_URLS) {
      setRequestError(`Máximo ${MAX_URLS} URLs por vez.`);
      return;
    }

    startLoading();
    try {
      const collected: ScrapeResult[] = [];
      for (const [index, url] of urls.entries()) {
        const result: ScrapeResult = { url, shortcode: null, ok: false, mode: "none", comments: [] };
        const seen = new Set<string>();
        let cursor: string | null = null;
        let retries = 0;
        const pendingParents: string[] = [];
        let topLevelCount = 0;
        let expectedReplies = 0;
        const addComments = (comments: CommentItem[]) => {
          for (const c of comments) {
            if (seen.has(c.commentId)) continue;
            seen.add(c.commentId);
            result.comments.push(c);
          }
        };
        setProgress({ video: index + 1, videos: urls.length, fetched: 0 });

        // Pide tandas hasta que Instagram indique que no hay más comentarios.
        do {
          const res = await fetch("/api/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, cursor }),
          });
          const data = await res.json();
          if (!res.ok) {
            result.error = data.error ?? "Error al procesar la solicitud.";
            break;
          }
          const chunk = data as CommentsChunkResponse;
          result.shortcode = chunk.shortcode;
          result.mode = chunk.mode;
          addComments(chunk.comments);
          pendingParents.push(...(chunk.pendingReplies ?? []));
          topLevelCount += chunk.topLevelCount ?? 0;
          expectedReplies += chunk.expectedReplies ?? 0;
          if (chunk.reportedCount != null) result.reportedCount = chunk.reportedCount;
          setProgress({ video: index + 1, videos: urls.length, fetched: result.comments.length });

          if (chunk.error && chunk.nextCursor && retries < 3) {
            // Error pasajero de Instagram: se espera un poco y se reintenta desde la página que falló.
            retries++;
            cursor = chunk.nextCursor;
            await new Promise((resolve) => setTimeout(resolve, 4_000 * retries));
            continue;
          }
          if (chunk.error) result.error = chunk.error;
          // Si Instagram repite el cursor, se corta para no pedir lo mismo para siempre.
          cursor = chunk.nextCursor && chunk.nextCursor !== cursor ? chunk.nextCursor : null;
          retries = 0;
        } while (cursor && !result.error && result.comments.length < MAX_COMMENTS_PER_VIDEO);

        // Segunda fase: respuestas de los comentarios que tienen más de las que vienen de vista previa.
        const attempts = new Map<string, number>();
        let queue = [...new Set(pendingParents)];
        let stalls = 0;
        while (queue.length > 0 && !result.error && stalls < 3) {
          const parents = queue.slice(0, REPLY_PARENTS_PER_REQUEST);
          queue = queue.slice(REPLY_PARENTS_PER_REQUEST);
          const res = await fetch("/api/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, replyParents: parents }),
          });
          const data = (await res.json()) as RepliesChunkResponse;
          const before = result.comments.length;
          addComments(data.comments ?? []);
          const skipped = data.skipped ?? [];
          // Si un pedido no avanzó nada varias veces seguidas, se corta para no quedar en un bucle.
          stalls = result.comments.length > before || skipped.length < parents.length ? 0 : stalls + 1;
          queue.unshift(...skipped);
          setProgress({ video: index + 1, videos: urls.length, fetched: result.comments.length });
          // Lo que quedó sin terminar (por tiempo o error pasajero) se reintenta hasta 3 veces.
          const retry = (data.unfinished ?? []).filter((id) => {
            const n = (attempts.get(id) ?? 0) + 1;
            attempts.set(id, n);
            return n <= 3;
          });
          if (retry.length > 0) {
            if (data.error) await new Promise((resolve) => setTimeout(resolve, 4_000));
            queue.push(...retry);
          }
        }

        result.comments = groupReplies(result.comments);
        result.topLevelCount = topLevelCount;
        result.expectedReplies = expectedReplies;
        result.ok = result.comments.length > 0;
        collected.push(result);
      }
      setResults(collected);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Error de red.");
    } finally {
      setLoading(false);
      setProgress(null);
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
        <h2>{source === "links" ? "Pega tus videos, obtén los comentarios" : "Tus publicaciones, todos sus comentarios"}</h2>
        <p>
          {source === "links"
            ? "Una o varias URLs de reels o videos públicos de Instagram, una por línea. Vas a ver los comentarios organizados por video y podrás exportarlos a CSV o PDF."
            : "Conectá tu cuenta de Instagram, elegí una o varias publicaciones y extraé todos sus comentarios con la API oficial, incluidos los que ocultaste."}
        </p>
      </div>

      <div className="source-tabs" role="tablist" aria-label="Origen de los comentarios">
        <button
          type="button"
          role="tab"
          aria-selected={source === "links"}
          className={source === "links" ? "active" : undefined}
          onClick={() => setSource("links")}
        >
          <IconLink />
          Por enlace
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source === "account"}
          className={source === "account" ? "active" : undefined}
          onClick={() => setSource("account")}
        >
          <IconUserCircle />
          Mi cuenta
          {igStatus?.connected && igStatus.profile && <span className="tab-meta">@{igStatus.profile.username}</span>}
        </button>
      </div>

      {source === "links" && (
        <div className="notice">
          <IconAlertTriangle />
          <span>
            Este modo usa métodos no oficiales de Instagram, por lo que puede dejar de funcionar sin
            aviso o requerir una sesión autenticada. Para resultados confiables, configura{" "}
            <code>IG_SESSIONID</code> (y opcionalmente <code>IG_DS_USER_ID</code> /{" "}
            <code>IG_CSRFTOKEN</code>) con la cookie de sesión de una cuenta tuya de Instagram. Ver{" "}
            <code>README.md</code>.
          </span>
        </div>
      )}

      <div className="card">
        {source === "links" ? (
          <>
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
          </>
        ) : (
          <div className="account-panel">
            {accountNotice && (
              <div className={accountNotice.tone === "ok" ? "account-notice ok" : "request-error"}>
                {accountNotice.tone === "ok" ? <IconUserCircle /> : <IconAlertCircle />}
                <span>{accountNotice.text}</span>
              </div>
            )}
            {!igStatus ? (
              <div className="skeleton-line" style={{ width: "50%" }} />
            ) : !igStatus.configured ? (
              <div className="account-empty">
                <h3>Falta configurar la conexión</h3>
                <p>
                  Para conectar tu cuenta hay que crear una app en Meta for Developers y agregar{" "}
                  <code>INSTAGRAM_APP_ID</code> e <code>INSTAGRAM_APP_SECRET</code> a las variables de
                  entorno. Los pasos están en <code>README.md</code>.
                </p>
              </div>
            ) : !igStatus.connected ? (
              <div className="account-empty">
                <h3>Conectá tu cuenta de Instagram</h3>
                <p>
                  Vas a poder elegir tus publicaciones y extraer todos sus comentarios con la API oficial
                  de Instagram, incluidos los que ocultaste. Tu cuenta tiene que ser profesional (Empresa o
                  Creador); el cambio es gratis desde la configuración de Instagram.
                </p>
                {igStatus.error && (
                  <div className="request-error">
                    <IconAlertCircle />
                    <span>{igStatus.error}</span>
                  </div>
                )}
                <a className="btn-primary btn-link" href="/api/ig/login">
                  <IconUserCircle />
                  Conectar mi Instagram
                </a>
              </div>
            ) : (
              <>
                <div className="account-header">
                  {igStatus.profile?.profilePictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="account-avatar" src={igStatus.profile.profilePictureUrl} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="account-avatar avatar" style={{ background: avatarColor(igStatus.profile?.username ?? "") }}>
                      {initials(igStatus.profile?.username ?? "")}
                    </span>
                  )}
                  <div className="account-header-text">
                    <strong>@{igStatus.profile?.username}</strong>
                    <span>
                      {igStatus.profile?.mediaCount != null ? `${igStatus.profile.mediaCount} publicaciones · ` : ""}
                      Elegí hasta {MAX_SELECTED_MEDIA} para extraer sus comentarios
                    </span>
                  </div>
                  <button type="button" className="btn-secondary btn-small" onClick={handleDisconnect}>
                    Desconectar
                  </button>
                </div>

                {mediaError && (
                  <div className="request-error">
                    <IconAlertCircle />
                    <span>{mediaError}</span>
                  </div>
                )}

                <div className="media-grid">
                  {media.map((m) => {
                    const selected = selectedMedia.includes(m.id);
                    return (
                      <button
                        type="button"
                        key={m.id}
                        className={`media-tile${selected ? " selected" : ""}`}
                        onClick={() => toggleMedia(m.id)}
                        aria-pressed={selected}
                        title={m.caption ?? undefined}
                      >
                        <span className="media-thumb">
                          {m.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={m.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <IconCamera />
                          )}
                          {m.mediaType === "VIDEO" && <span className="media-type">Reel</span>}
                          {m.mediaType === "CAROUSEL_ALBUM" && <span className="media-type">Carrusel</span>}
                          <span className="media-check" aria-hidden="true">
                            {selected ? "✓" : ""}
                          </span>
                        </span>
                        <span className="media-meta">
                          <span className="media-count">{m.commentsCount ?? 0} comentarios</span>
                          {m.timestamp && (
                            <span className="media-date">{new Date(m.timestamp).toLocaleDateString("es-ES")}</span>
                          )}
                        </span>
                        <span className="media-caption">{m.caption || "Sin descripción"}</span>
                      </button>
                    );
                  })}
                  {mediaLoading &&
                    Array.from({ length: media.length === 0 ? 6 : 3 }).map((_, i) => (
                      <span className="media-tile media-skeleton" key={`s${i}`} />
                    ))}
                </div>
                {!mediaLoading && media.length === 0 && !mediaError && (
                  <p className="filter-empty">Tu cuenta todavía no tiene publicaciones.</p>
                )}
                {mediaNext && !mediaLoading && (
                  <button type="button" className="btn-secondary btn-small media-more" onClick={() => loadMedia(mediaNext)}>
                    Cargar más publicaciones
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div className="actions">
          <button
            className="btn-primary"
            onClick={source === "links" ? handleSubmit : handleAccountSubmit}
            disabled={loading || (source === "account" && (!igStatus?.connected || selectedMedia.length === 0))}
          >
            {loading && <span className="spinner" />}
            {loading
              ? progress
                ? `Obteniendo comentarios… ${progress.fetched}${progress.videos > 1 ? ` (video ${progress.video} de ${progress.videos})` : ""}`
                : "Obteniendo comentarios…"
              : source === "account" && selectedMedia.length > 0
                ? `Obtener comentarios (${selectedMedia.length})`
                : "Obtener comentarios"}
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
                    : result.comments.length !== results[index].comments.length
                      ? `${result.comments.length} de ${results[index].comments.length} comentarios`
                      : (results[index].reportedCount ?? 0) > result.comments.length
                        ? `${result.comments.length} de ${results[index].reportedCount} según Instagram`
                        : `${result.comments.length} comentarios`}
                </span>
              </div>
              {result.error && (
                <div className="result-error">
                  <IconAlertCircle />
                  <span>{result.error}</span>
                </div>
              )}
              {(() => {
                const full = results[index];
                if (!full.reportedCount || full.reportedCount <= full.comments.length) return null;
                const replies = full.comments.filter((c) => c.parentCommentId).length;
                const topLevel = full.comments.length - replies;
                return (
                  <p className="count-detail">
                    Leídos: {topLevel} comentarios principales y {replies}
                    {full.expectedReplies ? ` de ${full.expectedReplies}` : ""} respuestas. Instagram informa{" "}
                    {full.reportedCount} en total;{" "}
                    {full.mode === "account"
                      ? "la diferencia suele ser de comentarios eliminados o de cuentas restringidas, que la API oficial no devuelve (los que ocultaste sí están incluidos)."
                      : "la diferencia suele ser de comentarios ocultos por Instagram (spam u ofensivos), borrados o de cuentas restringidas, que no se pueden leer."}
                  </p>
                );
              })()}
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
                            {c.hidden && <span className="hidden-badge">Oculto</span>}
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
            {source === "links"
              ? "Todavía no pediste ningún comentario. Pega arriba una o más URLs de reels/videos y presioná “Obtener comentarios”."
              : "Todavía no pediste ningún comentario. Elegí arriba una o más publicaciones y presioná “Obtener comentarios”."}
          </p>
        </div>
      )}
    </div>
  );
}
