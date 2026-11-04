import type { CommentItem } from "./types";

// Cliente de la API oficial de Instagram. Soporta las dos formas de conexión que ofrece Meta:
// - "instagram": Instagram API with Instagram Login (se entra con el usuario de Instagram).
// - "facebook": Facebook Login for Business (se entra con Facebook y se llega a la cuenta de
//   Instagram a través de la página de Facebook vinculada). Se activa con META_LOGIN_CONFIG_ID.
// Solo funciona con cuentas profesionales (Empresa o Creador) y solo da acceso a las publicaciones
// de la cuenta conectada. Devuelve también los comentarios ocultos por el dueño (campo `hidden`).

export type IgProvider = "instagram" | "facebook";

/** Datos para llamar a la API en nombre de la cuenta conectada. */
export interface IgAuth {
  token: string;
  provider: IgProvider;
  /** Id de la cuenta de Instagram (en "facebook", el instagram_business_account de la página). */
  igUserId: string;
}

// Versión opcional de la API (p. ej. "v23.0"); sin ella se usa la versión por defecto de la app.
const VERSION = process.env.INSTAGRAM_GRAPH_VERSION ? `/${process.env.INSTAGRAM_GRAPH_VERSION}` : "";
const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_manage_comments"];

function graphHost(provider: IgProvider): string {
  return provider === "facebook" ? "https://graph.facebook.com" : "https://graph.instagram.com";
}

/** Nodo de la cuenta: "/me" con Instagram Login, el id de la cuenta con Facebook Login. */
function accountNode(auth: IgAuth): string {
  return auth.provider === "facebook" ? `/${auth.igUserId}` : "/me";
}

export class IgGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number
  ) {
    super(message);
  }
}

export function igConfig(): { appId: string; appSecret: string; provider: IgProvider; configId: string | null } | null {
  const appId = process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  const configId = process.env.META_LOGIN_CONFIG_ID || null;
  return { appId, appSecret, provider: configId ? "facebook" : "instagram", configId };
}

export function redirectUri(origin: string): string {
  return process.env.INSTAGRAM_REDIRECT_URI || `${origin}/api/ig/callback`;
}

export function authorizeUrl(
  config: NonNullable<ReturnType<typeof igConfig>>,
  redirect: string,
  state: string
): string {
  if (config.provider === "facebook") {
    // Facebook Login for Business: los permisos los define la configuración (config_id) en Meta.
    const url = new URL(`https://www.facebook.com${VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", config.appId);
    url.searchParams.set("config_id", config.configId!);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("override_default_response_type", "true");
    url.searchParams.set("state", state);
    return url.toString();
  }
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
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

/**
 * Cambia el código de autorización por un token de larga duración (60 días) y averigua la cuenta
 * de Instagram a la que da acceso.
 */
export async function exchangeCode(
  code: string,
  redirect: string,
  config: NonNullable<ReturnType<typeof igConfig>>
): Promise<IgAuth> {
  const { appId, appSecret, provider } = config;

  if (provider === "facebook") {
    const shortUrl = new URL(`https://graph.facebook.com${VERSION}/oauth/access_token`);
    shortUrl.searchParams.set("client_id", appId);
    shortUrl.searchParams.set("client_secret", appSecret);
    shortUrl.searchParams.set("redirect_uri", redirect);
    shortUrl.searchParams.set("code", code);
    const short = await readJson(await fetch(shortUrl, { cache: "no-store" }));
    const token = await exchangeFacebookToken(short.access_token, appId, appSecret).catch(() => short.access_token);
    const account = await findInstagramAccount(token, appId, appSecret);
    return { token, provider: account.provider, igUserId: account.id };
  }

  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirect,
    code,
  });
  const short = await readJson(await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body }));
  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("access_token", short.access_token);
  const long = await readJson(await fetch(longUrl, { cache: "no-store" }));
  return { token: long.access_token, provider, igUserId: String(short.user_id) };
}

