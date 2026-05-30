/**
 * Setup YouTube OAuth2 — corre UNA SOLA VEZ para obtener el refresh_token.
 *
 * Uso: npx tsx scripts/setup-youtube-auth.ts
 *
 * Requiere en .env:
 *   YOUTUBE_CLIENT_ID=...
 *   YOUTUBE_CLIENT_SECRET=...
 */

import "dotenv/config";
import http from "http";
import { google } from "googleapis";

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI  = "http://localhost:3456/oauth2callback";
const PORT          = 3456;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Falta YOUTUBE_CLIENT_ID o YOUTUBE_CLIENT_SECRET en .env");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt:      "consent",           // Fuerza que Google devuelva el refresh_token
  scope: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
  ],
});

console.log("\n════════════════════════════════════════");
console.log("  SETUP YOUTUBE OAUTH2");
console.log("════════════════════════════════════════");
console.log("\n1. Abre este URL en tu navegador:\n");
console.log("   " + authUrl);
console.log("\n2. Inicia sesión con la cuenta de YouTube del canal");
console.log("3. Aprobá los permisos");
console.log("4. Google te redirige a localhost — este script captura el código automáticamente\n");

// Servidor temporal para recibir el callback OAuth
const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth2callback")) return;

  const urlParams = new URL(req.url, `http://localhost:${PORT}`);
  const code      = urlParams.searchParams.get("code");
  const error     = urlParams.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h2>❌ Error: ${error}</h2><p>Cerrá esta pestaña y volvé a correr el script.</p>`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>❌ No se recibió código de autorización</h2>");
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html><body style="font-family:monospace;padding:40px;background:#0d0d0d;color:#f2ede4">
        <h2 style="color:#e8520a">✓ Autorización exitosa</h2>
        <p>Cerrá esta pestaña y mirá la terminal.</p>
      </body></html>
    `);

    server.close();

    console.log("\n════════════════════════════════════════");
    console.log("  ✓ TOKENS OBTENIDOS");
    console.log("════════════════════════════════════════");
    console.log("\nAgregá estas líneas a tu .env:\n");
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
    if (tokens.access_token) {
      console.log(`# (access token temporal, el refresh_token es lo que importa)`);
    }
    console.log("\n════════════════════════════════════════\n");

  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h2>❌ Error al obtener tokens: ${(err as Error).message}</h2>`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Servidor OAuth escuchando en http://localhost:${PORT}`);
  console.log("Esperando callback de Google...\n");
});
