/**
 * Content Creator Agent — lee Notion (knowledge base + ideas), genera VideoProps JSON
 * validado con Zod, llama TTS y renderiza con editor-pro-max.
 *
 * Uso: npx tsx scripts/content-creator.ts --niche masculinity [--pillar arquetipos] [--dry-run]
 *      npx tsx scripts/content-creator.ts --retry --post-id <uuid> [--dry-run]
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { VideoPropsSchema, type VideoProps } from "./types.js";
import { loadNicheConfig, log, writeJson, readJson, getContentPipelineDir } from "./utils.js";
import type { ValidationReport } from "./validate-vision.js";

const isDryRun = process.argv.includes("--dry-run");
const isRetry = process.argv.includes("--retry");
const _nicheIdx2 = process.argv.indexOf("--niche");
const nicheArg = process.argv.find((a) => a.startsWith("--niche="))?.split("=")[1]
  ?? (_nicheIdx2 !== -1 ? process.argv[_nicheIdx2 + 1] : undefined)
  ?? "masculinity";
const pillarArg = process.argv.find((a) => a.startsWith("--pillar="))?.split("=")[1]
  ?? (process.argv.includes("--pillar") ? process.argv[process.argv.indexOf("--pillar") + 1] : null);
const _postIdIdx = process.argv.indexOf("--post-id");
const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? (_postIdIdx !== -1 ? process.argv[_postIdIdx + 1] : undefined);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Leer Knowledge Base desde Notion ────────────────────────────────────────

async function fetchNotionKnowledgeBase(dbId: string): Promise<string> {
  if (!dbId || !process.env.NOTION_TOKEN) return "";

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 20 }),
    });

    if (!res.ok) return "";
    const data = (await res.json()) as {
      results: Array<{ properties: Record<string, { title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }>; select?: { name: string } }> }>;
    };

    return data.results.map((page) => {
      const title = page.properties["Topic"]?.title?.[0]?.plain_text ?? "";
      const content = page.properties["Content"]?.rich_text?.[0]?.plain_text ?? "";
      const category = page.properties["Category"]?.select?.name ?? "";
      return `[${category}] ${title}: ${content}`;
    }).join("\n");
  } catch {
    return "";
  }
}

// ─── Leer Content Pillars desde Notion ───────────────────────────────────────

async function fetchContentPillars(dbId: string): Promise<Array<{ id: string; name: string; weight: number; description: string }>> {
  const defaultPillars = [
    { id: "arquetipos", name: "Análisis de Arquetipos Masculinos", weight: 0.15, description: "" },
    { id: "filosofia", name: "Visión Filosófica de la Dirección Masculina", weight: 0.15, description: "" },
    { id: "sin-rumbo", name: "Historias de Hombres Sin Rumbo", weight: 0.15, description: "" },
    { id: "psicologia", name: "Visión Psicológica del Hombre Moderno", weight: 0.10, description: "" },
    { id: "relaciones", name: "Cómo se Ven en Relaciones", weight: 0.10, description: "" },
    { id: "frases", name: "Frases Poderosas que Tocan Dolores", weight: 0.10, description: "" },
    { id: "consciencia", name: "Contenido para Aumentar Niveles de Consciencia", weight: 0.10, description: "" },
    { id: "venta", name: "Contenido de Venta del Producto", weight: 0.08, description: "" },
    { id: "producto", name: "Contenido Mostrando el Producto en Acción", weight: 0.07, description: "" },
  ];

  if (!dbId || !process.env.NOTION_TOKEN) return defaultPillars;

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 20 }),
    });

    if (!res.ok) return defaultPillars;
    const data = (await res.json()) as {
      results: Array<{ id: string; properties: Record<string, { title?: Array<{ plain_text: string }>; number?: number; rich_text?: Array<{ plain_text: string }> }> }>;
    };

    if (data.results.length === 0) return defaultPillars;

    return data.results.map((page) => ({
      id: page.id,
      name: page.properties["Name"]?.title?.[0]?.plain_text ?? "",
      weight: page.properties["Weight"]?.number ?? 0.1,
      description: page.properties["Description"]?.rich_text?.[0]?.plain_text ?? "",
    }));
  } catch {
    return defaultPillars;
  }
}

// ─── Seleccionar pillar con rotación ponderada ────────────────────────────────

function selectPillar(
  pillars: Array<{ id: string; name: string; weight: number; description: string }>,
  forcedPillar?: string | null
): { id: string; name: string; description: string } {
  if (forcedPillar) {
    const found = pillars.find((p) => p.id === forcedPillar || p.name.toLowerCase().includes(forcedPillar.toLowerCase()));
    if (found) return found;
  }

  // Weighted random selection
  const totalWeight = pillars.reduce((sum, p) => sum + p.weight, 0);
  let rand = Math.random() * totalWeight;

  for (const pillar of pillars) {
    rand -= pillar.weight;
    if (rand <= 0) return pillar;
  }

  return pillars[0];
}

// ─── Obtener idea de Notion Ideas Pool ───────────────────────────────────────

async function fetchTopIdea(dbId: string, _pillarName: string): Promise<{ id: string; title: string; summary: string } | null> {
  if (!dbId || !process.env.NOTION_TOKEN) return null;

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "Status", select: { equals: "pending" } },
        sorts: [{ property: "Score", direction: "descending" }],
        page_size: 5,
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      results: Array<{ id: string; properties: Record<string, { title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }> }> }>;
    };

    if (data.results.length === 0) return null;
    const page = data.results[0];
    return {
      id: page.id,
      title: page.properties["Idea"]?.title?.[0]?.plain_text ?? "",
      summary: page.properties["Summary"]?.rich_text?.[0]?.plain_text ?? "",
    };
  } catch {
    return null;
  }
}

// ─── Generar VideoProps con Claude ────────────────────────────────────────────

async function generateVideoProps(
  pillar: { id: string; name: string; description: string },
  nicheConfig: ReturnType<typeof loadNicheConfig>,
  knowledgeBase: string,
  idea: { id: string; title: string; summary: string } | null,
  fixedPostId?: string
): Promise<VideoProps> {
  const postId = fixedPostId ?? uuidv4();
  const ideaContext = idea
    ? `\nIdea de investigación: "${idea.title}"\nContexto: ${idea.summary}`
    : "\nGenera una idea original alineada al pillar.";

  // fixedPostId indica que es un retry — el caller inyecta el contexto de feedback via prompt externo

  const prompt = `Eres el creador de contenido de "El Camino del Guerrero" (@elcaminodel.guerrero).
Nicho: Dirección Masculina. Tagline: "Sistema. No motivación."

AVATAR: Hombre 25-45 años. Tiene trabajo, quizás pareja, pero vive sin dirección real.
No busca motivación vacía. Busca SISTEMA y COHERENCIA INTERNA. Le habla una voz que no lo suaviza.

PILAR: ${pillar.name}
${pillar.description ? `Guía del pilar: ${pillar.description}` : ""}

VOZ DE MARCA — 4 PILARES (aplicar en orden según la escena):
⚔ BRUTAL HONESTIDAD: Di lo que el avatar piensa pero no admite. Sin suavizar. Sin filtros.
🧱 SOLIDEZ INTERNA: No prometemos sentirse bien. Prometemos coherencia. Sistema.
⚙ SISTEMA PRÁCTICO: Todo ejecutable. Nada de motivación vacía. Accionable.
🔥 VULNERABILIDAD AUTÉNTICA: No somos el gurú perfecto. Somos el que también pasó por el ciclo.

FRASES CORRECTAS (imita este tono):
- "Sabés exactamente lo que tenés que hacer. El problema es que no lo hacés."
- "No es motivación. Es un sistema que funciona aunque no tengas ganas."
- "Rompé el ciclo. Construí al hombre que sabés que podés ser."
- "Sin estructura, el potencial se convierte en culpa."

FRASES PROHIBIDAS (nunca escribir nada similar):
- "¡Tú puedes lograrlo! Cree en ti mismo."
- "En 30 días transformarás tu vida por completo."
- "Únete a nuestra comunidad de guerreros exitosos."
- "El secreto que nadie te contó para ser productivo."
${ideaContext}

KNOWLEDGE BASE:
${knowledgeBase.slice(0, 800) || "(usa tu conocimiento del nicho)"}

═══════════════════════════════════════
REGLAS DE AUDIO — MUY IMPORTANTE
═══════════════════════════════════════
Todos los "voiceover" de las escenas se CONCATENAN en UN SOLO AUDIO continuo.
ElevenLabs los leerá en secuencia como si fuera un monólogo sin cortes.

Por lo tanto:
1. Escríbelos como UN MONÓLOGO FLUIDO dividido en segmentos visuales.
2. Cada voiceover debe CONECTAR con el siguiente — usa transiciones naturales:
   ("Y es que...", "Pero hay algo...", "Lo que nadie te dijo es...", "Y entonces...",
   "Piénsalo así...", "Porque cuando un hombre...", "Y eso cambia todo...")
3. NO escribas frases aisladas. Es una conversación, no una lista de aforismos.
4. El ritmo debe ir: gancho fuerte → tensión → desarrollo → resolución → llamada.
5. durationSec es solo una guía visual (4-8s). El timing real lo calcula el audio.

═══════════════════════════════════════
REGLAS VISUALES
═══════════════════════════════════════
- "text" = la FRASE CLAVE en pantalla. SIEMPRE EN MAYÚSCULAS. Máx 8 palabras.
  El voiceover puede desarrollar esa frase con más detalle.
- Escena 1 (hook): la frase más disruptiva. Que duela o sorprenda.
- Varía los textStyle para que no todo se vea igual.
- NUNCA uses emojis de coach motivacional (💪🔥✨🎯🚀💯) en el texto en pantalla.
  Solo puedes usar: — · → ↓ ↑ ⚔ ⚙ ✓ ▸

- "background" = color oscuro de la paleta de marca. SIEMPRE fondo oscuro, NUNCA gradiente.
  Varía entre las 4 opciones para dar ritmo visual:
  - "#0D0D0D" — negro primario (escenas principales)
  - "#1A1A1A" — negro secundario (variación sutil)
  - "#0A0A0A" — negro profundo (revelaciones / tensión máxima)
  - "#141414" — negro variante (desarrollo / transición)

- "visualPrompt" = descripción corta EN INGLÉS del fondo ideal para esa escena.
  Será usada para buscar fotos en Pexels y generar imágenes con IA.
  Estética: oscuro dramático cinematográfico masculino. Alto contraste chiaroscuro.
  Sin texto, sin caras, sin colores brillantes, sin gradientes.
  Sujetos preferidos: figuras solitarias, elementos naturales crudos, objetos simbólicos.
  Ejemplos alineados con la marca:
  - "lone silhouette standing on mountain edge before storm dramatic contrast"
  - "dark empty corridor stone architecture single light source at end"
  - "rough hands gripping iron chains dark dramatic lighting close-up"
  - "ancient stone path through dense misty forest at dawn"
  - "lone wolf on snow peak against dark storm clouds twilight"

VALORES EXACTOS (solo estos, sin variaciones):
- background: "#0D0D0D" | "#1A1A1A" | "#0A0A0A" | "#141414"
- textStyle: "fade" | "slideUp" | "slideDown" | "slideLeft" | "slideRight" | "scale" | "typewriter" | "blur"
- format: "tiktok" | "instagram_reel" | "youtube_short"
- platforms: "tiktok" | "instagram" | "youtube" | "facebook"

Responde SOLO con este JSON (sin texto adicional, sin campos extra):
{
  "postId": "${postId}",
  "niche": "${nicheConfig.nicheId}",
  "pillarId": "${pillar.id}",
  "format": "tiktok",
  "hook": "La frase del hook — máx 70 chars, que pare el scroll",
  "scenes": [
    {
      "text": "Frase clave visual — máx 8 palabras",
      "voiceover": "El segmento de audio de esta escena. Fluye con las demás.",
      "durationSec": 7,
      "background": "#0D0D0D",
      "textStyle": "scale",
      "visualPrompt": "short English description of ideal background — dark dramatic cinematic, no text no faces"
    }
  ],
  "cta": "CTA — invita a seguir o reflexionar, no agresivo — máx 90 chars",
  "hashtags": ["masculinidad", "propósito", "hombres"],
  "platforms": ["tiktok", "instagram", "youtube"],
  "notionIdeaId": "${idea?.id ?? "manual"}"
}`;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    log("Creator", `Generando VideoProps (intento ${attempts}/${maxAttempts})...`);

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");

      const parsed = JSON.parse(jsonMatch[0]);
      const validated = VideoPropsSchema.parse(parsed);
      log("Creator", `VideoProps válido generado — ${validated.scenes.length} escenas, hook: "${validated.hook.slice(0, 50)}..."`);
      return validated;
    } catch (err) {
      log("Creator", `Intento ${attempts} fallido: ${(err as Error).message}`);
      if (attempts >= maxAttempts) throw new Error(`No se pudo generar VideoProps válido en ${maxAttempts} intentos`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("Unreachable");
}

// ─── Retry con feedback del validation-report ─────────────────────────────────

async function generateVideoPropsWithFeedback(
  previousProps: VideoProps,
  report: ValidationReport,
  nicheConfig: ReturnType<typeof loadNicheConfig>
): Promise<VideoProps> {
  const postId = previousProps.postId;

  const failingScores = Object.entries(report.scores)
    .filter(([, v]) => v < 7)
    .map(([k, v]) => `  - ${k}: ${v}/10`)
    .join("\n");

  const prompt = `Eres un experto creador de contenido para el nicho "${nicheConfig.name}".
Un video fue RECHAZADO por validación automática. Tu tarea es corregirlo basándote en el feedback.

SCORES QUE FALLARON (mínimo requerido: 7/10):
${failingScores || "  (ninguno bajo 7 — revisar promedio general)"}

SUGERENCIAS DEL VALIDADOR:
${report.suggestions.map((s) => `  → ${s}`).join("\n")}

VIDEO ORIGINAL (mantén lo que funciona, corrige lo que falló):
Hook: "${previousProps.hook}"
Escenas:
${previousProps.scenes.map((s, i) => `  ${i + 1}. Texto: "${s.text}" | Voz: "${s.voiceover}"`).join("\n")}
CTA: "${previousProps.cta}"

TONO DE MARCA: ${nicheConfig.voice.tone}
ESTILO: ${nicheConfig.voice.style}
EVITAR: ${nicheConfig.voice.forbidden.join(", ")}

INSTRUCCIONES:
- Mantén la estructura narrativa y escenas que ya funcionan (scores >= 8)
- Corrige SOLO lo que el validador señaló — no rompas lo que ya está bien
- hook: MÁXIMO 80 caracteres
- cta: MÁXIMO 100 caracteres

VALORES EXACTOS PERMITIDOS (no uses otros):
- background: "#0D0D0D" | "#1A1A1A" | "#0A0A0A" | "#141414"  — NUNCA gradientes
- textStyle: "fade" | "slideUp" | "slideDown" | "slideLeft" | "slideRight" | "scale" | "typewriter" | "blur"
- format: "tiktok" | "instagram_reel" | "youtube_short"
- platforms items: "tiktok" | "instagram" | "youtube" | "facebook"
- visualPrompt: descripción corta en inglés del fondo ideal. Estética oscura dramática cinematográfica. Sin texto, sin caras, sin gradientes. Conserva el original si el visual no cambió.

Responde SOLO con este JSON válido (sin texto adicional, sin campos extra):
{
  "postId": "${postId}",
  "niche": "${previousProps.niche}",
  "pillarId": "${previousProps.pillarId}",
  "format": "${previousProps.format}",
  "hook": "...",
  "scenes": [
    {
      "text": "...",
      "voiceover": "...",
      "durationSec": 7,
      "background": "#0D0D0D",
      "textStyle": "slideUp",
      "visualPrompt": "short English description of ideal background — dark dramatic cinematic, no text no faces"
    }
  ],
  "cta": "...",
  "hashtags": ${JSON.stringify(previousProps.hashtags)},
  "platforms": ${JSON.stringify(previousProps.platforms)},
  "notionIdeaId": "${previousProps.notionIdeaId}"
}`;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    log("Creator", `Regenerando con feedback (intento ${attempts}/${maxAttempts})...`);

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");

      const parsed = JSON.parse(jsonMatch[0]);
      const validated = VideoPropsSchema.parse(parsed);
      log("Creator", `VideoProps corregido — hook: "${validated.hook.slice(0, 50)}..."`);
      return validated;
    } catch (err) {
      log("Creator", `Intento ${attempts} fallido: ${(err as Error).message}`);
      if (attempts >= maxAttempts) throw new Error(`No se pudo corregir VideoProps en ${maxAttempts} intentos`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("Unreachable");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function retryContent(postId: string): Promise<string> {
  const pipelineDir = getContentPipelineDir(postId);
  const propsPath = path.join(pipelineDir, "video-props.json");
  const reportPath = path.join(pipelineDir, "validation-report.json");

  if (!fs.existsSync(propsPath)) throw new Error(`video-props.json no encontrado para: ${postId}`);
  if (!fs.existsSync(reportPath)) throw new Error(`validation-report.json no encontrado para: ${postId}`);

  const previousProps = readJson<VideoProps>(propsPath);
  const report = readJson<ValidationReport>(reportPath);

  if (report.passed) {
    log("Creator", `El post ${postId} ya pasó validación — no es necesario retry`);
    return postId;
  }

  log("Creator", `Retry de ${postId} | Scores fallidos: ${
    Object.entries(report.scores).filter(([, v]) => v < 7).map(([k, v]) => `${k}:${v}`).join(", ") || "promedio bajo"
  }`);

  const config = loadNicheConfig(previousProps.niche);
  const videoProps = await generateVideoPropsWithFeedback(previousProps, report, config);

  writeJson(propsPath, videoProps);
  log("Creator", `VideoProps corregido guardado: ${propsPath}`);

  return postId;
}

export async function createContent(nicheId: string, forcedPillar?: string | null): Promise<string> {
  const config = loadNicheConfig(nicheId);

  log("Creator", `Cargando knowledge base desde Notion...`);
  const [knowledgeBase, pillars] = await Promise.all([
    fetchNotionKnowledgeBase(config.notion.kbDbId),
    fetchContentPillars(config.notion.pillarsDbId),
  ]);

  const selectedPillar = selectPillar(pillars, forcedPillar);
  log("Creator", `Pillar seleccionado: "${selectedPillar.name}"`);

  const idea = await fetchTopIdea(config.notion.ideasDbId, selectedPillar.name);
  if (idea) {
    log("Creator", `Idea de Notion: "${idea.title.slice(0, 60)}"`);
  }

  const videoProps = await generateVideoProps(selectedPillar, config, knowledgeBase, idea);

  const pipelineDir = getContentPipelineDir(videoProps.postId);
  const propsPath = path.join(pipelineDir, "video-props.json");
  writeJson(propsPath, videoProps);
  log("Creator", `VideoProps guardado: ${propsPath}`);

  return videoProps.postId;
}

async function main() {
  if (isRetry) {
    if (!postIdArg) {
      console.error("Uso: npx tsx scripts/content-creator.ts --retry --post-id <uuid>");
      process.exit(1);
    }
    log("Creator", `Modo retry para post: ${postIdArg}${isDryRun ? " [DRY RUN]" : ""}`);
    const postId = await retryContent(postIdArg);
    log("Creator", `Siguiente paso: npx tsx scripts/validate-vision.ts --post-id ${postId}`);
  } else {
    log("Creator", `Iniciando para nicho: ${nicheArg}${isDryRun ? " [DRY RUN]" : ""}${pillarArg ? ` [pillar: ${pillarArg}]` : ""}`);
    const postId = await createContent(nicheArg, pillarArg);
    log("Creator", `Post ID generado: ${postId}`);
    log("Creator", `Siguiente paso: npx tsx scripts/validate-vision.ts --post-id ${postId}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
