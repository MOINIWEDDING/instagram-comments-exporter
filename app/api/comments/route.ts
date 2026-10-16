import { NextRequest, NextResponse } from "next/server";
import { extractShortcode, fetchCommentsChunk } from "@/lib/instagram";
import type { CommentsChunkResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Cada pedido trae una tanda de comentarios de un video; la app vuelve a llamar con `cursor`
// hasta que `nextCursor` sea null. Así no hay tope de comentarios por video.
const TIME_BUDGET_MS = 50_000;

export async function POST(req: NextRequest) {
  let body: { url?: unknown; cursor?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido, se esperaba JSON." }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
  if (!url) {
    return NextResponse.json({ error: "Envía la URL del video en 'url'." }, { status: 400 });
  }

  const shortcode = extractShortcode(url);
  if (!shortcode) {
    const response: CommentsChunkResponse = {
      shortcode: null,
      mode: "none",
      comments: [],
      nextCursor: null,
      error: "URL de Instagram inválida.",
    };
    return NextResponse.json(response);
  }

  try {
    const outcome = await fetchCommentsChunk(url, shortcode, cursor, Date.now() + TIME_BUDGET_MS);
    const response: CommentsChunkResponse = { shortcode, ...outcome };
    return NextResponse.json(response);
  } catch (err) {
    const response: CommentsChunkResponse = {
      shortcode,
      mode: "none",
      comments: [],
      nextCursor: null,
      error: err instanceof Error ? err.message : "Error desconocido.",
    };
    return NextResponse.json(response);
  }
}
