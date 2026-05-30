# ContentAutomation — Estado del Proyecto
> Última actualización: 2026-05-27

## Qué es este proyecto
Pipeline automatizado de creación y publicación de contenido para redes sociales, orquestado por Claude Code. Nicho inicial: **dirección masculina** (hombres sin rumbo, arquetipos, filosofía). Publica 3x/semana en TikTok, Instagram, YouTube, Facebook.

**Repositorio:** `C:\ContentAutomation\`
**Editor de video:** `C:\DevProjects\editor-pro-max` (Remotion + TypeScript, ya construido)

---

## Stack técnico
- **TypeScript + Node.js** para todos los scripts de orquestación
- **Notion MCP** como cerebro (knowledge base, content pillars, ideas, analytics)
- **ElevenLabs** para TTS (voz en off)
- **editor-pro-max** (Remotion) para renderizar videos
- **Higgsfield MCP** para generación de video AI (pendiente de configurar)
- **Figma MCP** para carruseles e imágenes de marca (ya configurado)
- **Claude API** para generar contenido y validarlo

---

## Archivos clave del pipeline

| Archivo | Agente | Estado |
|---------|--------|--------|
| `scripts/research.ts` | Research (Reddit+YouTube+Trends→Notion) | ✅ Completo |
| `scripts/content-creator.ts` | Genera VideoProps JSON con Claude | ✅ Completo |
| `scripts/tts.ts` | TTS unificado con chunking | ✅ Completo |
| `scripts/reels-expert.ts` | Auditor Reels — mejora VideoProps antes de render | ✅ Completo |
| `scripts/render.ts` | VideoProps → Remotion → MP4 | ✅ Completo |
| `scripts/validate-vision.ts` | Claude Vision + rúbrica de contenido | ✅ Completo |
| `scripts/approval-server.ts` | Dashboard HTML localhost:3001 | ✅ Completo |
| `scripts/publish.ts` | YouTube + Instagram + Facebook + TikTok | ✅ Completo |
| `scripts/monitor.ts` | Métricas 48h → Notion Analytics | ✅ Completo |
| `scripts/pipeline.ts` | Orquestador completo | ✅ Completo |
| `scripts/types.ts` | VideoProps schema (Zod) | ✅ Completo |
| `scripts/utils.ts` | Helpers compartidos | ✅ Completo |
| `SETUP.md` | Guía de configuración de APIs | ✅ Completo |

---

## Flujo completo
```
Research → Content Creator → TTS (audio único) → Render (Remotion) 
→ Validator (Claude Vision) → Approval Dashboard → Publisher → Monitor (48h) → Learning (domingo)
```

---

## Problemas de calidad identificados (video real probado)

Se generó un video de prueba y el resultado fue malo. Se identificaron **5 problemas** y se están resolviendo **1 a 1**:

### ✅ RESUELTO — Problema 2: Audio roto
**Era:** 1 archivo MP3 por escena → cortes de audio, entonación se reiniciaba cada escena.
**Ahora:** 
- `generateUnifiedAudio()` en `tts.ts`: UN solo audio para todo el video
- Si el script supera 4,500 chars → `splitScriptIntoChunks()` divide en fronteras naturales (`\n\n` entre escenas, `. ` como fallback), genera chunks secuencialmente con 800ms delay, y los **concatena con ffmpeg** en un solo `full-script.mp3`
- `render.ts`: `<Audio src="full-script.mp3" />` una vez en la raíz de la composición (no dentro de cada `<Sequence>`)
- Duraciones de escenas calculadas proporcionalmente del audio real (ffprobe), no de `durationSec` fijo
- Prompt de `content-creator.ts` actualizado: pide voiceovers como **monólogo fluido continuo** con transiciones naturales

---

### ✅ RESUELTO — Problema 1: Hook visual nulo
**Era:** La escena 1 se veía igual que las demás. Solo texto blanco sobre gradiente estático.
**Ahora** (en `render.ts` → `buildRemotionComposition`):
- Escena 0 (hook): font **76px** / weight 900 / letterSpacing -1 / textShadow con glow (`0 0 80px rgba(255,255,255,0.25), 0 4px 32px rgba(0,0,0,0.9)`)
- Animación `scale` snappy: enterDuration **12 frames** (vs 18 en escenas normales)
- GradientBackground con `animateAngle={true} animateSpeed={0.3}` → gradiente rota lentamente
- **ParticleField overlay** (25 partículas blancas subiendo, opacity 0.22)
- BUGFIX crítico incluido: `GradientBackground` ahora usa `colors={GRADIENTS["key"]}` (antes usaba prop `preset` que no existe)
- BUGFIX crítico incluido: `AnimatedTitle` ahora usa `enterAnimation`/`exitAnimation` + `enterDuration`/`holdDuration`/`exitDuration` (antes usaba `enter`/`exit`/`style` que no existen)
- Escenas normales: 52px weight 800, animaciones correctas con hold calculado

---

### 🔴 PENDIENTE — Problema 3: Sin imágenes ni video
**Problema:** Solo gradientes de color. No hay imágenes, GIFs ni video.
**Fix a implementar en capas:**
1. **Gratis:** Pexels API (stock photos/videos por keyword del `visualPrompt`)
2. **$0.04/img:** DALL-E 3 via OpenAI API
3. **Free tier:** Higgsfield MCP para clips de video AI
- Añadir campo `visualPrompt` que el render use para generar/buscar el asset visual de fondo de cada escena

---

### ✅ RESUELTO — Problema 4: Sin auditor experto de Reels
**Era:** El Content Creator generaba un borrador, nadie lo revisaba antes de renderizar.
**Ahora:**
- `scripts/reels-expert.ts`: auditor experto con 6 criterios ponderados (hook 25%, pacing 20%, variedad visual 15%, claridad texto 15%, flujo audio 15%, CTA 10%)
- Llama Claude claude-sonnet-4-6 con prompt de auditor exigente que sabe qué funciona en Reels en español para masculinidad
- Guarda `video-props-original.json` como backup antes de sobrescribir
- Guarda `reels-audit-report.json` con scores antes/después y lista de cambios con justificaciones
- Integrado en `pipeline.ts` como PASO 2 (entre createContent y renderPost)
- Si falla, el pipeline continúa con el VideoProps original (no bloquea el flujo)
- CLI directo: `npx tsx scripts/reels-expert.ts --post-id <uuid>`

---

### 🟡 PENDIENTE — Problema 5: Sin conexión a Figma para branding
**Problema:** Figma MCP está configurado pero el pipeline nunca lo usa.
**Fix a implementar:** Script `scripts/fetch-brand.ts`
- Lee el archivo Figma del nicho (URL en `config.json`)
- Extrae colores primarios, tipografía, componentes de marca
- Guarda en `niches/masculinity/brand-guide.json`
- Content Creator y Reels Expert usan esa guía al generar el VideoProps

---

## Orden de resolución acordado
1. ✅ Audio unificado (RESUELTO)
2. ✅ Auditor Reels Expert (RESUELTO)
3. ✅ Hook visual especial (RESUELTO)
4. 🟠 Imágenes/video con Pexels + DALL-E + Higgsfield — **SIGUIENTE A IMPLEMENTAR**
5. 🟡 Figma branding

---

## Comandos para probar el estado actual
```bash
# Generar contenido (requiere ANTHROPIC_API_KEY en .env)
npx tsx C:/ContentAutomation/scripts/content-creator.ts --niche masculinity --pillar arquetipos --dry-run

