# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm install                                                        # instalar dependencias

# Pipeline paso a paso (cada uno requiere --post-id del paso anterior)
npx tsx scripts/research.ts --niche masculinity [--dry-run]
npx tsx scripts/content-creator.ts --niche masculinity [--pillar arquetipos] [--dry-run]
npx tsx scripts/reels-expert.ts --post-id <uuid> [--dry-run]
npx tsx scripts/visual-strategist.ts --post-id <uuid>
npx tsx scripts/fetch-visuals.ts --post-id <uuid>
npx tsx scripts/visual-evaluator.ts --post-id <uuid>
npx tsx scripts/render.ts --post-id <uuid>
npx tsx scripts/validate-vision.ts --post-id <uuid>
npx tsx scripts/approval-server.ts --post-id <uuid>       # abre http://localhost:3001
npx tsx scripts/publish.ts --post-id <uuid>
npx tsx scripts/monitor.ts --post-id <uuid>               # 48h después de publicar

# Pipeline completo automatizado
npx tsx scripts/pipeline.ts --niche masculinity

# Retry cuando validate-vision falla
npx tsx scripts/content-creator.ts --retry --post-id <uuid>
```

`--dry-run` en `research` y `content-creator` evita escribir en Notion y no genera audios TTS.

## Architecture

### Pipeline flow

```
research → content-creator → reels-expert → visual-strategist → fetch-visuals
        → visual-evaluator → render → validate-vision → approval-server → publish → monitor
```

`pipeline.ts` orquesta todo el flujo. Cada script es también ejecutable individualmente. El pipeline tiene hasta 2 ciclos de regeneración automática: si `validate-vision` falla, llama `retryContent()` que relee el `validation-report.json` e incluye las sugerencias en el prompt de Claude antes de reintentar.

### Central data contract

`VideoProps` (definido en `types.ts` con Zod) es el contrato que pasa entre scripts. Se persiste como `content-pipeline/<postId>/video-props.json`. Claude lo genera en `content-creator`, `reels-expert` lo mejora iterativamente (hasta score 9/10), y `render` lo consume para construir la composición Remotion.

Restricciones clave del schema que Claude debe respetar al generarlo:
- `hook`: máx 80 chars
- `cta`: máx 100 chars
- `background`: solo hex de la paleta de marca — `"#0D0D0D"` | `"#1A1A1A"` | `"#0A0A0A"` | `"#141414"`
- `textStyle`: `"fade"` | `"slideUp"` | `"slideDown"` | `"slideLeft"` | `"slideRight"` | `"scale"` | `"typewriter"` | `"blur"`

### Niche config

Cada nicho vive en `niches/<nicheId>/config.json` (estrategia de contenido, subreddits, términos YouTube, IDs de Notion) y `niches/<nicheId>/brand-guide.json` (paleta, tipografía, guía visual, reglas de marca). El nicho activo es `masculinity` — marca **El Camino del Guerrero**, handle `@elcaminodel.guerrero`. `loadNicheConfig()` y `loadBrandGuide()` en `utils.ts` los leen.

### Notion as database

Los scripts leen y escriben directamente a la API de Notion (sin SDK, usando `fetch`). Cuatro bases de datos configuradas en `config.json → notion`:
- **Knowledge Base**: contexto del nicho inyectado en el prompt de `content-creator`
- **Content Pillars**: 9 pilares con pesos para selección ponderada aleatoria
- **Ideas Pool**: resultados de `research`, filtrados por `Status = "pending"` y `Score desc`
- **Analytics**: métricas post-publicación recolectadas por `monitor`

### Render pipeline

`render.ts` genera código TypeScript de una composición Remotion en `editor-pro-max/src/compositions/generated-<postId8>/index.tsx`, lo registra en `Root.tsx` (inserta el import antes de `export const RemotionRoot` y `<Composition>` dentro del return), y ejecuta `npx remotion render` desde el directorio de `editor-pro-max`. Los componentes que usa son `AnimatedTitle` y `GradientBackground` en `editor-pro-max/src/components/`.

TTS: `render.ts` genera los audios con ElevenLabs **solo si no existen** — si los archivos `audio/scene-N.mp3` ya están en el directorio del post, los usa directamente (útil para colocarlos manualmente cuando se trabaja con el free tier).

### File layout per post

```
content-pipeline/<postId>/
  video-props.json          # contrato central (VideoProps)
  reels-audit-report.json   # output de reels-expert
  visual-strategy.json      # output de visual-strategist
  visuals-manifest.json     # output de fetch-visuals
  visual-evaluation.json    # output de visual-evaluator
  validation-report.json    # output de validate-vision (scores + sugerencias)
  raw-video.mp4             # output de render
  thumbnail.png
  audio/scene-0.mp3 ...

approval-queue/<postId>/
  metadata.json
  decision.json             # { action: "approve"|"reject"|"regenerate", approved: bool }
```

### Environment

Todos los scripts leen variables del `.env` vía `dotenv/config`. Ver `.env.example` para la lista completa. Las rutas `EDITOR_PRO_MAX_PATH`, `CONTENT_PIPELINE_DIR` etc. son configurables — los scripts usan `process.env` con fallback a rutas Windows absolutas.
