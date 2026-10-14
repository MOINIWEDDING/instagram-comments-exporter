export interface CommentItem {
  videoUrl: string;
  shortcode: string;
  commentId: string;
  parentCommentId: string | null;
  username: string;
  text: string;
  timestamp: number | null;
  likeCount: number | null;
}

export interface ScrapeResult {
  url: string;
  shortcode: string | null;
  ok: boolean;
  error?: string;
  mode: "authenticated" | "anonymous" | "none";
  comments: CommentItem[];
}

export type Sentiment = "positive" | "negative" | "neutral";

/** Filtro temático definido por el usuario, p. ej. "Precio" → "preguntan cuánto cuesta". */
export interface CustomFilter {
  id: string;
  name: string;
  description: string;
}

export interface CommentAnalysis {
  sentiment: Sentiment;
  /** IDs de los CustomFilter que aplican a este comentario. */
  filterIds: string[];
}

export interface AnalyzeRequestComment {
  id: string;
  text: string;
  likeCount?: number | null;
}

/** Análisis escrito por la IA sobre el conjunto de comentarios. */
export interface AiInsights {
  summary: string;
  audienceOpinion: string;
  positives: string[];
  negatives: string[];
  recurringThemes: string[];
  recommendations: string[];
}

export interface AnalyzeResponse {
  /** Análisis por commentId. */
  analysis: Record<string, CommentAnalysis>;
  engine: "gemini" | "local";
  insights?: AiInsights;
  warning?: string;
}
