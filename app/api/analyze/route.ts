import { NextRequest, NextResponse } from "next/server";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { analyzeLocally } from "@/lib/analysis";
import type {
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

// JSON Schema que Gemini usa para devolver la respuesta ya estructurada.
const { $schema: _ignored, ...RESPONSE_JSON_SCHEMA } = z.toJSONSchema(BatchResultSchema) as Record<string, unknown>;

/** Traduce el error de Gemini a un motivo entendible para mostrar en la app. */
function describeGeminiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) {
      return "La GEMINI_API_KEY no es válida: revisá que esté bien copiada.";
    }
    if (err.status === 403) return "La GEMINI_API_KEY no tiene permiso para usar la API de Gemini.";
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

/** Segundos que Gemini pide esperar tras un 429 (viene como "retryDelay": "23s"). */
function retryDelayMs(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const match = err.message.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.ceil(Number(match[1]) * 1000) : 10_000;
}

function hasGeminiCredentials(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function classifyBatch(
  ai: GoogleGenAI,
  batch: AnalyzeRequestComment[],
  filters: CustomFilter[]
): Promise<Record<string, CommentAnalysis>> {
  const codeToId = new Map(filters.map((f, idx) => [`f${idx + 1}`, f.id]));
  const filtersText =
    filters.length > 0
      ? filters.map((f, idx) => `f${idx + 1}: ${f.name} — ${f.description}`).join("\n")
      : "(sin filtros temáticos: devolvé filters vacío)";
  const commentsText = batch.map((c, i) => JSON.stringify({ i, text: c.text })).join("\n");

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: `Filtros temáticos:\n${filtersText}\n\nComentarios (uno por línea, JSON):\n${commentsText}`,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_JSON_SCHEMA,
      temperature: 0,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini devolvió una respuesta vacía.");
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
          typeof c?.id === "string" && typeof c?.text === "string"
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
        Object.assign(analysis, await classifyBatch(ai, batch, filters));
      } catch (err) {
        // Con el plan gratuito, un 429 suele resolverse esperando lo que pide Gemini: un reintento.
        const wait = retryDelayMs(err);
        let retried = false;
        if (wait !== null && Date.now() + wait + 5_000 < deadline) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          try {
            Object.assign(analysis, await classifyBatch(ai, batch, filters));
            retried = true;
          } catch (retryErr) {
            err = retryErr;
          }
        }
        if (!retried) {
          failedBatches++;
          firstError ??= describeGeminiError(err);
          console.error("Fallo al clasificar lote con Gemini:", err);
        }
      }
      // Lo que el modelo no devolvió (lote fallido o índices faltantes) se completa localmente.
      const missing = batch.filter((c) => !analysis[c.id]);
      if (missing.length > 0) Object.assign(analysis, analyzeLocally(missing, filters));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  const result: AnalyzeResponse = {
    analysis,
    engine: "gemini",
    warning:
      failedBatches > 0
        ? `${failedBatches} de ${batches.length} lotes no pudieron analizarse con IA y se clasificaron con el análisis local. Motivo: ${firstError}`
        : undefined,
  };
  return NextResponse.json(result);
}
