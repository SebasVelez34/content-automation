/**
 * Pipeline Orchestrator — flujo completo:
 *   1. Content Creator
 *   2. Reels Expert (score ≥ 9)
 *   3. Visual Strategist (decide imagen/video/secuencia por escena)
 *   4. Fetch Visuals (Pexels + Gemini + Pexels Video)
 *   5. Visual Evaluator (Claude Vision evalúa y reemplaza assets malos)
 *   6. Render (Remotion — Oswald Bold, fondos oscuros, brand-accurate)
 *   7. Validación (contenido + Claude Vision sobre frames)
 *   8. Approval Dashboard (decisión humana)
 *   9. Publicar
 *
 * Uso: npx tsx scripts/pipeline.ts --niche masculinity [--step research|create|full]
 */

import "dotenv/config";
import { log } from "./utils.js";
import { createContent, retryContent } from "./content-creator.js";
import { auditAndImprove } from "./reels-expert.js";
import { analyzeVisualStrategy } from "./visual-strategist.js";
import { fetchVisualsForPost } from "./fetch-visuals.js";
import { evaluateVisuals } from "./visual-evaluator.js";
import { renderPost } from "./render.js";
import { validatePost } from "./validate-vision.js";
import { startApprovalServer } from "./approval-server.js";
import { publishPost } from "./publish.js";

