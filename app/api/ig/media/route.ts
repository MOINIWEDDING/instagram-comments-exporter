import { NextRequest, NextResponse } from "next/server";
import { describeIgError, listMedia } from "@/lib/ig-graph";
import { authFrom, getIgSession, notConnected, withRenewed } from "@/lib/ig-route";

export const dynamic = "force-dynamic";

// Publicaciones de la cuenta conectada, de a 24 (con `after` para la página siguiente).
export async function GET(req: NextRequest) {
  const current = await getIgSession(req);
  if (!current) return notConnected();
  try {
    const page = await listMedia(authFrom(current.session), req.nextUrl.searchParams.get("after"));
    return withRenewed(NextResponse.json(page), current.renewed);
  } catch (err) {
    return NextResponse.json({ error: describeIgError(err) }, { status: 502 });
  }
}
