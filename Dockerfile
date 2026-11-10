# Imagen del agente de órdenes de compra: servidor + chat web en un solo proceso.
# Los secretos (LLM_API_KEY, CLAVE_DE_ACCESO) NO van aquí: se pasan como variables de entorno del servicio.

# --- Bloque 1: base con Bun (misma versión que en desarrollo) ---
FROM oven/bun:1.4.4

WORKDIR /app

# --- Bloque 2: dependencias (capa aparte para aprovechar la caché) ---
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Bloque 3: código del proyecto ---
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY agent ./agent
COPY fixtures ./fixtures

# --- Bloque 4: ejecución sin privilegios ---
# La imagen oficial trae el usuario "bun"; las sesiones escriben en la carpeta temporal del sistema.
ENV NODE_ENV=production
ENV PORT=3000
# Detrás del proxy del servicio de alojamiento la IP real llega en x-forwarded-for
ENV CONFIAR_EN_PROXY=true
USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
