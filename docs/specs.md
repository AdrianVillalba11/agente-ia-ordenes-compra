# Especificación del agente de órdenes de compra

Qué hace el sistema, con qué reglas y con qué límites. Los datos son ficticios y el SAP es simulado.

## 1. Propósito

Un agente conversacional que ayuda a la analista administrativa a crear órdenes de compra (OC): lee el paquete de la compra, valida los controles, arma la OC, genera la evidencia de la aprobación y la crea en un SAP simulado. Lo que no cumple un control no se arregla a la fuerza: se bloquea o se devuelve a la persona para que lo confirme.

## 2. Actores

| Actor | Papel |
|---|---|
| Analista administrativa | Usa el chat: pide procesar una solicitud y confirma las excepciones |
| Agente | Orquesta: pide herramientas y explica los resultados |
| Código (ciclo y herramientas) | Decide lo que se permite: bloqueos, confirmaciones, evidencia, idempotencia |
| Contabilidad y auditoría | Consume `out/control.csv`, `out/log.jsonl` y la evidencia |
| SAP | Sistema de registro; aquí, simulado con archivos |

## 3. Entradas

Cada solicitud (`fixtures/reto-03/solicitudes/sol-00X/`) trae: `correo.json`, `solicitud.json`, `cotizacion.txt`, `aprobacion.json` y, a veces, `factura.txt`. Los maestros (`fixtures/reto-03/maestros/`) son: proveedores, centros de costo con aprobadores y topes, condiciones de pago e indicadores de IVA.

## 4. Requisitos funcionales

| Id | Requisito | Dónde |
|---|---|---|
| RF-1 | Leer el paquete y normalizarlo. Un adjunto ausente se reporta en `faltantes`, sin excepciones | `oc_leer_paquete` |
| RF-2 | Validar con RC1–RC10 y devolver `apta`, `bloqueos`, `confirmaciones`, `derivados` y si es retroactiva, cada hallazgo con razón y acción sugerida | `oc_validar` |
| RF-3 | Construir la OC validada con zod, con la trazabilidad de cada valor | `oc_construir_payload` |
| RF-4 | Generar la evidencia: `aprobacion.txt` con sha256 y `aprobacion.pdf` | `oc_generar_evidencia` |
| RF-5 | Crear la OC en el SAP simulado: numeración desde 4500000001, idempotente, con registro de cada intento | `oc_crear` |
| RF-6 | Errores legibles: `{ ok: false, error }`; nunca excepciones ni valores inventados | todas |
| RF-7 | Chat con historial, llamadas a herramientas visibles, aviso de confirmación pendiente y botones de confirmar | `web/` |
| RF-8 | Demo sin modelo que corre los 6 casos y se autoverifica | `demo.ts` |

## 5. Reglas de control

**Bloqueos** (la OC no se crea, ni siquiera con confirmación):

| Regla | Condición |
|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo |
| RC2 | Hay aprobación que dice "Aprobado" y viene de un aprobador del centro de costos de la solicitud |
| RC3 | El valor total no supera el tope del aprobador en ese centro (igual al tope sí se permite) |
| RC4 | La subárea pertenece al centro de costos |
| RC10 | cantidad × precio unitario = valor total, con tolerancia de 1 unidad monetaria |

**Confirmaciones** (se crea solo si la persona las confirma):

| Regla | Condición |
|---|---|
| RC5 | La cotización difiere de la solicitud en 2 % o menos; si difiere más o falta la cotización, confirma |
| RC6 | Falta el indicador de IVA: se propone el del proveedor |
| RC8 | Existe una factura anterior a la solicitud: compra retroactiva, se marca en `control.csv` |
| RC9 | La aprobación es anterior a la solicitud |

**Derivado** (solo se informa): RC7, condiciones de pago ausentes, se toman del proveedor.

## 6. Resultados esperados de los 6 casos

| Caso | Situación | Resultado |
|---|---|---|
| sol-001 | Sin problemas | OC creada |
| sol-002 | Proveedor inexistente | Bloqueada por RC1 |
| sol-003 | Aprobador de otro centro de costos | Bloqueada por RC2 |
| sol-004 | Cotización distinta de la solicitud | Pide confirmación (RC5); con confirmación, se crea |
| sol-005 | Factura anterior a la solicitud | Pide confirmación (RC8); con confirmación, se crea y queda `retroactiva = true` |
| sol-006 | Sin indicador de IVA | Pide confirmación (RC6); sin respuesta, queda pendiente |

