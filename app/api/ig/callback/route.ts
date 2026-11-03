import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, getProfile, igConfig, redirectUri } from "@/lib/ig-graph";
import { sealSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, STATE_COOKIE } from "@/lib/ig-session";

export const dynamic = "force-dynamic";

// Vuelta desde Instagram: valida `state`, cambia el código por un token y guarda la sesión.
export async function GET(req: NextRequest) {
  const back = (status: string) => {
    const res = NextResponse.redirect(new URL(`/?cuenta=${status}`, req.url));
    res.cookies.delete(STATE_COOKIE);
    return res;
  };

  const config = igConfig();
  if (!config) return back("sin-configurar");

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return back("cancelada");
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || state !== req.cookies.get(STATE_COOKIE)?.value) return back("error");

  try {
    // Instagram agrega "#_" al final del código en algunos casos.
    const { token, userId } = await exchangeCode(
      code.replace(/#_$/, ""),
      redirectUri(req.nextUrl.origin),
      config.appId,
      config.appSecret
    );
    const profile = await getProfile(token);
    const res = back("conectada");
    res.cookies.set(
      SESSION_COOKIE,
      sealSession({ token, userId: profile.userId || userId, username: profile.username, issuedAt: Date.now() }),
      SESSION_COOKIE_OPTIONS
    );
    return res;
  } catch (err) {
    console.error("Fallo al conectar la cuenta de Instagram:", err);
    return back("error");
  }
}
