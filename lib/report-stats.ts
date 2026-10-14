import { percent, sentimentStats, type SentimentStats } from "./analysis";
import type { CommentAnalysis, CommentItem, CustomFilter, ScrapeResult } from "./types";

// Métricas del reporte, inspiradas en un reporte de redes sociales (alcance, interacciones,
// contenido destacado, días clave…) pero calculadas solo con lo que tenemos de cada comentario.

export interface VideoStats {
  index: number;
  url: string;
  shortcode: string;
  comments: number;
  replies: number;
  likes: number;
  uniqueUsers: number;
  sentiment: SentimentStats | null;
}

export interface TopicStats {
  filter: CustomFilter;
  count: number;
  sentiment: SentimentStats;
  topComment: CommentItem | null;
}

export interface DayStats {
  key: string;
  date: Date;
  count: number;
}

export interface ReportStats {
  videos: VideoStats[];
  totalComments: number;
  topLevel: number;
  replies: number;
  totalLikes: number;
  avgLikes: number;
  uniqueUsers: number;
  repeatUsers: number;
  replyRate: number;
  sentiment: SentimentStats | null;
  /** % positivos - % negativos, de -100 a 100. */
  netSentiment: number | null;
  topics: TopicStats[];
  topComments: { comment: CommentItem; replies: number; videoIndex: number }[];
  topUsers: { username: string; count: number; likes: number }[];
  days: DayStats[];
  peakDays: DayStats[];
  unansweredQuestions: number;
  strengths: string[];
  attention: string[];
  takeaways: string[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("es-ES");
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

export function computeReportStats(
  results: ScrapeResult[],
  analysis: Record<string, CommentAnalysis> | null,
  filters: CustomFilter[]
): ReportStats {
  const withVideo = results.flatMap((r, videoIndex) => r.comments.map((c) => ({ c, videoIndex })));
  const all = withVideo.map((x) => x.c);

  const repliesByParent = new Map<string, number>();
  for (const c of all) {
    if (c.parentCommentId) {
      repliesByParent.set(c.parentCommentId, (repliesByParent.get(c.parentCommentId) ?? 0) + 1);
    }
  }

  const userCounts = new Map<string, { count: number; likes: number }>();
  for (const c of all) {
    const u = userCounts.get(c.username) ?? { count: 0, likes: 0 };
    u.count++;
    u.likes += c.likeCount ?? 0;
    userCounts.set(c.username, u);
  }

  const videos: VideoStats[] = results
    .map((r, index) => ({
      index,
      url: r.url,
      shortcode: r.shortcode ?? `video-${index + 1}`,
      comments: r.comments.length,
      replies: r.comments.filter((c) => c.parentCommentId).length,
      likes: r.comments.reduce((s, c) => s + (c.likeCount ?? 0), 0),
      uniqueUsers: new Set(r.comments.map((c) => c.username)).size,
      sentiment: analysis ? sentimentStats(r.comments, analysis) : null,
    }))
    .filter((v) => v.comments > 0);

  const totalComments = all.length;
  const replies = all.filter((c) => c.parentCommentId).length;
  const totalLikes = all.reduce((s, c) => s + (c.likeCount ?? 0), 0);
  const sentiment = analysis ? sentimentStats(all, analysis) : null;
  const netSentiment =
    sentiment && sentiment.total > 0
      ? Math.round(((sentiment.positive - sentiment.negative) / sentiment.total) * 100)
      : null;

  const topics: TopicStats[] = analysis
    ? filters
        .map((filter) => {
          const matching = all.filter((c) => analysis[c.commentId]?.filterIds.includes(filter.id));
          const topComment =
            [...matching].sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))[0] ?? null;
          return { filter, count: matching.length, sentiment: sentimentStats(matching, analysis), topComment };
        })
        .sort((a, b) => b.count - a.count)
    : [];

  const topComments = [...withVideo]
    .sort((a, b) => (b.c.likeCount ?? 0) - (a.c.likeCount ?? 0))
    .slice(0, 3)
    .map(({ c, videoIndex }) => ({ comment: c, replies: repliesByParent.get(c.commentId) ?? 0, videoIndex }));

  const topUsers = [...userCounts.entries()]
    .map(([username, v]) => ({ username, ...v }))
    .sort((a, b) => b.count - a.count || b.likes - a.likes)
    .slice(0, 5);

