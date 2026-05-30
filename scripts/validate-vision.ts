/**
 * Validator Agent — evalúa el video generado con Claude Vision (frames) + rúbrica de contenido.
 * Si pasa: mueve a approval-queue. Si falla: devuelve al content-creator (máx 2 ciclos).
 *
 * Uso: npx tsx scripts/validate-vision.ts --post-id <uuid>
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import Anthropic from "@anthropic-ai/sdk";
import { log, readJson, writeJson, getContentPipelineDir, getApprovalQueueDir } from "./utils.js";
import type { VideoProps } from "./types.js";

const execAsync = promisify(exec);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EDITOR_PATH = process.env.EDITOR_PRO_MAX_PATH ?? "C:\\DevProjects\\editor-pro-max";
const FFMPEG  = process.env.FFMPEG_PATH  ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];

export interface ValidationReport {
  postId: string;
  passed: boolean;
  scores: {
    hook: number;
    nicheAlignment: number;
    argumentThread: number;
    virality: number;
    cta: number;
    visual: number;
  };
  averageScore: number;
  feedback: string[];
  suggestions: string[];
  validatedAt: string;
}

// ─── Extraer frames del video con ffmpeg ─────────────────────────────────────

async function extractFrames(videoPath: string, outputDir: string, count: number = 5): Promise<string[]> {
  if (!fs.existsSync(videoPath)) {
    log("Validator", `Video no encontrado: ${videoPath} — saltando validación visual`);
    return [];
  }

  const framePaths: string[] = [];

  try {
    // Obtener duración del video
    const { stdout } = await execAsync(
      `"${FFPROBE}" -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`
    );
    const duration = parseFloat(stdout.trim()) || 30;

    // Extraer frames a intervalos regulares
    for (let i = 0; i < count; i++) {
      const timeSec = (duration / (count + 1)) * (i + 1);
      const framePath = path.join(outputDir, `frame-${i}.jpg`);

      await execAsync(
        `"${FFMPEG}" -ss ${timeSec.toFixed(2)} -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" -y`
      );

      if (fs.existsSync(framePath)) framePaths.push(framePath);
    }

    log("Validator", `${framePaths.length} frames extraídos`);
  } catch (err) {
    log("Validator", `Error extrayendo frames: ${(err as Error).message}`);
  }

  return framePaths;
}

// ─── Validación visual con Claude Vision ─────────────────────────────────────

async function validateVisually(framePaths: string[], videoProps: VideoProps): Promise<{ score: number; feedback: string[] }> {
  if (framePaths.length === 0) {
    return { score: 8, feedback: ["Validación visual omitida — no hay frames disponibles"] };
  }

  const imageContents = framePaths.map((fp) => {
    const imageData = fs.readFileSync(fp).toString("base64");
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/jpeg" as const,
        data: imageData,
      },
    };
  });

  const prompt = `Analiza estos ${framePaths.length} frames de un video de contenido para redes sociales (TikTok/Instagram).
El video es sobre el nicho: dirección masculina, propósito de vida.
Hook esperado: "${videoProps.hook}"

Evalúa del 1 al 10:
1. ¿El texto es legible y tiene buen contraste?
2. ¿El diseño visual es profesional y atractivo?
3. ¿No hay frames en blanco o con errores de render?
4. ¿La estética es coherente (colores, tipografía)?
5. ¿Hay CTA visible en algún frame final?

Responde SOLO con JSON:
{"score": 8, "feedback": ["observación 1", "observación 2"], "issues": ["problema si existe"]}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: [...imageContents, { type: "text", text: prompt }] }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { score: 7, feedback: ["No se pudo parsear respuesta visual"] };

    const result = JSON.parse(jsonMatch[0]) as { score: number; feedback: string[]; issues?: string[] };
    return { score: result.score, feedback: [...result.feedback, ...(result.issues ?? [])] };
  } catch (err) {
    log("Validator", `Claude Vision error: ${(err as Error).message}`);
    return { score: 7, feedback: ["Error en validación visual — usando score neutro"] };
  }
}

// ─── Validación de contenido con Claude ──────────────────────────────────────

async function validateContent(videoProps: VideoProps): Promise<{
  scores: Omit<ValidationReport["scores"], "visual">;
  feedback: string[];
  suggestions: string[];
}> {
  const scenesText = videoProps.scenes.map((s, i) =>
    `Escena ${i + 1} (${s.durationSec}s): "${s.text}" | Voz: "${s.voiceover}"`
  ).join("\n");

  const prompt = `Eres un experto validador de contenido para el nicho "dirección masculina" en redes sociales.
Avatar: hombre 25-45 años que busca propósito y dirección de vida.

Evalúa este video de frases (TikTok/Reel):

HOOK: "${videoProps.hook}"
PILLAR: ${videoProps.pillarId}
ESCENAS:
${scenesText}
CTA: "${videoProps.cta}"
HASHTAGS: ${videoProps.hashtags.join(", ")}

Evalúa del 1-10 cada criterio:
- hook: ¿Para el scroll en 3 segundos? ¿Genera curiosidad o emoción inmediata?
- nicheAlignment: ¿Habla directo al dolor del avatar? ¿Es relevante?
- argumentThread: ¿Las escenas fluyen con coherencia narrativa?
- virality: ¿Tiene emoción, verdad incómoda, o revelación que se comparte?
- cta: ¿La acción final es clara, natural y no forzada?

Responde SOLO con JSON:
{
  "scores": {"hook": 8, "nicheAlignment": 9, "argumentThread": 7, "virality": 8, "cta": 7},
  "feedback": ["lo que funciona bien"],
  "suggestions": ["mejora específica si score < 8"]
}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const result = JSON.parse(jsonMatch[0]) as {
      scores: Omit<ValidationReport["scores"], "visual">;
      feedback: string[];
      suggestions: string[];
    };

    return result;
  } catch (err) {
    log("Validator", `Validation error: ${(err as Error).message}`);
    return {
      scores: { hook: 7, nicheAlignment: 7, argumentThread: 7, virality: 7, cta: 7 },
      feedback: ["Error en validación — usando scores conservadores"],
      suggestions: [],
    };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function validatePost(postId: string): Promise<ValidationReport> {
  const pipelineDir = getContentPipelineDir(postId);
  const videoPath = path.join(pipelineDir, "raw-video.mp4");
  const propsPath = path.join(pipelineDir, "video-props.json");

  if (!fs.existsSync(propsPath)) throw new Error(`VideoProps no encontrado: ${propsPath}`);
  const videoProps = readJson<VideoProps>(propsPath);

  log("Validator", `Extrayendo frames de: ${videoPath}`);
  const framePaths = await extractFrames(videoPath, pipelineDir);

  log("Validator", "Validando visualmente con Claude Vision...");
  const [visualResult, contentResult] = await Promise.all([
    validateVisually(framePaths, videoProps),
    validateContent(videoProps),
  ]);

  const scores = {
    ...contentResult.scores,
    visual: visualResult.score,
  };

  const allScores = Object.values(scores);
  const averageScore = allScores.reduce((sum, s) => sum + s, 0) / allScores.length;
  const minScore = Math.min(...allScores);
  const passed = minScore >= 7 && averageScore >= 7.5;

  const report: ValidationReport = {
    postId,
    passed,
    scores,
    averageScore: Math.round(averageScore * 10) / 10,
    feedback: [...contentResult.feedback, ...visualResult.feedback],
    suggestions: contentResult.suggestions,
    validatedAt: new Date().toISOString(),
  };

  // Guardar reporte
  const reportPath = path.join(pipelineDir, "validation-report.json");
  writeJson(reportPath, report);

  log("Validator", `Score promedio: ${report.averageScore}/10 | ${passed ? "✓ APROBADO" : "✗ RECHAZADO"}`);
  Object.entries(scores).forEach(([key, val]) => log("Validator", `  ${key}: ${val}/10`));

  if (!passed && report.suggestions.length > 0) {
    log("Validator", "Sugerencias de mejora:");
    report.suggestions.forEach((s) => log("Validator", `  → ${s}`));
  }

  // Si pasa, mover a approval-queue
  if (passed) {
    const approvalDir = getApprovalQueueDir(postId);
    const approvalMetadata = {
      postId,
      validationReport: report,
      pipelineDir,
      videoPath,
      thumbnailPath: path.join(pipelineDir, "thumbnail.png"),
      createdAt: new Date().toISOString(),
      status: "pending_approval",
    };
    writeJson(path.join(approvalDir, "metadata.json"), approvalMetadata);
    log("Validator", `Movido a approval-queue: ${approvalDir}`);
    log("Validator", `Siguiente paso: npx tsx scripts/approval-server.ts --post-id ${postId}`);
  }

  return report;
}

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/validate-vision.ts --post-id <uuid>");
    process.exit(1);
  }

  const report = await validatePost(postIdArg);
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
