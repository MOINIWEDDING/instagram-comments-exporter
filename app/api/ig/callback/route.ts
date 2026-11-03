import { NextRequest, NextResponse } from "next/server";
import { describeIgError, exchangeCode, getProfile, igConfig, redirectUri } from "@/lib/ig-graph";
import { sealSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, STATE_COOKIE } from "@/lib/ig-session";

export const dynamic = "force-dynamic";

// Vuelta desde Instagram: valida `state`, cambia el código por un token y guarda la sesión.
export async function GET(req: NextRequest) {
  // `motivo` lleva a la app el detalle del error para mostrarlo.
  const back = (status: string, motivo?: string) => {
    const url = new URL(`/?cuenta=${status}`, req.url);
    if (motivo) url.searchParams.set("motivo", motivo.slice(0, 400));
    const res = NextResponse.redirect(url);
    res.cookies.delete(STATE_COOKIE);
    return res;
  };

  const config = igConfig();
  if (!config) return back("sin-configurar");

  const params = req.nextUrl.searchParams;
  if (params.get("error")) {
    const reason = params.get("error_reason") ?? params.get("error");
    if (reason === "user_denied" || reason === "access_denied") return back("cancelada");
    return back("error", params.get("error_description") ?? params.get("error_message") ?? reason ?? undefined);
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code) return back("error", "Meta no devolvió el código de autorización.");
  if (!state || state !== req.cookies.get(STATE_COOKIE)?.value) {
    return back(
      "error",
      "La conexión expiró o se empezó desde otra dirección. Abrí la app desde https://instagram-comments-exporter.vercel.app y volvé a tocar \"Conectar mi Instagram\"."
    );
  }

  try {
    // Instagram agrega "#_" al final del código en algunos casos.
    const auth = await exchangeCode(code.replace(/#_$/, ""), redirectUri(req.nextUrl.origin), config);
    const profile = await getProfile(auth);
    const res = back("conectada");
    res.cookies.set(
      SESSION_COOKIE,
      sealSession({
        token: auth.token,
        userId: auth.provider === "facebook" ? auth.igUserId : profile.userId || auth.igUserId,
        username: profile.username,
        provider: auth.provider,
        issuedAt: Date.now(),
      }),
      SESSION_COOKIE_OPTIONS
    );
    return res;
  } catch (err) {
    console.error("Fallo al conectar la cuenta de Instagram:", err);
    return back("error", describeIgError(err));
  }
}
