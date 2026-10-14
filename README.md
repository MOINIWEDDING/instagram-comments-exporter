# Exportador de comentarios de Instagram

App en Next.js para pegar URLs de reels/videos públicos de Instagram, ver sus comentarios (incluidas
las respuestas a comentarios) en un dashboard y exportarlos a CSV. Pensada para desplegarse en
Vercel.

## ⚠️ Aviso importante

Instagram **no ofrece una API oficial** para leer comentarios de publicaciones de terceros. Esta
app usa un endpoint interno no documentado de Instagram, lo cual:

- **Viola los Términos de Servicio de Instagram** si se usa sin su autorización — úsalo bajo tu
  propio criterio y responsabilidad (por ejemplo, solo sobre tus propias publicaciones o con
  fines de investigación/moderación legítimos).
- **Puede dejar de funcionar en cualquier momento** sin aviso, si Instagram cambia su API interna.
- **Requiere una sesión autenticada** para funcionar de forma confiable. Sin ella, Instagram
  bloquea casi todas las lecturas de comentarios desde IPs de datacenter (como las de Vercel).
- Si usas la cookie de sesión de tu propia cuenta de Instagram, esa cuenta corre riesgo de ser
  limitada o bloqueada temporalmente por actividad automatizada. No uses una cuenta que no puedas
  permitirte perder temporalmente.

Si más adelante prefieres una vía 100% oficial y estable, la alternativa es usar la
[Instagram Graph API](https://developers.facebook.com/docs/instagram-api) de Meta, pero esa solo
da acceso a comentarios de publicaciones de **tu propia cuenta** Business/Creator.

## Cómo obtener `IG_SESSIONID`

### Opción automática (recomendada)

```bash
npm run get-session
```

Esto abre un navegador real apuntando a instagram.com. Iniciá sesión ahí normalmente (con tu
2FA si tenés). El script nunca ve ni guarda tu contraseña — la escribís directo en la página real
de Instagram. En cuanto detecta el login, extrae las cookies necesarias y las escribe en
`.env.local` automáticamente, y las imprime en la terminal para que las copies a Vercel.

### Opción manual

1. Inicia sesión en instagram.com desde Chrome/Firefox con la cuenta que quieras usar.
2. Abre las herramientas de desarrollador → pestaña **Application/Storage** → **Cookies** →
   `https://www.instagram.com`.
3. Copia el valor de la cookie `sessionid` (y opcionalmente `ds_user_id` y `csrftoken`).

En ambos casos: nunca compartas estos valores, equivalen a estar logueado en esa cuenta.

## Desarrollo local

```bash
npm install
cp .env.example .env.local   # y pega ahí tu IG_SESSIONID
npm run dev
```

Abre http://localhost:3000.

## Despliegue en Vercel

1. Sube este proyecto a un repositorio de GitHub (tú mismo, desde tu cuenta).
2. En [vercel.com](https://vercel.com), "Add New… → Project" e importa el repo.
3. En **Settings → Environment Variables**, agrega `IG_SESSIONID` (y opcionalmente
   `IG_DS_USER_ID` / `IG_CSRFTOKEN`).
4. Deploy.

Cuando la sesión expire, corré `npm run get-session` de nuevo y después `npm run push-session` para
subir los valores nuevos a Vercel (production y preview) automáticamente vía su CLI — te pide loguearte
la primera vez (`npx vercel login`) y vincular el proyecto (`npx vercel link`).

## Cómo funciona

- `lib/instagram.ts`: convierte el shortcode del URL en un `media_id` (algoritmo público, sin red)
  y pagina comentarios desde el endpoint web `www.instagram.com/api/v1/media/{id}/comments/`
  usando la cookie de sesión configurada. Para cada comentario con más respuestas de las que trae
  el preview, pagina también `.../comments/{id}/child_comments/` para traerlas todas. Si no hay
  sesión configurada, intenta un modo anónimo best-effort que rara vez trae resultados completos.
- `app/api/comments/route.ts`: recibe hasta 10 URLs por solicitud, hasta 300 comentarios de primer
  nivel por video (las respuestas se suman aparte), con un presupuesto de tiempo de ~50s para no
  exceder el límite de función serverless.
- `app/page.tsx`: UI para pegar URLs, ver el dashboard de resultados (respuestas indentadas y
  marcadas con un ícono), analizar/filtrar los comentarios y exportarlos.
- `lib/export.ts`: generación del CSV y del PDF.

## Análisis de sentimiento y filtros por tema

Después de obtener los comentarios aparece el panel **Análisis y filtros**:

- **Positivos / negativos / neutrales**: cada comentario se clasifica por sentimiento. Podés filtrar
  la vista por sentimiento y ver las estadísticas (cantidad y porcentaje de cada uno).
- **Filtros personalizados**: agregá tus propios temas con un nombre y una descripción en lenguaje
  natural (por ejemplo *Precio* → "preguntan cuánto cuesta o por promociones"). Cada comentario se
  etiqueta con los temas que trata y podés filtrar por tema.
- **Exportación**: el CSV y el PDF respetan los filtros activos y agregan las columnas de
  sentimiento y temas. El PDF incluye además una página de estadísticas (sentimiento general, por
  video y por tema) y una sección por cada filtro con los comentarios que tratan ese tema.

La clasificación usa Gemini de Google (`app/api/analyze/route.ts`, modelo `gemini-flash-lite-latest`
por defecto; se puede cambiar con `GEMINI_MODEL`) si configurás `GEMINI_API_KEY` (en `.env.local` y en
las variables de entorno de Vercel). La key se obtiene gratis en https://aistudio.google.com/apikey;
el plan gratuito tiene límites de pedidos por minuto y por día. Al exportar el PDF, si los comentarios
todavía no se analizaron, se analizan automáticamente para que el reporte incluya el sentimiento. Sin
la key, la app usa un análisis local por palabras clave y emojis (`lib/analysis.ts`), gratuito pero
bastante menos preciso.

## Límites conocidos

- Máximo 10 URLs y 300 comentarios por video por solicitud (ajustable en
  `app/api/comments/route.ts`).
- Los reels/videos privados nunca serán accesibles salvo que la cuenta autenticada los siga y
  tenga permiso.
- Instagram puede exigir verificación (challenge) a la sesión si detecta actividad inusual; en ese
  caso hay que volver a iniciar sesión manualmente en el navegador y refrescar `IG_SESSIONID`.
