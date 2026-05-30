# Guía de Setup — Content Automation System

## 1. Copiar variables de entorno

```bash
copy .env.example .env
```

Editar `.env` con tus API keys según los pasos a continuación.

---

## 2. Notion — Cerebro del Sistema (PRIMERO)

### 2.1 Crear la Integration

1. Ir a https://www.notion.so/my-integrations
2. Clic en **"+ New integration"**
3. Nombre: `ContentAutomation`
4. Capabilities: Read content + Update content + Insert content
5. Copiar el **Internal Integration Secret** → pegar en `.env` como `NOTION_TOKEN`

### 2.2 Crear las 4 Databases en Notion

Crea una página raíz en Notion llamada `ContentAutomation` y dentro crea estas 4 bases de datos:

#### Knowledge Base DB
| Campo | Tipo |
|-------|------|
| Topic | Title |
| Category | Select (avatar, pain-point, archetype, vocabulary, principle) |
| Content | Rich Text |
| Source | URL |
| Validated | Checkbox |

#### Content Pillars DB
| Campo | Tipo |
|-------|------|
| Name | Title |
| Weight | Number |
| LastUsed | Date |
| AvgScore | Number |
| Description | Rich Text |

**Poblar con los 9 pilares iniciales (copiar del plan).**

#### Ideas Pool DB
| Campo | Tipo |
|-------|------|
| Idea | Title |
| Source | Select (reddit, youtube, trends, news, manual) |
| Status | Select (pending, in-progress, published, rejected) |
| Score | Number |
| ResearchDate | Date |
| Summary | Rich Text |

#### Analytics DB
| Campo | Tipo |
|-------|------|
| Post | Title |
| Platform | Select (tiktok, instagram, youtube, facebook) |
| PublishDate | Date |
| Views | Number |
| Engagement | Number |
| RetentionAvg | Number |
| TopComment | Rich Text |
| IsViralRef | Checkbox |

### 2.3 Obtener los Database IDs

Para cada database: abrir en el navegador → la URL tiene el formato:
`https://www.notion.so/[workspace]/[DATABASE_ID]?v=...`

Copiar los IDs en:
1. `.env`: `NOTION_KB_DB_ID`, `NOTION_PILLARS_DB_ID`, `NOTION_IDEAS_DB_ID`, `NOTION_ANALYTICS_DB_ID`
2. `niches/masculinity/config.json` → campo `notion`

### 2.4 Conectar la Integration a las databases

En cada database: clic en `...` (top right) → **Connections** → Add `ContentAutomation`.

---

## 3. ElevenLabs TTS — Voz en Off

1. Crear cuenta gratuita en https://elevenlabs.io (10,000 chars/mes gratis)
2. Ir a **My Account** → API Key → copiar en `.env` como `ELEVENLABS_API_KEY`
3. Ir a **Voice Library** → buscar una voz masculina en español (ej: "Antoni", "Adam", o subir tu propia voz)
4. Copiar el **Voice ID** → `.env` como `ELEVENLABS_VOICE_ID`

**Voces masculinas en español recomendadas:**
- `pNInz6obpgDQGcFmaJgB` — Adam (inglés pero funciona para pruebas)
- Buscar "Spanish" en la Voice Library para voces nativas

---

## 4. Higgsfield AI MCP — Video AI

1. Crear cuenta en https://higgsfield.ai (free tier disponible)
2. Ir a Settings → API Keys → crear nueva key
3. Copiar en `.env` como `HIGGSFIELD_API_KEY`
4. Añadir al `claude_desktop_config.json`:

```json
// C:\Users\hoyes\AppData\Roaming\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "figma-605dcr-13": { ... },
    "higgsfield": {
      "command": "npx",
      "args": ["-y", "@higgsfield/mcp-server"],
      "env": {
        "HIGGSFIELD_API_KEY": "tu_api_key_aqui"
      }
    }
  }
}
```

5. Reiniciar Claude Desktop para activar el MCP

---

## 5. YouTube Data API v3

1. Ir a https://console.cloud.google.com
2. Crear proyecto: `ContentAutomation`
3. Habilitar APIs: **YouTube Data API v3** + **YouTube Analytics API**
4. Ir a **Credentials** → Create Credentials → **OAuth 2.0 Client ID**
   - Application type: Web application
   - Authorized redirect URIs: `http://localhost:8080/callback`