# Renderizar (requiere editor-pro-max en C:/DevProjects/editor-pro-max)
npx tsx C:/ContentAutomation/scripts/render.ts --post-id <uuid>

# Ver approval dashboard
npx tsx C:/ContentAutomation/scripts/approval-server.ts --post-id <uuid>

# Test TTS chunking (verifica que el audio unificado funciona)
npx tsx C:/ContentAutomation/scripts/tts.ts test-output/
```

---

## Variables de entorno requeridas (.env)
```env
ANTHROPIC_API_KEY=         # Requerida desde ya para generar contenido
ELEVENLABS_API_KEY=        # Para audio real (sin ella genera silencio de placeholder)
ELEVENLABS_VOICE_ID=       # Opcional — default: Adam (pNInz6obpgDQGcFmaJgB)
NOTION_TOKEN=              # Para usar Notion como cerebro
NOTION_KB_DB_ID=           # Knowledge Base
NOTION_PILLARS_DB_ID=      # Content Pillars
NOTION_IDEAS_DB_ID=        # Ideas Pool
NOTION_ANALYTICS_DB_ID=    # Analytics
EDITOR_PRO_MAX_PATH=C:\DevProjects\editor-pro-max
```

---

## Contexto del usuario
- **Nombre:** Sebastian Velez (sebastian.velezvelasquez@gmail.com)
- **Nicho activo:** Dirección masculina (hombres sin rumbo que encuentran su camino)
- **Plataformas:** TikTok, Instagram, Facebook, YouTube
- **Presupuesto inicial:** $0 → upgrades según resultados
- **Idioma:** Español
- **Modo:** Semi-auto con aprobación rápida (< 2 min antes de publicar)
- **MVP format:** Video corto con frases animadas (TikTok/Reel, 30-60s)
- **APIs de plataformas:** Ninguna configurada todavía (ver SETUP.md)
