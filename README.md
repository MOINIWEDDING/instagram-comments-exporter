# Exportador de comentarios de Instagram

App en Next.js para pegar URLs de reels/videos públicos de Instagram, ver sus comentarios en un
dashboard y exportarlos a CSV. Pensada para desplegarse en Vercel.

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

1. Inicia sesión en instagram.com desde Chrome/Firefox con la cuenta que quieras usar.
2. Abre las herramientas de desarrollador → pestaña **Application/Storage** → **Cookies** →
   `https://www.instagram.com`.
3. Copia el valor de la cookie `sessionid` (y opcionalmente `ds_user_id` y `csrftoken`).
4. Nunca compartas estos valores: equivalen a estar logueado en esa cuenta.

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

## Cómo funciona

- `lib/instagram.ts`: convierte el shortcode del URL en un `media_id` (algoritmo público, sin red)
  y pagina comentarios desde el endpoint interno `i.instagram.com/api/v1/media/{id}/comments/`
  usando la cookie de sesión configurada. Si no hay sesión configurada, intenta un modo anónimo
  best-effort que rara vez trae resultados completos.
- `app/api/comments/route.ts`: recibe hasta 10 URLs por solicitud, hasta 300 comentarios por
  video, con un presupuesto de tiempo de ~50s para no exceder el límite de función serverless.
- `app/page.tsx`: UI para pegar URLs, ver el dashboard de resultados y descargar el CSV.

## Límites conocidos

- Máximo 10 URLs y 300 comentarios por video por solicitud (ajustable en
  `app/api/comments/route.ts`).
- Los reels/videos privados nunca serán accesibles salvo que la cuenta autenticada los siga y
  tenga permiso.
- Instagram puede exigir verificación (challenge) a la sesión si detecta actividad inusual; en ese
  caso hay que volver a iniciar sesión manualmente en el navegador y refrescar `IG_SESSIONID`.
