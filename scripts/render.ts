/**
 * Render Script — genera el audio unificado y construye la composición Remotion.
 *
 * Arquitectura de audio (corregida):
 *   - UN solo <Audio> en la raíz de la composición (no dentro de cada Sequence)
 *   - El audio corre sin interrupciones de principio a fin
 *   - Las escenas cambian visualmente según las duraciones calculadas del audio real
 *   - durationSec del VideoProps se usa como fallback si no hay audio todavía
 *
 * Uso: npx tsx scripts/render.ts --post-id <uuid>
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { log, readJson, writeJson, getContentPipelineDir } from "./utils.js";
import type { VideoProps } from "./types.js";
import { generateUnifiedAudio, type UnifiedAudioResult } from "./tts.js";
import type { VisualAssetsManifest } from "./fetch-visuals.js";

const execAsync = promisify(exec);
const EDITOR_PATH = process.env.EDITOR_PRO_MAX_PATH ?? "C:\\DevProjects\\editor-pro-max";

interface SceneAsset { path: string; mediaType: "image" | "video" }

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];

// ─── Copiar assets al public/ de editor-pro-max ──────────────────────────────
// Remotion/Chromium bloquea file:/// — los assets deben estar en public/ y
// referenciarse con staticFile() para que el servidor interno los sirva.

function copyAssetsToPublic(
  postId:     string,
  assetsMap:  Map<number, SceneAsset>,
  audioPath:  string,
): string {
  const publicDir  = path.join(EDITOR_PATH, "public", "pipeline", postId.slice(0, 8));
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  // Copiar cada asset de escena
  for (const [index, asset] of assetsMap.entries()) {
    if (!asset.path || !fs.existsSync(asset.path)) continue;
    const ext  = asset.mediaType === "video" ? ".mp4" : ".jpg";
    const dest = path.join(publicDir, `scene-${index}${ext}`);
    fs.copyFileSync(asset.path, dest);
  }

  // Copiar audio
  if (audioPath && fs.existsSync(audioPath)) {
    fs.copyFileSync(audioPath, path.join(publicDir, "full-script.mp3"));
  }

  log("Render", `Assets copiados a public/pipeline/${postId.slice(0, 8)}/`);
  return `pipeline/${postId.slice(0, 8)}`;
}

// ─── Construir composición Remotion con audio unificado ───────────────────────

// Ken Burns cycle for image variety
const KEN_BURNS_CYCLE = ["zoomIn", "panRight", "panLeft", "zoomOut", "panUp", "panDown"];

// Brand colors (El Camino del Guerrero)
const BRAND_BG_PRIMARY = "#0D0D0D";
const BRAND_TEXT       = "#F2EDE4";
const BRAND_ACCENT     = "#E8520A";

function buildRemotionComposition(
  videoProps:   VideoProps,
  audioResult:  UnifiedAudioResult,
  assetsMap:    Map<number, SceneAsset> = new Map(),
  publicPrefix: string = "",
): string {
  const fps           = 30;
  const ENTER_HOOK    = 12;
  const ENTER_NORMAL  = 18;
  const EXIT_FRAMES   = 12;

  const sceneDurations = audioResult.sceneDurations.length === videoProps.scenes.length
    ? audioResult.sceneDurations
    : videoProps.scenes.map((s) => s.durationSec);

  const sceneStartFrames = sceneDurations.reduce<number[]>((acc, _dur, i) => {
    if (i === 0) return [0];
    return [...acc, acc[i - 1] + Math.ceil(sceneDurations[i - 1] * fps)];
  }, []);

  const totalFrames         = Math.ceil(audioResult.totalDurationSec * fps);
  const audioPathNormalized = audioResult.audioPath.replace(/\\/g, "/");
  const hasImages = [...assetsMap.values()].some((a) => a.mediaType === "image");
  const hasVideos = [...assetsMap.values()].some((a) => a.mediaType === "video");

  const scenesCode = videoProps.scenes.map((scene, index) => {
    const startFrame     = sceneStartFrames[index];
    const durationFrames = Math.ceil(sceneDurations[index] * fps);
    const isHook = index === 0;
    const isCTA  = index === videoProps.scenes.length - 1;

    const enterDuration  = isHook ? ENTER_HOOK : ENTER_NORMAL;
    const exitDuration   = EXIT_FRAMES;
    const holdDuration   = Math.max(durationFrames - enterDuration - exitDuration, 1);

    // Brand-accurate typography: Oswald Bold, brand colors
    const fontSize       = isHook ? 78 : 48;
    const fontWeight     = 700;
    const textColor      = `"${BRAND_TEXT}"`;
    const textShadow     = '"0 4px 32px rgba(0,0,0,0.95), 0 0 60px rgba(0,0,0,0.6)"';
    const letterSpacing  = isHook ? -2 : 0;
    const maxWidth       = isHook ? '"88%"' : '"90%"';
    const padding        = isHook ? "60px 44px" : "48px 40px";
    const enterAnimation = isHook ? '"scale"' : `"${scene.textStyle}"`;

    // ── Background layer ──────────────────────────────────────────────────
    const asset = assetsMap.get(index);
    let backgroundLayer: string;

    if (asset?.mediaType === "video") {
      // Brand rule: no gradients — video clip with dark overlay
      const ext            = ".mp4";
      const staticSrc      = `staticFile("${publicPrefix}/scene-${index}${ext}")`;
      const overlayOpacity = isHook ? 0.42 : 0.55;
      backgroundLayer = `
    {/* Video clip */}
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Video src={${staticSrc}} loop style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
    {/* Dark overlay — brand rule */}
    <AbsoluteFill style={{ background: "rgba(0,0,0,${overlayOpacity})" }} />`;

    } else if (asset?.mediaType === "image") {
      // Photo with Ken Burns + dark overlay
      const staticSrc      = `staticFile("${publicPrefix}/scene-${index}.jpg")`;
      const kenBurns       = isHook ? "zoomIn" : KEN_BURNS_CYCLE[index % KEN_BURNS_CYCLE.length];
      const overlayOpacity = isHook ? 0.42 : 0.55;
      backgroundLayer = `
    {/* Photo background with Ken Burns */}
    <FitImage src={${staticSrc}} fit="cover" kenBurns="${kenBurns}" kenBurnsIntensity={0.08} />
    {/* Dark overlay — brand rule */}
    <AbsoluteFill style={{ background: "rgba(0,0,0,${overlayOpacity})" }} />`;

    } else {
      // Brand fallback: solid dark background (NEVER gradients per brand guide)
      const bgColor = isHook ? "#0A0A0A" : BRAND_BG_PRIMARY;
      backgroundLayer = `
    {/* Solid dark background — brand fallback */}
    <AbsoluteFill style={{ background: "${bgColor}" }} />`;
    }

    // Accent line for hook (brand element: 3px naranja #E8520A)
    const accentLine = isHook ? `
    {/* Brand accent line */}
    <AbsoluteFill style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: "60px" }}>
      <div style={{ width: "50px", height: "3px", background: "${BRAND_ACCENT}", borderRadius: "2px" }} />
    </AbsoluteFill>` : "";

    // ParticleField only on hook
    const particleLayer = isHook ? `
    {/* Particle overlay — hook only */}
    <ParticleField count={25} color="rgba(255,255,255,0.18)" direction="up" speed={0.7} />` : "";

    const ctaText  = videoProps.cta.replace(/['"]/g, " ");
    const ctaBlock = isCTA ? `
        <AnimatedTitle
          text="${ctaText}"
          fontSize={24}
          fontWeight={700}
          fontFamily={oswaldFont}
          color="${BRAND_ACCENT}"
          textAlign="center"
          enterAnimation="slideUp"
          exitAnimation="fade"
          enterDuration={${enterDuration}}
          holdDuration={${holdDuration}}
          exitDuration={${exitDuration}}
          lineHeight={1.4}
          maxWidth="85%"
        />` : "";

    const mediaTag = asset ? ` [${asset.mediaType.toUpperCase()}]` : "";
    return `
  {/* ── Escena ${index + 1}${isHook ? " [HOOK ★]" : isCTA ? " [CTA]" : ""}${mediaTag}: ${scene.text.slice(0, 40)} ── */}
  <Sequence from={${startFrame}} durationInFrames={${durationFrames}}>${backgroundLayer}
    ${particleLayer}
    ${accentLine}
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "${padding}",
        gap: "20px",
      }}
    >
      <AnimatedTitle
        text="${scene.text.replace(/['"]/g, " ")}"
        fontSize={${fontSize}}
        fontWeight={${fontWeight}}
        fontFamily={oswaldFont}
        color={${textColor}}
        textAlign="center"
        enterAnimation={${enterAnimation}}
        exitAnimation="fade"
        enterDuration={${enterDuration}}
        holdDuration={${holdDuration}}
        exitDuration={${exitDuration}}
        textShadow={${textShadow}}
        letterSpacing={${letterSpacing}}
        lineHeight={1.1}
        maxWidth={${maxWidth}}
      />${ctaBlock}
    </AbsoluteFill>
  </Sequence>`;
  }).join("\n");

  const generatedAt    = new Date().toISOString();
  const fitImageImport = hasImages
    ? "\nimport { FitImage } from '../../components/media/FitImage';"
    : "";
  const videoImport = hasVideos
    ? "\nimport { Video } from 'remotion';"
    : "";
  const audioSrc = publicPrefix
    ? `{staticFile("${publicPrefix}/full-script.mp3")}`
    : `"${audioPathNormalized}"`;

  return `import React from 'react';
