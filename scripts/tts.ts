/**
 * TTS Helper — genera UN SOLO audio unificado para todo el video.
 *
 * Estrategia de chunking:
 *   - Si el script cabe en un solo request (≤ MAX_CHARS_PER_CHUNK) → 1 call a ElevenLabs
 *   - Si excede el límite → se divide en chunks en fronteras naturales (párrafos / oraciones)
 *     → cada chunk se genera por separado → se concatenan con ffmpeg → 1 solo full-script.mp3
 *
 * Los chunks se dividen en fronteras NATURALES para preservar entonación:
 *   1. Preferencia: en \n\n (entre escenas) — pausa natural ya incluida
 *   2. Fallback: al final de oración (". " o "? " o "! ") si una escena supera el límite
 *
 * Remotion siempre recibe UN solo archivo full-script.mp3 — no sabe cuántos chunks hubo.
 *
 * Límites ElevenLabs:
 *   Free tier  : 10,000 chars/mes  (~20 videos de 60s o ~4 videos de 5min)
 *   Starter    : 30,000 chars/mes  ($5/mo)
 *   Creator    : 100,000 chars/mes ($22/mo)
 *   Por request: ~5,000 chars prácticos (se corta en ElevenLabs si supera)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { log } from "./utils.js";

const execAsync = promisify(exec);
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";

// Rutas absolutas de ffmpeg — evita depender del PATH del sistema
// Si no están en .env, intenta con el comando simple (funciona si está en PATH)
const FFMPEG  = process.env.FFMPEG_PATH  ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "pNInz6obpgDQGcFmaJgB"; // Adam — funciona en español

const PAUSE_BETWEEN_SCENES = 0.6;   // segundos de pausa entre escenas (\n\n en ElevenLabs)
const WORDS_PER_MINUTE     = 130;   // velocidad de habla promedio en español
const MAX_CHARS_PER_CHUNK  = 4_500; // límite seguro por request de ElevenLabs
const DELAY_BETWEEN_CHUNKS = 800;   // ms entre requests consecutivos (rate limit)

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface TTSOptions {
  voiceId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

export interface UnifiedAudioResult {
  audioPath: string;
  totalDurationSec: number;
  sceneDurations: number[];  // segundos por escena (calculados del audio real)
  scriptText: string;        // script completo enviado a ElevenLabs
  chunksUsed: number;        // cuántos chunks se generaron (1 = sin split)
}

// ─── Obtener duración real del MP3 con ffprobe ────────────────────────────────

export async function getAudioDurationSec(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `"${FFPROBE}" -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`
    );
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? 0 : d;
  } catch {
    return 0;
  }
}

// ─── Estimar duración por escena desde conteo de palabras ────────────────────

function estimateSceneDurations(voiceovers: string[], totalAudioSec: number): number[] {
  const wordCounts = voiceovers.map((v) => v.trim().split(/\s+/).length);
  const totalWords  = wordCounts.reduce((s, w) => s + w, 0);
  if (totalWords === 0) return voiceovers.map(() => totalAudioSec / voiceovers.length);

  const totalPauseSec   = PAUSE_BETWEEN_SCENES * (voiceovers.length - 1);
  const speechOnlySec   = Math.max(totalAudioSec - totalPauseSec, totalAudioSec * 0.85);

  return wordCounts.map((words, i) => {
    const speechPart  = (words / totalWords) * speechOnlySec;
    const pausePart   = i < voiceovers.length - 1 ? PAUSE_BETWEEN_SCENES : 0;
    return Math.max(3, speechPart + pausePart);
  });
}

// ─── Dividir script en chunks en fronteras naturales ─────────────────────────

/**
 * Divide el script completo (párrafos separados por \n\n) en chunks que no superen
 * MAX_CHARS_PER_CHUNK. Siempre corta en fronteras de párrafo (\n\n).
 * Si un párrafo solo ya supera el límite, lo subdivide en oraciones.
 */
function splitScriptIntoChunks(script: string, maxChars: number): string[] {
  if (script.length <= maxChars) return [script];

  const paragraphs = script.split(/\n\n/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current.length > 0 ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      // El párrafo actual haría superar el límite — cerrar chunk y abrir uno nuevo
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }

      // Si el párrafo solo es más grande que el límite, subdividir en oraciones
      if (para.length > maxChars) {
        const sentences = para.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [para];
        let sentenceGroup = "";
        for (const sentence of sentences) {
          const sentCandidate = sentenceGroup.length > 0
            ? `${sentenceGroup} ${sentence.trim()}`
            : sentence.trim();

          if (sentCandidate.length <= maxChars) {
            sentenceGroup = sentCandidate;
          } else {
            if (sentenceGroup.length > 0) chunks.push(sentenceGroup.trim());
            sentenceGroup = sentence.trim();
          }
        }
        if (sentenceGroup.length > 0) current = sentenceGroup;
      } else {
        current = para;
      }
    }
  }

  if (current.length > 0) chunks.push(current.trim());

  log("TTS", `Script dividido en ${chunks.length} chunks: ${chunks.map((c) => `${c.length}chars`).join(", ")}`);
  return chunks;
}

