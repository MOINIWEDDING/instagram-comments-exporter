import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeUrl, igConfig, redirectUri } from "@/lib/ig-graph";
import { STATE_COOKIE } from "@/lib/ig-session";

export const dynamic = "force-dynamic";

// Inicia la conexión: redirige a Instagram para que el usuario autorice la app.
export async function GET(req: NextRequest) {
  const config = igConfig();
  if (!config) {
    return NextResponse.redirect(new URL("/?cuenta=sin-configurar", req.url));
  }
  // `state` protege contra pedidos falsificados: se compara al volver de Instagram.
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authorizeUrl(config.appId, redirectUri(req.nextUrl.origin), state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return res;
}
