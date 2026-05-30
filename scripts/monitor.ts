/**
 * Monitor Agent — recolecta métricas 48h post-publicación y las guarda en Notion.
 *
 * Uso: npx tsx scripts/monitor.ts --post-id <uuid> [--platform youtube]
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { log, readJson, writeJson, getContentPipelineDir, getPublishedDir } from "./utils.js";
import type { MetricsData, PublishResult } from "./types.js";

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];
const platformArg = process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1]
  ?? (process.argv.includes("--platform") ? process.argv[process.argv.indexOf("--platform") + 1] : null);

// ─── YouTube Analytics ────────────────────────────────────────────────────────

async function getYouTubeMetrics(videoId: string): Promise<Partial<MetricsData>> {
  try {
    const { google } = await import("googleapis");
    const oauth2Client = new google.auth.OAuth2(
      process.env.YOUTUBE_CLIENT_ID,
      process.env.YOUTUBE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

    const youtubeAnalytics = google.youtubeAnalytics({ version: "v2", auth: oauth2Client });
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await youtubeAnalytics.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "views,likes,comments,shares,averageViewDuration",
      filters: `video==${videoId}`,
    });

    const row = res.data.rows?.[0] ?? [];
    return {
      views: Number(row[0]) || 0,
      likes: Number(row[1]) || 0,
      comments: Number(row[2]) || 0,
      shares: Number(row[3]) || 0,
      retentionAvg: Number(row[4]) || 0,
      topComments: [],
    };
  } catch (err) {
    log("Monitor", `YouTube Analytics error: ${(err as Error).message}`);
    return {};
  }
}

// ─── Meta Insights ────────────────────────────────────────────────────────────

async function getMetaMetrics(postId: string, platform: string): Promise<Partial<MetricsData>> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return {};

  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${postId}/insights?metric=reach,impressions,saved,video_views,comments,likes,shares&access_token=${token}`
    );

    const data = (await res.json()) as { data?: Array<{ name: string; values: Array<{ value: number }> }> };
    if (!data.data) return {};

    const metrics: Partial<MetricsData> = {};
    for (const item of data.data) {
      const val = item.values?.[0]?.value ?? 0;
      if (item.name === "reach") metrics.views = val;
      if (item.name === "saved") metrics.saves = val;
      if (item.name === "likes") metrics.likes = val;
      if (item.name === "comments") metrics.comments = val;
      if (item.name === "shares") metrics.shares = val;
    }

    return metrics;
  } catch (err) {
    log("Monitor", `Meta Insights error: ${(err as Error).message}`);
    return {};
  }
}

// ─── Guardar métricas en Notion ───────────────────────────────────────────────

async function saveMetricsToNotion(metrics: MetricsData, analyticsDbId: string): Promise<string | null> {
  if (!analyticsDbId || !process.env.NOTION_TOKEN) return null;

  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: analyticsDbId },
        properties: {
          Post: { title: [{ text: { content: `${metrics.platform} — ${metrics.postId.slice(0, 12)}` } }] },
          Platform: { select: { name: metrics.platform } },
          PublishDate: { date: { start: metrics.collectedAt.slice(0, 10) } },
          Views: { number: metrics.views },
          Engagement: { number: metrics.views > 0 ? Math.round(((metrics.likes + metrics.comments + (metrics.shares ?? 0)) / metrics.views) * 100) / 100 : 0 },
          RetentionAvg: { number: metrics.retentionAvg ?? 0 },
          TopComment: { rich_text: [{ text: { content: metrics.topComments[0] ?? "" } }] },
          IsViralRef: { checkbox: false },
        },
      }),
    });

    const data = (await res.json()) as { id?: string };
    if (data.id) {
      log("Monitor", `Métricas guardadas en Notion: ${metrics.platform}`);
      return data.id;
    }
  } catch (err) {
    log("Monitor", `Notion save error: ${(err as Error).message}`);
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function monitorPost(postId: string, platformFilter?: string | null): Promise<void> {
  const publishedDir = getPublishedDir();
  const publishedPath = path.join(publishedDir, `post-${postId.slice(0, 8)}.json`);

  if (!fs.existsSync(publishedPath)) {
    log("Monitor", `No se encontraron datos de publicación para: ${postId}`);
    return;
  }

  const published = readJson<{ results: PublishResult[] }>(publishedPath);
  const results = platformFilter
    ? published.results.filter((r) => r.platform === platformFilter)
    : published.results.filter((r) => r.success);

  const allMetrics: MetricsData[] = [];

  for (const result of results) {
    log("Monitor", `Recolectando métricas de ${result.platform} (post: ${result.postId.slice(0, 12)})...`);

    let partialMetrics: Partial<MetricsData> = {};

    switch (result.platform) {
      case "youtube":
        partialMetrics = await getYouTubeMetrics(result.postId);
        break;
      case "instagram":
      case "facebook":
        partialMetrics = await getMetaMetrics(result.postId, result.platform);
        break;
      case "tiktok":
        log("Monitor", "TikTok Analytics API requiere app review — saltando por ahora");
        break;
    }

    const metrics: MetricsData = {
      platform: result.platform,
      postId: result.postId,
      views: partialMetrics.views ?? 0,
      likes: partialMetrics.likes ?? 0,
      comments: partialMetrics.comments ?? 0,
      shares: partialMetrics.shares ?? 0,
      saves: partialMetrics.saves,
      retentionAvg: partialMetrics.retentionAvg,
      topComments: partialMetrics.topComments ?? [],
      collectedAt: new Date().toISOString(),
    };

    allMetrics.push(metrics);
    log("Monitor", `${result.platform}: ${metrics.views} views, ${metrics.likes} likes, ${metrics.comments} comentarios`);
  }

  // Guardar métricas localmente
  const metricsPath = path.join(getPublishedDir(), `metrics-${postId.slice(0, 8)}.json`);
  writeJson(metricsPath, { postId, metrics: allMetrics, collectedAt: new Date().toISOString() });
  log("Monitor", `Métricas guardadas: ${metricsPath}`);

  // Guardar en Notion si está configurado
  for (const metrics of allMetrics) {
    const nicheConfig = JSON.parse(
      fs.readFileSync(`C:\\ContentAutomation\\niches\\masculinity\\config.json`, "utf-8")
    ) as { notion: { analyticsDbId: string } };
    await saveMetricsToNotion(metrics, nicheConfig.notion.analyticsDbId);
  }
}

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/monitor.ts --post-id <uuid> [--platform youtube]");
    process.exit(1);
  }

  await monitorPost(postIdArg, platformArg);
  log("Monitor", "Completado.");
}

main().catch((err) => { console.error(err); process.exit(1); });