// ─── Concatenar audios con ffmpeg (concat demuxer — sin re-encode) ────────────

/**
 * Concatena múltiples MP3 en uno solo usando ffmpeg.
 * Usa el concat demuxer (-f concat) que es más rápido y no re-encodea.
 * Los archivos intermedios se eliminan automáticamente.
 */
async function concatenateAudioFiles(chunkPaths: string[], outputPath: string): Promise<void> {
  if (chunkPaths.length === 1) {
    fs.renameSync(chunkPaths[0], outputPath);
    return;
  }

  // Crear archivo de lista para ffmpeg concat demuxer
  const concatListPath = outputPath.replace(".mp3", "-concat-list.txt");
  const concatContent  = chunkPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  fs.writeFileSync(concatListPath, concatContent, "utf-8");

  log("TTS", `Concatenando ${chunkPaths.length} chunks → ${path.basename(outputPath)}`);

  try {
    // Primer intento: concat sin re-encode (más rápido)
    await execAsync(
      `"${FFMPEG}" -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}" -y`
    );
  } catch {
    // Fallback: re-encode (más lento pero más compatible entre bitrates diferentes)
    log("TTS", "Concat sin re-encode falló — intentando con re-encode");
    const inputs  = chunkPaths.map((p) => `-i "${p}"`).join(" ");
    const filter  = chunkPaths.map((_, i) => `[${i}:a]`).join("") + `concat=n=${chunkPaths.length}:v=0:a=1[outa]`;
    await execAsync(
      `"${FFMPEG}" ${inputs} -filter_complex "${filter}" -map "[outa]" "${outputPath}" -y`
    );
  }

  // Limpiar chunks intermedios y lista
  for (const p of chunkPaths) {
    try { fs.unlinkSync(p); } catch { /* ignorar */ }
  }
  fs.unlinkSync(concatListPath);

  log("TTS", `Concatenación completa: ${path.basename(outputPath)}`);
}

// ─── Llamada a ElevenLabs API ─────────────────────────────────────────────────

async function callElevenLabs(text: string, outputPath: string, options: TTSOptions): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no configurada");

  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;

  const response = await fetch(`${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability:        options.stability        ?? 0.45,
        similarity_boost: options.similarityBoost  ?? 0.80,
        style:            options.style            ?? 0.25,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${error.slice(0, 300)}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
  log("TTS", `  ${path.basename(outputPath)}: ${Math.round(buffer.byteLength / 1024)}KB`);
}

// ─── Generar audio silencioso (fallback sin API key) ─────────────────────────

async function generateSilentAudio(outputPath: string, durationSec: number): Promise<void> {
  try {
    await execAsync(
      `"${FFMPEG}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSec} -q:a 9 -acodec libmp3lame "${outputPath}" -y`
    );
    log("TTS", `Placeholder silencioso: ${path.basename(outputPath)} (${durationSec.toFixed(1)}s)`);
  } catch {
    fs.writeFileSync(outputPath, Buffer.alloc(0));
    log("TTS", "Placeholder vacío creado (ffmpeg no disponible)");
  }
}

// ─── API pública principal ────────────────────────────────────────────────────

/**
 * Genera UN SOLO audio para todo el video.
 *
 * Flujo:
 *   script completo → dividir si > MAX_CHARS_PER_CHUNK → generar chunk(s) → concatenar → full-script.mp3
 *
 * Si ElevenLabs no está configurada, genera un audio silencioso de la duración estimada
 * para que el pipeline pueda seguir sin audio real (útil para testing).
 *
 * @param voiceovers  Array de voiceovers por escena, en orden
 * @param outputDir   Directorio donde guardar full-script.mp3 y archivos intermedios
 * @param options     Configuración de voz opcional
 */
