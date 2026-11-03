import { NextRequest, NextResponse } from "next/server";
import { openSession, sealSession, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, type IgSession } from "./ig-session";
import { refreshToken } from "./ig-graph";

// Renueva el token cuando tiene más de 7 días, para que la conexión no venza mientras se use.
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Lee la sesión de la cuenta conectada; null si no hay cuenta conectada. */
export async function getIgSession(req: NextRequest): Promise<{ session: IgSession; renewed: string | null } | null> {
  const session = openSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  if (Date.now() - session.issuedAt > REFRESH_AFTER_MS) {
    try {
      const token = await refreshToken(session.token);
      const renewedSession = { ...session, token, issuedAt: Date.now() };
      return { session: renewedSession, renewed: sealSession(renewedSession) };
    } catch {
      // Si no se pudo renovar, se sigue con el token actual mientras siga valiendo.
    }
  }
  return { session, renewed: null };
}

export function notConnected() {
  return NextResponse.json({ error: "No hay una cuenta de Instagram conectada." }, { status: 401 });
}

/** Guarda en la respuesta el token renovado, si lo hubo. */
export function withRenewed<T extends NextResponse>(res: T, renewed: string | null): T {
  if (renewed) res.cookies.set(SESSION_COOKIE, renewed, SESSION_COOKIE_OPTIONS);
  return res;
}
