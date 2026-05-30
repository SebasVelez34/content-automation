/**
 * Reels Expert Agent — auditor experto de Reels que revisa y mejora el VideoProps
 * ANTES de renderizar. Se inserta como PASO 2 entre content-creator y render.
 *
 * Lógica de iteración:
 *   - Score mínimo aceptable: MIN_ACCEPTABLE_SCORE (9/10)
 *   - Si el score es < 9 → re-audita el VideoProps ya mejorado con contexto de qué falta
 *   - Repite hasta score ≥ 9 o MAX_AUDIT_ITERATIONS (3)
 *   - Cada iteración pasa el historial de cambios y scores previos para no repetir trabajo
 *
 * Criterios (ponderados):
 *   Hook 25% | Pacing 20% | Variedad visual 15% | Claridad texto 15%
 *   Flujo audio 15% | CTA 10%
 *
 * Uso: npx tsx scripts/reels-expert.ts --post-id <uuid> [--dry-run]
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import fs from "fs";
import { VideoPropsSchema, type VideoProps } from "./types.js";
import { log, readJson, writeJson, getContentPipelineDir, extractAndParseJSON } from "./utils.js";

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];

const isDryRun = process.argv.includes("--dry-run");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Constantes ───────────────────────────────────────────────────────────────

const MIN_ACCEPTABLE_SCORE = 9;   // Umbral mínimo para dar el VideoProps por bueno
const MAX_AUDIT_ITERATIONS = 3;   // Máx iteraciones de mejora antes de rendirse

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface ReelsAuditReport {
  postId: string;
  iterationsRun: number;        // Cuántas iteraciones se necesitaron
  originalScores: ReelsScores;  // Scores del borrador original (pre-auditoría)
  finalScores: ReelsScores;     // Scores finales tras todas las iteraciones
  allChanges: ReelsChange[];    // Todos los cambios acumulados de todas las iteraciones
  reachedTarget: boolean;       // ¿Se llegó a score >= MIN_ACCEPTABLE_SCORE?
  auditedAt: string;
  modelUsed: string;
}

export interface ReelsScores {
  hook: number;          // ¿Para el scroll en 3 segundos? (1-10)
  pacing: number;        // ¿Ritmo adecuado entre escenas? (1-10)
  visualVariety: number; // ¿Variedad de fondos y animaciones? (1-10)
  textClarity: number;   // ¿Textos cortos y de impacto? (1-10)
  audioFlow: number;     // ¿Voiceover fluido como monólogo? (1-10)
  ctaStrength: number;   // ¿CTA natural y motivador? (1-10)
  overall: number;       // Promedio ponderado (calculado)
}

export interface ReelsChange {
  field: string;   // e.g. "hook", "scene[0].text", "scene[2].background"
  before: string;
  after: string;
  reason: string;
}

// ─── Contexto de iteración (para re-auditorías) ───────────────────────────────

interface IterationContext {
  iteration: number;
  previousScores: ReelsScores;
  previousChanges: ReelsChange[];
}

// ─── Prompt inicial (primera auditoría) ──────────────────────────────────────

function buildInitialPrompt(videoProps: VideoProps): string {
  const scenesText = videoProps.scenes.map((s, i) => `
  Escena ${i + 1}:
    text:      "${s.text}"
    voiceover: "${s.voiceover}"
    durationSec: ${s.durationSec}
    background: ${s.background}
    textStyle:  ${s.textStyle}`).join("\n");

  return `Eres el AUDITOR EXPERTO de Reels en español más exigente del mundo.
Trabajas con creadores de contenido en el nicho de masculinidad / dirección masculina.
Tu trabajo es revisar un VideoProps borrador y MEJORARLO hasta que sea material viral real.

OBJETIVO DE SCORE: Cada criterio debe llegar a 9/10 o más. Overall mínimo: ${MIN_ACCEPTABLE_SCORE}/10.
Sé implacable. Si algo es un 7, no es suficiente.

═══════════════════════════════════════
VIDEOPROPS A AUDITAR
═══════════════════════════════════════
hook: "${videoProps.hook}"
cta:  "${videoProps.cta}"
pillar: ${videoProps.pillarId}
hashtags: ${videoProps.hashtags.join(", ")}
${scenesText}

${CRITERIA_BLOCK}

${buildOutputFormat(videoProps)}`;
}

// ─── Prompt de re-auditoría (iteraciones 2+) ─────────────────────────────────

function buildIterationPrompt(videoProps: VideoProps, ctx: IterationContext): string {
  const scenesText = videoProps.scenes.map((s, i) => `
  Escena ${i + 1}:
    text:      "${s.text}"
    voiceover: "${s.voiceover}"
    durationSec: ${s.durationSec}
    background: ${s.background}
    textStyle:  ${s.textStyle}`).join("\n");

  // Campos todavía por debajo del umbral
  const scoreFields: Array<{ key: keyof Omit<ReelsScores, "overall">; label: string }> = [
    { key: "hook",          label: "Hook" },
    { key: "pacing",        label: "Pacing" },
    { key: "visualVariety", label: "Variedad visual" },
    { key: "textClarity",   label: "Claridad texto" },
    { key: "audioFlow",     label: "Flujo audio" },
    { key: "ctaStrength",   label: "CTA" },
  ];

  const stillBelow = scoreFields
    .filter(({ key }) => ctx.previousScores[key] < MIN_ACCEPTABLE_SCORE)
    .map(({ key, label }) => `  - ${label}: ${ctx.previousScores[key]}/10 → necesita llegar a ${MIN_ACCEPTABLE_SCORE}`)
    .join("\n");

  const alreadyGood = scoreFields
    .filter(({ key }) => ctx.previousScores[key] >= MIN_ACCEPTABLE_SCORE)
    .map(({ key, label }) => `  ✓ ${label}: ${ctx.previousScores[key]}/10`)
    .join("\n");

  const prevChangeSummary = ctx.previousChanges.length > 0
    ? ctx.previousChanges.slice(0, 8).map((c) =>
        `  [${c.field}] "${c.before.slice(0, 40)}" → "${c.after.slice(0, 40)}"`
      ).join("\n")
    : "  (ninguno registrado)";

  return `Eres el AUDITOR EXPERTO de Reels en español más exigente del mundo.
Nicho: masculinidad / dirección masculina.

═══════════════════════════════════════
ITERACIÓN ${ctx.iteration} DE ${MAX_AUDIT_ITERATIONS} — MEJORA CONTINUA
═══════════════════════════════════════
Este VideoProps ya fue auditado ${ctx.iteration - 1} vez/veces.
Score overall actual: ${ctx.previousScores.overall}/10.
OBJETIVO: llegar a ${MIN_ACCEPTABLE_SCORE}+ en TODOS los criterios.

LO QUE YA ESTÁ BIEN (no tocar sin razón fuerte):
${alreadyGood || "  (nada todavía)"}

LO QUE AÚN FALLA Y DEBES MEJORAR:
${stillBelow || "  (todo está bien — refina mínimamente)"}

CAMBIOS YA APLICADOS EN ITERACIONES ANTERIORES:
${prevChangeSummary}
→ No repitas los mismos cambios. Busca ángulos nuevos para mejorar lo que falta.
→ Sé más agresivo. Si el hook es 7, no está bien. Reescríbelo desde cero si hace falta.

═══════════════════════════════════════
VIDEOPROPS ACTUAL (ya mejorado de iteraciones anteriores)
═══════════════════════════════════════
hook: "${videoProps.hook}"
cta:  "${videoProps.cta}"
pillar: ${videoProps.pillarId}
hashtags: ${videoProps.hashtags.join(", ")}
${scenesText}

${CRITERIA_BLOCK}

${buildOutputFormat(videoProps)}`;
}

// ─── Criterios de evaluación (bloque reutilizable) ───────────────────────────

const CRITERIA_BLOCK = `═══════════════════════════════════════
CRITERIOS DE EVALUACIÓN (objetivo: 9+ en cada uno)
═══════════════════════════════════════

1. HOOK (peso: 25%)
   - ¿Para el scroll en los PRIMEROS 3 SEGUNDOS?
   - El texto de la escena 1 debe ser una bofetada emocional, no una introducción.
   - Patrones que funcionan: pregunta que duele, afirmación provocadora, dato inesperado.
   - MAL: "Los hombres de hoy están perdidos" (genérico, cliché)
   - BIEN: "Tienes 30 años y sigues esperando que alguien te diga qué hacer." (personal, incómodo)
   - El voiceover de la primera escena TAMBIÉN debe enganchar en las primeras 5 palabras habladas.
   - Score 9+: el hook hace que incluso alguien que no sigue el nicho pare el scroll.

2. PACING (peso: 20%)
   - Curva emocional obligatoria: tensión → revelación → desarrollo → resolución → llamada
   - Escenas cortas (4-5s) para golpes emocionales, largas (7-9s) para desarrollo
   - No más de 2 escenas consecutivas con el mismo tono emocional
   - La penúltima escena debe ser la más poderosa (cierre emocional antes del CTA)
   - Score 9+: si alguien escucha el voiceover completo, no puede no llegar al final.

3. VARIEDAD VISUAL (peso: 15%)
   - NO repetir el mismo background en escenas consecutivas (nunca)
   - NO repetir la misma animación más de 2 veces en todo el video
   - Para masculinidad: dark colors → midnight, aurora, fire, purple
   - Hook SIEMPRE: scale o blur (agresivo)
   - CTA scene: contraste visual fuerte → sunset u ocean
   - Score 9+: cada 5 segundos hay algo visualmente distinto.

4. CLARIDAD DE TEXTO (peso: 15%)
   - Máximo 8 palabras por escena. Cortar todo lo demás.
   - El texto en pantalla = el impacto de la escena en 1 frase, no un resumen.
   - Eliminar artículos y conectores: "Los hombres sin dirección" → "Sin dirección."
   - Puntuación para énfasis: "..." para suspenso, "." rotundo para verdades.
   - Score 9+: cada texto leído por separado impacta.

5. FLUJO DE AUDIO (peso: 15%)
   - Los voiceovers DEBEN leerse como un monólogo continuo, fluido, sin cortes.
   - Cada voiceover conecta con el siguiente usando transiciones naturales.
   - El voiceover del hook termina en tensión (no cierra la idea).
   - Score 9+: se puede leer en voz alta y suena natural, no como una lista.

6. CTA (peso: 10%)
   - NO: "Sígueme para más contenido" / "Comenta si te identificas"
   - SÍ: Apelación directa al dolor o al deseo del avatar.
   - SÍ: Pregunta reflexiva que se queda en la cabeza del espectador.
   - Máximo 90 caracteres. Sin emojis genéricos.
   - Score 9+: el CTA completa la transformación emocional del video.`;

// ─── Formato de salida esperado ───────────────────────────────────────────────

function buildOutputFormat(videoProps: VideoProps): string {
  return `═══════════════════════════════════════
ENTREGA — Solo este JSON, sin texto adicional
═══════════════════════════════════════

{
  "scores_original": {
    "hook": <1-10>,
    "pacing": <1-10>,
    "visualVariety": <1-10>,
    "textClarity": <1-10>,
    "audioFlow": <1-10>,
    "ctaStrength": <1-10>
  },
  "improved_props": {
    "postId": "${videoProps.postId}",
    "niche": "${videoProps.niche}",
    "pillarId": "${videoProps.pillarId}",
    "format": "${videoProps.format}",
    "hook": "<hook — máx 80 chars, que pare el scroll>",
    "scenes": [
      {
        "text": "<máx 8 palabras, impacto inmediato>",
        "voiceover": "<segmento de monólogo, fluye con los demás>",
        "durationSec": <4-9>,
        "background": "<sunset|ocean|forest|purple|fire|midnight|aurora|rainbow>",
        "textStyle": "<fade|slideUp|slideDown|slideLeft|slideRight|scale|typewriter|blur>",
        "visualPrompt": "<short English description of ideal background image — preserve original if visual unchanged>"
      }
    ],
    "cta": "<CTA — máx 90 chars>",
    "hashtags": [<3-15 hashtags sin #>],
    "platforms": ${JSON.stringify(videoProps.platforms)},
    "notionIdeaId": "${videoProps.notionIdeaId}"
  },
  "scores_improved": {
    "hook": <1-10>,
    "pacing": <1-10>,
    "visualVariety": <1-10>,
    "textClarity": <1-10>,
    "audioFlow": <1-10>,
    "ctaStrength": <1-10>
  },
  "changes": [
    {
      "field": "<hook|cta|scene[N].text|scene[N].voiceover|scene[N].background|scene[N].textStyle|hashtags>",
      "before": "<valor original>",
      "after": "<valor mejorado>",
      "reason": "<por qué este cambio empuja el score a 9+>"
    }
  ]
}

REGLAS ABSOLUTAS:
- Mantén postId, niche, pillarId, format, platforms, notionIdeaId sin cambios
- Rango de escenas: 4-7
- Si un campo ya tiene score >= 9, no lo cambies sin razón muy fuerte
- Solo registra en "changes" lo que REALMENTE cambiaste esta iteración
- background y textStyle DEBEN ser exactamente uno de los valores del enum
- visualPrompt: si cambias background/textStyle de una escena, mejora también su visualPrompt para que coincida con la nueva atmósfera; si no cambias lo visual, copia el visualPrompt original exacto

⚠ JSON VÁLIDO — MUY IMPORTANTE:
- NUNCA uses comillas dobles (") dentro de los valores de string del JSON
- Si necesitas citar algo en un voiceover o reason, usa comillas simples ('así') o ninguna
- NUNCA pongas saltos de línea literales dentro de un string — todo en una sola línea
- Verifica que el JSON sea parseable antes de responder`;
}


// ─── Parser de scores ─────────────────────────────────────────────────────────

interface AuditResponse {
  scores_original: Record<string, number>;
  improved_props: unknown;
  scores_improved: Record<string, number>;
  changes: ReelsChange[];
}

function parseScores(raw: Record<string, number>): ReelsScores {
  return {
    hook:          raw.hook          ?? 5,
    pacing:        raw.pacing        ?? 5,
    visualVariety: raw.visualVariety ?? 5,
    textClarity:   raw.textClarity   ?? 5,
    audioFlow:     raw.audioFlow     ?? 5,
    ctaStrength:   raw.ctaStrength   ?? 5,
    overall: parseFloat((
      (raw.hook          ?? 5) * 0.25 +
      (raw.pacing        ?? 5) * 0.20 +
      (raw.visualVariety ?? 5) * 0.15 +
      (raw.textClarity   ?? 5) * 0.15 +
      (raw.audioFlow     ?? 5) * 0.15 +
      (raw.ctaStrength   ?? 5) * 0.10
    ).toFixed(2)),
  };
}

// ─── Llamar a Claude Auditor (una iteración) ─────────────────────────────────

async function callReelsAuditor(
  videoProps: VideoProps,
  iterationContext?: IterationContext,
): Promise<{
  improvedProps: VideoProps;
  originalScores: ReelsScores;
  improvedScores: ReelsScores;
  changes: ReelsChange[];
}> {
  const prompt = iterationContext
    ? buildIterationPrompt(videoProps, iterationContext)
    : buildInitialPrompt(videoProps);

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    const iterLabel = iterationContext ? ` [iter ${iterationContext.iteration}]` : " [iter 1]";
    log("ReelsExpert", `Llamando auditor${iterLabel} (intento ${attempts}/${maxAttempts})...`);

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: "Respondes ÚNICAMENTE con un objeto JSON válido. Sin texto antes, sin texto después, sin markdown, sin bloques de código. Solo el JSON crudo.",
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const parsed = extractAndParseJSON(text) as AuditResponse;

      if (!parsed.improved_props)  throw new Error("Falta 'improved_props'");
      if (!parsed.scores_original) throw new Error("Falta 'scores_original'");
      if (!parsed.scores_improved) throw new Error("Falta 'scores_improved'");

      const improvedProps   = VideoPropsSchema.parse(parsed.improved_props);
      const originalScores  = parseScores(parsed.scores_original);
      const improvedScores  = parseScores(parsed.scores_improved);
      const changes         = Array.isArray(parsed.changes) ? parsed.changes : [];

      return { improvedProps, originalScores, improvedScores, changes };

    } catch (err) {
      log("ReelsExpert", `Intento ${attempts} fallido: ${(err as Error).message}`);
      if (attempts >= maxAttempts) {
        throw new Error(`Auditor Reels falló en ${maxAttempts} intentos: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  throw new Error("Unreachable");
}

// ─── Loggear tabla de scores ──────────────────────────────────────────────────

function logScoreTable(label: string, before: ReelsScores, after: ReelsScores): void {
  const fields: Array<{ key: keyof ReelsScores; label: string }> = [
    { key: "hook",          label: "Hook (25%)" },
    { key: "pacing",        label: "Pacing (20%)" },
    { key: "visualVariety", label: "Variedad visual (15%)" },
    { key: "textClarity",   label: "Claridad texto (15%)" },
    { key: "audioFlow",     label: "Flujo audio (15%)" },
    { key: "ctaStrength",   label: "CTA (10%)" },
    { key: "overall",       label: "OVERALL" },
  ];

  log("ReelsExpert", `─── ${label} ${"─".repeat(Math.max(0, 36 - label.length))}`);
  for (const { key, label: fieldLabel } of fields) {
    const b     = before[key] as number;
    const a     = after[key]  as number;
    const delta = a - b;
    const arrow = delta > 0 ? `↑ +${delta.toFixed(1)}` : delta < 0 ? `↓ ${delta.toFixed(1)}` : "→ igual";
    const flag  = a >= MIN_ACCEPTABLE_SCORE ? "✓" : "✗";
    log("ReelsExpert", `  ${flag} ${fieldLabel.padEnd(22)} ${b.toFixed(1)} → ${a.toFixed(1)}  ${arrow}`);
  }
  log("ReelsExpert", "─".repeat(40));
}

function logChanges(changes: ReelsChange[], iteration: number): void {
  if (changes.length === 0) {
    log("ReelsExpert", `  Iter ${iteration}: sin cambios registrados`);
    return;
  }
  log("ReelsExpert", `  Iter ${iteration}: ${changes.length} cambio(s):`);
  for (const change of changes) {
    const b = change.before.length > 55 ? change.before.slice(0, 55) + "…" : change.before;
    const a = change.after.length  > 55 ? change.after.slice(0, 55)  + "…" : change.after;
    log("ReelsExpert", `    [${change.field}] "${b}" → "${a}"`);
    log("ReelsExpert", `    ↳ ${change.reason}`);
  }
}

// ─── API pública: auditAndImprove ─────────────────────────────────────────────

/**
 * Audita el VideoProps de un post e itera hasta score >= MIN_ACCEPTABLE_SCORE (9)
 * o MAX_AUDIT_ITERATIONS (3), lo que ocurra primero.
 *
 * Archivos generados en content-pipeline/<postId>/:
 *   video-props-original.json  — backup del borrador de content-creator (nunca se sobreescribe)
 *   video-props.json           — versión final mejorada (sobreescribe en cada iteración)
 *   reels-audit-report.json    — scores antes/después, cambios acumulados, nº de iteraciones
 */
