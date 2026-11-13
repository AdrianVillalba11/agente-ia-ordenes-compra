# Agente de órdenes de compra para SAP

Agente conversacional en TypeScript que procesa solicitudes de compra: lee el paquete (solicitud, cotización y correo de aprobación), lo valida contra los maestros con diez controles (RC1–RC10), arma la orden de compra (OC), genera la evidencia de aprobación y crea la OC en un SAP simulado. Lo que incumple un control se bloquea; lo dudoso se devuelve a la analista, que debe confirmarlo. Todos los datos son ficticios.

Principio de diseño: **el modelo propone y el código decide.** El modelo elige qué herramienta llamar y explica el resultado; los bloqueos, la confirmación humana y la creación de la OC se imponen en código. El planteamiento completo está en [SOLUCION.md](SOLUCION.md).

## Probar en línea

**https://agente-ia-ordenes-compra.onrender.com**

- **Clave de acceso:** `OddieLulo`
- El servicio corre en un plan gratuito que se duerme tras unos 15 minutos sin uso; la primera carga puede tardar cerca de un minuto.
- Prueba con los botones de ejemplo o escribe "Procesa la solicitud sol-001". Los casos con excepción (sol-004, sol-005) se detienen y piden confirmación; el botón o el texto "Confirmo sol-004" la da.

## Arquitectura

```
Chat web (React, web/)
   │  POST /api/chat · GET /api/sessions/:id · GET /api/health
   ▼
Servidor (src/server.ts): clave de acceso, límite por IP, tope diario de tokens, zod
   ▼
Ciclo del agente (src/agente/ciclo.ts) ◄──► Adaptador del modelo (src/llm/, Gemini)
   │   └─ confirmación humana decidida por código (src/agente/confirmacion.ts)
   ▼
Registro de herramientas (src/tools/registro.ts): valida con zod, resume, anota el log
   ▼
Herramientas oc_* (src/tools/oc.ts) ──► Dominio (src/dominio/) ──► SAP simulado (src/sap/)
```

| Capa | Dónde |
|---|---|
| Comportamiento (prompt del agente) | `agent/prompt.md` |
| Conocimiento del proceso | `src/knowledge/ordenes-compra.md` |
| Ejecución (herramientas y dominio) | `src/tools/` y `src/dominio/` |

## Herramientas

Cinco herramientas tipadas con zod. Todas devuelven `{ ok: true, data }` o `{ ok: false, error }` y nunca lanzan excepciones. Cada export de `src/tools/oc.ts` se publica como `oc_<export>`.

| Herramienta | Qué hace |
|---|---|
| `oc_leer_paquete` | Lee y normaliza solicitud, cotización, aprobación y factura (NIT, montos, fechas). Un adjunto ausente se reporta en `faltantes`, sin excepciones |
| `oc_validar` | Aplica RC1–RC10 y devuelve `apta`, `bloqueos`, `confirmaciones`, `derivados` y si la compra es retroactiva; cada hallazgo trae razón y acción sugerida |
| `oc_construir_payload` | Arma la OC validada con zod y guarda en `out/<caso>/trazabilidad.json` la fuente de cada valor |
| `oc_generar_evidencia` | Escribe `aprobacion.txt` (con sha256) y `aprobacion.pdf` a partir del correo de aprobación |
| `oc_crear` | Crea la OC en el SAP simulado. Es idempotente y solo actúa si no hay bloqueos, la evidencia existe con el hash correcto y las confirmaciones pendientes ya se mostraron y fueron confirmadas |

## Controles RC1–RC10

| Tipo | Reglas |
|---|---|
| **Bloqueo** (no se salta ni con confirmación) | RC1 proveedor existe y está activo · RC2 aprobación válida y de un aprobador del centro · RC3 valor dentro del tope · RC4 subárea del centro · RC10 cantidad × precio = total |
| **Confirmación** | RC5 cotización difiere más de 2 % · RC6 falta el indicador de IVA · RC8 factura anterior a la solicitud (compra retroactiva) · RC9 aprobación anterior a la solicitud |
| **Derivado** | RC7 condiciones de pago ausentes, tomadas del proveedor |

## Ciclo del agente

1. El ciclo envía al modelo el prompt, el conocimiento, el historial y las herramientas.
2. Si el modelo responde con texto, termina el turno; si pide una herramienta, el ciclo la ejecuta por `registro.ts` y le devuelve un resultado compacto.
3. Se repite hasta 25 pasos por turno; al agotarlos, una última llamada sin herramientas responde con lo que hay.

**Confirmación humana.** El modelo no ve el argumento `confirmado`: solo ve `caso`. El ciclo lo agrega a `oc_crear` únicamente si había un pendiente de un turno anterior y el último mensaje del usuario es una confirmación explícita (afirmativa, sin negación ni pregunta, de menos de 200 caracteres, y nombrando el caso si hay varios pendientes). `oc_crear` además exige que la duda se haya mostrado antes.