import { AbsoluteFill, Sequence, staticFile, Audio } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Oswald';
import { AnimatedTitle } from '../../components/text/AnimatedTitle';
import { ParticleField } from '../../components/backgrounds/ParticleField';${fitImageImport}${videoImport}

// Brand: El Camino del Guerrero — Sistema. No motivación.
// Auto-generado por ContentAutomation — ${generatedAt}
// Post ID: ${videoProps.postId} | Pillar: ${videoProps.pillarId}
// Audio: ${audioResult.totalDurationSec.toFixed(1)}s | Escenas: ${videoProps.scenes.length}
// Assets: ${assetsMap.size}/${videoProps.scenes.length} escenas con media

const { fontFamily: oswaldFont } = loadFont('normal', { weights: ['700'] });

export const GeneratedVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#0D0D0D" }}>
      <Audio src=${audioSrc} />

${scenesCode}
    </AbsoluteFill>
  );
};

export const generatedVideoConfig = {
  id: "GeneratedVideo",
  component: GeneratedVideo,
  durationInFrames: ${totalFrames},
  fps: ${fps},
  width: 1080,
  height: 1920,
};
`;
}

// ─── Registrar composición en Root.tsx ───────────────────────────────────────

async function registerComposition(postId: string): Promise<void> {
  const rootPath = path.join(EDITOR_PATH, "src", "Root.tsx");
  if (!fs.existsSync(rootPath)) throw new Error(`Root.tsx no encontrado: ${rootPath}`);

  let root = fs.readFileSync(rootPath, "utf-8");
  const importLine      = `import { generatedVideoConfig } from './compositions/generated-${postId.slice(0, 8)}/index';`;
  const compositionLine = `      <Composition {...generatedVideoConfig} />`;

  // Si ya está registrado exactamente este post, no hacer nada
  if (root.includes(importLine) && root.includes(compositionLine)) {
    log("Render", "Composición ya registrada en Root.tsx");
    return;
  }

  // Limpiar TODOS los generated anteriores (import + JSX) para evitar duplicados
  root = root.replace(/^import \{ generatedVideoConfig \} from '\.\/compositions\/generated-[^']+\/index';\n?/gm, "");
  root = root.replace(/^\s*<Composition \{\.\.\.(generatedVideoConfig)\} \/>\n?/gm, "");
  // Limpiar líneas en blanco extra que pudieron quedar
  root = root.replace(/\n{3,}/g, "\n\n");

  // Insertar import antes de "export const RemotionRoot"
  root = root.replace(/^(export const RemotionRoot)/m, `${importLine}\n\n$1`);

  // Insertar <Composition> al inicio del return de RemotionRoot
  root = root.replace(/(\s*)(return\s*\(\s*\n\s*<>)/, `$1$2\n${compositionLine}`);

  fs.writeFileSync(rootPath, root, "utf-8");
  log("Render", `Composición registrada: GeneratedVideo`);
}

// ─── Ejecutar render de Remotion ──────────────────────────────────────────────

async function renderVideo(compositionId: string, outputPath: string): Promise<void> {
  log("Render", `Ejecutando: npx remotion render ${compositionId}`);
  const cmd = `npx remotion render ${compositionId} "${outputPath}" --codec=h264`;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: EDITOR_PATH,
      timeout: 8 * 60 * 1000,
    });
    if (stdout) log("Render", stdout.split("\n").slice(-5).join(" | "));
    if (stderr && !stderr.toLowerCase().includes("warning")) {
      log("Render", `stderr: ${stderr.slice(-200)}`);
    }
  } catch (err) {
    const error = err as { stderr?: string; message: string };
    log("Render", `Error: ${error.message}`);
    if (error.stderr) log("Render", error.stderr.slice(-600));
    throw err;
  }
}

// ─── Extraer thumbnail ────────────────────────────────────────────────────────

async function extractThumbnail(compositionId: string, outputPath: string): Promise<void> {
  try {
    await execAsync(`npx remotion still ${compositionId} "${outputPath}" --frame=30`, {
      cwd: EDITOR_PATH,
      timeout: 60_000,
    });
    log("Render", `Thumbnail: ${path.basename(outputPath)}`);
  } catch (err) {
    log("Render", `Advertencia: no se pudo extraer thumbnail — ${(err as Error).message}`);
  }
}

// ─── Main exportado ────────────────────────────────────────────────────────────

export async function renderPost(postId: string): Promise<{ videoPath: string; thumbnailPath: string }> {
  const pipelineDir = getContentPipelineDir(postId);
  const propsPath = path.join(pipelineDir, "video-props.json");

  if (!fs.existsSync(propsPath)) throw new Error(`VideoProps no encontrado: ${propsPath}`);

  const videoProps = readJson<VideoProps>(propsPath);
  const audioDir = path.join(pipelineDir, "audio");
  const unifiedAudioPath = path.join(audioDir, "full-script.mp3");

  // ─── Paso 1: Generar audio unificado ─────────────────────────────────────────
  let audioResult: UnifiedAudioResult;

  if (fs.existsSync(unifiedAudioPath)) {
    log("Render", "Audio unificado ya existe — reutilizando");
    // Leer metadata guardada del audio si existe
    const audioMetaPath = path.join(audioDir, "audio-meta.json");
    if (fs.existsSync(audioMetaPath)) {
      audioResult = readJson<UnifiedAudioResult>(audioMetaPath);
      // Verificar que el path apunte al archivo correcto
      audioResult.audioPath = unifiedAudioPath;
    } else {
      // Recalcular desde el archivo existente
      // Estimar duración desde durationSec del VideoProps como fallback
      const total = videoProps.scenes.reduce((s, sc) => s + sc.durationSec, 0);
      audioResult = {
        audioPath: unifiedAudioPath,
        totalDurationSec: total,
        sceneDurations: videoProps.scenes.map((s) => s.durationSec),
        scriptText: videoProps.scenes.map((s) => s.voiceover).join("\n\n"),
        chunksUsed: 1,
      };
    }
  } else {
    log("Render", `Generando audio unificado para ${videoProps.scenes.length} escenas...`);
    const voiceovers = videoProps.scenes.map((s) => s.voiceover);
    audioResult = await generateUnifiedAudio(voiceovers, audioDir);

    // Guardar metadata del audio para reutilizar
    writeJson(path.join(audioDir, "audio-meta.json"), audioResult);
    log("Render", `Audio listo: ${audioResult.totalDurationSec.toFixed(1)}s total`);
  }

  // ─── Paso 2: Leer assets manifest (si existe) ────────────────────────────────
  const assetsMap = new Map<number, SceneAsset>();
  const manifestPath = path.join(pipelineDir, "assets-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson<VisualAssetsManifest>(manifestPath);
    for (const asset of manifest.assets) {
      if (asset.source !== "none" && asset.assetPath) {
        assetsMap.set(asset.sceneIndex, {
          path:      asset.assetPath,
          mediaType: asset.mediaType ?? "image",
        });
      }
    }
    const videos = [...assetsMap.values()].filter((a) => a.mediaType === "video").length;
    log("Render", `Assets cargados: ${assetsMap.size} (${videos} videos · ${assetsMap.size - videos} imágenes) para ${videoProps.scenes.length} escenas`);
  } else {
    log("Render", "Sin assets-manifest.json — todas las escenas usarán fondo oscuro #0D0D0D");
  }

  // ─── Paso 3: Copiar assets al public/ de editor-pro-max ─────────────────────
  const publicPrefix = copyAssetsToPublic(postId, assetsMap, audioResult.audioPath);

  // ─── Paso 4: Generar composición TypeScript ───────────────────────────────────
  const compositionDir = path.join(EDITOR_PATH, "src", "compositions", `generated-${postId.slice(0, 8)}`);
  if (!fs.existsSync(compositionDir)) fs.mkdirSync(compositionDir, { recursive: true });

  const compositionCode = buildRemotionComposition(videoProps, audioResult, assetsMap, publicPrefix);
  const compositionPath = path.join(compositionDir, "index.tsx");
  fs.writeFileSync(compositionPath, compositionCode, "utf-8");
  log("Render", `Composición escrita: src/compositions/generated-${postId.slice(0, 8)}/index.tsx`);

  // ─── Paso 5: Registrar en Root.tsx ────────────────────────────────────────────
  await registerComposition(postId);

  // ─── Paso 6: Renderizar con Remotion ─────────────────────────────────────────
  const videoPath = path.join(pipelineDir, "raw-video.mp4");
  const thumbnailPath = path.join(pipelineDir, "thumbnail.png");

  await renderVideo("GeneratedVideo", videoPath);
  await extractThumbnail("GeneratedVideo", thumbnailPath);

  writeJson(path.join(pipelineDir, "render-metadata.json"), {
    postId,
    videoPath,
    thumbnailPath,
    audioPath: audioResult.audioPath,
    totalDurationSec: audioResult.totalDurationSec,
    sceneDurations: audioResult.sceneDurations,
    renderedAt: new Date().toISOString(),
  });

  return { videoPath, thumbnailPath };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/render.ts --post-id <uuid>");
    process.exit(1);
  }
  log("Render", `Renderizando post: ${postIdArg}`);
  const { videoPath, thumbnailPath } = await renderPost(postIdArg);
  log("Render", `✓ Video: ${videoPath}`);
  log("Render", `✓ Thumbnail: ${thumbnailPath}`);
  log("Render", `Siguiente: npx tsx scripts/validate-vision.ts --post-id ${postIdArg}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