export async function auditAndImprove(
  postId: string,
): Promise<{ videoPropsPath: string; report: ReelsAuditReport }> {
  const pipelineDir = getContentPipelineDir(postId);
  const propsPath   = path.join(pipelineDir, "video-props.json");

  if (!fs.existsSync(propsPath)) {
    throw new Error(`video-props.json no encontrado: ${propsPath}`);
  }

  const originalProps = readJson<VideoProps>(propsPath);
  log("ReelsExpert", `=== AUDITOR EXPERTO DE REELS — Post: ${postId} ===`);
  log("ReelsExpert", `Hook original: "${originalProps.hook}"`);
  log("ReelsExpert", `Escenas: ${originalProps.scenes.length} | Score mínimo objetivo: ${MIN_ACCEPTABLE_SCORE}/10`);

  // ── Modo dry-run ──────────────────────────────────────────────────────────
  if (isDryRun) {
    log("ReelsExpert", "[DRY RUN] — simulando sin llamar a Claude ni guardar archivos");
    const mockScores: ReelsScores = { hook: 6, pacing: 6, visualVariety: 5, textClarity: 7, audioFlow: 6, ctaStrength: 5, overall: 6.0 };
    const report: ReelsAuditReport = {
      postId, iterationsRun: 0,
      originalScores: mockScores,
      finalScores: mockScores,
      allChanges: [],
      reachedTarget: false,
      auditedAt: new Date().toISOString(),
      modelUsed: "claude-sonnet-4-6 (dry-run)",
    };
    return { videoPropsPath: propsPath, report };
  }

  // ── Guardar original como backup (solo la primera vez) ───────────────────
  const backupPath = path.join(pipelineDir, "video-props-original.json");
  if (!fs.existsSync(backupPath)) {
    writeJson(backupPath, originalProps);
    log("ReelsExpert", "Backup guardado: video-props-original.json");
  }

  // ── Bucle de auditoría iterativa ─────────────────────────────────────────
  let currentProps              = originalProps;
  let firstIterationScores: ReelsScores | null = null;
  let lastScores: ReelsScores   = { hook: 0, pacing: 0, visualVariety: 0, textClarity: 0, audioFlow: 0, ctaStrength: 0, overall: 0 };
  let allChanges: ReelsChange[] = [];
  let iteration                 = 0;
  let reachedTarget             = false;

  while (iteration < MAX_AUDIT_ITERATIONS) {
    iteration++;
    log("ReelsExpert", `\n--- Iteración ${iteration}/${MAX_AUDIT_ITERATIONS} ---`);

    const iterCtx: IterationContext | undefined = iteration > 1
      ? { iteration, previousScores: lastScores, previousChanges: allChanges }
      : undefined;

    const { improvedProps, originalScores, improvedScores, changes } = await callReelsAuditor(currentProps, iterCtx);

    // Guardar scores de la primera iteración como referencia del "original"
    if (iteration === 1) {
      firstIterationScores = originalScores;
    }

    logScoreTable(`Iteración ${iteration}`, originalScores, improvedScores);
    logChanges(changes, iteration);

    lastScores  = improvedScores;
    allChanges  = [...allChanges, ...changes];
    currentProps = improvedProps;

    // Guardar VideoProps mejorado después de cada iteración
    writeJson(propsPath, improvedProps);
    log("ReelsExpert", `  VideoProps iter ${iteration} guardado (score: ${improvedScores.overall})`);

    if (improvedScores.overall >= MIN_ACCEPTABLE_SCORE) {
      reachedTarget = true;
      log("ReelsExpert", `✓ Score ${improvedScores.overall} ≥ ${MIN_ACCEPTABLE_SCORE} — objetivo alcanzado en ${iteration} iteración(es)`);
      break;
    }

    if (iteration < MAX_AUDIT_ITERATIONS) {
      // Mostrar qué criterios quedan por mejorar
      const belowTarget = Object.entries(improvedScores)
        .filter(([k, v]) => k !== "overall" && (v as number) < MIN_ACCEPTABLE_SCORE)
        .map(([k, v]) => `${k}:${(v as number).toFixed(1)}`);
      log("ReelsExpert", `  Score ${improvedScores.overall} < ${MIN_ACCEPTABLE_SCORE} — re-auditando. Falta mejorar: ${belowTarget.join(", ")}`);
      await new Promise((r) => setTimeout(r, 800)); // pausa antes de siguiente iteración
    } else {
      log("ReelsExpert", `⚠ Máx iteraciones (${MAX_AUDIT_ITERATIONS}) alcanzadas. Score final: ${improvedScores.overall}`);
    }
  }

  // ── Reporte final ─────────────────────────────────────────────────────────
  const report: ReelsAuditReport = {
    postId,
    iterationsRun:  iteration,
    originalScores: firstIterationScores!,
    finalScores:    lastScores,
    allChanges,
    reachedTarget,
    auditedAt:      new Date().toISOString(),
    modelUsed:      "claude-sonnet-4-6",
  };

  writeJson(path.join(pipelineDir, "reels-audit-report.json"), report);

  log("ReelsExpert", `\n=== RESULTADO FINAL ===`);
  log("ReelsExpert", `  Iteraciones:     ${iteration}/${MAX_AUDIT_ITERATIONS}`);
  log("ReelsExpert", `  Score inicial:   ${firstIterationScores!.overall}/10`);
  log("ReelsExpert", `  Score final:     ${lastScores.overall}/10`);
  log("ReelsExpert", `  Objetivo (≥${MIN_ACCEPTABLE_SCORE}): ${reachedTarget ? "✓ ALCANZADO" : "✗ No alcanzado (mejor esfuerzo)"}`);
  log("ReelsExpert", `  Cambios totales: ${allChanges.length}`);
  log("ReelsExpert", "Reporte guardado: reels-audit-report.json");

  return { videoPropsPath: propsPath, report };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/reels-expert.ts --post-id <uuid> [--dry-run]");
    process.exit(1);
  }

  const { videoPropsPath, report } = await auditAndImprove(postIdArg);

  log("ReelsExpert", `✓ VideoProps final: ${videoPropsPath}`);
  if (!report.reachedTarget) {
    log("ReelsExpert", `⚠ Score ${report.finalScores.overall} < ${MIN_ACCEPTABLE_SCORE} — continuar igualmente o revisar manualmente`);
  }
  log("ReelsExpert", `Siguiente paso: npx tsx scripts/render.ts --post-id ${postIdArg}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
