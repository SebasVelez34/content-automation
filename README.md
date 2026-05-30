# Content Automation

Pipeline automatizado de creación y publicación de contenido para redes sociales, orquestado por Claude AI. Genera videos cortos (TikTok/Reels/Shorts) con voz en off, visuals y texto animado — desde la investigación de ideas hasta la publicación — con supervisión humana en el punto de aprobación.

**Nicho inicial:** El Camino del Guerrero (`@elcaminodel.guerrero`) — dirección masculina, arquetipos, propósito de vida.

---

## Cómo funciona

```
Research → Content Creator → Reels Expert → Visual Strategist → Fetch Visuals
         → Visual Evaluator → Render → Validate → Approval → Publish → Monitor
```

1. **Research** — Scrape de Reddit, YouTube y Google Trends. Claude categoriza y puntúa cada idea, las top 10 van a Notion.
2. **Content Creator** — Claude genera el `VideoProps` (hook, escenas, voiceover, CTA) basándose en la idea de Notion y la knowledge base del nicho.
3. **Reels Expert** — Auditor especializado que itera el VideoProps hasta alcanzar score ≥ 9/10 (máx 3 rondas).
4. **Visual Strategist** — Decide tipo de media (imagen/secuencia/video) y genera prompts por escena alineados con la marca.
5. **Fetch Visuals** — Descarga assets desde Pexels y genera imágenes con Gemini.
6. **Visual Evaluator** — Claude Vision evalúa cada asset y reemplaza los que no pasan (score < 7).
7. **Render** — Genera una composición Remotion con los assets, audios TTS y tipografía de marca. Produce `raw-video.mp4`.
8. **Validate** — Claude evalúa el contenido (hook, alineación, viralidad, CTA). Si falla, el pipeline hace retry automático con el feedback.
9. **Approval** — Dashboard web local (`localhost:3001`) para revisar y aprobar/rechazar/regenerar antes de publicar.
10. **Publish** — Publica en TikTok, Instagram, YouTube y Facebook simultáneamente.
11. **Monitor** — Recolecta métricas 48h después y las guarda en Notion Analytics.

---

## Setup

### 1. Instalar dependencias

```bash
npm install
```

Requiere Node.js 20+ y ffmpeg instalado en el sistema.

### 2. Variables de entorno

```bash
copy .env.example .env
```

Editar `.env` con las API keys. Ver [SETUP.md](SETUP.md) para instrucciones detalladas de cada servicio.

| Variable | Servicio | Requerido |
|----------|----------|-----------|
| `ANTHROPIC_API_KEY` | Claude AI | ✅ Siempre |
| `NOTION_TOKEN` + DB IDs | Notion | ✅ Para research y knowledge base |
| `ELEVENLABS_API_KEY` | TTS | ✅ Para render con voz |
| `YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN` | YouTube | Para publicar |
| `META_ACCESS_TOKEN` | Instagram/Facebook | Para publicar |
| `TIKTOK_ACCESS_TOKEN` | TikTok | Para publicar |
| `EDITOR_PRO_MAX_PATH` | Remotion editor | ✅ Para render |

### 3. Notion

Crear 4 bases de datos: **Knowledge Base**, **Content Pillars**, **Ideas Pool**, **Analytics**. Conectar la integration y copiar los IDs en `.env` y en `niches/masculinity/config.json`. Ver [SETUP.md](SETUP.md) para el schema exacto de cada DB.

---

## Uso

### Pipeline completo

```bash
npx tsx scripts/pipeline.ts --niche masculinity
```

### Paso a paso

```bash
npx tsx scripts/research.ts --niche masculinity
npx tsx scripts/content-creator.ts --niche masculinity [--pillar arquetipos]
npx tsx scripts/reels-expert.ts --post-id <uuid>
npx tsx scripts/render.ts --post-id <uuid>
npx tsx scripts/validate-vision.ts --post-id <uuid>
npx tsx scripts/approval-server.ts --post-id <uuid>
npx tsx scripts/publish.ts --post-id <uuid>
```

Usar `--dry-run` en `research` y `content-creator` para probar sin escribir en Notion ni generar audios TTS.

### Retry cuando la validación falla

```bash
npx tsx scripts/content-creator.ts --retry --post-id <uuid>
```

Lee el `validation-report.json` del post y regenera el video incorporando las sugerencias de mejora.

---

## Agregar un nuevo nicho

1. Crear `niches/<nicheId>/config.json` con la estructura de `niches/masculinity/config.json`
2. Crear `niches/<nicheId>/brand-guide.json` con paleta, tipografía y guía visual
3. Crear las 4 Notion DBs y configurar los IDs en el `config.json`
4. Ejecutar: `npx tsx scripts/research.ts --niche <nicheId>`

---

## Stack

- **Runtime:** Node.js + TypeScript (tsx, sin compilación)
- **AI:** Claude (`claude-sonnet-4-6`) — generación, auditoría, validación y evaluación visual
- **TTS:** ElevenLabs API
- **Video render:** [Remotion](https://remotion.dev) vía `editor-pro-max`
- **Visuals:** Pexels API + Google Gemini (imagen generativa)
- **Database:** Notion (knowledge base, ideas, analytics)
- **Validación de schema:** Zod
