import { NextRequest, NextResponse } from "next/server";
import { describeIgError, getProfile, igConfig } from "@/lib/ig-graph";
import { getIgSession, withRenewed } from "@/lib/ig-route";

export const dynamic = "force-dynamic";

// Estado de la conexión y perfil de la cuenta conectada.
export async function GET(req: NextRequest) {
  if (!igConfig()) return NextResponse.json({ configured: false, connected: false });
  const current = await getIgSession(req);
  if (!current) return NextResponse.json({ configured: true, connected: false });
  try {
    const profile = await getProfile(current.session.token);
    return withRenewed(NextResponse.json({ configured: true, connected: true, profile }), current.renewed);
  } catch (err) {
    return NextResponse.json({ configured: true, connected: false, error: describeIgError(err) });
  }
}
