/**
 * Research Agent — busca ideas de contenido en Reddit, YouTube y Google Trends
 * y las guarda en Notion Ideas Pool DB.
 *
 * Uso: npx tsx scripts/research.ts --niche masculinity [--dry-run]
 */

import "dotenv/config";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { loadNicheConfig, log, writeJson, getPublishedDir } from "./utils.js";
import type { ResearchResult } from "./types.js";

const isDryRun = process.argv.includes("--dry-run");
const _nicheIdx = process.argv.indexOf("--niche");
const nicheArg = process.argv.find((a) => a.startsWith("--niche="))?.split("=")[1]
  ?? (_nicheIdx !== -1 ? process.argv[_nicheIdx + 1] : undefined)
  ?? "masculinity";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── YouTube Search ──────────────────────────────────────────────────────────

async function searchYouTube(terms: string[], maxResults: number, daysAgo: number): Promise<ResearchResult[]> {
  if (!process.env.YOUTUBE_API_KEY && !process.env.YOUTUBE_CLIENT_ID) {
    log("Research", "YOUTUBE_API_KEY no configurada — saltando YouTube");
    return [];
  }

  const youtube = google.youtube({ version: "v3", auth: process.env.YOUTUBE_API_KEY });
  const publishedAfter = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const results: ResearchResult[] = [];

  for (const term of terms.slice(0, 3)) {
    try {
      const res = await youtube.search.list({
        part: ["snippet"],
        q: term,
        type: ["video"],
        order: "viewCount",
        publishedAfter,
        maxResults,
        relevanceLanguage: "es",
      });

      for (const item of res.data.items ?? []) {
        const title = item.snippet?.title ?? "";
        const desc = item.snippet?.description ?? "";
        results.push({
          source: "youtube",
          title,
          summary: desc.slice(0, 200),
          url: `https://youtube.com/watch?v=${item.id?.videoId}`,
          engagementScore: 7,
          suggestedPillar: "filosofia",
        });
      }
    } catch (err) {
      log("Research", `YouTube error para "${term}": ${(err as Error).message}`);
    }
  }

  return results;
}

// ─── Reddit via Pushshift/Reddit API ─────────────────────────────────────────

async function searchReddit(subreddits: string[], minUpvotes: number, postsPerSub: number): Promise<ResearchResult[]> {
  const results: ResearchResult[] = [];

  for (const sub of subreddits.slice(0, 4)) {
    try {
      const url = `https://www.reddit.com/r/${sub}/top.json?t=week&limit=${postsPerSub}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "ContentAutomation/1.0 (educational project)" },
      });

      if (!res.ok) continue;
      const data = (await res.json()) as {
        data: { children: Array<{ data: { title: string; selftext: string; score: number; url: string; permalink: string } }> };
      };

      for (const post of data.data.children) {
        if (post.data.score < minUpvotes) continue;
        results.push({
          source: "reddit",
          title: post.data.title,
          summary: post.data.selftext.slice(0, 300),
          url: `https://reddit.com${post.data.permalink}`,
          engagementScore: Math.min(10, Math.floor(post.data.score / 500)),
          suggestedPillar: "sin-rumbo",
        });
      }
    } catch (err) {
      log("Research", `Reddit error para r/${sub}: ${(err as Error).message}`);
    }
  }

  return results;
}

// ─── Google Trends via WebSearch fallback ────────────────────────────────────

async function searchTrends(keywords: string[]): Promise<ResearchResult[]> {
  // Google Trends no tiene API oficial estable; usamos búsqueda web como fallback
  const results: ResearchResult[] = [];
  const query = keywords.slice(0, 3).join(", ");

  try {
    const trendUrl = `https://trends.google.com/trends/explore?q=${encodeURIComponent(query)}&geo=CO`;
    results.push({
      source: "trends",
      title: `Google Trends: ${query}`,
      summary: `Revisar tendencias en: ${trendUrl}`,
      url: trendUrl,
      engagementScore: 6,
      suggestedPillar: "arquetipos",
    });
  } catch {
    // silent
  }

  return results;
}

// ─── Claude: categoriza y prioriza ideas ─────────────────────────────────────

