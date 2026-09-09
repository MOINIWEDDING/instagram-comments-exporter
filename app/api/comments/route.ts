import { NextRequest, NextResponse } from "next/server";
import { extractShortcode, fetchCommentsForShortcode } from "@/lib/instagram";
import type { ScrapeResult } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_URLS_PER_REQUEST = 10;
const MAX_COMMENTS_PER_VIDEO = 300;
const TIME_BUDGET_MS = 50_000;

export async function POST(req: NextRequest) {
  let body: { urls?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido, se esperaba JSON." }, { status: 400 });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];

  if (urls.length === 0) {
    return NextResponse.json({ error: "Envía al menos una URL en 'urls'." }, { status: 400 });
  }
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Máximo ${MAX_URLS_PER_REQUEST} URLs por solicitud.` },
      { status: 400 }
    );
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  const results: ScrapeResult[] = [];

  for (const url of urls) {
    const shortcode = extractShortcode(url);
    if (!shortcode) {
      results.push({ url, shortcode: null, ok: false, mode: "none", error: "URL de Instagram inválida.", comments: [] });
      continue;
    }

    try {
      const outcome = await fetchCommentsForShortcode(url, shortcode, MAX_COMMENTS_PER_VIDEO, deadline);
      results.push({
        url,
        shortcode,
        ok: outcome.comments.length > 0,
        mode: outcome.mode,
        error: outcome.error,
        comments: outcome.comments,
      });
    } catch (err) {
      results.push({
        url,
        shortcode,
        ok: false,
        mode: "none",
        error: err instanceof Error ? err.message : "Error desconocido.",
        comments: [],
      });
    }
  }

  return NextResponse.json({ results });
}
