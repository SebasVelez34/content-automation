/**
 * Fetch Visuals — descarga o genera imágenes/videos de fondo para cada escena.
 * Respeta la VisualStrategy (si existe) para usar prompts mejorados y decidir
 * el tipo de media. Enriquece los prompts de Gemini con el brand guide.
 *
 * Orden de intentos por escena:
 *   image/image_sequence → Pexels foto → Gemini Imagen → fondo oscuro (#0D0D0D)
 *   video                → Pexels Video → Pexels foto → fondo oscuro (#0D0D0D)
 *
 * Salida:
 *   content-pipeline/<postId>/assets/scene-N.jpg        — imagen
 *   content-pipeline/<postId>/assets/scene-N-clip.mp4   — video clip
 *   content-pipeline/<postId>/assets-manifest.json
 *
 * Uso: npx tsx scripts/fetch-visuals.ts --post-id <uuid>
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { log, readJson, writeJson, getContentPipelineDir, loadBrandGuide } from "./utils.js";
import type { VideoProps, BrandGuide, VisualStrategy } from "./types.js";

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface VisualAsset {
  sceneIndex: number;
  assetPath:  string;
  mediaType:  "image" | "video";
  source:     "pexels" | "pexels_video" | "gemini" | "none";
  prompt:     string;
  pexelsUrl?: string;
}

export interface VisualAssetsManifest {
  postId:      string;
  assets:      VisualAsset[];
  generatedAt: string;
}

export function kenBurnsForScene(sceneIndex: number, isHook: boolean): string {
  const CYCLE = ["zoomIn", "panRight", "panLeft", "zoomOut", "panUp", "panDown"] as const;
  return isHook ? "zoomIn" : CYCLE[sceneIndex % CYCLE.length];
}

// ─── Pexels: stock photo ──────────────────────────────────────────────────────

interface PexelsPhoto {
  src: { portrait: string; large2x: string };
  photographer: string;
}

async function fetchPhotoFromPexels(prompt: string, pick: number): Promise<string | null> {
  if (!PEXELS_API_KEY) { log("FetchVisuals", "  PEXELS_API_KEY no configurada"); return null; }
  const query = prompt.replace(/[.,!?]/g, "").split(" ").slice(0, 6).join(" ");
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`,
      { headers: { Authorization: PEXELS_API_KEY } }
    );
    if (!res.ok) { log("FetchVisuals", `  Pexels foto ${res.status}`); return null; }
    const data = await res.json() as { photos: PexelsPhoto[]; total_results: number };
    if (!data.photos?.length) { log("FetchVisuals", `  Pexels: sin resultados para "${query}"`); return null; }
    const photo = data.photos[pick % data.photos.length];
    log("FetchVisuals", `  Pexels ✓ "${query}" — foto de ${photo.photographer}`);
    return photo.src.portrait ?? photo.src.large2x;
  } catch (err) { log("FetchVisuals", `  Pexels error: ${(err as Error).message}`); return null; }
}

// ─── Pexels: video clip ───────────────────────────────────────────────────────

interface PexelsVideoFile {
  quality:   string;
  file_type: string;
  width:     number;
  height:    number;
  link:      string;
}
interface PexelsVideo { video_files: PexelsVideoFile[] }

async function fetchVideoFromPexels(prompt: string, pick: number): Promise<string | null> {
  if (!PEXELS_API_KEY) { log("FetchVisuals", "  PEXELS_API_KEY no configurada"); return null; }
  const query = prompt.replace(/[.,!?]/g, "").split(" ").slice(0, 6).join(" ");
  try {
    const res = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`,
      { headers: { Authorization: PEXELS_API_KEY } }
    );
    if (!res.ok) { log("FetchVisuals", `  Pexels video ${res.status}`); return null; }
    const data = await res.json() as { videos: PexelsVideo[] };
    if (!data.videos?.length) { log("FetchVisuals", `  Pexels video: sin resultados para "${query}"`); return null; }
    const video = data.videos[pick % data.videos.length];
    const portrait = video.video_files.filter((f) => f.height > f.width);
    const file     = portrait.find((f) => f.quality === "sd") ?? portrait.find((f) => f.quality === "hd") ?? portrait[0];
    if (!file) { log("FetchVisuals", "  Pexels video: sin archivo portrait disponible"); return null; }
    log("FetchVisuals", `  Pexels Video ✓ "${query}" — ${file.quality} ${file.width}x${file.height}`);
    return file.link;
  } catch (err) { log("FetchVisuals", `  Pexels video error: ${(err as Error).message}`); return null; }
}

// ─── Gemini Imagen: generar imagen ───────────────────────────────────────────

async function generateWithGemini(prompt: string, brand: BrandGuide | null, outputPath: string): Promise<boolean> {
  if (!GEMINI_API_KEY) { log("FetchVisuals", "  GEMINI_API_KEY no configurada"); return false; }
  try {
    const genaiModule = await import("@google/genai").catch(() => null);
    if (!genaiModule) { log("FetchVisuals", "  @google/genai no instalado"); return false; }
    const { GoogleGenAI } = genaiModule;
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const brandContext = brand
      ? `${brand.imageAesthetic.lighting}, ${brand.imageAesthetic.colorGrade}, ${brand.imageAesthetic.primaryMood}.`
      : "dark dramatic masculine cinematic.";

    const enriched = `Cinematic vertical photo (9:16 ratio) for social media Reel. ${prompt}. ${brandContext} Photorealistic, professional photography. No text, no watermarks, no faces.`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (ai as any).models.generateImages({
      model:  "imagen-3.0-generate-002",
      prompt: enriched,
      config: { numberOfImages: 1, aspectRatio: "9:16", personGeneration: "dont_allow" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageBytes = (response as any)?.generatedImages?.[0]?.image?.imageBytes as string | undefined;
    if (!imageBytes) { log("FetchVisuals", "  Gemini: sin imageBytes"); return false; }
    fs.writeFileSync(outputPath, Buffer.from(imageBytes, "base64"));
    log("FetchVisuals", `  Gemini ✓ → ${path.basename(outputPath)}`);
    return true;
  } catch (err) { log("FetchVisuals", `  Gemini error: ${(err as Error).message}`); return false; }
}

// ─── Descargar desde URL ──────────────────────────────────────────────────────

async function downloadUrl(url: string, outputPath: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    fs.writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch { return false; }
}

// ─── API pública exportada ────────────────────────────────────────────────────

export async function fetchVisualsForPost(postId: string): Promise<VisualAssetsManifest> {
  const pipelineDir  = getContentPipelineDir(postId);
  const propsPath    = path.join(pipelineDir, "video-props.json");
  const assetsDir    = path.join(pipelineDir, "assets");
  const manifestPath = path.join(pipelineDir, "assets-manifest.json");
  const stratPath    = path.join(pipelineDir, "visual-strategy.json");

  if (!fs.existsSync(propsPath)) throw new Error(`video-props.json no encontrado: ${propsPath}`);
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  const videoProps = readJson<VideoProps>(propsPath);
  const brand      = loadBrandGuide(videoProps.niche);
  const strategy   = fs.existsSync(stratPath) ? readJson<VisualStrategy>(stratPath) : null;

  log("FetchVisuals", `=== FETCH VISUALS — Post: ${postId} ===`);
  if (strategy) log("FetchVisuals", `Usando VisualStrategy: ${strategy.overallMood}`);
  if (brand)    log("FetchVisuals", `Brand guide: ${brand.brandName}`);

  const assets: VisualAsset[] = [];

  for (let i = 0; i < videoProps.scenes.length; i++) {
    const scene      = videoProps.scenes[i];
    const stratScene = strategy?.scenes.find((s) => s.sceneIndex === i);

    // Determine prompt: strategy > videoProps.visualPrompt > fallback
    const prompt = stratScene?.suggestedPrompts?.[0]
      ?? scene.visualPrompt
      ?? `dark dramatic ${brand?.imageAesthetic.primaryMood ?? "masculine cinematic"} scene`;

    const mediaType  = stratScene?.mediaType ?? "image";
    const isVideo    = mediaType === "video";
    const ext        = isVideo ? "-clip.mp4" : ".jpg";
    const assetPath  = path.join(assetsDir, `scene-${i}${ext}`);

    log("FetchVisuals", `\nEscena ${i + 1} [${stratScene?.narrativeRole ?? "scene"}] ${isVideo ? "🎬" : "🖼"}: "${prompt.slice(0, 65)}"`);

    // Reutilizar si ya existe
    if (fs.existsSync(assetPath)) {
      log("FetchVisuals", "  Reutilizando asset existente");
      assets.push({ sceneIndex: i, assetPath, mediaType: isVideo ? "video" : "image", source: "pexels", prompt });
      continue;
    }

    // Also check the alternate format (video might have been saved as image before)
    const altPath = isVideo
      ? path.join(assetsDir, `scene-${i}.jpg`)
      : path.join(assetsDir, `scene-${i}-clip.mp4`);
    if (fs.existsSync(altPath)) {
      log("FetchVisuals", "  Reutilizando asset existente (formato alternativo)");
      assets.push({ sceneIndex: i, assetPath: altPath, mediaType: fs.existsSync(altPath) && altPath.endsWith(".mp4") ? "video" : "image", source: "pexels", prompt });
      continue;
    }

    // ── Video: Pexels Video ────────────────────────────────────────────────
    if (isVideo) {
      log("FetchVisuals", "  Intentando Pexels Video...");
      const videoUrl = await fetchVideoFromPexels(prompt, i);
      if (videoUrl) {
        const ok = await downloadUrl(videoUrl, assetPath);
        if (ok) {
          assets.push({ sceneIndex: i, assetPath, mediaType: "video", source: "pexels_video", prompt, pexelsUrl: videoUrl });
          log("FetchVisuals", `  ✓ scene-${i}-clip.mp4 (Pexels Video)`);
          continue;
        }
      }
      // Fallback video → image
      log("FetchVisuals", "  Pexels Video no disponible — usando imagen estática como fallback");
    }

    // ── Imagen: Pexels Photo ───────────────────────────────────────────────
    const imgPath = path.join(assetsDir, `scene-${i}.jpg`);
    const pexelsUrl = await fetchPhotoFromPexels(prompt, i);
    if (pexelsUrl) {
      const ok = await downloadUrl(pexelsUrl, imgPath);
      if (ok) {
        assets.push({ sceneIndex: i, assetPath: imgPath, mediaType: "image", source: "pexels", prompt, pexelsUrl });
        log("FetchVisuals", `  ✓ scene-${i}.jpg (Pexels)`);
        continue;
      }
    }

    // ── Gemini Imagen ──────────────────────────────────────────────────────
    log("FetchVisuals", "  Pexels falló — intentando Gemini Imagen...");
    const geminiOk = await generateWithGemini(prompt, brand, imgPath);
    if (geminiOk) {
      assets.push({ sceneIndex: i, assetPath: imgPath, mediaType: "image", source: "gemini", prompt });
      log("FetchVisuals", `  ✓ scene-${i}.jpg (Gemini)`);
      continue;
    }

    // ── Sin asset ──────────────────────────────────────────────────────────
    log("FetchVisuals", `  ✗ Sin imagen — usará fondo oscuro #0D0D0D`);
    assets.push({ sceneIndex: i, assetPath: "", mediaType: "image", source: "none", prompt });
  }

  const manifest: VisualAssetsManifest = { postId, assets, generatedAt: new Date().toISOString() };
  writeJson(manifestPath, manifest);

  const withAssets = assets.filter((a) => a.source !== "none").length;
  const videos     = assets.filter((a) => a.mediaType === "video").length;
  log("FetchVisuals", `\n✓ ${withAssets}/${assets.length} escenas con asset (${videos} videos · ${withAssets - videos} imágenes)`);

  return manifest;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!postIdArg) { console.error("Uso: npx tsx scripts/fetch-visuals.ts --post-id <uuid>"); process.exit(1); }
  const manifest   = await fetchVisualsForPost(postIdArg);
  const withAssets = manifest.assets.filter((a) => a.source !== "none").length;
  log("FetchVisuals", `✓ ${withAssets} assets listos`);
  log("FetchVisuals", `Siguiente: npx tsx scripts/visual-evaluator.ts --post-id ${postIdArg}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
