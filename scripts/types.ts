import { z } from "zod";

export const SceneSchema = z.object({
  text: z.string().min(1).describe("Texto en pantalla"),
  voiceover: z.string().min(1).describe("Script para ElevenLabs TTS"),
  durationSec: z.number().min(3).max(15).describe("Duración de la escena en segundos"),
  background: z.enum([
    "#0D0D0D", "#1A1A1A", "#0A0A0A", "#141414",
  ]).default("#0D0D0D").describe("Color de fondo oscuro de la marca (hex). NUNCA gradientes."),
  textStyle: z.enum(["fade", "slideUp", "slideDown", "slideLeft", "slideRight", "scale", "typewriter", "blur"])
    .default("slideUp")
    .describe("Animación de entrada del texto"),
  visualPrompt: z.string().optional().describe("Prompt para Higgsfield si se necesita B-roll"),
});

export const VideoPropsSchema = z.object({
  postId: z.string().uuid().describe("UUID único del post"),
  niche: z.string().describe("ID del nicho"),
  pillarId: z.string().describe("ID del content pillar"),
  format: z.enum(["tiktok", "instagram_reel", "youtube_short"]).default("tiktok"),
  hook: z.string().min(5).max(80).describe("Texto del gancho — primeros 3 segundos"),
  scenes: z.array(SceneSchema).min(3).max(8),
  cta: z.string().min(5).max(100).describe("Call to action final"),
  hashtags: z.array(z.string()).min(3).max(15),
  platforms: z.array(z.enum(["tiktok", "instagram", "youtube", "facebook"])).min(1),
  notionIdeaId: z.string().describe("ID de la página de la idea en Notion"),
  validationScores: z.object({
    hook: z.number().min(0).max(10),
    nicheAlignment: z.number().min(0).max(10),
    argumentThread: z.number().min(0).max(10),
    virality: z.number().min(0).max(10),
    cta: z.number().min(0).max(10),
  }).optional(),
});

export type VideoProps = z.infer<typeof VideoPropsSchema>;
export type Scene = z.infer<typeof SceneSchema>;

export interface NicheConfig {
  nicheId: string;
  name: string;
  language: string;
  platforms: string[];
  publishSchedule: {
    days: string[];
    publishTime: string;
    timezone: string;
  };
  research: {
    reddit: { subreddits: string[]; minUpvotes: number; postsPerSubreddit: number };
    youtube: { searchTerms: string[]; maxResults: number; publishedAfterDays: number };
    trends: { keywords: string[]; geo: string };
  };
  voice: { tone: string; style: string; forbidden: string[] };
  notion: { kbDbId: string; pillarsDbId: string; ideasDbId: string; analyticsDbId: string };
}

export interface ResearchResult {
  source: "reddit" | "youtube" | "trends" | "news";
  title: string;
  summary: string;
  url?: string;
  engagementScore: number;
  suggestedPillar: string;
  rawData?: unknown;
}

export interface PublishResult {
  platform: string;
  postId: string;
  url: string;
  publishedAt: string;
  success: boolean;
  error?: string;
}

export interface MetricsData {
  platform: string;
  postId: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves?: number;
  retentionAvg?: number;
  topComments: string[];
  collectedAt: string;
}

// ─── Brand Guide ──────────────────────────────────────────────────────────────

export interface BrandGuide {
  nicheId: string;
  brandName: string;
  tagline: string;
  handle: string;
  version: string;
  figmaFileUrl: string;
  updatedAt: string;
  palette: {
    backgrounds: Record<string, string>;
    accent: Record<string, string>;
    text: Record<string, string>;
    usageRule: string;
  };
  typography: {
    display: { family: string; googleFontsId: string; weight: number; sizes: Record<string, number> };
    body: { family: string; sizes: Record<string, number> };
    forbidden: string[];
  };
  voice: {
    pillars: Array<{ name: string; icon: string; description: string }>;
    examples: { correct: string[]; forbidden: string[] };
    positioning: string;
  };
  reelsGuide: {
    durationTargetSec: number;
    structure: Array<{ timeRange: string; role: string; description: string }>;
    hookRule: string;
    music: string;
  };
  graphicElements: {
    backgrounds: { rule: string; allowed: string[]; fallback: string };
    symbolsAllowed: string[];
    emojiForbidden: string[];
  };
  imageAesthetic: {
    primaryMood: string;
    lighting: string;
    colorGrade: string;
    preferredSubjects: string[];
    forbiddenElements: string[];
    imageStyleKeywords: string;
    overlayOpacityHook: number;
    overlayOpacityScene: number;
  };
  videoAesthetic: {
    motionStyle: string;
    cameraMovement: string;
    clipDurationSec: string;
    colorGrade: string;
    forbiddenMotion: string[];
  };
}

// ─── Visual Strategy (output of visual-strategist) ────────────────────────────

export type NarrativeRole = "hook" | "tension" | "development" | "revelation" | "resolution" | "cta";
export type MediaType = "image" | "image_sequence" | "video";
export type VisualSource = "pexels" | "pexels_video" | "gemini" | "ai_video";

export interface SceneVisualPlan {
  sceneIndex: number;
  narrativeRole: NarrativeRole;
  mediaType: MediaType;
  count: number;
  suggestedPrompts: string[];
  preferredSource: VisualSource;
  motionNote?: string;
}

export interface VisualStrategy {
  postId: string;
  globalNarrativeSummary: string;
  overallMood: string;
  scenes: SceneVisualPlan[];
  analyzedAt: string;
}

// ─── Visual Evaluation (output of visual-evaluator) ──────────────────────────

export interface SceneEvaluation {
  sceneIndex: number;
  assetPath: string;
  mediaType: "image" | "video";
  scores: {
    sceneRelevance: number;
    brandAlignment: number;
    narrativeContribution: number;
  };
  averageScore: number;
  keep: boolean;
  feedback: string;
  replacementPrompt?: string;
  replacementSource?: VisualSource;
}

export interface VisualEvaluation {
  postId: string;
  evaluations: SceneEvaluation[];
  replacementsNeeded: number;
  evaluatedAt: string;
}
