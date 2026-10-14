import type {
  AnalyzeRequestComment,
  CommentAnalysis,
  CommentItem,
  CustomFilter,
  Sentiment,
} from "./types";

// Análisis local (sin IA): léxico simple en español/inglés + emojis para el sentimiento y
// coincidencia de palabras clave para los filtros personalizados. Es el respaldo cuando no hay
// OPENAI_API_KEY configurada; es mucho menos preciso que el análisis con ChatGPT.

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const POSITIVE_WORDS = [
  "amo", "amor", "ame", "encanta", "encanto", "hermoso", "hermosa", "hermosos", "hermosas",
  "precioso", "preciosa", "bello", "bella", "lindo", "linda", "lindos", "lindas", "bonito",
  "bonita", "genial", "excelente", "increible", "espectacular", "maravilloso", "maravillosa",
  "perfecto", "perfecta", "felicidades", "felicitaciones", "gracias", "divino", "divina",
  "bravo", "top", "mejor", "buenisimo", "buenisima", "bueno", "buena", "fantastico",
  "fantastica", "brutal", "crack", "idolo", "idola", "emocion", "emociona", "emocionante",
  "feliz", "felices", "wow", "guau", "precioso", "recomiendo", "recomendado", "love", "beautiful",
  "amazing", "great", "awesome", "perfect", "congrats", "congratulations", "best", "nice",
  "gorgeous", "stunning", "cute", "lovely", "wonderful", "excellent", "thanks",
];

const NEGATIVE_WORDS = [
  "odio", "feo", "fea", "feos", "feas", "horrible", "horrendo", "horrenda", "malo", "mala",
  "malisimo", "malisima", "pesimo", "pesima", "asco", "asqueroso", "basura", "terrible",
  "decepcion", "decepcionado", "decepcionada", "aburrido", "aburrida", "triste", "estafa",
  "estafadores", "fraude", "mentira", "mentiroso", "ridiculo", "ridicula", "verguenza",
  "peor", "caro", "carisimo", "lamentable", "desastre", "queja", "reclamo",
  "robo", "ladrones", "cutre", "hate", "ugly", "awful", "worst", "bad", "scam", "boring",
  "disappointed", "disappointing", "trash", "fake", "sad",
];

const POSITIVE_EMOJI = new Set(Array.from("😍🥰😘❤💕💖💗💓💞💘♥😊☺🙌👏🔥✨💯🥹😻💜💙💚🧡🤍🤩😀😃😄😁🎉👌👍"));
const NEGATIVE_EMOJI = new Set(Array.from("😡🤬😠👎😒🙄🤮🤢💩😤😞😔😢😭"));
const NEGATORS = new Set(["no", "nada", "ni", "sin", "nunca", "not", "never"]);

const POSITIVE_SET = new Set(POSITIVE_WORDS);
const NEGATIVE_SET = new Set(NEGATIVE_WORDS);

export function localSentiment(text: string): Sentiment {
  const tokens = normalize(text).split(/[^a-z0-9ñ]+/).filter(Boolean);
  let score = 0;
  tokens.forEach((token, i) => {
    const negated = i > 0 && NEGATORS.has(tokens[i - 1]);
    if (POSITIVE_SET.has(token)) score += negated ? -1 : 1;
    else if (NEGATIVE_SET.has(token)) score += negated ? 1 : -1;
  });
  for (const char of Array.from(text)) {
    if (POSITIVE_EMOJI.has(char)) score += 1;
    else if (NEGATIVE_EMOJI.has(char)) score -= 1;
  }
  if (score > 0) return "positive";
  if (score < 0) return "negative";
  return "neutral";
}

const STOPWORDS = new Set([
  "que", "los", "las", "del", "con", "para", "por", "una", "uno", "unos", "unas", "sobre", "como",
  "cual", "cuales", "comentarios", "comentario", "tratan", "trata", "hablan", "habla", "personas",
  "gente", "usuarios", "este", "esta", "estos", "estas", "tema", "temas", "acerca", "the", "and",
  "about", "with", "that", "comments", "people", "sus", "son", "mas", "muy", "pero", "donde",
]);

export function filterKeywords(filter: CustomFilter): string[] {
  const words = normalize(`${filter.name} ${filter.description}`)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

/** Coincide si el comentario contiene alguna palabra clave (o su raíz de 5+ letras). */
function matchesKeywords(normalizedText: string, keywords: string[]): boolean {
  return keywords.some((kw) => {
    const stem = kw.length > 6 ? kw.slice(0, Math.max(5, kw.length - 2)) : kw;
    return normalizedText.includes(stem);
  });
}

export function analyzeLocally(
  comments: AnalyzeRequestComment[],
  filters: CustomFilter[]
): Record<string, CommentAnalysis> {
  const keywordsByFilter = filters.map((f) => ({ id: f.id, keywords: filterKeywords(f) }));
  const out: Record<string, CommentAnalysis> = {};
  for (const c of comments) {
    const normalizedText = normalize(c.text);
    out[c.id] = {
      sentiment: localSentiment(c.text),
      filterIds: keywordsByFilter
        .filter((f) => f.keywords.length > 0 && matchesKeywords(normalizedText, f.keywords))
        .map((f) => f.id),
    };
  }
  return out;
}

export interface SentimentStats {
  total: number;
  positive: number;
  negative: number;
  neutral: number;
}

export function sentimentStats(
  comments: CommentItem[],
  analysis: Record<string, CommentAnalysis>
): SentimentStats {
  const stats: SentimentStats = { total: 0, positive: 0, negative: 0, neutral: 0 };
  for (const c of comments) {
    const a = analysis[c.commentId];
    if (!a) continue;
    stats.total++;
    stats[a.sentiment]++;
  }
  return stats;
}

export function percent(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
  positive: "Positivo",
  negative: "Negativo",
  neutral: "Neutral",
};
