import type { CommentItem } from "./types";

const APP_ID = "936619743392459";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export class InstagramAuthRequiredError extends Error {}

export function extractShortcode(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    const match = url.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function shortcodeToMediaId(shortcode: string): string {
  let mediaId = 0n;
  for (const char of shortcode) {
    const idx = SHORTCODE_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Shortcode inválido: ${shortcode}`);
    }
    mediaId = mediaId * 64n + BigInt(idx);
  }
  return mediaId.toString();
}

function buildSession(): { cookie: string; csrfToken: string } | null {
  const sessionId = process.env.IG_SESSIONID;
  if (!sessionId) return null;
  const dsUserId = process.env.IG_DS_USER_ID;
  const csrfToken = process.env.IG_CSRFTOKEN ?? "missing";
  const parts = [`sessionid=${sessionId}`];
  if (dsUserId) parts.push(`ds_user_id=${dsUserId}`);
  parts.push(`csrftoken=${csrfToken}`);
  return { cookie: parts.join("; "), csrfToken };
}

interface PrivateApiComment {
  pk: string | number;
  text: string;
  created_at?: number;
  comment_like_count?: number;
  user?: { username?: string };
  parent_comment_id?: string | number;
  child_comment_count?: number;
  preview_child_comments?: PrivateApiComment[];
  has_more_tail_child_comments?: boolean;
  next_max_child_cursor?: string;
}

function igHeaders(shortcode: string, cookie: string, csrfToken: string): HeadersInit {
  return {
    "User-Agent": BROWSER_USER_AGENT,
    "X-IG-App-ID": APP_ID,
    "X-CSRFToken": csrfToken,
    "X-Requested-With": "XMLHttpRequest",
    "X-ASBD-ID": "198387",
    "X-IG-WWW-Claim": "0",
    Accept: "*/*",
    Origin: "https://www.instagram.com",
    Referer: `https://www.instagram.com/p/${shortcode}/`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Cookie: cookie,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function igApiFetch(
  url: string,
  shortcode: string,
  cookie: string,
  csrfToken: string
): Promise<any> {
  // Instagram a veces limita (429) o falla (5xx) por un momento: se reintenta con espera.
  let res: Response | null = null;
  for (const wait of [0, 2_000, 5_000]) {
    if (wait) await sleep(wait);
    res = await fetch(url, {
      headers: igHeaders(shortcode, cookie, csrfToken),
      cache: "no-store",
    });
    if (res.status !== 429 && res.status < 500) break;
  }
  if (!res) throw new Error("No se pudo contactar a Instagram.");

  if (res.status === 401 || res.status === 403) {
    throw new InstagramAuthRequiredError(
      "Instagram rechazó la sesión configurada (IG_SESSIONID vencida o inválida)."
    );
  }
  if (!res.ok) {
    throw new Error(`Instagram respondió ${res.status} al pedir comentarios.`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new InstagramAuthRequiredError(
      "Instagram devolvió una página en vez de datos (probablemente detectó la sesión como sospechosa o pide reautenticación). Corré 'npm run get-session' de nuevo para refrescar la sesión."
    );
  }

  const data = await res.json();
  if (data?.status && data.status !== "ok") {
    if (data?.message?.toLowerCase?.().includes("login")) {
      throw new InstagramAuthRequiredError("Instagram exige login para este contenido.");
    }
    throw new Error(data?.message ?? "Respuesta inesperada de Instagram.");
  }

  return data;
}

/**
 * Instagram pagina los comentarios en dos direcciones desde la primera página: `min_id` lleva a
 * los más nuevos ("headload") y `max_id` a los más antiguos. Hay que recorrer ambas para no
 * perder comentarios. El cursor guarda las dos direcciones pendientes.
 */
interface PageCursor {
  min: string | null;
  max: string | null;
}

function encodeCursor(cursor: PageCursor): string | null {
  return cursor.min || cursor.max ? JSON.stringify(cursor) : null;
}

function decodeCursor(raw: string | null): PageCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return { min: parsed.min ?? null, max: parsed.max ?? null };
  } catch {
    return { min: raw, max: null };
  }
}

async function fetchCommentsPageAuthenticated(
  shortcode: string,
  mediaId: string,
  cookie: string,
  csrfToken: string,
  cursor: PageCursor | null
): Promise<{ comments: PrivateApiComment[]; cursor: PageCursor; reportedCount: number | null }> {
  const url = new URL(`https://www.instagram.com/api/v1/media/${mediaId}/comments/`);
  url.searchParams.set("can_support_threading", "true");
  url.searchParams.set("permalink_enabled", "false");
  const direction: "first" | "min" | "max" = !cursor ? "first" : cursor.min ? "min" : "max";
  if (direction === "min") url.searchParams.set("min_id", cursor!.min!);
  if (direction === "max") url.searchParams.set("max_id", cursor!.max!);

  const data = await igApiFetch(url.toString(), shortcode, cookie, csrfToken);

  const comments: PrivateApiComment[] = data.comments ?? [];
  const nextMin: string | null =
    (data.has_more_headload_comments ?? Boolean(data.next_min_id)) && data.next_min_id ? String(data.next_min_id) : null;
  const nextMax: string | null =
    (data.has_more_comments ?? Boolean(data.next_max_id)) && data.next_max_id ? String(data.next_max_id) : null;
  const reportedCount = typeof data.comment_count === "number" ? data.comment_count : null;

  // Solo avanza la dirección que se pidió; la otra queda pendiente como estaba.
  const next: PageCursor =
    direction === "first"
      ? { min: nextMin, max: nextMax }
      : direction === "min"
        ? { min: nextMin, max: cursor!.max }
        : { min: null, max: nextMax };

  return { comments, cursor: next, reportedCount };
}

/**
 * Trae todas las respuestas de un comentario. Igual que los comentarios, las respuestas se
 * paginan en dos direcciones (más antiguas con `max_id` y más nuevas con `min_id`); se recorren
 * ambas. `complete` es false si se cortó por tiempo y hay que volver a pedirlas.
 */
async function fetchAllReplies(
  shortcode: string,
  mediaId: string,
  commentId: string,
  cookie: string,
  csrfToken: string,
  deadlineMs: number
): Promise<{ replies: PrivateApiComment[]; complete: boolean }> {
  const collected: PrivateApiComment[] = [];
  let tail: string | null = null;
  let head: string | null = null;
  let first = true;

  while (first || tail || head) {
    if (Date.now() + 3_000 > deadlineMs) return { replies: collected, complete: false };
    const url = new URL(
      `https://www.instagram.com/api/v1/media/${mediaId}/comments/${commentId}/child_comments/`
    );
    const direction = first ? "first" : tail ? "tail" : "head";
    if (direction === "tail") url.searchParams.set("max_id", tail!);
    if (direction === "head") url.searchParams.set("min_id", head!);

    const data = await igApiFetch(url.toString(), shortcode, cookie, csrfToken);
    collected.push(...((data.child_comments ?? []) as PrivateApiComment[]));

    const nextTail = data.has_more_tail_child_comments && data.next_max_child_cursor ? String(data.next_max_child_cursor) : null;
    const nextHead = data.has_more_head_child_comments && data.next_min_child_cursor ? String(data.next_min_child_cursor) : null;
    if (direction === "first") {
      tail = nextTail;
      head = nextHead;
    } else if (direction === "tail") {
      tail = nextTail;
    } else {
      head = nextHead;
    }
    first = false;
  }

  return { replies: collected, complete: true };
}

export interface RepliesOutcome {
  comments: CommentItem[];
  /** Comentarios cuyas respuestas se empezaron a leer pero no se terminaron (tiempo o error pasajero). */
  unfinished: string[];
  /** Comentarios que no se llegaron a empezar por falta de tiempo. */
  skipped: string[];
  error?: string;
}

/** Trae las respuestas completas de varios comentarios, hasta agotar el tiempo disponible. */
export async function fetchRepliesForParents(
  videoUrl: string,
  shortcode: string,
  parentIds: string[],
  deadlineMs: number
): Promise<RepliesOutcome> {
  const session = buildSession();
  if (!session) {
    return { comments: [], unfinished: [], skipped: [], error: "Falta IG_SESSIONID para leer respuestas." };
  }
  const mediaId = shortcodeToMediaId(shortcode);
  const collected: PrivateApiComment[] = [];
  const unfinished: string[] = [];
  const skipped: string[] = [];
  let error: string | undefined;

  for (const [i, parentId] of parentIds.entries()) {
    if (Date.now() + 4_000 > deadlineMs) {
      skipped.push(...parentIds.slice(i));
      break;
    }
    try {
      const { replies, complete } = await fetchAllReplies(
        shortcode,
        mediaId,
        parentId,
        session.cookie,
        session.csrfToken,
        deadlineMs
      );
      collected.push(...replies.map((r) => ({ ...r, parent_comment_id: r.parent_comment_id ?? parentId })));
      if (!complete) unfinished.push(parentId);
    } catch (err) {
      if (err instanceof InstagramAuthRequiredError) {
        return { comments: mapComments(videoUrl, shortcode, collected), unfinished: [], skipped: [], error: err.message };
      }
      error = err instanceof Error ? err.message : "Error al leer respuestas.";
      unfinished.push(parentId);
    }
  }

  return { comments: mapComments(videoUrl, shortcode, collected), unfinished, skipped, error };
}

async function fetchAnonymous(shortcode: string): Promise<PrivateApiComment[] | null> {
  try {
    const res = await fetch(`https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        "X-IG-App-ID": APP_ID,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const edges =
      data?.graphql?.shortcode_media?.edge_media_to_parent_comment?.edges ??
      data?.items?.[0]?.comments ??
      null;
    if (!edges || !Array.isArray(edges) || edges.length === 0) return null;

    return edges.map((edge: any) => {
      const node = edge.node ?? edge;
      return {
        pk: node.id ?? node.pk,
        text: node.text,
        created_at: node.created_at,
        comment_like_count: node.edge_liked_by?.count ?? node.comment_like_count,
        user: { username: node.owner?.username ?? node.user?.username },
      } as PrivateApiComment;
    });
  } catch {
    return null;
  }
}

/**
 * Agrega a cada comentario las respuestas de vista previa que ya vienen en la página, y anota
 * cuáles tienen más respuestas para pedirlas aparte (ver fetchRepliesForParents).
 */
function withPreviewReplies(topLevel: PrivateApiComment[]): {
  comments: PrivateApiComment[];
  pendingReplies: string[];
  expectedReplies: number;
} {
  const comments: PrivateApiComment[] = [];
  const pendingReplies: string[] = [];
  let expectedReplies = 0;
  for (const comment of topLevel) {
    comments.push(comment);
    const preview = (comment.preview_child_comments ?? []).map((r) => ({
      ...r,
      parent_comment_id: r.parent_comment_id ?? comment.pk,
    }));
    comments.push(...preview);
    const childCount = comment.child_comment_count ?? 0;
    expectedReplies += childCount;
    if (childCount > preview.length) pendingReplies.push(String(comment.pk));
  }
  return { comments, pendingReplies, expectedReplies };
}

export interface CommentChunkOutcome {
  comments: CommentItem[];
  mode: "authenticated" | "anonymous" | "none";
  /**
   * Cursor para pedir la siguiente tanda, o null si ya no hay más comentarios. Si hubo un error
   * pasajero, apunta a la página que falló para que se pueda reintentar.
   */
  nextCursor: string | null;
  reportedCount?: number | null;
  /** Comentarios principales de esta tanda con respuestas que hay que pedir aparte. */
  pendingReplies?: string[];
  /** Cantidad de comentarios principales y de respuestas que informa Instagram en esta tanda. */
  topLevelCount?: number;
  expectedReplies?: number;
  error?: string;
}

// Margen para no empezar una página nueva cuando queda poco tiempo antes del corte del servidor.
const PAGE_SAFETY_MS = 8_000;

/**
 * Trae una tanda de comentarios (con sus respuestas) empezando en `cursor`, hasta agotar el tiempo
 * disponible. Si quedan más, devuelve `nextCursor` para continuar en otro pedido: así se pueden
 * leer publicaciones con miles de comentarios sin chocar con el límite de tiempo de Vercel.
 */
export async function fetchCommentsChunk(
  videoUrl: string,
  shortcode: string,
  cursor: string | null,
  deadlineMs: number
): Promise<CommentChunkOutcome> {
  const mediaId = shortcodeToMediaId(shortcode);
  const session = buildSession();

  if (session) {
    const collected: PrivateApiComment[] = [];
    let pageCursor = decodeCursor(cursor);
    let reportedCount: number | null = null;
    const pendingReplies: string[] = [];
    let topLevelCount = 0;
    let expectedReplies = 0;
    const nextCursor = () => (pageCursor ? encodeCursor(pageCursor) : null);
    try {
      while (Date.now() + PAGE_SAFETY_MS < deadlineMs) {
        const page = await fetchCommentsPageAuthenticated(
          shortcode,
          mediaId,
          session.cookie,
          session.csrfToken,
          pageCursor
        );
        reportedCount = page.reportedCount ?? reportedCount;
        const withPreview = withPreviewReplies(page.comments);
        collected.push(...withPreview.comments);
        pendingReplies.push(...withPreview.pendingReplies);
        topLevelCount += page.comments.length;
        expectedReplies += withPreview.expectedReplies;
        pageCursor = page.cursor;
        if (!encodeCursor(pageCursor)) break;
      }

      return {
        mode: "authenticated",
        comments: mapComments(videoUrl, shortcode, collected),
        nextCursor: nextCursor(),
        reportedCount,
        pendingReplies,
        topLevelCount,
        expectedReplies,
      };
    } catch (err) {
      const isAuth = err instanceof InstagramAuthRequiredError;
      return {
        mode: "authenticated",
        comments: mapComments(videoUrl, shortcode, collected),
        // Un error pasajero deja el cursor en la página que falló para reintentarla.
        nextCursor: isAuth ? null : (nextCursor() ?? cursor),
        reportedCount,
        pendingReplies,
        topLevelCount,
        expectedReplies,
        error: err instanceof Error ? err.message : "Error desconocido al paginar comentarios.",
      };
    }
  }

  // Sin sesión solo hay un intento best-effort, sin paginación.
  const anonymous = cursor ? null : await fetchAnonymous(shortcode);
  if (anonymous && anonymous.length > 0) {
    return { mode: "anonymous", comments: mapComments(videoUrl, shortcode, anonymous), nextCursor: null };
  }

  return {
    mode: "none",
    comments: [],
    nextCursor: null,
    error:
      "No se pudo leer comentarios sin sesión autenticada. Configura IG_SESSIONID (y opcionalmente IG_DS_USER_ID / IG_CSRFTOKEN) en las variables de entorno.",
  };
}

function mapComments(videoUrl: string, shortcode: string, raw: PrivateApiComment[]): CommentItem[] {
  return raw
    .filter((c) => c && c.text)
    .map((c) => ({
      videoUrl,
      shortcode,
      commentId: String(c.pk ?? `${shortcode}-${Math.random()}`),
      parentCommentId: c.parent_comment_id != null ? String(c.parent_comment_id) : null,
      username: c.user?.username ?? "desconocido",
      text: c.text,
      timestamp: c.created_at ?? null,
      likeCount: c.comment_like_count ?? null,
    }));
}