const nicheArg = process.argv.find((a) => a.startsWith("--niche="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--niche") + 1]
  ?? "masculinity";

const stepArg = process.argv.find((a) => a.startsWith("--step="))?.split("=")[1]
  ?? (process.argv.includes("--step") ? process.argv[process.argv.indexOf("--step") + 1] : "full");

const MAX_REGENERATION_CYCLES = 2;

async function runFullPipeline(nicheId: string): Promise<void> {
  log("Pipeline", `=== INICIANDO PIPELINE COMPLETO — Nicho: ${nicheId} ===`);

  let postId: string | null = null;
  let validationPassed = false;
  let cycles = 0;

  while (!validationPassed && cycles < MAX_REGENERATION_CYCLES) {
    cycles++;
    log("Pipeline", `--- Ciclo ${cycles}/${MAX_REGENERATION_CYCLES} ---`);

    // PASO 1: Crear contenido
    log("Pipeline", "PASO 1: Content Creator");
    postId = await createContent(nicheId);
    log("Pipeline", `Post ID: ${postId}`);

    // PASO 2: Reels Expert — itera hasta score ≥ 9
    log("Pipeline", "PASO 2: Reels Expert Auditor");
    try {
      const { report } = await auditAndImprove(postId);
      const icon = report.reachedTarget ? "✓" : "⚠";
      log("Pipeline", `Reels Expert: ${report.originalScores.overall} → ${report.finalScores.overall} (${report.iterationsRun} iter) ${icon} | ${report.allChanges.length} cambios`);
    } catch (err) {
      log("Pipeline", `Reels Expert falló: ${(err as Error).message} — usando VideoProps original`);
    }

    // PASO 3: Visual Strategist — decide media type + prompts por escena
    log("Pipeline", "PASO 3: Visual Strategist");
    try {
      const strategy = await analyzeVisualStrategy(postId);
      const videos = strategy.scenes.filter((s) => s.mediaType === "video").length;
      const seqs   = strategy.scenes.filter((s) => s.mediaType === "image_sequence").length;
      log("Pipeline", `Visual Strategist: ${strategy.scenes.length - videos - seqs} imgs · ${seqs} seqs · ${videos} videos | ${strategy.overallMood}`);
    } catch (err) {
      log("Pipeline", `Visual Strategist falló: ${(err as Error).message} — fetch-visuals usará visualPrompts originales`);
    }

    // PASO 4: Fetch Visuals — descarga imágenes/videos (Pexels + Gemini)
    log("Pipeline", "PASO 4: Fetch Visuals");
    try {
      const manifest   = await fetchVisualsForPost(postId);
      const withAssets = manifest.assets.filter((a) => a.source !== "none").length;
      const videos     = manifest.assets.filter((a) => a.mediaType === "video").length;
      log("Pipeline", `Fetch Visuals: ${withAssets}/${manifest.assets.length} escenas con asset (${videos} videos)`);
    } catch (err) {
      log("Pipeline", `Fetch Visuals falló: ${(err as Error).message} — render con fondos oscuros`);
    }

    // PASO 5: Visual Evaluator — Claude Vision evalúa y reemplaza assets malos
    log("Pipeline", "PASO 5: Visual Evaluator");
    try {
      const evaluation = await evaluateVisuals(postId);
      const kept    = evaluation.evaluations.filter((e) => e.keep).length;
      const avgScore = evaluation.evaluations.length > 0
        ? (evaluation.evaluations.reduce((s, e) => s + e.averageScore, 0) / evaluation.evaluations.length).toFixed(1)
        : "n/a";
      log("Pipeline", `Visual Evaluator: ${kept}/${evaluation.evaluations.length} aprobados | score promedio: ${avgScore}/10`);
    } catch (err) {
      log("Pipeline", `Visual Evaluator falló: ${(err as Error).message} — usando assets sin evaluar`);
    }

    // PASO 6: Render con Remotion
    log("Pipeline", "PASO 6: Render con Remotion");
    try {
      await renderPost(postId);
    } catch (err) {
      log("Pipeline", `Render falló: ${(err as Error).message} — continuando sin video para validación`);
    }

    // PASO 7: Validar contenido + Claude Vision sobre frames
    log("Pipeline", "PASO 7: Validación (contenido + Claude Vision)");
    const report = await validatePost(postId);
    validationPassed = report.passed;

    if (!validationPassed && cycles < MAX_REGENERATION_CYCLES) {
      log("Pipeline", `Validación fallida (avg: ${report.averageScore}/10) — regenerando con feedback...`);
      postId = await retryContent(postId);
      const retryReport = await validatePost(postId);
      validationPassed = retryReport.passed;
      if (!validationPassed) {
        log("Pipeline", `Retry también falló (avg: ${retryReport.averageScore}/10) — pasando a aprobación manual`);
      }
      break;
    } else if (!validationPassed) {
      log("Pipeline", `Validación fallida (avg: ${report.averageScore}/10) — pasando a aprobación manual`);
    }
  }

  if (!postId) throw new Error("No se pudo generar un post válido");

  // PASO 8: Approval Dashboard
  log("Pipeline", "PASO 8: Approval Dashboard (esperando decisión humana...)");
  await startApprovalServer(postId);

  const decisionPath = `C:\\ContentAutomation\\approval-queue\\${postId}\\decision.json`;
  const fs = await import("fs");
  if (!fs.default.existsSync(decisionPath)) {
    log("Pipeline", "No hay decisión — pipeline detenido");
    return;
  }

  const decision = JSON.parse(fs.default.readFileSync(decisionPath, "utf-8")) as { approved: boolean; action: string };

  if (decision.action === "regenerate") {
    log("Pipeline", "Regenerando por solicitud del usuario...");
    await runFullPipeline(nicheId);
    return;
  }

  if (!decision.approved) {
    log("Pipeline", "Contenido rechazado — pipeline terminado");
    return;
  }

  // PASO 9: Publicar
  log("Pipeline", "PASO 9: Publicando en redes sociales");
  const results  = await publishPost(postId);
  const successes = results.filter((r) => r.success);
  log("Pipeline", `Publicado en ${successes.length}/${results.length} plataformas`);
  successes.forEach((r) => log("Pipeline", `  ✓ ${r.platform}: ${r.url}`));

  log("Pipeline", `=== PIPELINE COMPLETADO — Post: ${postId} ===`);
  log("Pipeline", `Monitor en 48h: npx tsx scripts/monitor.ts --post-id ${postId}`);
}

async function main() {
  switch (stepArg) {
    case "research":
      log("Pipeline", "Solo research — ejecutar: npx tsx scripts/research.ts --niche " + nicheArg);
      break;
    case "full":
    default:
      await runFullPipeline(nicheArg);
  }
}

main().catch((err) => {
  log("Pipeline", `ERROR FATAL: ${(err as Error).message}`);
  console.error(err);
  process.exit(1);
});