export async function generateUnifiedAudio(
  voiceovers: string[],
  outputDir: string,
  options: TTSOptions = {}
): Promise<UnifiedAudioResult> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const audioPath  = path.join(outputDir, "full-script.mp3");

  // Script completo: voiceovers unidos con \n\n (= pausa natural en ElevenLabs)
  const scriptText = voiceovers.map((v) => v.trim()).join("\n\n");
  const totalWords = scriptText.split(/\s+/).length;

  log("TTS", `Script: ${voiceovers.length} escenas | ${totalWords} palabras | ${scriptText.length} chars`);
  log("TTS", `Preview: "${scriptText.slice(0, 100)}..."`);

  // ── Sin API key: generar silencio y estimar duraciones ──────────────────────
  if (!process.env.ELEVENLABS_API_KEY) {
    const estimatedSec = voiceovers.reduce((sum, v) => {
      return sum + (v.trim().split(/\s+/).length / WORDS_PER_MINUTE) * 60 + PAUSE_BETWEEN_SCENES;
    }, 0);
    await generateSilentAudio(audioPath, estimatedSec);
    return {
      audioPath,
      totalDurationSec: estimatedSec,
      sceneDurations:   estimateSceneDurations(voiceovers, estimatedSec),
      scriptText,
      chunksUsed: 0,
    };
  }

  // ── Con API key: dividir en chunks si es necesario ──────────────────────────
  const chunks     = splitScriptIntoChunks(scriptText, MAX_CHARS_PER_CHUNK);
  const chunkPaths = chunks.map((_, i) => path.join(outputDir, `chunk-${i}.mp3`));

  if (chunks.length === 1) {
    log("TTS", `Un solo chunk (${scriptText.length} chars) — 1 request a ElevenLabs`);
    await callElevenLabs(scriptText, audioPath, options);
  } else {
    log("TTS", `${chunks.length} chunks necesarios — generando en secuencia...`);

    for (let i = 0; i < chunks.length; i++) {
      log("TTS", `Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
      await callElevenLabs(chunks[i], chunkPaths[i], options);

      // Respetar rate limit entre chunks
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_CHUNKS));
      }
    }

    // Concatenar todos los chunks en un solo archivo
    await concatenateAudioFiles(chunkPaths, audioPath);
  }

  // Medir duración real del audio final
  const totalDurationSec = await getAudioDurationSec(audioPath);
  log("TTS", `Duración total: ${totalDurationSec.toFixed(1)}s`);

  // Calcular duración proporcional por escena
  const sceneDurations = estimateSceneDurations(voiceovers, totalDurationSec);
  sceneDurations.forEach((d, i) =>
    log("TTS", `  Escena ${i + 1}: ${d.toFixed(1)}s — "${voiceovers[i].slice(0, 45)}..."`)
  );

  return { audioPath, totalDurationSec, sceneDurations, scriptText, chunksUsed: chunks.length };
}

// ─── Compatibilidad hacia atrás ───────────────────────────────────────────────

/** @deprecated Usar generateUnifiedAudio */
export async function textToSpeech(text: string, outputPath: string, options: TTSOptions = {}): Promise<void> {
  if (!process.env.ELEVENLABS_API_KEY) {
    const sec = Math.ceil(text.split(/\s+/).length / WORDS_PER_MINUTE * 60);
    await generateSilentAudio(outputPath, sec);
    return;
  }
  await callElevenLabs(text, outputPath, options);
}

// ─── CLI de prueba ────────────────────────────────────────────────────────────

if (process.argv[1]?.includes("tts")) {
  const testVoiceovers = [
    "No te falta motivación. Te falta un arquetipo al que seguir.",
    "La mayoría de hombres hoy crecieron sin ver a un hombre de verdad en acción. Y cuando no tienes ese modelo, empiezas a construir tu identidad de los pedazos equivocados.",
    "Buscas en el trabajo, en las relaciones, en el gym. Y ninguno llena el hueco. Porque el hueco no es de logros. Es de identidad.",
    "Pero hay algo que cambia cuando por fin encuentras el arquetipo que resuena contigo. No como imitación. Como reconocimiento.",
    "Empieza el camino de regreso a ti mismo. Y ese camino tiene un nombre.",
  ];
  const outDir = process.argv[2] ?? "test-audio";
  generateUnifiedAudio(testVoiceovers, outDir)
    .then((r) => {
      console.log("\n✓ Audio:", r.audioPath);
      console.log("✓ Total:", r.totalDurationSec.toFixed(1) + "s");
      console.log("✓ Chunks usados:", r.chunksUsed);
      console.log("✓ Por escena:", r.sceneDurations.map((d) => d.toFixed(1) + "s").join(", "));
    })
    .catch(console.error);
}
