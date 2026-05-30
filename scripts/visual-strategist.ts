/**
 * Visual Strategist — analiza la narrativa completa del reel y decide para cada
 * escena: tipo de media (imagen / secuencia de imágenes / video clip), cantidad
 * de assets, prompts precisos alineados con la marca, y fuente preferida.
 *
 * Se ejecuta DESPUÉS del Reels Expert y ANTES del Fetch Visuals.
 * Salida: content-pipeline/<postId>/visual-strategy.json
 *
 * Uso: npx tsx scripts/visual-strategist.ts --post-id <uuid>
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import fs from "fs";
import type { VideoProps, BrandGuide, VisualStrategy, SceneVisualPlan } from "./types.js";
import { log, readJson, writeJson, getContentPipelineDir, loadBrandGuide, extractAndParseJSON } from "./utils.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildStrategyPrompt(videoProps: VideoProps, brand: BrandGuide): string {
  const scenesDesc = videoProps.scenes.map((s, i) =>
    `  Escena ${i + 1}: "${s.text}" | Voz: "${s.voiceover.slice(0, 100)}" | visualPrompt base: "${s.visualPrompt ?? "(ninguno)"}"`
  ).join("\n");

  return `Eres un director de arte especializado en contenido para redes sociales del nicho de dirección masculina.

MARCA: ${brand.brandName} — "${brand.tagline}"
ESTÉTICA: ${brand.imageAesthetic.primaryMood}
ILUMINACIÓN: ${brand.imageAesthetic.lighting}
COLOR GRADE: ${brand.imageAesthetic.colorGrade}

SUJETOS PREFERIDOS:
${brand.imageAesthetic.preferredSubjects.map((s) => `  • ${s}`).join("\n")}

ELEMENTOS PROHIBIDOS EN CUALQUIER IMAGEN:
${brand.imageAesthetic.forbiddenElements.map((e) => `  ✗ ${e}`).join("\n")}

ESTÉTICA DE VIDEO (clips de movimiento):
  • ${brand.videoAesthetic.motionStyle}
  • Cámara: ${brand.videoAesthetic.cameraMovement}
  • Duración por clip: ${brand.videoAesthetic.clipDurationSec}
  ✗ Prohibido: ${brand.videoAesthetic.forbiddenMotion.join(", ")}

═══════════════════════════════════════
REEL A ANALIZAR
═══════════════════════════════════════
Hook principal: "${videoProps.hook}"
Pillar: ${videoProps.pillarId}
CTA: "${videoProps.cta}"

ESCENAS:
${scenesDesc}

═══════════════════════════════════════
TU TAREA
═══════════════════════════════════════
Para cada escena, decide:

1. NARRATIVE ROLE: qué función cumple en el arco narrativo
   → "hook" | "tension" | "development" | "revelation" | "resolution" | "cta"

2. MEDIA TYPE: qué tipo de asset aportará más profundidad y contexto
   → "image": una foto estática (suficiente para la mayoría de escenas)
   → "image_sequence": 2-3 imágenes que se evaluarán y se elegirá la mejor
   → "video": clip de video con movimiento (SOLO cuando el movimiento sea CRÍTICO para la emoción)

3. COUNT: cuántos assets descargar (1-3)

4. SUGGESTED PROMPTS: array de prompts EN INGLÉS, precisos y alineados con la marca.
   Cada prompt debe:
   - Ser extremadamente específico (no genérico)
   - Incluir: sujeto + iluminación + atmósfera + estilo cinematográfico
   - Excluir explícitamente lo que NO queremos
   - Respetar el color grade oscuro de la marca
   - Estar optimizado para búsqueda en Pexels (frases naturales de máx 8 palabras)

5. PREFERRED SOURCE: de dónde obtener el asset
   → "pexels": foto stock gratis (PRIMERA opción siempre)
   → "pexels_video": video stock gratis (cuando mediaType=video y Pexels tiene opciones)
   → "gemini": imagen generada por IA, gratis (cuando Pexels no tiene lo específico)
   → "ai_video": video generado por IA, de pago (SOLO si es absolutamente crítico y pexels_video no sirve)

JERARQUÍA DE COSTOS (respétala estrictamente):
  1. pexels (gratis, fotos)
  2. pexels_video (gratis, video)
  3. gemini (gratis, imagen IA)
  4. ai_video (pago — usar SOLO para el hook si el movimiento es imprescindible)

REGLA SOBRE VIDEOS: Usa mediaType="video" SOLO cuando:
  a) El hook necesita movimiento para maximizar la retención en los primeros 2 segundos
  b) La escena describe explícitamente acción o movimiento (olas rompiendo, fuego ardiendo, niebla moviéndose)
  c) La revelación emocional clave ganaría dramáticamente con motion
  Para todas las demás escenas → "image" es suficiente.

═══════════════════════════════════════
ENTREGA — Solo este JSON, sin texto adicional
═══════════════════════════════════════

{
  "globalNarrativeSummary": "<resumen del arco narrativo en 1-2 oraciones>",
  "overallMood": "<atmósfera visual global que unifica el reel>",
  "scenes": [
    {
      "sceneIndex": 0,
      "narrativeRole": "hook",
      "mediaType": "video",
      "count": 1,
      "suggestedPrompts": ["dramatic slow motion lone silhouette walking toward dawn light dark corridor"],
      "preferredSource": "pexels_video",
      "motionNote": "<por qué se eligió video aquí — omitir si es imagen>"
    }
  ]
}

REGLAS JSON ABSOLUTAS:
- NUNCA uses comillas dobles (") dentro de los valores de string
- Si necesitas citar algo, usa comillas simples (') o sin comillas
- NUNCA pongas saltos de línea literales dentro de un string
- Genera exactamente ${videoProps.scenes.length} entradas en "scenes" (una por escena)`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyzeVisualStrategy(postId: string): Promise<VisualStrategy> {
  const pipelineDir = getContentPipelineDir(postId);
  const propsPath   = path.join(pipelineDir, "video-props.json");
  const stratPath   = path.join(pipelineDir, "visual-strategy.json");

  if (!fs.existsSync(propsPath)) throw new Error(`video-props.json no encontrado: ${propsPath}`);

  // Reutilizar si ya existe
  if (fs.existsSync(stratPath)) {
    log("VisualStrategist", "Estrategia ya existe — reutilizando");
    return readJson<VisualStrategy>(stratPath);
  }

  const videoProps = readJson<VideoProps>(propsPath);
  const brand      = loadBrandGuide(videoProps.niche);

  if (!brand) {
    log("VisualStrategist", `Sin brand-guide para niche "${videoProps.niche}" — usando visualPrompts originales`);
    const fallback: VisualStrategy = {
      postId,
      globalNarrativeSummary: "Sin estrategia — brand guide no disponible",
      overallMood: "dark dramatic",
      scenes: videoProps.scenes.map((s, i) => ({
        sceneIndex:       i,
        narrativeRole:    i === 0 ? "hook" : i === videoProps.scenes.length - 1 ? "cta" : "development",
        mediaType:        "image",
        count:            1,
        suggestedPrompts: s.visualPrompt ? [s.visualPrompt] : ["dark dramatic masculine solitude"],
        preferredSource:  "pexels",
      } as SceneVisualPlan)),
      analyzedAt: new Date().toISOString(),
    };
    writeJson(stratPath, fallback);
    return fallback;
  }

  log("VisualStrategist", `=== VISUAL STRATEGIST — Post: ${postId} ===`);
  log("VisualStrategist", `Analizando ${videoProps.scenes.length} escenas con brand guide "${brand.brandName}"...`);

  const prompt = buildStrategyPrompt(videoProps, brand);

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    log("VisualStrategist", `Llamando a Claude (intento ${attempts}/${maxAttempts})...`);

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: "Respondes ÚNICAMENTE con un objeto JSON válido. Sin texto adicional, sin markdown, sin explicaciones.",
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const raw  = extractAndParseJSON(text) as {
        globalNarrativeSummary: string;
        overallMood: string;
        scenes: SceneVisualPlan[];
      };

      if (!raw.scenes || raw.scenes.length !== videoProps.scenes.length) {
        throw new Error(`Esperaba ${videoProps.scenes.length} escenas, recibí ${raw.scenes?.length ?? 0}`);
      }

      const strategy: VisualStrategy = {
        postId,
        globalNarrativeSummary: raw.globalNarrativeSummary,
        overallMood:            raw.overallMood,
        scenes:                 raw.scenes,
        analyzedAt:             new Date().toISOString(),
      };

      writeJson(stratPath, strategy);

      // Log resumen
      const videoScenes = strategy.scenes.filter((s) => s.mediaType === "video").length;
      const seqScenes   = strategy.scenes.filter((s) => s.mediaType === "image_sequence").length;
      const imgScenes   = strategy.scenes.filter((s) => s.mediaType === "image").length;
      log("VisualStrategist", `✓ Estrategia generada: ${imgScenes} imágenes · ${seqScenes} secuencias · ${videoScenes} videos`);
      log("VisualStrategist", `  Mood: ${strategy.overallMood}`);
      strategy.scenes.forEach((s) => {
        const icon = s.mediaType === "video" ? "🎬" : s.mediaType === "image_sequence" ? "🖼×" : "🖼";
        log("VisualStrategist", `  Escena ${s.sceneIndex + 1} [${s.narrativeRole}] ${icon} → ${s.preferredSource} | "${s.suggestedPrompts[0]?.slice(0, 60)}"`);
      });

      return strategy;

    } catch (err) {
      log("VisualStrategist", `Intento ${attempts} fallido: ${(err as Error).message}`);
      if (attempts >= maxAttempts) throw new Error(`Visual Strategist falló en ${maxAttempts} intentos`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("Unreachable");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/visual-strategist.ts --post-id <uuid>");
    process.exit(1);
  }
  const strategy = await analyzeVisualStrategy(postIdArg);
  log("VisualStrategist", `✓ Guardado: visual-strategy.json (${strategy.scenes.length} escenas)`);
  log("VisualStrategist", `Siguiente: npx tsx scripts/fetch-visuals.ts --post-id ${postIdArg}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
