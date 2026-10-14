import { NextRequest, NextResponse } from "next/server";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { analyzeLocally } from "@/lib/analysis";
import type {
  AiInsights,
  AnalyzeRequestComment,
  AnalyzeResponse,
  CommentAnalysis,
  CustomFilter,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Modelo de Gemini con plan gratuito; el alias apunta siempre al Flash-Lite más reciente.
// Se puede cambiar con GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
// Si el modelo principal está saturado o sin cupo, se prueba con este (también tiene plan gratuito).
const MODELS = [MODEL, "gemini-flash-latest"].filter((m, i, all) => all.indexOf(m) === i);
const MAX_COMMENTS = 5000;
const MAX_FILTERS = 10;
// Lotes grandes y poca concurrencia para respetar los límites por minuto del plan gratuito.
const BATCH_SIZE = 200;
const CONCURRENCY = 2;
const TIME_BUDGET_MS = 50_000;

const BatchResultSchema = z.object({
  results: z.array(
    z.object({
      i: z.number(),
      sentiment: z.enum(["positive", "negative", "neutral"]),
      filters: z.array(z.string()),
    })
  ),
});

const SYSTEM_PROMPT = `Clasificás comentarios de Instagram (en cualquier idioma, con jerga, emojis e ironía).

Para cada comentario devolvé:
- sentiment: "positive" si expresa aprobación, cariño, entusiasmo o felicitación; "negative" si expresa crítica, queja, enojo, burla o decepción; "neutral" si es una pregunta, una mención a otra persona, información o no tiene carga emocional clara. Tené en cuenta el sarcasmo.
- filters: los códigos de los filtros temáticos (f1, f2, …) cuya descripción aplica al comentario. Un comentario puede coincidir con varios filtros o con ninguno; solo incluilo cuando el comentario realmente trata ese tema.

Devolvé exactamente un resultado por cada comentario recibido, usando su índice "i".`;

const InsightsSchema = z.object({
  summary: z.string(),
  audienceOpinion: z.string(),
  positives: z.array(z.string()),
  negatives: z.array(z.string()),
  recurringThemes: z.array(z.string()),
  recommendations: z.array(z.string()),
});

const INSIGHTS_PROMPT = `Sos analista de redes sociales. Recibís comentarios de videos de Instagram, cada uno con su sentimiento ya clasificado y sus likes. Escribí en español, claro y concreto, sin inventar datos que no estén en los comentarios.

Devolvé:
- summary: resumen general de la conversación en 3 o 4 oraciones.
- audienceOpinion: qué opina la audiencia en general, en 2 oraciones.
- positives: de 2 a 4 aspectos que la audiencia valora (frases cortas, máximo 25 palabras cada una).
- negatives: de 0 a 4 críticas o quejas que se repiten (frases cortas). Vacío si no hay críticas.
- recurringThemes: de 3 a 6 temas recurrentes, de 1 a 4 palabras cada uno.
- recommendations: de 3 a 4 recomendaciones accionables para quien publica los videos, basadas en los comentarios.`;

const MAX_INSIGHT_COMMENTS = 400;

// JSON Schema que Gemini usa para devolver la respuesta ya estructurada.
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
const RESPONSE_JSON_SCHEMA = jsonSchema(BatchResultSchema);
const INSIGHTS_JSON_SCHEMA = jsonSchema(InsightsSchema);

/** Traduce el error de Gemini a un motivo entendible para mostrar en la app. */
function describeGeminiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) {
      return "La GEMINI_API_KEY no es válida: revisá que esté bien copiada.";
    }
    if (err.status === 403) return "La GEMINI_API_KEY no tiene permiso para usar la API de Gemini.";
    if (err.status === 503 || err.status === 500) {
      return "Gemini está saturado en este momento (error 503) y no respondió tras varios reintentos: probá de nuevo en unos minutos.";
    }
    if (err.status === 429) {
      return "Se alcanzó el límite gratuito de Gemini (pedidos por minuto o por día): esperá un rato y volvé a analizar.";
    }
    if (err.status === 404) {
      return `El modelo "${MODEL}" no está disponible: probá con GEMINI_MODEL=gemini-flash-latest.`;
    }
    return `Gemini respondió con error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Error desconocido.";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cuánto esperar antes de reintentar con el mismo modelo, o null si no conviene reintentar.
 * 503/500 (servidores saturados): hasta 2 reintentos con espera creciente.
 * 429 (límite gratuito): un reintento esperando lo que pide Gemini ("retryDelay": "23s").
 */
function waitBeforeRetry(err: unknown, attempt: number): number | null {
  if (!(err instanceof ApiError)) return attempt < 2 ? 1_500 : null;
  if (err.status === 503 || err.status === 500) return attempt < 2 ? 2_000 * (attempt + 1) : null;
  if (err.status === 429 && attempt === 0) {
    const match = err.message.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/);
    return match ? Math.ceil(Number(match[1]) * 1000) : 10_000;
  }
  return null;
}

/** Errores de configuración (key inválida, sin permiso) que no se arreglan cambiando de modelo. */
function isConfigError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403 || (err.status === 400 && /api key/i.test(err.message)));
}

// Modelos que quedaron saturados hace poco: se saltean durante un minuto para no esperarlos de nuevo.
const busyUntil = new Map<string, number>();
const BUSY_COOLDOWN_MS = 60_000;

type GenerateParams = Omit<Parameters<GoogleGenAI["models"]["generateContent"]>[0], "model">;

/** Llama a Gemini con reintentos y, si el modelo sigue fallando, prueba con el de respaldo. */
async function generate(ai: GoogleGenAI, params: GenerateParams, deadline: number): Promise<string> {
  let lastError: unknown;
  const available = MODELS.filter((m) => (busyUntil.get(m) ?? 0) < Date.now());
  for (const model of available.length > 0 ? available : MODELS) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await ai.models.generateContent({ ...params, model });
        if (!response.text) throw new Error("Gemini devolvió una respuesta vacía.");
        return response.text;
      } catch (err) {
        lastError = err;
        if (isConfigError(err)) throw err;
        const wait = waitBeforeRetry(err, attempt);
        if (wait === null || Date.now() + wait + 5_000 > deadline) {
          if (err instanceof ApiError && (err.status === 503 || err.status === 429)) {
            busyUntil.set(model, Date.now() + BUSY_COOLDOWN_MS);
          }
          break;
        }
        await sleep(wait);
      }
    }
    if (Date.now() + 5_000 > deadline) break;
  }
  throw lastError;
}

function hasGeminiCredentials(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function classifyBatch(
  ai: GoogleGenAI,
  batch: AnalyzeRequestComment[],
  filters: CustomFilter[],
  deadline: number
): Promise<Record<string, CommentAnalysis>> {
  const codeToId = new Map(filters.map((f, idx) => [`f${idx + 1}`, f.id]));
  const filtersText =
    filters.length > 0
      ? filters.map((f, idx) => `f${idx + 1}: ${f.name} — ${f.description}`).join("\n")
      : "(sin filtros temáticos: devolvé filters vacío)";
  const commentsText = batch.map((c, i) => JSON.stringify({ i, text: c.text })).join("\n");

  const text = await generate(ai, {
    contents: `Filtros temáticos:\n${filtersText}\n\nComentarios (uno por línea, JSON):\n${commentsText}`,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_JSON_SCHEMA,
      temperature: 0,
    },
  }, deadline);

  const parsed = BatchResultSchema.parse(JSON.parse(text));

  const out: Record<string, CommentAnalysis> = {};
  for (const r of parsed.results) {
    const comment = batch[r.i];
    if (!comment) continue;
    out[comment.id] = {
      sentiment: r.sentiment,
      filterIds: r.filters
        .map((code) => codeToId.get(code))
        .filter((id): id is string => Boolean(id)),
    };
  }
  return out;
}

const SENTIMENT_WORD = { positive: "positivo", negative: "negativo", neutral: "neutral" } as const;

/** Pide a Gemini un análisis escrito de la conversación, priorizando los comentarios con más likes. */
async function generateInsights(
  ai: GoogleGenAI,
  comments: AnalyzeRequestComment[],
  analysis: Record<string, CommentAnalysis>,
  filters: CustomFilter[],
  deadline: number
): Promise<AiInsights> {
  const sample = [...comments]
    .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    .slice(0, MAX_INSIGHT_COMMENTS);
  const counts = { positive: 0, negative: 0, neutral: 0 };
  for (const c of comments) {
    const a = analysis[c.id];
    if (a) counts[a.sentiment]++;
  }
  const lines = sample.map((c) => {
    const sentiment = analysis[c.id]?.sentiment ?? "neutral";
    return `[${SENTIMENT_WORD[sentiment]}] (${c.likeCount ?? 0} likes) ${c.text.slice(0, 300)}`;
  });
  const themes = filters.length > 0 ? `\nTemas definidos por el usuario: ${filters.map((f) => f.name).join(", ")}.` : "";

  const text = await generate(ai, {
    contents: `Total: ${comments.length} comentarios (${counts.positive} positivos, ${counts.negative} negativos, ${counts.neutral} neutrales).${themes}\n\nComentarios (los ${sample.length} con más likes):\n${lines.join("\n")}`,
    config: {
      systemInstruction: INSIGHTS_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: INSIGHTS_JSON_SCHEMA,
      temperature: 0.3,
    },
  }, deadline);
  return InsightsSchema.parse(JSON.parse(text));
}

export async function POST(req: NextRequest) {
  let body: { comments?: unknown; filters?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido, se esperaba JSON." }, { status: 400 });
  }

  const comments = Array.isArray(body.comments)
    ? body.comments.filter(
        (c): c is AnalyzeRequestComment =>
          typeof c?.id === "string" &&
          typeof c?.text === "string" &&
          (c.likeCount === undefined || c.likeCount === null || typeof c.likeCount === "number")
      )
    : [];
  const filters = Array.isArray(body.filters)
    ? body.filters.filter(
        (f): f is CustomFilter =>
          typeof f?.id === "string" &&
          typeof f?.name === "string" &&
          typeof f?.description === "string"
      )
    : [];

  if (comments.length === 0) {
    return NextResponse.json({ error: "No hay comentarios para analizar." }, { status: 400 });
  }
  if (comments.length > MAX_COMMENTS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_COMMENTS} comentarios por análisis.` },
      { status: 400 }
    );
  }
  if (filters.length > MAX_FILTERS) {
    return NextResponse.json({ error: `Máximo ${MAX_FILTERS} filtros.` }, { status: 400 });
  }

  if (!hasGeminiCredentials()) {
    const result: AnalyzeResponse = {
      analysis: analyzeLocally(comments, filters),
      engine: "local",
      warning:
        "No hay GEMINI_API_KEY configurada: se usó un análisis local por palabras clave, mucho menos preciso. Configurala para clasificar con Gemini.",
    };
    return NextResponse.json(result);
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // Opcional: pasar por un proxy propio.
    httpOptions: process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : undefined,
  });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const batches: AnalyzeRequestComment[][] = [];
  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    batches.push(comments.slice(i, i + BATCH_SIZE));
  }

  const analysis: Record<string, CommentAnalysis> = {};
  let failedBatches = 0;
  let firstError: string | null = null;
  let next = 0;

  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        Object.assign(analysis, await classifyBatch(ai, batch, filters, deadline));
      } catch (err) {
        failedBatches++;
        firstError ??= describeGeminiError(err);
        console.error("Fallo al clasificar lote con Gemini:", err);
      }
      // Lo que el modelo no devolvió (lote fallido o índices faltantes) se completa localmente.
      const missing = batch.filter((c) => !analysis[c.id]);
      if (missing.length > 0) Object.assign(analysis, analyzeLocally(missing, filters));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  const warnings: string[] = [];
  if (failedBatches > 0) {
    warnings.push(
      `${failedBatches} de ${batches.length} lotes no pudieron analizarse con IA y se clasificaron con el análisis local. Motivo: ${firstError}`
    );
  }

  // Análisis escrito para el reporte (si no hubo un fallo total y queda tiempo).
  let insights: AiInsights | undefined;
  if (failedBatches < batches.length && Date.now() + 8_000 < deadline) {
    try {
      insights = await generateInsights(ai, comments, analysis, filters, deadline);
    } catch (err) {
      console.error("Fallo al generar el análisis escrito con Gemini:", err);
      warnings.push(`No se pudo generar el análisis escrito de la IA. Motivo: ${describeGeminiError(err)}`);
    }
  }

  const result: AnalyzeResponse = {
    analysis,
    engine: "gemini",
    insights,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
  return NextResponse.json(result);
}
