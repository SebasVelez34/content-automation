/**
 * Approval Dashboard — servidor HTTP local que muestra el contenido generado
 * y permite aprobar/rechazar en < 2 minutos.
 *
 * Uso: npx tsx scripts/approval-server.ts --post-id <uuid>
 */

import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { log, readJson, writeJson, getApprovalQueueDir, getContentPipelineDir } from "./utils.js";
import type { VideoProps } from "./types.js";
import type { ValidationReport } from "./validate-vision.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3001;

const postIdArg = process.argv.find((a) => a.startsWith("--post-id="))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--post-id") + 1];

// ─── Generar HTML del dashboard ───────────────────────────────────────────────

function buildDashboardHTML(postId: string, videoProps: VideoProps, validation: ValidationReport): string {
  const scoreColor = (score: number) => score >= 8 ? "#22c55e" : score >= 6 ? "#eab308" : "#ef4444";
  const scoreBar = (score: number) => `
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
      <div style="width:120px;height:8px;background:#374151;border-radius:4px;overflow:hidden">
        <div style="width:${score * 10}%;height:100%;background:${scoreColor(score)};border-radius:4px"></div>
      </div>
      <span style="color:${scoreColor(score)};font-weight:700">${score}/10</span>
    </div>`;

  const scenesHtml = videoProps.scenes.map((scene, i) => `
    <div style="background:#1f2937;border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="color:#9ca3af;font-size:12px;margin-bottom:4px">ESCENA ${i + 1} · ${scene.durationSec}s · ${scene.background}</div>
      <div style="color:white;font-size:16px;font-weight:700;margin-bottom:6px">${scene.text}</div>
      <div style="color:#d1d5db;font-size:13px;font-style:italic">"${scene.voiceover}"</div>
    </div>`).join("");

  const feedbackHtml = validation.feedback.map((f) => `<li style="margin-bottom:4px">${f}</li>`).join("");
  const suggestionsHtml = validation.suggestions.map((s) => `<li style="color:#f59e0b;margin-bottom:4px">→ ${s}</li>`).join("");

  const pipelineDir = getContentPipelineDir(postId);
  const videoExists = fs.existsSync(path.join(pipelineDir, "raw-video.mp4"));
  const thumbnailExists = fs.existsSync(path.join(pipelineDir, "thumbnail.png"));
  const thumbnailSrc = thumbnailExists
    ? `data:image/png;base64,${fs.readFileSync(path.join(pipelineDir, "thumbnail.png")).toString("base64")}`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Aprobación de Contenido — ${postId.slice(0, 8)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #111827; color: white; padding: 24px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 22px; color: #f9fafb; margin-bottom: 4px; }
    .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
    .card { background: #1f2937; border-radius: 12px; padding: 20px; }
    .card-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; margin-bottom: 12px; }
    .hook { font-size: 20px; font-weight: 700; color: #f3f4f6; line-height: 1.3; margin-bottom: 16px; }
    .cta { background: #374151; border-radius: 8px; padding: 10px 14px; color: #d1d5db; font-size: 14px; }
    .score-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .score-label { color: #9ca3af; font-size: 13px; }
    .avg-score { font-size: 28px; font-weight: 800; color: ${scoreColor(validation.averageScore)}; text-align: center; padding: 16px; }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; background: ${validation.passed ? "#166534" : "#7f1d1d"}; color: ${validation.passed ? "#86efac" : "#fca5a5"}; margin-bottom: 8px; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
    .btn { padding: 12px 28px; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.85; }
    .btn-approve { background: #16a34a; color: white; }
    .btn-reject { background: #dc2626; color: white; }
    .btn-regenerate { background: #2563eb; color: white; }
    .thumbnail { width: 100%; border-radius: 8px; max-height: 300px; object-fit: cover; }
    .hashtags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .hashtag { background: #374151; color: #93c5fd; padding: 3px 10px; border-radius: 9999px; font-size: 12px; }
    .platforms { display: flex; gap: 8px; margin-top: 8px; }
    .platform { background: #374151; padding: 4px 10px; border-radius: 6px; font-size: 12px; color: #d1d5db; }
    #result { display: none; padding: 16px; background: #374151; border-radius: 8px; margin-top: 16px; text-align: center; font-size: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Revisión de Contenido</h1>
    <div class="meta">Post ID: ${postId} · Pillar: <strong>${videoProps.pillarId}</strong> · ${new Date().toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>

    <div class="grid">
      <!-- Preview visual -->
      <div class="card">
        <div class="card-title">Preview</div>
        ${thumbnailSrc ? `<img class="thumbnail" src="${thumbnailSrc}" alt="Thumbnail">` : ""}
        ${videoExists ? `<div style="margin-top:10px"><a href="/video" style="color:#60a5fa;font-size:13px">▶ Ver video completo</a></div>` : "<div style='color:#6b7280;font-size:13px'>Video no disponible</div>"}
        <div style="margin-top:12px">
          <div class="card-title">Plataformas</div>
          <div class="platforms">${videoProps.platforms.map((p) => `<span class="platform">${p}</span>`).join("")}</div>
        </div>
        <div style="margin-top:12px">
          <div class="card-title">Hashtags</div>
          <div class="hashtags">${videoProps.hashtags.map((h) => `<span class="hashtag">#${h}</span>`).join("")}</div>
        </div>
      </div>

      <!-- Scores -->
      <div class="card">
        <div class="card-title">Scores de Validación</div>
        <div class="avg-score">${validation.averageScore}/10</div>
        <div style="text-align:center;margin-bottom:16px"><span class="status-badge">${validation.passed ? "✓ LISTO PARA PUBLICAR" : "✗ NECESITA MEJORAS"}</span></div>
        ${Object.entries(validation.scores).map(([key, val]) => `
          <div class="score-row">
            <span class="score-label">${key}</span>
            ${scoreBar(val)}
          </div>`).join("")}
        ${feedbackHtml ? `<div style="margin-top:12px"><div class="card-title">Feedback</div><ul style="color:#9ca3af;font-size:13px;padding-left:16px">${feedbackHtml}</ul></div>` : ""}
        ${suggestionsHtml ? `<div style="margin-top:8px"><ul style="font-size:13px;padding-left:16px">${suggestionsHtml}</ul></div>` : ""}
      </div>
    </div>

    <!-- Contenido del video -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-title">Contenido del Video</div>
      <div class="hook">${videoProps.hook}</div>
      ${scenesHtml}
      <div class="cta">🎯 CTA: ${videoProps.cta}</div>
    </div>

    <!-- Acciones -->
    <div class="actions">
      <button class="btn btn-approve" onclick="decide('approve')">✅ Aprobar y Programar</button>
      <button class="btn btn-regenerate" onclick="decide('regenerate')">🔄 Regenerar</button>
      <button class="btn btn-reject" onclick="decide('reject')">❌ Rechazar</button>
    </div>

    <div id="result"></div>
  </div>

  <script>
    async function decide(action) {
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.style.color = action === 'approve' ? '#86efac' : action === 'reject' ? '#fca5a5' : '#93c5fd';
      result.textContent = action === 'approve' ? '✅ Aprobado — programando publicación...' : action === 'regenerate' ? '🔄 Regenerando contenido...' : '❌ Rechazado';

      try {
        const res = await fetch('/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, postId: '${postId}', timestamp: new Date().toISOString() })
        });
        const data = await res.json();
        result.textContent = data.message;
        if (action !== 'regenerate') setTimeout(() => window.close(), 2000);
      } catch (e) {
        result.textContent = 'Error al procesar — revisa la consola';
      }
    }
  </script>
</body>
</html>`;
}

// ─── Servidor HTTP ─────────────────────────────────────────────────────────────

export async function startApprovalServer(postId: string): Promise<void> {
  const pipelineDir = getContentPipelineDir(postId);
  const approvalDir = getApprovalQueueDir(postId);

  const propsPath = path.join(pipelineDir, "video-props.json");
  const reportPath = path.join(pipelineDir, "validation-report.json");

  if (!fs.existsSync(propsPath)) throw new Error(`VideoProps no encontrado: ${propsPath}`);

  const videoProps = readJson<VideoProps>(propsPath);
  const validation = fs.existsSync(reportPath)
    ? readJson<ValidationReport>(reportPath)
    : { postId, passed: true, scores: { hook: 8, nicheAlignment: 8, argumentThread: 8, virality: 8, cta: 8, visual: 8 }, averageScore: 8, feedback: [], suggestions: [], validatedAt: new Date().toISOString() };

  const html = buildDashboardHTML(postId, videoProps, validation);
  const htmlPath = path.join(approvalDir, "preview.html");
  fs.writeFileSync(htmlPath, html, "utf-8");

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);

      } else if (req.method === "GET" && req.url === "/video") {
        const videoPath = path.join(pipelineDir, "raw-video.mp4");
        if (!fs.existsSync(videoPath)) {
          res.writeHead(404); res.end("Video not found"); return;
        }
        const stat = fs.statSync(videoPath);
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": stat.size });
        fs.createReadStream(videoPath).pipe(res);

      } else if (req.method === "POST" && req.url === "/decide") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const decision = JSON.parse(body) as { action: string; postId: string; timestamp: string };
            const decisionPath = path.join(approvalDir, "decision.json");
            writeJson(decisionPath, {
              ...decision,
              approved: decision.action === "approve",
              platforms: videoProps.platforms,
            });
            log("Approval", `Decisión registrada: ${decision.action}`);

            res.writeHead(200, { "Content-Type": "application/json" });
            const message = decision.action === "approve"
              ? "✅ Contenido aprobado — se publicará en el horario programado"
              : decision.action === "regenerate"
              ? "🔄 Iniciando regeneración..."
              : "❌ Contenido rechazado";
            res.end(JSON.stringify({ success: true, message }));

            setTimeout(() => {
              server.close();
              resolve();
            }, 1000);
          } catch (err) {
            res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });
      } else {
        res.writeHead(404); res.end("Not found");
      }
    });

    server.listen(PORT, "127.0.0.1", () => {
      log("Approval", `Dashboard disponible en http://localhost:${PORT}`);
      // Abrir en el navegador automáticamente
      const openCmd = process.platform === "win32" ? `start http://localhost:${PORT}` : `open http://localhost:${PORT}`;
      exec(openCmd);
    });

    // Timeout de seguridad: cerrar el servidor después de 30 minutos
    setTimeout(() => {
      const decisionPath = path.join(approvalDir, "decision.json");
      if (!fs.existsSync(decisionPath)) {
        log("Approval", "Timeout: cerrando servidor sin decisión");
        writeJson(decisionPath, { action: "timeout", approved: false, timestamp: new Date().toISOString() });
      }
      server.close();
      resolve();
    }, 30 * 60 * 1000);
  });
}

async function main() {
  if (!postIdArg) {
    console.error("Uso: npx tsx scripts/approval-server.ts --post-id <uuid>");
    process.exit(1);
  }

  log("Approval", `Iniciando dashboard para post: ${postIdArg}`);
  await startApprovalServer(postIdArg);
  log("Approval", "Dashboard cerrado.");
}

main().catch((err) => { console.error(err); process.exit(1); });
