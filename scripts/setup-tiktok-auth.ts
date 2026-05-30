/**
 * Setup TikTok OAuth2 — corre UNA SOLA VEZ para obtener el access_token.
 *
 * Flujo:
 *   1. Script genera URL de autorización → abrís en el browser
 *   2. TikTok te redirige a tu GitHub Pages → la página muestra el código
 *   3. Copiás el código y lo pegás aquí
 *   4. Script intercambia el código por tokens
 *
 * Prerequisito — página estática en GitHub Pages:
 *   Creá un repo con un index.html que muestre los query params:
 *   https://gist.github.com/ (o cualquier static host con HTTPS)
 *   Ver instrucciones en el README del proyecto.
 *
 * Uso: npx tsx scripts/setup-tiktok-auth.ts
 *
 * Requiere en .env:
 *   TIKTOK_CLIENT_KEY=...
 *   TIKTOK_CLIENT_SECRET=...
 *   TIKTOK_REDIRECT_URI=https://TU-USUARIO.github.io/REPO/
 */

import "dotenv/config";
import crypto from "crypto";
import readline from "readline";

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI  = process.env.TIKTOK_REDIRECT_URI?.trim();

if (!CLIENT_KEY || !CLIENT_SECRET) {
  console.error("❌ Falta TIKTOK_CLIENT_KEY o TIKTOK_CLIENT_SECRET en .env");
  process.exit(1);
}
if (!REDIRECT_URI || REDIRECT_URI.includes("XXXX")) {
  console.error("❌ Configurá TIKTOK_REDIRECT_URI en .env con tu URL de GitHub Pages");
  console.error("   Ejemplo: TIKTOK_REDIRECT_URI=https://mi-usuario.github.io/tiktok-auth/");
  process.exit(1);
}

// PKCE
const codeVerifier  = crypto.randomBytes(64).toString("base64url");
const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
const state         = crypto.randomBytes(16).toString("hex");

const authUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
authUrl.searchParams.set("client_key",            CLIENT_KEY);
authUrl.searchParams.set("response_type",         "code");
authUrl.searchParams.set("scope",                 "video.publish,video.upload");
authUrl.searchParams.set("redirect_uri",          REDIRECT_URI);
authUrl.searchParams.set("state",                 state);
authUrl.searchParams.set("code_challenge",        codeChallenge);
authUrl.searchParams.set("code_challenge_method", "S256");

console.log("\n════════════════════════════════════════");
console.log("  SETUP TIKTOK OAUTH2");
console.log("════════════════════════════════════════");
console.log(`\nRedirect URI: ${REDIRECT_URI}`);
console.log("\nPASO 1 — Abre este URL en tu navegador:\n");
console.log("  " + authUrl.toString());
console.log("\nPASO 2 — Iniciá sesión con tu cuenta de TikTok y aprobá los permisos");
console.log("PASO 3 — La página te muestra el código de autorización");
console.log("PASO 4 — Copiá ese código y pegalo abajo\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Pegá el código de autorización aquí: ", async (code) => {
  rl.close();
  code = code.trim();

  if (!code) {
    console.error("❌ No ingresaste ningún código");
    process.exit(1);
  }

  console.log("\nIntercambiando código por tokens...");

  try {
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key:    CLIENT_KEY!,
        client_secret: CLIENT_SECRET!,
        code,
        grant_type:    "authorization_code",
        redirect_uri:  REDIRECT_URI!,
        code_verifier: codeVerifier,
      }).toString(),
    });

    const data = (await tokenRes.json()) as {
      access_token?:      string;
      refresh_token?:     string;
      open_id?:           string;
      expires_in?:        number;
      error?:             string;
      error_description?: string;
    };

    if (data.error || !data.access_token) {
      throw new Error(data.error_description ?? data.error ?? "Sin access_token en la respuesta");
    }

    const expiresAt = new Date(Date.now() + (data.expires_in ?? 86400) * 1000).toISOString();

    console.log("\n════════════════════════════════════════");
    console.log("  ✓ TOKENS TIKTOK OBTENIDOS");
    console.log("════════════════════════════════════════");
    console.log("\nAgregá estas líneas a tu .env:\n");
    console.log(`TIKTOK_ACCESS_TOKEN=${data.access_token}`);
    if (data.refresh_token) console.log(`TIKTOK_REFRESH_TOKEN=${data.refresh_token}`);
    if (data.open_id)       console.log(`TIKTOK_OPEN_ID=${data.open_id}`);
    console.log(`\n# Token expira: ${expiresAt}`);
    console.log("# ⚠️  El access_token dura 24h. Para renovar: npx tsx scripts/refresh-tiktok-token.ts");
    console.log("\n════════════════════════════════════════\n");

  } catch (err) {
    console.error("\n❌ Error:", (err as Error).message);
    process.exit(1);
  }
});
