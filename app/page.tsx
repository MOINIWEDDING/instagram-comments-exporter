"use client";

import { useMemo, useState } from "react";
import type { ScrapeResult } from "@/lib/types";

function toCsv(results: ScrapeResult[]): string {
  const header = ["video_url", "shortcode", "usuario", "comentario", "fecha", "likes"];
  const rows = [header.join(",")];

  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;

  for (const result of results) {
    for (const c of result.comments) {
      const date = c.timestamp ? new Date(c.timestamp * 1000).toISOString() : "";
      rows.push(
        [
          escape(c.videoUrl),
          escape(c.shortcode),
          escape(c.username),
          escape(c.text),
          escape(date),
          String(c.likeCount ?? ""),
        ].join(",")
      );
    }
  }

  return rows.join("\n");
}

function downloadCsv(csv: string) {
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
  const [results, setResults] = useState<ScrapeResult[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);

  const lineCount = input.split("\n").map((l) => l.trim()).filter(Boolean).length;

  const totalComments = useMemo(
    () => results.reduce((sum, r) => sum + r.comments.length, 0),
    [results]
  );
  const okCount = results.filter((r) => r.ok).length;
  const errorCount = results.filter((r) => !r.ok).length;

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
            disabled={totalComments === 0}
            onClick={() => downloadCsv(toCsv(results))}
          >
            <IconDownload />
            Descargar CSV ({totalComments})
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

          <p className="section-heading">Resultados por video</p>

          {results.map((result) => (
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
                  {result.ok ? `${result.comments.length} comentarios` : "sin datos"}
                </span>
              </div>
              {result.error && (
                <div className="result-error">
                  <IconAlertCircle />
                  <span>{result.error}</span>
                </div>
              )}
              {result.comments.length > 0 && (
                <table className="comments-table">
                  <thead>
                    <tr>
                      <th className="col-user">Usuario</th>
                      <th>Comentario</th>
                      <th className="col-date">Fecha</th>
                      <th className="col-likes">Likes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.comments.map((c) => (
                      <tr key={c.commentId}>
                        <td className="col-user" data-label="Usuario">
                          <div className="user-cell">
                            <span className="avatar" style={{ background: avatarColor(c.username) }}>
                              {initials(c.username)}
                            </span>
                            <span className="username">@{c.username}</span>
                          </div>
                        </td>
                        <td data-label="Comentario">
                          <CommentText text={c.text} />
                        </td>
                        <td className="col-date" data-label="Fecha">
                          {formatRelative(c.timestamp)}
                        </td>
                        <td className="col-likes" data-label="Likes">
                          {c.likeCount ?? "—"}
                        </td>
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
