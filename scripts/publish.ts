/**
 * Publisher — orquesta la publicación en todas las plataformas configuradas.
 * Lee decision.json del approval-queue y publica si approved: true.
 *
 * Uso: npx tsx scripts/publish.ts --post-id <uuid> [--platform youtube] [--private]
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { log, readJson, writeJson, getApprovalQueueDir, getContentPipelineDir, getPublishedDir } from "./utils.js";
import type { VideoProps, PublishResult } from "./types.js";

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];
const platformArg = process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1]
  ?? (process.argv.includes("--platform") ? process.argv[process.argv.indexOf("--platform") + 1] : null);
const isPrivate = process.argv.includes("--private");

// ─── YouTube Publisher ────────────────────────────────────────────────────────

async function publishToYouTube(videoPath: string, videoProps: VideoProps, isPrivate: boolean): Promise<PublishResult> {
  const { google } = await import("googleapis");

  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  try {
    const description = `${videoProps.scenes.map((s) => s.voiceover).join("\n\n")}\n\n${videoProps.hashtags.map((h) => `#${h}`).join(" ")}`;

    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: videoProps.hook.slice(0, 100),
          description: description.slice(0, 5000),
          tags: videoProps.hashtags,
          categoryId: "26", // Howto & Style
          defaultLanguage: "es",
        },
        status: {
          privacyStatus: isPrivate ? "private" : "public",
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(videoPath),
      },
    });

    const videoId = res.data.id ?? "";
    log("Publisher", `YouTube: publicado ${isPrivate ? "(privado)" : ""} — https://youtube.com/shorts/${videoId}`);

    return {
      platform: "youtube",
      postId: videoId,
      url: `https://youtube.com/shorts/${videoId}`,
      publishedAt: new Date().toISOString(),
      success: true,
    };
  } catch (err) {
    const error = (err as Error).message;
    log("Publisher", `YouTube error: ${error}`);
    return { platform: "youtube", postId: "", url: "", publishedAt: new Date().toISOString(), success: false, error };
  }
}

// ─── Instagram/Facebook Publisher (Meta Graph API) ────────────────────────────

async function publishToMeta(videoPath: string, videoProps: VideoProps, platform: "instagram" | "facebook"): Promise<PublishResult> {
  const token = process.env.META_ACCESS_TOKEN;
  const igUserId = process.env.META_IG_USER_ID;
  const fbPageId = process.env.META_FB_PAGE_ID;

  if (!token) {
    return { platform, postId: "", url: "", publishedAt: new Date().toISOString(), success: false, error: "META_ACCESS_TOKEN no configurado" };
  }

  const caption = `${videoProps.hook}\n\n${videoProps.scenes.map((s) => s.text).join("\n")}\n\n${videoProps.cta}\n\n${videoProps.hashtags.map((h) => `#${h}`).join(" ")}`;

  try {
    if (platform === "instagram" && igUserId) {
      // Paso 1: Crear container de Reel (requiere URL pública del video — usar upload o URL temporal)
      // Nota: Meta Graph API requiere que el video esté en una URL pública accesible
      // En producción se debe subir el video a un CDN o usar la Graph API upload
      const containerRes = await fetch(
        `https://graph.facebook.com/v19.0/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_type: "REELS",
            video_url: "PLACEHOLDER_CDN_URL", // TODO: implementar upload a CDN
            caption: caption.slice(0, 2200),
            access_token: token,
          }),
        }
      );

      const containerData = (await containerRes.json()) as { id?: string; error?: { message: string } };
      if (!containerData.id) throw new Error(containerData.error?.message ?? "Container creation failed");

      // Paso 2: Publicar el container
      await new Promise((r) => setTimeout(r, 3000));
      const publishRes = await fetch(
        `https://graph.facebook.com/v19.0/${igUserId}/media_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ creation_id: containerData.id, access_token: token }),
        }
      );

      const publishData = (await publishRes.json()) as { id?: string; error?: { message: string } };
      if (!publishData.id) throw new Error(publishData.error?.message ?? "Publish failed");

      const postUrl = `https://instagram.com/reel/${publishData.id}`;
      log("Publisher", `Instagram: publicado — ${postUrl}`);
      return { platform: "instagram", postId: publishData.id, url: postUrl, publishedAt: new Date().toISOString(), success: true };
    }

    if (platform === "facebook" && fbPageId) {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${fbPageId}/videos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_url: "PLACEHOLDER_CDN_URL", // TODO: implementar upload a CDN
            description: caption.slice(0, 5000),
            access_token: token,
          }),
        }
      );
      const data = (await res.json()) as { id?: string; error?: { message: string } };
      if (!data.id) throw new Error(data.error?.message ?? "Facebook upload failed");

      const postUrl = `https://facebook.com/${data.id}`;
      log("Publisher", `Facebook: publicado — ${postUrl}`);
      return { platform: "facebook", postId: data.id, url: postUrl, publishedAt: new Date().toISOString(), success: true };
    }

    return { platform, postId: "", url: "", publishedAt: new Date().toISOString(), success: false, error: "IDs no configurados" };
  } catch (err) {
    const error = (err as Error).message;
    log("Publisher", `Meta (${platform}) error: ${error}`);
    return { platform, postId: "", url: "", publishedAt: new Date().toISOString(), success: false, error };
  }
}

// ─── TikTok Publisher ─────────────────────────────────────────────────────────

async function publishToTikTok(videoPath: string, videoProps: VideoProps): Promise<PublishResult> {
  const token  = process.env.TIKTOK_ACCESS_TOKEN;
  const openId = process.env.TIKTOK_OPEN_ID;
  if (!token) {
    return { platform: "tiktok", postId: "", url: "", publishedAt: new Date().toISOString(), success: false, error: "TIKTOK_ACCESS_TOKEN no configurado — corré setup-tiktok-auth.ts" };
  }

  // TikTok Content Posting API v2
  const caption = `${videoProps.hook} ${videoProps.hashtags.map((h) => `#${h}`).join(" ")}`.slice(0, 150);

  try {
    // Paso 1: Inicializar upload
    const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          title: caption,
          privacy_level: "SELF_ONLY", // Cambiar a PUBLIC_TO_EVERYONE en producción
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fs.statSync(videoPath).size,
          chunk_size: fs.statSync(videoPath).size,
          total_chunk_count: 1,
        },
      }),
    });

    const initData = (await initRes.json()) as {
      data?: { publish_id: string; upload_url: string };
      error?: { code: string; message: string };
    };

    if (!initData.data) {
      log("Publisher", `TikTok respuesta completa: ${JSON.stringify(initData)}`);
      throw new Error(initData.error?.message ?? "TikTok init failed");
    }

    // Paso 2: Upload del video
    const videoBuffer = fs.readFileSync(videoPath);
    await fetch(initData.data.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
      },
      body: videoBuffer,
    });

    log("Publisher", `TikTok: video subido, publish_id: ${initData.data.publish_id}`);
    return {
      platform: "tiktok",
      postId: initData.data.publish_id,
      url: "https://tiktok.com/@me",
      publishedAt: new Date().toISOString(),
      success: true,
    };
  } catch (err) {
    const error = (err as Error).message;
    log("Publisher", `TikTok error: ${error}`);
    return { platform: "tiktok", postId: "", url: "", publishedAt: new Date().toISOString(), success: false, error };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function publishPost(postId: string, platformFilter?: string | null, forcePrivate = false): Promise<PublishResult[]> {
  const pipelineDir = getContentPipelineDir(postId);
  const approvalDir = getApprovalQueueDir(postId);

  const decisionPath = path.join(approvalDir, "decision.json");
  if (!fs.existsSync(decisionPath)) throw new Error(`decision.json no encontrado — el post debe ser aprobado primero`);

  const decision = readJson<{ approved: boolean; platforms?: string[] }>(decisionPath);
  if (!decision.approved) {
    log("Publisher", `Post ${postId} no aprobado — saltando publicación`);
    return [];
  }

  const propsPath = path.join(pipelineDir, "video-props.json");
  const videoProps = readJson<VideoProps>(propsPath);
  const videoPath = path.join(pipelineDir, "raw-video.mp4");

  if (!fs.existsSync(videoPath)) throw new Error(`Video no encontrado: ${videoPath}`);

  const platforms = platformFilter ? [platformFilter] : (decision.platforms ?? videoProps.platforms);
  log("Publisher", `Publicando en: ${platforms.join(", ")}`);

  const results: PublishResult[] = [];

  for (const platform of platforms) {
    switch (platform) {
      case "youtube":
        results.push(await publishToYouTube(videoPath, videoProps, forcePrivate || isPrivate));
        break;
      case "instagram":
        results.push(await publishToMeta(videoPath, videoProps, "instagram"));
        break;
      case "facebook":
        results.push(await publishToMeta(videoPath, videoProps, "facebook"));
        break;
      case "tiktok":
        results.push(await publishToTikTok(videoPath, videoProps));
        break;
      default:
        log("Publisher", `Plataforma desconocida: ${platform}`);
    }

    // Pausa entre plataformas para evitar rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Guardar resultados
  const publishedDir = getPublishedDir();
  const publishedPath = path.join(publishedDir, `post-${postId.slice(0, 8)}.json`);
  writeJson(publishedPath, { postId, results, publishedAt: new Date().toISOString() });

  const successes = results.filter((r) => r.success).length;
  log("Publisher", `Publicado: ${successes}/${results.length} plataformas exitosas`);

  return results;
}

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/publish.ts --post-id <uuid> [--platform youtube] [--private]");
    process.exit(1);
  }

  const results = await publishPost(postIdArg, platformArg, isPrivate);
  results.forEach((r) => {
    log("Publisher", `${r.platform}: ${r.success ? `✓ ${r.url}` : `✗ ${r.error}`}`);
  });

  log("Publisher", `Siguiente paso (48h): npx tsx scripts/monitor.ts --post-id ${postIdArg}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