## 7. Comportamiento del agente

- El modelo decide qué herramienta pedir; el código decide qué se permite.
- El ciclo repite modelo → herramienta → resultado hasta que el modelo responde con texto, con un tope de 25 pasos por turno. Al agotarlo responde con lo que tiene y lo que falta.
- **Confirmación:** el modelo no ve el argumento `confirmado`. El ciclo lo agrega solo si había un pendiente de un turno anterior y el último mensaje del usuario es una confirmación explícita: afirmativa, sin negación, sin pregunta, de menos de 200 caracteres, y nombrando el caso si hay varios pendientes.
- Un bloqueo también llama a `oc_crear` una vez, para dejar constancia en `control.csv`; la herramienta lo rechaza.
- Al modelo solo se le muestra el argumento `caso`. Los resultados llegan sin el texto completo de correos y cotizaciones.
- Todo valor que el agente afirme viene de una herramienta.

## 8. Reglas de `oc_crear`

Solo crea si se cumple todo:
- no hay bloqueos;
- la evidencia existe y su hash coincide con el de la OC;
- si hay confirmaciones, antes se mostraron (quedaron pendientes en `control.csv`) y llega `confirmado: true`.

Es idempotente: pedir dos veces la misma solicitud devuelve la OC existente. La fecha de la OC es la de Colombia. Cada intento queda en `control.csv` con: solicitud, resultado, número de OC, si es retroactiva, bloqueos, confirmaciones y hora.

## 9. API del servidor

| Ruta | Método | Para qué |
|---|---|---|
| `/` | GET | El chat |
| `/api/chat` | POST | Envía un mensaje y recibe pasos, respuesta y estado de confirmación |
| `/api/sessions/:id` | GET | Recupera el historial de una sesión |
| `/api/health` | GET | Estado del servicio: modelo, si hay clave, si pide clave de acceso |

## 10. Requisitos no funcionales

- **Seguridad:** clave de acceso opcional con bloqueo por fuerza bruta; límite de mensajes por visitante; tope diario de tokens; cuerpo máximo de 64 KB; validación con zod; claves tachadas de toda respuesta; nombre de caso restringido a letras, números y guiones; el texto del agente no se interpreta como HTML.
- **Aislamiento:** cada sesión tiene su propia copia de los fixtures y su propio SAP simulado, con caducidad.
- **Costos:** 25 pasos por turno, 300 000 tokens por sesión, 1 500 000 por día, 2 048 tokens de salida por respuesta (configurables).
- **Determinismo:** la demo usa un reloj fijo y da siempre el mismo resultado; la evidencia en PDF es reproducible.
- **Idioma:** español en todo el código y los comentarios, salvo los nombres que fija el PRD.
- **Verificación:** 477 pruebas automáticas y TypeScript estricto.

## 11. Configuración

Variables de entorno (ver `.env.example`): `LLM_API_KEY`, `LLM_MODEL`, `CLAVE_DE_ACCESO`, `PORT`, `MAX_ITERACIONES_POR_TURNO`, `MAX_TOKENS_POR_SESION`, `MAX_TOKENS_GLOBAL_DIARIO`, `MAX_MENSAJES_POR_IP`, `VENTANA_IP_SEGUNDOS`, `MAX_SESIONES`, `TTL_SESION_MINUTOS`, `CONFIAR_EN_PROXY`.

## 12. Fuera de alcance y limitaciones conocidas

- Conexión a un SAP real: solo está diseñada (ver `SOLUCION.md`, sección 6).
- Lectura de Excel y PDF binarios: los datos de prueba vienen como JSON y texto.
- Una sola instancia: sesiones y límites viven en memoria.
- Clave de acceso compartida, no por usuario.
- Sin controles extra a RC1–RC10: moneda, montos en cero, códigos inexistentes y NIT cruzado.
- El precio ya incluye IVA y la OC lleva además indicador de IVA: en un SAP real podría cobrarse dos veces.
- No se verificaron el precio ni los límites de la capa gratuita de Gemini.
