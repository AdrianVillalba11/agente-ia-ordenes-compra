# Agente de órdenes de compra (Reto 3)

Agente conversacional que lee un paquete de compra (solicitud, cotización y correo de aprobación), valida los controles RC1–RC10 contra los maestros, arma la orden de compra, genera la evidencia de aprobación y crea la OC en un SAP simulado. Las excepciones no se resuelven a la fuerza: se devuelven a la analista para que las confirme. Todos los datos son ficticios.

El planteamiento completo (arquitectura, controles, modelo, diseño del SAP real, riesgos) está en [SOLUCION.md](SOLUCION.md).

## Probar en línea

**https://agente-ia-ordenes-compra.onrender.com**

- **Clave de acceso:** `OddieLulo`. El chat la pide antes de dejar usar el modelo.
- **Primera visita:** el servicio está en un plan gratuito que se duerme tras unos 15 minutos sin uso; la primera carga puede tardar cerca de un minuto.
- **Qué probar:** los botones de ejemplo de la pantalla inicial, o escribir "Procesa la solicitud sol-001". Los casos con excepción (sol-004, sol-005) se detienen y piden confirmación; el botón o el texto "Confirmo sol-004" la da.

## Levantar en local

Requisito: [Bun](https://bun.sh) 1.4 o superior.

```bash
bun install
bun start
```

Abre http://localhost:3000. Sin clave del modelo el chat abre, pero responde con un aviso: para usar el modelo copia `.env.example` como `.env` y completa `LLM_API_KEY` (clave de Google AI Studio). El archivo `.env` no se sube al repositorio.

## Demo sin modelo

```bash
bun run demo
```

Ejecuta las herramientas sobre los 6 casos de `fixtures/reto-03/`, sin modelo, sin clave y sin red. Con un reloj fijo, así que da siempre el mismo resultado. Muestra la secuencia de llamadas de cada caso, un resumen y 5 comprobaciones (idempotencia, confirmación explícita, confirmar sin haber mostrado la duda, ruta peligrosa, bloqueo que no se salta). Sale con código 0 si todo salió como se esperaba. Escribe en `out/`: `sap/ordenes.jsonl`, `control.csv`, `log.jsonl` y, por caso, la evidencia (`aprobacion.txt` y `.pdf`) y la trazabilidad.

## Otros comandos

| Comando | Qué hace |
|---|---|
| `bun run verificar` | Revisa tipos y corre las 477 pruebas |
| `bun run modulo` | Regenera `modulo/agent.md` y `modulo/skill/.../SKILL.md` desde el prompt y el conocimiento de la aplicación |
| `bun test` | Solo las pruebas |
| `bun run humo` | Prueba la conexión real con el modelo y un caso completo, sol-001 (necesita `LLM_API_KEY`; gasta tokens) |
| `bun run humo -- --completo` | Además, la confirmación humana con sol-004 |

## Variables de entorno

Todas son opcionales salvo la clave del modelo para usar el agente. Ver `.env.example`.

| Variable | Para qué | Por defecto |
|---|---|---|
| `LLM_API_KEY` (o `GEMINI_API_KEY`) | Clave de la API del modelo | — (sin ella el chat responde con un aviso) |
| `LLM_MODEL` | Modelo de Gemini | `gemini-3.5-flash-lite` |
| `CLAVE_DE_ACCESO` | Si se define, el chat la pide antes de usar el modelo | sin clave |
| `PORT` | Puerto del servidor | 3000 |
| `MAX_ITERACIONES_POR_TURNO` | Pasos máximos entre el modelo y las herramientas en un turno | 25 |
| `MAX_TOKENS_POR_SESION` | Tokens máximos por sesión | 300000 |
| `MAX_TOKENS_GLOBAL_DIARIO` | Tokens máximos de todo el servidor por día (hora de Colombia) | 1500000 |
| `MAX_MENSAJES_POR_IP` / `VENTANA_IP_SEGUNDOS` | Límite de mensajes por visitante y su ventana | 30 / 600 |
| `MAX_SESIONES` / `TTL_SESION_MINUTOS` | Sesiones simultáneas y minutos sin uso antes de caducar | 100 / 120 |
| `CONFIAR_EN_PROXY` | `true` solo detrás de un proxy de confianza (toma la IP de `x-forwarded-for`) | false |

## Despliegue

El repositorio incluye un `Dockerfile` y un `render.yaml` para Render (plan gratuito). Las claves (`LLM_API_KEY`, `CLAVE_DE_ACCESO`) se configuran como variables de entorno del servicio y nunca van en el repositorio.

## Estructura

```
agent/prompt.md            Comportamiento del agente
src/knowledge/             Conocimiento del proceso de órdenes de compra
src/tools/                 Las 5 herramientas oc_* (zod) y su registro
src/dominio/               Lógica de negocio: lectura, controles RC1–RC10, orden, evidencia
src/sap/                   Interfaz del adaptador SAP y su versión simulada
src/agente/                Ciclo del agente, confirmación humana y sesiones
src/llm/                   Adaptador del modelo (Gemini)
src/server.ts              Servidor HTTP del chat
web/                       Chat en React
modulo/                    Bonus: el agente empaquetado (agent.md, tools/oc.ts, skill/ordenes-compra/SKILL.md)
demo.ts                    Demo sin modelo
fixtures/reto-03/          Datos de entrada entregados por el reto
```
