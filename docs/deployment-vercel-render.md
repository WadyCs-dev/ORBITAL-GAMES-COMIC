# Despliegue opcional: Vercel + Render

La publicación vigente sigue siendo GitHub Pages + Supabase. Esta configuración agrega un frontend Vite en Vercel y un servicio HTTP en Render para el proxy NASA/JPL y la API REST/MCP existente. No crea otro servidor de vuelo: las salas, presencia y estado cooperativo siguen usando Supabase Auth, PostgreSQL y Realtime.

## Vercel: frontend

Importa `WadyCs-dev/ORBITAL-GAMES-COMIC` en Vercel con raíz del proyecto en `/`. `vercel.json` fija `npm ci`, `npm run build` y `dist`. Configura estas variables en **Production** y **Preview** según el entorno; se incorporan al bundle del navegador:

- `VITE_SUPABASE_URL`: origen HTTPS del proyecto Supabase.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: clave publicable (`sb_publishable_` o `anon` antigua), nunca `service_role` ni `sb_secret_`.
- `VITE_ORBITAL_API_URL`: URL HTTPS del servicio API de Render, sin ruta ni barra final.
- `VITE_NASA_MODE=proxy`: usa Render para consultas NASA y las instantáneas publicadas si falla el proxy.

El CSP de Vite permite al origen configurado las conexiones API/WebSocket de Supabase y las peticiones/imagen del proxy. No añadas una rewrite global: el juego usa archivos estáticos y navegación hash. La configuración de Vercel sigue su [referencia oficial de `vercel.json`](https://vercel.com/docs/project-configuration/vercel-json).

## Render: API

`render.yaml` crea un servicio Node para `server/render-api.mjs`, Node 24, plan Free y health check `/healthz`. En Render usa **New → Blueprint** y selecciona este repositorio. Configura `ORBITAL_ALLOWED_ORIGINS` con los orígenes exactos de Vercel separados por coma, incluidos los dominios Preview que necesites; nunca uses `*`.

Variables privadas opcionales del servicio:

- `NASA_API_KEY`: sólo para orígenes que requieren una clave.
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`: necesarias sólo para las rutas REST/MCP Node que persisten proyectos; permanecen exclusivamente en Render.
- `ORBITAL_API_KEYS`: claves de integración REST/MCP (una o varias separadas por coma).
- `ORBITAL_APP_URL`: base pública de la app para construir enlaces de vista previa.

Render asigna `PORT`; el servidor escucha en `0.0.0.0`, expone `/healthz` y rechaza orígenes de navegador que no estén permitidos (localhost queda habilitado para desarrollo). La prueba de health/CORS es unitaria; no se ha desplegado el Blueprint ni probado un dominio real de Vercel.

El plan Free puede suspender el servicio cuando queda inactivo y su sistema de archivos es efímero ([limitaciones oficiales](https://render.com/docs/free)). No subas ni guardes archivos de usuarios en Render. Los borradores Developers actuales almacenan texto limitado en Supabase; el proyecto todavía no implementa carga de imágenes ni adjuntos binarios. Para producción continua, selecciona un plan estable después de revisar los costos en tu cuenta de Render.

## Datos y límites actuales

- Supabase sigue siendo el backend de identidad, persistencia de proyectos/partidas y Realtime. Render no sustituye las migraciones, RLS, Auth ni la publicación Realtime.
- La colaboración transmite presencia y estado de misión mediante Supabase; las físicas de vuelo siguen en cada cliente. No se implementó Socket.IO ni una simulación de vuelo autoritativa en Render.
- Vercel/Render requieren crear proyectos en sus dashboards y añadir allí variables. No hay credenciales de esas cuentas en el repositorio ni se ha hecho un despliegue externo.
- GitHub Pages puede seguir desplegándose en paralelo. No se cambió el flujo de publicación existente.
