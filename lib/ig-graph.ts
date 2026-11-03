import type { CommentItem } from "./types";

// Cliente de la API oficial de Instagram ("Instagram API with Instagram Login"). Solo funciona con
// cuentas profesionales (Empresa o Creador) y solo da acceso a las publicaciones de la cuenta
// conectada. Devuelve también los comentarios ocultos por el dueño (campo `hidden`).

const GRAPH = "https://graph.instagram.com";
// Versión opcional de la API (p. ej. "v23.0"); sin ella se usa la versión por defecto de la app.
const VERSION = process.env.INSTAGRAM_GRAPH_VERSION ? `/${process.env.INSTAGRAM_GRAPH_VERSION}` : "";
const SCOPES = ["instagram_business_basic", "instagram_business_manage_comments"];

export class IgGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number
  ) {
    super(message);
  }
}

export function igConfig() {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export function redirectUri(origin: string): string {
  return process.env.INSTAGRAM_REDIRECT_URI || `${origin}/api/ig/callback`;
}

export function authorizeUrl(appId: string, redirect: string, state: string): string {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

async function readJson(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error || data?.error_message) {
    const err = data?.error ?? {};
    const message = err.message ?? data?.error_message ?? `Instagram respondió ${res.status}.`;
    throw new IgGraphError(message, res.status, err.code ?? data?.code);
  }
  return data;
}

/** Cambia el código de autorización por un token de larga duración (60 días). */
export async function exchangeCode(
  code: string,
  redirect: string,
  appId: string,
  appSecret: string
): Promise<{ token: string; userId: string }> {
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirect,
    code,
  });
  const short = await readJson(await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body }));
  const longUrl = new URL(`${GRAPH}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("access_token", short.access_token);
  const long = await readJson(await fetch(longUrl, { cache: "no-store" }));
  return { token: long.access_token, userId: String(short.user_id) };
}

/** Renueva un token de larga duración por otros 60 días. */
export async function refreshToken(token: string): Promise<string> {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const data = await readJson(await fetch(url, { cache: "no-store" }));
  return data.access_token;
}

async function graphGet(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${GRAPH}${VERSION}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  return graphGetUrl(url.toString());
}

async function graphGetUrl(url: string): Promise<any> {
  // Errores pasajeros (límite de uso o fallas del servidor): se reintenta con espera.
  for (const wait of [0, 2_000, 5_000]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const res = await fetch(url, { cache: "no-store" });
    if ((res.status === 429 || res.status >= 500) && wait !== 5_000) continue;
    return readJson(res);
  }
}

export interface IgProfile {
  userId: string;
  username: string;
  name: string | null;
  accountType: string | null;
  profilePictureUrl: string | null;
  mediaCount: number | null;
}

export async function getProfile(token: string): Promise<IgProfile> {
  const data = await graphGet("/me", token, {
    fields: "user_id,username,name,account_type,profile_picture_url,media_count",
  });
  return {
    userId: String(data.user_id ?? data.id),
    username: data.username,
    name: data.name ?? null,
    accountType: data.account_type ?? null,
    profilePictureUrl: data.profile_picture_url ?? null,
    mediaCount: data.media_count ?? null,
  };
}

export interface IgMedia {
  id: string;
  caption: string | null;
  mediaType: string;
  thumbnailUrl: string | null;
  permalink: string;
  timestamp: string | null;
  commentsCount: number | null;
  likeCount: number | null;
}

export async function listMedia(token: string, after: string | null): Promise<{ media: IgMedia[]; next: string | null }> {
  const params: Record<string, string> = {
    fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count",
    limit: "24",
  };
  if (after) params.after = after;
  const data = await graphGet("/me/media", token, params);
  const media: IgMedia[] = (data.data ?? []).map((m: any) => ({
    id: String(m.id),
    caption: m.caption ?? null,
    mediaType: m.media_type,
    // En videos media_url es el video: para la miniatura se usa thumbnail_url.
    thumbnailUrl: m.thumbnail_url ?? (m.media_type === "VIDEO" ? null : m.media_url ?? null),
    permalink: m.permalink,
    timestamp: m.timestamp ?? null,
    commentsCount: m.comments_count ?? null,
    likeCount: m.like_count ?? null,
  }));
  return { media, next: data.paging?.next ? (data.paging?.cursors?.after ?? null) : null };
}

const COMMENT_FIELDS = "id,text,timestamp,username,like_count,hidden,parent_id";

function shortcodeFromPermalink(permalink: string): string {
  return permalink.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
}

function mapComment(c: any, permalink: string, parentId: string | null): CommentItem {
  return {
    videoUrl: permalink,
    shortcode: shortcodeFromPermalink(permalink),
    commentId: String(c.id),
    parentCommentId: parentId ?? (c.parent_id ? String(c.parent_id) : null),
    username: c.username ?? c.from?.username ?? "desconocido",
    text: c.text ?? "",
    timestamp: c.timestamp ? Math.floor(new Date(c.timestamp).getTime() / 1000) : null,
    likeCount: typeof c.like_count === "number" ? c.like_count : null,
    hidden: Boolean(c.hidden),
  };
}

/**
 * Trae una tanda de comentarios (con todas sus respuestas) de una publicación propia, hasta agotar
 * el tiempo. Devuelve el cursor para seguir en otro pedido si quedan más.
 */
export async function fetchMediaCommentsChunk(
  token: string,
  mediaId: string,
  permalink: string,
  after: string | null,
  deadlineMs: number
): Promise<{ comments: CommentItem[]; next: string | null }> {
  const comments: CommentItem[] = [];
  let cursor = after;

  do {
    const params: Record<string, string> = {
      fields: `${COMMENT_FIELDS},replies.limit(50){${COMMENT_FIELDS}}`,
      limit: "50",
    };
    if (cursor) params.after = cursor;
    const data = await graphGet(`/${mediaId}/comments`, token, params);

    for (const c of data.data ?? []) {
      comments.push(mapComment(c, permalink, null));
      const replies = c.replies;
      for (const r of replies?.data ?? []) comments.push(mapComment(r, permalink, String(c.id)));
      // Si el comentario tiene más de 50 respuestas, se siguen las páginas siguientes.
      let nextReplies: string | null = replies?.paging?.next ?? null;
      while (nextReplies) {
        const page = await graphGetUrl(nextReplies);
        for (const r of page.data ?? []) comments.push(mapComment(r, permalink, String(c.id)));
        nextReplies = page.paging?.next ?? null;
      }
    }

    cursor = data.paging?.next ? (data.paging?.cursors?.after ?? null) : null;
  } while (cursor && Date.now() + 8_000 < deadlineMs);

  return { comments, next: cursor };
}

/** Mensaje entendible para los errores más comunes de la API. */
export function describeIgError(err: unknown): string {
  if (err instanceof IgGraphError) {
    if (err.code === 190 || err.status === 401) {
      return "La conexión con Instagram venció o fue revocada: volvé a conectar tu cuenta.";
    }
    if (err.code === 10 || err.code === 200) {
      return "Falta permiso para leer comentarios: volvé a conectar la cuenta y aceptá todos los permisos.";
    }
    if (err.code === 4 || err.code === 17 || err.code === 32 || err.status === 429) {
      return "Instagram limitó la cantidad de pedidos: esperá unos minutos y volvé a intentar.";
    }
    return `Instagram respondió: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Error desconocido.";
}
