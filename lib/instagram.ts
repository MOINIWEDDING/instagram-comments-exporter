import type { CommentItem } from "./types";

const APP_ID = "936619743392459";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PRIVATE_API_USER_AGENT =
  "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2137; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)";

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

function buildSessionCookie(): string | null {
  const sessionId = process.env.IG_SESSIONID;
  if (!sessionId) return null;
  const dsUserId = process.env.IG_DS_USER_ID;
  const csrfToken = process.env.IG_CSRFTOKEN;
  const parts = [`sessionid=${sessionId}`];
  if (dsUserId) parts.push(`ds_user_id=${dsUserId}`);
  parts.push(`csrftoken=${csrfToken ?? "missing"}`);
  return parts.join("; ");
}

interface PrivateApiComment {
  pk: string | number;
  text: string;
  created_at?: number;
  comment_like_count?: number;
  user?: { username?: string };
}

async function fetchCommentsPageAuthenticated(
  mediaId: string,
  cookie: string,
  minId: string | undefined
): Promise<{ comments: PrivateApiComment[]; nextMinId: string | null; hasMore: boolean }> {
  const url = new URL(`https://i.instagram.com/api/v1/media/${mediaId}/comments/`);
  url.searchParams.set("can_support_threading", "true");
  url.searchParams.set("permalink_enabled", "false");
  if (minId) url.searchParams.set("min_id", minId);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": PRIVATE_API_USER_AGENT,
      "X-IG-App-ID": APP_ID,
      Accept: "*/*",
      Cookie: cookie,
    },
    cache: "no-store",
  });

  if (res.status === 401 || res.status === 403) {
    throw new InstagramAuthRequiredError(
      "Instagram rechazó la sesión configurada (IG_SESSIONID vencida o inválida)."
    );
  }
  if (!res.ok) {
    throw new Error(`Instagram respondió ${res.status} al pedir comentarios.`);
  }

  const data = await res.json();
  if (data?.status && data.status !== "ok") {
    if (data?.message?.toLowerCase?.().includes("login")) {
      throw new InstagramAuthRequiredError("Instagram exige login para este contenido.");
    }
    throw new Error(data?.message ?? "Respuesta inesperada de Instagram.");
  }

  const comments: PrivateApiComment[] = data.comments ?? [];
  const nextMinId: string | null = data.next_min_id ?? null;
  const hasMore: boolean = Boolean(data.has_more_headload_comments ?? data.has_more_comments ?? nextMinId);

  return { comments, nextMinId, hasMore };
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

export interface CommentFetchOutcome {
  comments: CommentItem[];
  mode: "authenticated" | "anonymous" | "none";
  error?: string;
}

export async function fetchCommentsForShortcode(
  videoUrl: string,
  shortcode: string,
  maxComments: number,
  deadlineMs: number
): Promise<CommentFetchOutcome> {
  const mediaId = shortcodeToMediaId(shortcode);
  const cookie = buildSessionCookie();

  if (cookie) {
    const collected: PrivateApiComment[] = [];
    let minId: string | undefined = undefined;
    try {
      while (collected.length < maxComments && Date.now() < deadlineMs) {
        const page = await fetchCommentsPageAuthenticated(mediaId, cookie, minId);
        collected.push(...page.comments);
        if (!page.hasMore || !page.nextMinId) break;
        minId = page.nextMinId;
      }
      return {
        mode: "authenticated",
        comments: mapComments(videoUrl, shortcode, collected.slice(0, maxComments)),
      };
    } catch (err) {
      if (err instanceof InstagramAuthRequiredError) {
        return { mode: "authenticated", comments: [], error: err.message };
      }
      return {
        mode: "authenticated",
        comments: mapComments(videoUrl, shortcode, collected.slice(0, maxComments)),
        error: err instanceof Error ? err.message : "Error desconocido al paginar comentarios.",
      };
    }
  }

  const anonymous = await fetchAnonymous(shortcode);
  if (anonymous && anonymous.length > 0) {
    return { mode: "anonymous", comments: mapComments(videoUrl, shortcode, anonymous) };
  }

  return {
    mode: "none",
    comments: [],
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
      username: c.user?.username ?? "desconocido",
      text: c.text,
      timestamp: c.created_at ?? null,
      likeCount: c.comment_like_count ?? null,
    }));
}
