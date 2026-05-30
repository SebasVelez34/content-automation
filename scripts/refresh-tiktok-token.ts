/**
 * Refresca el access_token de TikTok usando el refresh_token.
 * El access_token dura 24h — correr este script antes de publicar si ya expiró.
 *
 * Uso: npx tsx scripts/refresh-tiktok-token.ts
 */

import "dotenv/config";
import fs from "fs";

const CLIENT_KEY     = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET  = process.env.TIKTOK_CLIENT_SECRET;
const REFRESH_TOKEN  = process.env.TIKTOK_REFRESH_TOKEN;

if (!CLIENT_KEY || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("❌ Falta TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET o TIKTOK_REFRESH_TOKEN en .env");
  process.exit(1);
}

async function refreshToken(): Promise<void> {
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key:    CLIENT_KEY!,
      client_secret: CLIENT_SECRET!,
      grant_type:    "refresh_token",
      refresh_token: REFRESH_TOKEN!,
    }).toString(),
  });

  const data = (await res.json()) as {
    access_token?:  string;
    refresh_token?: string;
    expires_in?:    number;
    error?:         string;
    error_description?: string;
  };

  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);
  if (!data.access_token) throw new Error("No se recibió access_token");

  const expiresAt = new Date(Date.now() + (data.expires_in ?? 86400) * 1000).toISOString();

  console.log("\n✓ Token refrescado exitosamente");
  console.log("\nActualizá en .env:\n");
  console.log(`TIKTOK_ACCESS_TOKEN=${data.access_token}`);
  if (data.refresh_token) console.log(`TIKTOK_REFRESH_TOKEN=${data.refresh_token}`);
  console.log(`# Expira: ${expiresAt}\n`);
}

refreshToken().catch((err) => { console.error("❌", err.message); process.exit(1); });
