import { NextRequest, NextResponse } from "next/server";
import { describeIgError, fetchMediaCommentsChunk } from "@/lib/ig-graph";
import { authFrom, getIgSession, notConnected, withRenewed } from "@/lib/ig-route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TIME_BUDGET_MS = 50_000;

// Una tanda de comentarios de una publicación propia; la app repite con `after` hasta terminar.
export async function POST(req: NextRequest) {
  const current = await getIgSession(req);
  if (!current) return notConnected();

  let body: { mediaId?: unknown; permalink?: unknown; after?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido, se esperaba JSON." }, { status: 400 });
  }
  const mediaId = typeof body.mediaId === "string" && /^\d+$/.test(body.mediaId) ? body.mediaId : null;
  const permalink = typeof body.permalink === "string" ? body.permalink : "";
  const after = typeof body.after === "string" && body.after ? body.after : null;
  if (!mediaId) return NextResponse.json({ error: "Falta 'mediaId'." }, { status: 400 });

  try {
    const chunk = await fetchMediaCommentsChunk(
      authFrom(current.session),
      mediaId,
      permalink,
      after,
      Date.now() + TIME_BUDGET_MS
    );
    return withRenewed(NextResponse.json(chunk), current.renewed);
  } catch (err) {
    return NextResponse.json({ error: describeIgError(err) }, { status: 502 });
  }
}