async function categorizeIdeas(
  rawResults: ResearchResult[],
  nicheConfig: ReturnType<typeof loadNicheConfig>
): Promise<ResearchResult[]> {
  if (rawResults.length === 0) return [];

  const pillars = [
    "arquetipos", "filosofia", "sin-rumbo", "psicologia",
    "relaciones", "frases", "consciencia", "venta", "producto",
  ];

  const prompt = `Eres un experto en contenido para el nicho: "${nicheConfig.name}".
Avatar: hombre de 25-45 años que siente que le falta dirección, propósito o identidad masculina.
Tono de la marca: ${nicheConfig.voice.tone}.

Analiza estos ${rawResults.length} hallazgos de investigación y para cada uno:
1. Asigna el pillar más adecuado de: ${pillars.join(", ")}
2. Da un score de potencial de contenido (1-10) basado en: emoción, relevancia al avatar, viralidad
3. Escribe un resumen del ángulo de contenido en español (máx 100 chars)

Responde SOLO con JSON array con este formato exacto:
[{"index": 0, "pillar": "...", "score": 8, "angle": "..."}]

Hallazgos:
${rawResults.map((r, i) => `${i}. [${r.source}] ${r.title}`).join("\n")}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return rawResults;

    const categorized = JSON.parse(jsonMatch[0]) as Array<{
      index: number; pillar: string; score: number; angle: string;
    }>;

    return rawResults.map((r, i) => {
      const cat = categorized.find((c) => c.index === i);
      if (!cat) return r;
      return { ...r, suggestedPillar: cat.pillar, engagementScore: cat.score, summary: cat.angle };
    }).sort((a, b) => b.engagementScore - a.engagementScore);
  } catch (err) {
    log("Research", `Claude categorization error: ${(err as Error).message}`);
    return rawResults;
  }
}

// ─── Notion: guardar ideas ────────────────────────────────────────────────────

async function saveToNotion(ideas: ResearchResult[], nicheConfig: ReturnType<typeof loadNicheConfig>): Promise<void> {
  const ideasDbId = nicheConfig.notion.ideasDbId;
  if (!ideasDbId || !process.env.NOTION_TOKEN) {
    log("Research", "Notion no configurado — ideas guardadas solo localmente");
    return;
  }

  for (const idea of ideas.slice(0, 10)) {
    try {
      const body = {
        parent: { database_id: ideasDbId },
        properties: {
          Idea: { title: [{ text: { content: idea.title.slice(0, 200) } }] },
          Source: { select: { name: idea.source } },
          Status: { select: { name: "pending" } },
          Score: { number: idea.engagementScore },
          ResearchDate: { date: { start: new Date().toISOString().slice(0, 10) } },
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: idea.summary } }] },
          },
          ...(idea.url ? [{
            object: "block" as const,
            type: "bookmark" as const,
            bookmark: { url: idea.url },
          }] : []),
        ],
      };

      const res = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        log("Research", `Notion error: ${err.slice(0, 100)}`);
      } else {
        log("Research", `Idea guardada en Notion: "${idea.title.slice(0, 50)}"`);
      }
    } catch (err) {
      log("Research", `Error saving to Notion: ${(err as Error).message}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("Research", `Iniciando para nicho: ${nicheArg}${isDryRun ? " [DRY RUN]" : ""}`);

  const config = loadNicheConfig(nicheArg);
  const allResults: ResearchResult[] = [];

  // Correr búsquedas en paralelo
  const [redditResults, youtubeResults, trendsResults] = await Promise.all([
    searchReddit(config.research.reddit.subreddits, config.research.reddit.minUpvotes, config.research.reddit.postsPerSubreddit),
    searchYouTube(config.research.youtube.searchTerms, config.research.youtube.maxResults, config.research.youtube.publishedAfterDays),
    searchTrends(config.research.trends.keywords),
  ]);

  allResults.push(...redditResults, ...youtubeResults, ...trendsResults);
  log("Research", `Hallazgos crudos: ${allResults.length} (Reddit: ${redditResults.length}, YouTube: ${youtubeResults.length}, Trends: ${trendsResults.length})`);

  if (allResults.length === 0) {
    log("Research", "No se encontraron resultados. Revisa la conexión a internet y las API keys.");
    process.exit(0);
  }

  // Categorizar con Claude
  const categorized = await categorizeIdeas(allResults, config);
  log("Research", `Ideas categorizadas: ${categorized.length}`);

  // Guardar localmente siempre
  const today = new Date().toISOString().slice(0, 10);
  const outPath = `${process.env.CONTENT_PIPELINE_DIR ?? "C:\\ContentAutomation\\content-pipeline"}\\${today}-research.json`;
  writeJson(outPath, { generatedAt: new Date().toISOString(), niche: nicheArg, ideas: categorized });
  log("Research", `Ideas guardadas en: ${outPath}`);

  // Guardar en Notion si está configurado
  if (!isDryRun) {
    await saveToNotion(categorized, config);
  } else {
    log("Research", `[DRY RUN] Se guardarían ${categorized.length} ideas en Notion`);
  }

  log("Research", "Completado.");
}

main().catch((err) => { console.error(err); process.exit(1); });