  const dayMap = new Map<string, DayStats>();
  for (const c of all) {
    if (!c.timestamp) continue;
    const d = new Date(c.timestamp * 1000);
    const key = dayKey(d);
    const entry = dayMap.get(key) ?? { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), count: 0 };
    entry.count++;
    dayMap.set(key, entry);
  }
  const days = [...dayMap.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  const peakDays = [...days].sort((a, b) => b.count - a.count).slice(0, 4).sort((a, b) => a.date.getTime() - b.date.getTime());

  const unansweredQuestions = all.filter(
    (c) => !c.parentCommentId && c.text.includes("?") && !repliesByParent.has(c.commentId)
  ).length;

  const repeatUsers = [...userCounts.values()].filter((u) => u.count > 1).length;
  const replyRate = ratio(replies, totalComments);

  // Textos automáticos
  const takeaways: string[] = [];
  const strengths: string[] = [];
  const attention: string[] = [];

  const busiestVideo = [...videos].sort((a, b) => b.comments - a.comments)[0];
  if (busiestVideo && videos.length > 1) {
    takeaways.push(
      `El video #${busiestVideo.index + 1} concentra ${percent(busiestVideo.comments, totalComments)} de la conversación (${busiestVideo.comments} comentarios).`
    );
  }
  takeaways.push(
    `${formatNumber(userCounts.size)} personas distintas comentaron; ${repeatUsers} de ellas lo hicieron más de una vez.`
  );
  if (sentiment && sentiment.total > 0) {
    takeaways.push(
      `${percent(sentiment.positive, sentiment.total)} de los comentarios son positivos y ${percent(sentiment.negative, sentiment.total)} negativos (sentimiento neto ${netSentiment! >= 0 ? "+" : ""}${netSentiment}).`
    );
  }
  takeaways.push(
    `${percent(replies, totalComments)} de los comentarios son respuestas: ${replyRate >= 0.15 ? "la audiencia conversa entre sí" : "la mayoría comenta sin generar hilo"}.`
  );
  const topTopic = topics.find((t) => t.count > 0);
  if (topTopic) {
    takeaways.push(`El tema más mencionado es "${topTopic.filter.name}", con ${topTopic.count} comentarios.`);
  }

  if (sentiment && sentiment.total > 0 && sentiment.positive >= sentiment.negative) {
    strengths.push(
      `La recepción es mayormente favorable: ${percent(sentiment.positive, sentiment.total)} positivos frente a ${percent(sentiment.negative, sentiment.total)} negativos.`
    );
  }
  if (topComments[0] && (topComments[0].comment.likeCount ?? 0) > 0) {
    strengths.push(
      `El comentario más valorado (@${topComments[0].comment.username}) suma ${formatNumber(topComments[0].comment.likeCount ?? 0)} likes: es un buen punto de partida para entender qué conecta.`
    );
  }
  const bestTopic = [...topics]
    .filter((t) => t.count > 0)
    .sort((a, b) => ratio(b.sentiment.positive, b.count) - ratio(a.sentiment.positive, a.count))[0];
  if (bestTopic && bestTopic.sentiment.positive > 0) {
    strengths.push(
      `"${bestTopic.filter.name}" es el tema mejor recibido: ${percent(bestTopic.sentiment.positive, bestTopic.count)} de sus comentarios son positivos.`
    );
  }
  if (replyRate >= 0.15) {
    strengths.push(`Hay conversación activa: ${percent(replies, totalComments)} de los comentarios son respuestas.`);
  }
  if (repeatUsers > 0) {
    strengths.push(`${repeatUsers} personas volvieron a comentar: es una comunidad que se involucra.`);
  }

  if (unansweredQuestions > 0) {
    attention.push(
      `${unansweredQuestions} ${unansweredQuestions === 1 ? "pregunta quedó" : "preguntas quedaron"} sin respuesta en los comentarios: responderlas mejora la conversación.`
    );
  }
  if (sentiment && sentiment.negative > 0) {
    attention.push(
      `${sentiment.negative} comentarios negativos (${percent(sentiment.negative, sentiment.total)}): revisalos para detectar quejas repetidas.`
    );
  }
  const worstTopic = [...topics]
    .filter((t) => t.sentiment.negative > 0)
    .sort((a, b) => b.sentiment.negative - a.sentiment.negative)[0];
  if (worstTopic) {
    attention.push(
      `"${worstTopic.filter.name}" acumula más críticas (${worstTopic.sentiment.negative} negativos): conviene darle una respuesta específica.`
    );
  }
  if (replyRate < 0.15) {
    attention.push(`Pocos comentarios generan hilo (${percent(replies, totalComments)} son respuestas): invitar a la conversación puede ayudar.`);
  }

  return {
    videos,
    totalComments,
    topLevel: totalComments - replies,
    replies,
    totalLikes,
    avgLikes: ratio(totalLikes, totalComments),
    uniqueUsers: userCounts.size,
    repeatUsers,
    replyRate,
    sentiment,
    netSentiment,
    topics,
    topComments,
    topUsers,
    days,
    peakDays,
    unansweredQuestions,
    strengths: strengths.slice(0, 3),
    attention: attention.slice(0, 3),
    takeaways: takeaways.slice(0, 4),
  };
}