## Estructura del proyecto

```
agent/prompt.md            Comportamiento del agente
src/
  server.ts                Servidor HTTP: API del chat, clave de acceso, límites
  config.ts                Variables de entorno y topes de costo
  esquemas.ts              Esquemas zod y tipos compartidos
  agente/                  ciclo.ts, confirmacion.ts, instrucciones.ts, sesiones.ts
  llm/                     adapter.ts (interfaz), gemini.ts, fabrica.ts
  tools/                   oc.ts (las 5 herramientas) y registro.ts (ejecución central)
  dominio/                 normalizar, paquete, maestros, controles, orden, evidencia, control
  sap/                     adapter.ts (interfaz SapAdapter) y mock.ts (SAP simulado)
  servidor/limites.ts      Límite por visitante y presupuesto diario de tokens
  knowledge/               ordenes-compra.md: conocimiento del proceso
  pruebas/                 Modelo simulado para pruebas
web/                       Chat en React: app.tsx, componentes.tsx, api.ts, markdown.ts
modulo/                    El agente empaquetado: agent.md, tools/oc.ts, skill/ordenes-compra/SKILL.md
fixtures/reto-03/          Datos de entrada: maestros y solicitudes sol-001 a sol-006
demo.ts                    Demo sin modelo
humo.ts                    Prueba de conexión real con el modelo
Dockerfile · render.yaml   Despliegue
out/                       Salidas generadas (no se versiona): ordenes.jsonl, control.csv, log.jsonl, evidencia
```

## Levantar en local

Requisito: [Bun](https://bun.sh) 1.4 o superior.

```bash
bun install
bun start
```

Abre http://localhost:3000. Sin clave del modelo el chat abre pero responde con un aviso: para usar el modelo copia `.env.example` como `.env` y completa `LLM_API_KEY` (clave de Google AI Studio). El archivo `.env` no se versiona.

## Demo sin modelo

```bash
bun run demo
```

Ejecuta las herramientas sobre los 6 casos, sin modelo, sin clave y sin red, con un reloj fijo, por lo que el resultado es siempre el mismo. Muestra la secuencia de llamadas de cada caso, un resumen y 5 comprobaciones (idempotencia, confirmación explícita, confirmar sin haber mostrado la duda, ruta peligrosa y bloqueo que no se salta con `confirmado: true`). Sale con código 0 si todo salió como se esperaba. Escribe en `out/`: `sap/ordenes.jsonl`, `control.csv`, `log.jsonl` y, por caso, la evidencia y la trazabilidad.

| Caso | Resultado esperado |
|---|---|
| sol-001 | OC creada |
| sol-002 | Bloqueada por RC1 (proveedor inexistente) |
| sol-003 | Bloqueada por RC2 (aprobador de otro centro) |
| sol-004 | Pide confirmación (RC5); con confirmación, se crea |
| sol-005 | Pide confirmación (RC8, retroactiva); con confirmación, se crea |
| sol-006 | Pide confirmación (RC6); queda pendiente |

## Comandos

| Comando | Qué hace |
|---|---|
| `bun start` | Levanta el servidor y el chat |
| `bun run demo` | Demo de los 6 casos sin modelo |
| `bun run verificar` | Revisa tipos (TypeScript estricto) y corre las 477 pruebas |
| `bun test` | Solo las pruebas |
| `bun run humo` | Prueba la conexión real con el modelo y un caso completo (necesita `LLM_API_KEY`; gasta tokens) |
| `bun run humo -- --completo` | Además, la confirmación humana con sol-004 |
| `bun run modulo` | Regenera `modulo/agent.md` y `modulo/skill/.../SKILL.md` desde el prompt y el conocimiento de la aplicación |

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

## Seguridad y límites de costo

- Clave de acceso opcional, con bloqueo tras 10 intentos fallidos y comparación sin pistas por tiempo.
- Límite de mensajes por visitante, tope diario de tokens del servidor y tope por sesión.
- Cada sesión tiene su propia copia de los fixtures y su propio SAP simulado, con caducidad.
- Cuerpo máximo de 64 KB, validación con zod y nombre de caso restringido a letras, números y guiones.
- Las claves se tachan de toda respuesta y el texto del agente nunca se interpreta como HTML.

## Módulo reutilizable

`modulo/` empaqueta el agente para otras plataformas, sin copias propias: `tools/oc.ts` reexporta las mismas herramientas de la aplicación, y `agent.md` y `skill/ordenes-compra/SKILL.md` se generan con `bun run modulo` a partir de `agent/prompt.md` y `src/knowledge/ordenes-compra.md`. Una prueba falla si dejan de coincidir.

## Despliegue

El repositorio incluye `Dockerfile` y `render.yaml` para Render (plan gratuito). Las claves (`LLM_API_KEY`, `CLAVE_DE_ACCESO`) se configuran como variables de entorno del servicio y nunca van en el repositorio.