5. Descargar JSON → copiar Client ID y Client Secret en `.env`
6. Para obtener el Refresh Token, ejecutar una vez:

```bash
npx tsx scripts/auth-youtube.ts
```

*(Este script se puede crear más adelante para el flujo OAuth)*

---

## 6. Meta Graph API (Instagram + Facebook)

**Requisitos:** Cuenta de Instagram de Creador o Business + Página de Facebook vinculada.

1. Ir a https://developers.facebook.com → Mis Apps → Crear App
2. Tipo: **Business**
3. Agregar producto: **Instagram Graph API**
4. En Instagram API → Generate Token → copiar en `.env` como `META_ACCESS_TOKEN`
5. Obtener **Instagram User ID**: `https://graph.facebook.com/me?fields=id,name&access_token=TU_TOKEN`
   → copiar ID en `.env` como `META_IG_USER_ID`
6. Obtener **Facebook Page ID** desde la URL de tu página

**Permisos necesarios:** `instagram_content_publish`, `pages_manage_posts`, `pages_read_engagement`

---

## 7. TikTok Content Posting API

1. Ir a https://developers.tiktok.com → My Apps → Create App
2. Tipo: Content Posting
3. Request access to **Content Posting API** (puede requerir review)
4. Una vez aprobado: generar access token
5. Copiar en `.env` como `TIKTOK_ACCESS_TOKEN`

**Nota:** TikTok tiene el proceso de developer más restrictivo. Si hay delay, el sistema publicará primero en YouTube/Instagram y se añade TikTok después.

---

## 8. Verificar que todo funciona

### Test del Research Agent (no requiere APIs de plataformas)
```bash
cd C:\ContentAutomation
npx tsx scripts/research.ts --niche masculinity --dry-run
```
→ Debe generar ideas en `content-pipeline\[fecha]-research.json`

### Test del Content Creator (requiere ANTHROPIC_API_KEY)
```bash
npx tsx scripts/content-creator.ts --niche masculinity --pillar arquetipos --dry-run
```
→ Debe generar `content-pipeline\[uuid]\video-props.json`

### Test del Approval Dashboard
```bash
npx tsx scripts/approval-server.ts --post-id [uuid-del-paso-anterior]
```
→ Debe abrir http://localhost:3001 en el navegador

### Test de publicación en YouTube (modo privado)
```bash
npx tsx scripts/publish.ts --post-id [uuid] --platform youtube --private
```

---

## 9. Scheduling con Claude Code CronCreate

Una vez verificados todos los pasos anteriores, ejecutar en Claude Code:

```
/schedule
```

Y configurar estas tareas:
- **Research**: Lunes, Miércoles, Viernes 7:00am — `npx tsx C:\ContentAutomation\scripts\research.ts --niche masculinity`
- **Pipeline completo**: Lunes, Miércoles, Viernes 8:30am — `npx tsx C:\ContentAutomation\scripts\pipeline.ts --niche masculinity`
- **Learning**: Domingo 9:00am — (crear scripts/learning.ts)

---

## 10. Estructura final del .env completo

```env
# Anthropic (REQUERIDO desde el inicio)
ANTHROPIC_API_KEY=sk-ant-...

# Notion (configurar en Paso 2)
NOTION_TOKEN=secret_...
NOTION_KB_DB_ID=...
NOTION_PILLARS_DB_ID=...
NOTION_IDEAS_DB_ID=...
NOTION_ANALYTICS_DB_ID=...

# ElevenLabs TTS (configurar en Paso 3)
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB

# Higgsfield (configurar en Paso 4)
HIGGSFIELD_API_KEY=...

# YouTube (configurar en Paso 5)
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REFRESH_TOKEN=...
YOUTUBE_API_KEY=...

# Meta / Instagram / Facebook (configurar en Paso 6)
META_ACCESS_TOKEN=...
META_IG_USER_ID=...
META_FB_PAGE_ID=...

# TikTok (configurar en Paso 7)
TIKTOK_ACCESS_TOKEN=...

# Paths (ajustar si es diferente)
EDITOR_PRO_MAX_PATH=C:\DevProjects\editor-pro-max
CONTENT_PIPELINE_DIR=C:\ContentAutomation\content-pipeline
APPROVAL_QUEUE_DIR=C:\ContentAutomation\approval-queue
PUBLISHED_DIR=C:\ContentAutomation\published
```