/** Facebook: cambia un token por uno de larga duración (sirve también para renovarlo). */
async function exchangeFacebookToken(token: string, appId: string, appSecret: string): Promise<string> {
  const url = new URL(`https://graph.facebook.com${VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", token);
  const data = await readJson(await fetch(url, { cache: "no-store" }));
  return data.access_token;
}

/** Facebook: busca la cuenta de Instagram profesional vinculada a alguna página del usuario. */
/**
 * Facebook: busca la cuenta de Instagram profesional a la que da acceso el token. Según cómo se
 * configuró el inicio de sesión, Meta la expone en lugares distintos, así que se prueban varios:
 * 1. Las páginas del usuario (/me/accounts) con su instagram_business_account.
 * 2. Los activos autorizados en el token (debug_token → granular_scopes): ids de Instagram, o
 *    ids de páginas cuya cuenta de Instagram vinculada se consulta.
 * 3. Los portfolios empresariales del usuario (inicio de sesión unificado con activos de empresa).
 * Si nada funciona, el error resume lo que devolvió cada intento, para poder diagnosticarlo.
 */
async function findInstagramAccount(
  token: string,
  appId: string,
  appSecret: string
): Promise<{ id: string; provider: IgProvider }> {
  const fb = (id: string) => ({ id, provider: "facebook" as const });
  const notes: string[] = [];
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120);

  // 0. ID indicado a mano (INSTAGRAM_ACCOUNT_ID): se verifica que el token tenga acceso.
  const manualId = process.env.INSTAGRAM_ACCOUNT_ID?.trim();
  if (manualId) {
    try {
      const account = await graphGet("facebook", `/${manualId}`, token, { fields: "id,username" });
      if (account?.id) return fb(String(account.id));
    } catch (err) {
      notes.push(`INSTAGRAM_ACCOUNT_ID ${manualId}: sin acceso (${errorText(err)})`);
    }
  }

  // Inicio de sesión unificado: el token puede servir también en la API de Instagram.
  try {
    const me = await graphGet("instagram", "/me", token, { fields: "user_id,username" });
    if (me?.user_id || me?.id) return { id: String(me.user_id ?? me.id), provider: "instagram" };
  } catch (err) {
    notes.push(`API de Instagram: ${errorText(err)}`);
  }

  // 1. Páginas
  try {
    const data = await graphGet("facebook", "/me/accounts", token, {
      fields: "id,name,instagram_business_account,connected_instagram_account",
      limit: "100",
    });
    const pages: any[] = data.data ?? [];
    const page = pages.find((p) => p.instagram_business_account?.id || p.connected_instagram_account?.id);
    if (page) return fb(String(page.instagram_business_account?.id ?? page.connected_instagram_account.id));
    notes.push(
      pages.length === 0
        ? "páginas: ninguna compartida"
        : `páginas sin Instagram vinculado: ${pages.slice(0, 5).map((p) => p.name ?? p.id).join(", ")}`
    );
  } catch (err) {
    notes.push(`páginas: error (${errorText(err)})`);
  }

  // 2. Activos autorizados en el token
  let granted: string[] = [];
  try {
    const debug = await graphGet("facebook", "/debug_token", `${appId}|${appSecret}`, { input_token: token });
    const info = debug.data ?? {};
    granted = info.scopes ?? [];
    const scopes: { scope: string; target_ids?: string[] }[] = info.granular_scopes ?? [];
    notes.push(`tipo de token: ${info.type ?? "?"}`);
    notes.push(
      `permisos: ${scopes.map((s) => `${s.scope}${s.target_ids?.length ? `(${s.target_ids.length} activos)` : ""}`).join(", ") || granted.join(", ") || "ninguno"}`
    );

    const igTarget = scopes.find((s) => s.scope.startsWith("instagram_") && s.target_ids?.length)?.target_ids?.[0];
    if (igTarget) return fb(String(igTarget));

    // Ids de páginas autorizadas: se busca la cuenta de Instagram vinculada a cada una.
    const pageIds = [...new Set(scopes.filter((s) => s.scope.startsWith("pages_")).flatMap((s) => s.target_ids ?? []))];
    for (const pageId of pageIds.slice(0, 10)) {
      try {
        const page = await graphGet("facebook", `/${pageId}`, token, {
          fields: "instagram_business_account,connected_instagram_account",
        });
        const igId = page.instagram_business_account?.id ?? page.connected_instagram_account?.id;
        if (igId) return fb(String(igId));
      } catch {
        // Se sigue con la siguiente página.
      }
    }
  } catch (err) {
    notes.push(`activos del token: error (${errorText(err)})`);
  }

  // 3. Portfolios empresariales
  try {
    const data = await graphGet("facebook", "/me/businesses", token, {
      fields: "id,name,instagram_business_accounts{id,username},owned_instagram_accounts{id,username}",
      limit: "25",
    });
    for (const business of data.data ?? []) {
      const ig = business.instagram_business_accounts?.data?.[0] ?? business.owned_instagram_accounts?.data?.[0];
      if (ig?.id) return fb(String(ig.id));
    }
    notes.push(`portfolios: ${(data.data ?? []).length} sin cuenta de Instagram`);
  } catch (err) {
    notes.push(`portfolios: error (${errorText(err)})`);
  }

  const missing = ["instagram_basic", "instagram_manage_comments"].filter((s) => granted.length > 0 && !granted.includes(s));
  if (missing.length > 0) {
    throw new IgGraphError(
      `El permiso de conexión no incluye ${missing.join(" ni ")}. Agregalo a la configuración del inicio de sesión en Meta y volvé a conectar.`,
      400,
      -1
    );
  }
  throw new IgGraphError(
    `No se encontró la cuenta de Instagram autorizada. Cargá en Vercel la variable INSTAGRAM_ACCOUNT_ID con el ID de tu cuenta de Instagram (lo muestra Meta en el panel de la app, en "Genera identificadores de acceso") y volvé a conectar. Detalle: ${notes.join(" · ")}`,
    400,
    -1
  );
}

/** Renueva un token de larga duración por otros 60 días. */
export async function refreshToken(auth: IgAuth): Promise<string> {
  if (auth.provider === "facebook") {
    const config = igConfig();
    if (!config) throw new Error("Falta configurar la app de Meta.");
    return exchangeFacebookToken(auth.token, config.appId, config.appSecret);
  }
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", auth.token);
  const data = await readJson(await fetch(url, { cache: "no-store" }));
  return data.access_token;
}

async function graphGet(
  provider: IgProvider,
  path: string,
  token: string,
  params: Record<string, string> = {}
): Promise<any> {
  const url = new URL(`${graphHost(provider)}${VERSION}${path}`);
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

export async function getProfile(auth: IgAuth): Promise<IgProfile> {
  const data = await graphGet(auth.provider, accountNode(auth), auth.token, {
    fields:
      auth.provider === "facebook"
        ? "id,username,name,profile_picture_url,media_count"
        : "user_id,username,name,account_type,profile_picture_url,media_count",
  });
  return {
    userId: String(data.user_id ?? data.id),
    username: data.username,
    name: data.name ?? null,
    accountType: data.account_type ?? (auth.provider === "facebook" ? "BUSINESS" : null),
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

export async function listMedia(auth: IgAuth, after: string | null): Promise<{ media: IgMedia[]; next: string | null }> {
  const params: Record<string, string> = {
    fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count",
    limit: "24",
  };
  if (after) params.after = after;
  const data = await graphGet(auth.provider, `${accountNode(auth)}/media`, auth.token, params);
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
  auth: IgAuth,
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
    const data = await graphGet(auth.provider, `/${mediaId}/comments`, auth.token, params);

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
    if (err.code === -1) return err.message;
    if (/client secret|client_secret/i.test(err.message)) {
      return "La clave secreta de la app no es correcta: revisá INSTAGRAM_APP_SECRET en Vercel (Meta → Configuración → Básica → Clave secreta de la app).";
    }
    if (/redirect_uri/i.test(err.message)) {
      return "La dirección de vuelta no coincide con la registrada en Meta: agregá https://<tu-dominio>/api/ig/callback en los URI de redireccionamiento de OAuth válidos.";
    }
    if (/verification code|authorization code|code has (expired|been used)/i.test(err.message)) {
      return "El código de autorización venció o ya se usó: volvé a tocar \"Conectar mi Instagram\".";
    }
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
