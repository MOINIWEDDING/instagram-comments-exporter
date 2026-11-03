import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Sesión de la cuenta de Instagram conectada. El token se guarda cifrado (AES-256-GCM) en una
// cookie httpOnly: nunca llega al navegador en claro ni se guarda en el servidor.

export const SESSION_COOKIE = "ig_account";
export const STATE_COOKIE = "ig_oauth_state";

export interface IgSession {
  token: string;
  userId: string;
  username: string;
  /** Momento (ms) en que se obtuvo o renovó el token de larga duración. */
  issuedAt: number;
}

function key(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.INSTAGRAM_APP_SECRET;
  if (!secret) throw new Error("Falta SESSION_SECRET (o INSTAGRAM_APP_SECRET) para cifrar la sesión.");
  return createHash("sha256").update(secret).digest();
}

export function sealSession(session: IgSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function openSession(value: string | undefined): IgSession | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(json) as IgSession;
    return parsed.token && parsed.userId ? parsed : null;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  // Los tokens de larga duración de Instagram valen 60 días.
  maxAge: 60 * 24 * 60 * 60,
};
