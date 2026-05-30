import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { NicheConfig, BrandGuide } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function loadNicheConfig(nicheId: string): NicheConfig {
  const configPath = path.join(ROOT, "niches", nicheId, "config.json");
  if (!fs.existsSync(configPath)) throw new Error(`Niche config not found: ${configPath}`);
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as NicheConfig;
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function getContentPipelineDir(postId: string): string {
  const dir = path.join(ROOT, "content-pipeline", postId);
  ensureDir(dir);
  return dir;
}

export function getApprovalQueueDir(postId: string): string {
  const dir = path.join(ROOT, "approval-queue", postId);
  ensureDir(dir);
  return dir;
}

export function getPublishedDir(): string {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(ROOT, "published", today);
  ensureDir(dir);
  return dir;
}

export function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function log(agent: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${agent}] ${message}`);
}

export function getRootDir(): string {
  return ROOT;
}

export function loadBrandGuide(nicheId: string): BrandGuide | null {
  const guidePath = path.join(ROOT, "niches", nicheId, "brand-guide.json");
  if (!fs.existsSync(guidePath)) return null;
  return JSON.parse(fs.readFileSync(guidePath, "utf-8")) as BrandGuide;
}

// ─── Shared JSON extractor ───────────────────────────────────────────────────
// Claude sometimes generates unescaped quotes or literal newlines inside JSON
// strings. This state-machine extractor handles those cases safely.

export function sanitizeJSONString(text: string): string {
  return text.replace(/[\n\r\t]/g, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return ch;
  });
}

export function extractAndParseJSON(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in response");

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) throw new Error("JSON incompleto — el objeto no se cerró correctamente");

  const raw = text.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(sanitizeJSONString(raw));
  }
}
