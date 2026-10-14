import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
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

const MODEL = "claude-opus-5-5";
const MAX_COMMENTS = 5000;
const MAX_FILTERS = 10;
const BATCH_SIZE = 120;
const CONCURRENCY = 6;

const BatchResultSchema = z.object({
  results: z.array(
    z.object({
      i: z.number().int(),
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

function hasClaudeCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function classifyBatch(
  client: Anthropic,
  batch: AnalyzeRequestComment[],
  filters: CustomFilter[]
): Promise<Record<string, CommentAnalysis>> {
  const codeToId = new Map(filters.map((f, idx) => [`f${idx + 1}`, f.id]));
  const filtersText =
    filters.length > 0
      ? filters.map((f, idx) => `f${idx + 1}: ${f.name} — ${f.description}`).join("\n")
      : "(sin filtros temáticos: devolvé filters vacío)";
  const commentsText = batch.map((c, i) => JSON.stringify({ i, text: c.text })).join("\n");

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(BatchResultSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Filtros temáticos:\n${filtersText}\n\nComentarios (uno por línea, JSON):\n${commentsText}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("El modelo rechazó clasificar este lote.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Respuesta del modelo sin formato válido.");

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

  if (!hasClaudeCredentials()) {
    const result: AnalyzeResponse = {
      analysis: analyzeLocally(comments, filters),
      engine: "local",
      warning:
        "No hay ANTHROPIC_API_KEY configurada: se usó un análisis local por palabras clave, mucho menos preciso. Configurala para clasificar con IA.",
    };
    return NextResponse.json(result);
  }

  const client = new Anthropic();
  const batches: AnalyzeRequestComment[][] = [];
  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    batches.push(comments.slice(i, i + BATCH_SIZE));
  }

  const analysis: Record<string, CommentAnalysis> = {};
  let failedBatches = 0;
  let next = 0;

  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        Object.assign(analysis, await classifyBatch(client, batch, filters));
      } catch (err) {
        failedBatches++;
        console.error("Fallo al clasificar lote con Claude:", err);
      }
      // Lo que el modelo no devolvió (lote fallido o índices faltantes) se completa localmente.
      const missing = batch.filter((c) => !analysis[c.id]);
      if (missing.length > 0) Object.assign(analysis, analyzeLocally(missing, filters));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  const result: AnalyzeResponse = {
    analysis,
    engine: "claude",
    warning:
      failedBatches > 0
        ? `${failedBatches} de ${batches.length} lotes no pudieron analizarse con IA y se clasificaron con el análisis local.`
        : undefined,
  };
  return NextResponse.json(result);
}
