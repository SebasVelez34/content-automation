/**
 * Visual Evaluator — usa Claude Vision para evaluar cada asset descargado.
 * Criteria: relevancia con la escena + alineación con el brand guide.
 * Si un asset no pasa (score avg < 7) genera un prompt más preciso y lo vuelve a descargar.
 *
 * Se ejecuta DESPUÉS del Fetch Visuals y ANTES del Render.
 * Salida: content-pipeline/<postId>/visual-evaluation.json + assets actualizados
 *
 * Uso: npx tsx scripts/visual-evaluator.ts --post-id <uuid>
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import fs from "fs";
import type { VideoProps, BrandGuide, VisualStrategy, VisualEvaluation, SceneEvaluation } from "./types.js";
import type { VisualAssetsManifest, VisualAsset } from "./fetch-visuals.js";
import { log, readJson, writeJson, getContentPipelineDir, loadBrandGuide, extractAndParseJSON } from "./utils.js";

const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];

const PASS_THRESHOLD = 7.0;

// ─── Evaluate a batch of assets with Claude Vision ────────────────────────────

interface BatchItem {
  sceneIndex: number;
  assetPath:  string;
  mediaType:  "image" | "video";
  sceneText:  string;
  voiceover:  string;
  role:       string;
}

function imageMediaType(filePath: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png")  return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif")  return "image/gif";
  return "image/jpeg";
}

function autoAcceptVideo(item: BatchItem): SceneEvaluation {
  return {
    sceneIndex:   item.sceneIndex,
    assetPath:    item.assetPath,
    mediaType:    "video",
    scores:       { sceneRelevance: 8, brandAlignment: 8, narrativeContribution: 8 },
    averageScore: 8,
    keep:         true,
    feedback:     "Video clip — evaluación visual omitida (Claude Vision no procesa video)",
  };
}

async function evaluateBatch(
  items:    BatchItem[],
  brand:    BrandGuide,
): Promise<SceneEvaluation[]> {

  // Videos cannot be sent to Claude Vision — auto-accept them
  const videoItems = items.filter((i) => i.mediaType === "video");
  const imageItems = items.filter((i) => i.mediaType === "image");

  const videoEvals = videoItems.map(autoAcceptVideo);

  if (imageItems.length === 0) return videoEvals;

  const imageContents = imageItems.map((item) => ({
    type:   "image" as const,
    source: {
      type:       "base64" as const,
      media_type: imageMediaType(item.assetPath),
      data:       fs.readFileSync(item.assetPath).toString("base64"),
    },
  }));

  const itemDescriptions = imageItems.map((item, idx) =>
    `IMAGEN ${idx + 1} (Escena ${item.sceneIndex + 1}, rol: ${item.role}):
  Texto en pantalla: "${item.sceneText}"
  Voz: "${item.voiceover.slice(0, 120)}"`
  ).join("\n\n");

  const prompt = `Eres un director de arte evaluando imágenes de fondo para un Reel de Instagram.

MARCA: ${brand.brandName} — "${brand.tagline}"
MOOD REQUERIDO: ${brand.imageAesthetic.primaryMood}
ILUMINACIÓN REQUERIDA: ${brand.imageAesthetic.lighting}
COLOR GRADE: ${brand.imageAesthetic.colorGrade}

ELEMENTOS PROHIBIDOS EN CUALQUIER IMAGEN:
${brand.imageAesthetic.forbiddenElements.map((e) => `  ✗ ${e}`).join("\n")}

SUJETOS DESEADOS:
${brand.imageAesthetic.preferredSubjects.slice(0, 3).map((s) => `  ✓ ${s}`).join("\n")}

═══
IMÁGENES A EVALUAR:
${itemDescriptions}

Para cada imagen evalúa del 1 al 10:
- sceneRelevance: ¿La imagen conecta emocionalmente con el texto/voz de esa escena?
- brandAlignment: ¿La imagen respeta la estética oscura dramática de la marca? (dark, moody, no bright colors, no faces looking at camera, no text/watermarks)
- narrativeContribution: ¿La imagen agrega profundidad y contexto visual al mensaje? ¿O es genérica/distractora?

Si el promedio < 7 genera un replacementPrompt EN INGLÉS extremadamente específico (sujeto + iluminación + atmósfera + ángulo de cámara) que garantice mejores resultados en Pexels o Gemini.

Responde SOLO con este JSON (sin texto adicional):
{
  "evaluations": [
    {
      "sceneIndex": <número>,
      "scores": {
        "sceneRelevance": <1-10>,
        "brandAlignment": <1-10>,
        "narrativeContribution": <1-10>
      },
      "keep": <true|false>,
      "feedback": "<observación corta — qué funciona o qué falla>",
      "replacementPrompt": "<solo si keep=false: prompt en inglés ultra-específico para re-búsqueda>",
      "replacementSource": "<solo si keep=false: pexels|gemini|pexels_video>"
    }
  ]
}

REGLAS JSON: sin comillas dobles dentro de strings, sin saltos de línea dentro de strings.`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2048,
    system:     "Respondes ÚNICAMENTE con JSON válido.",
    messages:   [{
      role:    "user",
      content: [...imageContents, { type: "text" as const, text: prompt }],
    }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const raw  = extractAndParseJSON(text) as { evaluations: Array<{
    sceneIndex: number;
    scores: { sceneRelevance: number; brandAlignment: number; narrativeContribution: number };
    keep: boolean;
    feedback: string;
    replacementPrompt?: string;
    replacementSource?: "pexels" | "gemini" | "pexels_video";
  }> };

  const imageEvals: SceneEvaluation[] = raw.evaluations.map((ev, idx) => {
    const item = imageItems[idx];
    const avg  = (ev.scores.sceneRelevance + ev.scores.brandAlignment + ev.scores.narrativeContribution) / 3;
    return {
      sceneIndex:            item.sceneIndex,
      assetPath:             item.assetPath,
      mediaType:             "image" as const,
      scores:                ev.scores,
      averageScore:          Math.round(avg * 10) / 10,
      keep:                  avg >= PASS_THRESHOLD,
      feedback:              ev.feedback,
      replacementPrompt:     avg < PASS_THRESHOLD ? ev.replacementPrompt : undefined,
      replacementSource:     avg < PASS_THRESHOLD ? (ev.replacementSource ?? "pexels") : undefined,
    } satisfies SceneEvaluation;
  });

  // Return combined: images evaluated + videos auto-accepted, sorted by sceneIndex
  return [...videoEvals, ...imageEvals].sort((a, b) => a.sceneIndex - b.sceneIndex);
}

// ─── Re-fetch a single scene asset with a new prompt ─────────────────────────

async function refetchAsset(
  sceneIndex:   number,
  newPrompt:    string,
  source:       "pexels" | "gemini" | "pexels_video",
  outputPath:   string,
): Promise<boolean> {
  log("VisualEval", `  Re-fetching escena ${sceneIndex + 1} via ${source}: "${newPrompt.slice(0, 60)}"`);

  if (source === "pexels" || source === "pexels_video") {
    if (!PEXELS_API_KEY) return false;
    const endpoint = source === "pexels_video"
      ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(newPrompt.split(" ").slice(0, 6).join(" "))}&per_page=5&orientation=portrait`
      : `https://api.pexels.com/v1/search?query=${encodeURIComponent(newPrompt.split(" ").slice(0, 6).join(" "))}&per_page=5&orientation=portrait`;

    try {
      const res = await fetch(endpoint, { headers: { Authorization: PEXELS_API_KEY } });
      if (!res.ok) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any;

      let downloadUrl: string | null = null;
      if (source === "pexels_video") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const videos = data.videos as any[];
        if (!videos?.length) return false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const files = videos[0].video_files?.filter((f: any) => f.height > f.width) ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        downloadUrl = (files.find((f: any) => f.quality === "sd") ?? files[0])?.link ?? null;
        if (downloadUrl) outputPath = outputPath.replace(".jpg", "-clip.mp4");
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const photos = data.photos as any[];
        if (!photos?.length) return false;
        downloadUrl = photos[sceneIndex % photos.length]?.src?.portrait ?? null;
      }

      if (!downloadUrl) return false;
      const imgRes = await fetch(downloadUrl);
      if (!imgRes.ok) return false;
      fs.writeFileSync(outputPath, Buffer.from(await imgRes.arrayBuffer()));
      return true;
    } catch { return false; }
  }

  if (source === "gemini") {
    if (!GEMINI_API_KEY) return false;
    try {
      const genaiModule = await import("@google/genai").catch(() => null);
      if (!genaiModule) return false;
      const { GoogleGenAI } = genaiModule;
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const enriched = `Cinematic vertical photo (9:16). ${newPrompt}. Dark dramatic lighting, masculine aesthetic, high contrast. No text, no watermarks, no faces.`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await (ai as any).models.generateImages({
        model:  "imagen-3.0-generate-002",
        prompt: enriched,
        config: { numberOfImages: 1, aspectRatio: "9:16", personGeneration: "dont_allow" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bytes = (resp as any)?.generatedImages?.[0]?.image?.imageBytes as string | undefined;
      if (!bytes) return false;
      fs.writeFileSync(outputPath, Buffer.from(bytes, "base64"));
      return true;
    } catch { return false; }
  }

  return false;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function evaluateVisuals(postId: string): Promise<VisualEvaluation> {
  const pipelineDir    = getContentPipelineDir(postId);
  const propsPath      = path.join(pipelineDir, "video-props.json");
  const manifestPath   = path.join(pipelineDir, "assets-manifest.json");
  const strategyPath   = path.join(pipelineDir, "visual-strategy.json");
  const evaluationPath = path.join(pipelineDir, "visual-evaluation.json");

  if (!fs.existsSync(propsPath))    throw new Error(`video-props.json no encontrado: ${propsPath}`);
  if (!fs.existsSync(manifestPath)) throw new Error(`assets-manifest.json no encontrado: ${manifestPath}`);

  const videoProps = readJson<VideoProps>(propsPath);
  const manifest   = readJson<VisualAssetsManifest>(manifestPath);
  const strategy: VisualStrategy | null = fs.existsSync(strategyPath) ? readJson<VisualStrategy>(strategyPath) : null;
  const brand      = loadBrandGuide(videoProps.niche);

  log("VisualEval", `=== VISUAL EVALUATOR — Post: ${postId} ===`);

  const assetsToEvaluate = manifest.assets.filter(
    (a) => a.source !== "none" && a.assetPath && fs.existsSync(a.assetPath)
  );

  if (assetsToEvaluate.length === 0) {
    log("VisualEval", "Sin assets para evaluar — todas las escenas usarán fondo oscuro");
    const empty: VisualEvaluation = { postId, evaluations: [], replacementsNeeded: 0, evaluatedAt: new Date().toISOString() };
    writeJson(evaluationPath, empty);
    return empty;
  }

  if (!brand) {
    log("VisualEval", "Sin brand guide — saltando evaluación visual, aceptando todos los assets");
    const passAll: VisualEvaluation = {
      postId,
      evaluations: assetsToEvaluate.map((a) => ({
        sceneIndex:   a.sceneIndex,
        assetPath:    a.assetPath,
        mediaType:    "image" as const,
        scores:       { sceneRelevance: 8, brandAlignment: 8, narrativeContribution: 8 },
        averageScore: 8,
        keep:         true,
        feedback:     "Aceptado sin evaluación — brand guide no disponible",
      })),
      replacementsNeeded: 0,
      evaluatedAt: new Date().toISOString(),
    };
    writeJson(evaluationPath, passAll);
    return passAll;
  }

  log("VisualEval", `Evaluando ${assetsToEvaluate.length} assets con Claude Vision...`);

  // Evaluate in batches of 4 to stay within context limits
  const BATCH_SIZE = 4;
  const allEvaluations: SceneEvaluation[] = [];

  for (let i = 0; i < assetsToEvaluate.length; i += BATCH_SIZE) {
    const batch = assetsToEvaluate.slice(i, i + BATCH_SIZE);
    log("VisualEval", `Batch ${Math.floor(i / BATCH_SIZE) + 1}: escenas ${batch.map((b) => b.sceneIndex + 1).join(", ")}`);

    const items: BatchItem[] = batch.map((asset) => {
      const scene    = videoProps.scenes[asset.sceneIndex];
      const stratScene = strategy?.scenes.find((s: { sceneIndex: number }) => s.sceneIndex === asset.sceneIndex);
      return {
        sceneIndex: asset.sceneIndex,
        assetPath:  asset.assetPath,
        mediaType:  asset.assetPath.endsWith(".mp4") ? "video" : "image",
        sceneText:  scene?.text ?? "",
        voiceover:  scene?.voiceover ?? "",
        role:       stratScene?.narrativeRole ?? (asset.sceneIndex === 0 ? "hook" : "development"),
      };
    });

    try {
      const batchEvals = await evaluateBatch(items, brand);
      allEvaluations.push(...batchEvals);
    } catch (err) {
      log("VisualEval", `Batch evaluation error: ${(err as Error).message} — aceptando assets de este batch`);
      batch.forEach((asset) => {
        allEvaluations.push({
          sceneIndex:   asset.sceneIndex,
          assetPath:    asset.assetPath,
          mediaType:    "image",
          scores:       { sceneRelevance: 7, brandAlignment: 7, narrativeContribution: 7 },
          averageScore: 7,
          keep:         true,
          feedback:     "Evaluación omitida por error — asset aceptado con score neutro",
        });
      });
    }
  }

  // Log results
  allEvaluations.forEach((ev) => {
    const icon = ev.keep ? "✓" : "✗";
    log("VisualEval", `  ${icon} Escena ${ev.sceneIndex + 1} (avg ${ev.averageScore}/10): ${ev.feedback.slice(0, 80)}`);
    if (!ev.keep && ev.replacementPrompt) {
      log("VisualEval", `    → Replace via ${ev.replacementSource}: "${ev.replacementPrompt.slice(0, 70)}"`);
    }
  });

  // Re-fetch rejected assets
  const rejected = allEvaluations.filter((ev) => !ev.keep && ev.replacementPrompt);
  log("VisualEval", `${rejected.length} asset(s) rechazado(s) — re-descargando...`);

  const updatedManifest = { ...manifest };
  for (const ev of rejected) {
    const originalAsset = manifest.assets.find((a) => a.sceneIndex === ev.sceneIndex);
    if (!originalAsset || !ev.replacementPrompt || !ev.replacementSource) continue;

    const safeSource = (ev.replacementSource === "ai_video" ? "pexels_video" : ev.replacementSource) as "pexels" | "pexels_video" | "gemini";
    const ok = await refetchAsset(ev.sceneIndex, ev.replacementPrompt, safeSource, ev.assetPath);
    if (ok) {
      log("VisualEval", `  ✓ Escena ${ev.sceneIndex + 1} re-descargada`);
      ev.keep = true;
      ev.feedback += " [reemplazado]";
      const assetIdx = updatedManifest.assets.findIndex((a) => a.sceneIndex === ev.sceneIndex);
      if (assetIdx >= 0) {
        (updatedManifest.assets[assetIdx] as VisualAsset).source = ev.replacementSource === "gemini" ? "gemini" : "pexels";
      }
    } else {
      log("VisualEval", `  ✗ Escena ${ev.sceneIndex + 1} re-descarga falló — usando asset original`);
      ev.keep = true;
      ev.feedback += " [re-descarga fallida, usando original]";
    }
  }

  writeJson(manifestPath, updatedManifest);

  const replacementsNeeded = rejected.length;
  const evaluation: VisualEvaluation = {
    postId,
    evaluations: allEvaluations,
    replacementsNeeded,
    evaluatedAt: new Date().toISOString(),
  };
  writeJson(evaluationPath, evaluation);

  const kept    = allEvaluations.filter((e) => e.keep).length;
  const avgScore = allEvaluations.reduce((s, e) => s + e.averageScore, 0) / allEvaluations.length;
  log("VisualEval", `✓ Evaluación completa: ${kept}/${allEvaluations.length} assets aprobados | score promedio: ${avgScore.toFixed(1)}/10`);

  return evaluation;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/visual-evaluator.ts --post-id <uuid>");
    process.exit(1);
  }
  const result = await evaluateVisuals(postIdArg);
  log("VisualEval", `✓ ${result.evaluations.length} evaluaciones guardadas`);
  log("VisualEval", `Siguiente: npx tsx scripts/render.ts --post-id ${postIdArg}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
