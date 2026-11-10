# SOLUCION — Agente de órdenes de compra (Reto 3)

Prueba en línea: https://agente-ia-ordenes-compra.onrender.com (la clave de acceso está en el README).
Cómo levantarlo y correr la demo: ver [README.md](README.md).

---

## 1. Problema en una frase

La analista administrativa digita a mano, en SAP, cada orden de compra (proveedor, centro de costos, valor, IVA, aprobador, condiciones de pago) y verifica de memoria que quien aprobó pueda hacerlo; eso cuesta tiempo, deja pasar errores que luego se corrigen en el cierre contable y nadie sabe cuántas OC se crean **después** de recibir la factura.

El agente lee el paquete, valida los controles, arma la OC, genera la evidencia y la crea en un SAP simulado. Lo dudoso no lo resuelve a la fuerza: lo devuelve a la analista con una recomendación.

## 2. Arquitectura

```
Navegador (chat React, web/)
        │  POST /api/chat · GET /api/sessions/:id · GET /api/health
        ▼
Servidor (src/server.ts) ── clave de acceso · límites por visitante · tope diario de tokens
        │
        ▼
Ciclo del agente (src/agente/ciclo.ts) ◄──► Modelo (src/llm/gemini.ts, detrás de una interfaz)
        │      │
        │      └─ la confirmación humana la decide el CÓDIGO (src/agente/confirmacion.ts)
        ▼
Registro de herramientas (src/tools/registro.ts): valida con zod, resume, anota out/log.jsonl
        ▼
Herramientas (src/tools/oc.ts) ──► Dominio (src/dominio/*) ──► SAP simulado (src/sap/mock.ts)
                                                              └─► archivos en out/
```

| Qué | Dónde vive |
|---|---|
| **Prompt** (comportamiento del agente) | `agent/prompt.md` |
| **Conocimiento** (cómo funciona el proceso de OC) | `src/knowledge/ordenes-compra.md` |
| **Ejecución** (lo que realmente lee, valida, crea) | `src/tools/oc.ts` y `src/dominio/` |
| **Sesiones** | `src/agente/sesiones.ts`: cada sesión tiene su propia copia de los fixtures y su propio SAP simulado |

Separación deliberada: el prompt dice *cómo portarse*, el conocimiento dice *cómo funciona el proceso* y el código hace *todo lo que importa*. Las decisiones críticas (bloquear, pedir confirmación, no repetir una OC) están en código, no en el prompt.

Las cinco herramientas, todas con argumentos validados por zod y respuesta `{ ok: true, data } | { ok: false, error }` (nunca lanzan excepciones): `oc_leer_paquete`, `oc_validar`, `oc_construir_payload`, `oc_generar_evidencia`, `oc_crear`.

## 3. Ciclo del agente

1. El usuario escribe ("procesa la solicitud sol-004"). El ciclo manda al modelo el prompt, el conocimiento, el historial y las herramientas.
2. El modelo pide herramientas; el ciclo las ejecuta por el registro y le devuelve resultados **compactos**: sin el texto completo de la cotización ni del correo de aprobación (ahorra tokens y es donde alguien podría esconder instrucciones).
3. El modelo solo ve el argumento `caso`. Los argumentos de contraste (`paquete`, `derivados`, `payload`) y `confirmado` quedan ocultos: el modelo no puede alterar un monto ni dar por confirmado nada. Las herramientas recalculan todo desde el disco.
4. Cuando el modelo responde sin pedir más herramientas, termina el turno.

**Tope de iteraciones:** 25 pasos por turno (`MAX_ITERACIONES_POR_TURNO`). Al agotarlo, el ciclo hace una última llamada sin herramientas para que el modelo responda con lo que tiene y lo que falta; si también falla, usa un texto fijo. También hay topes de tokens por sesión (300 000) y de salida por respuesta (2 048).

**Confirmación humana, decidida por código.** `oc_crear` con excepciones pendientes devuelve "requiere confirmación" y registra el pendiente. El ciclo solo agrega `confirmado: true` cuando se cumplen *todas* estas condiciones:
- había un pendiente registrado en un turno anterior;
- el último mensaje del usuario es una confirmación explícita: afirmativa, sin negación, sin pregunta, de menos de 200 caracteres;
- si hay varios pendientes, el mensaje nombra el caso.

Aun así, `oc_crear` comprueba por su cuenta que lo pendiente se mostró antes, que la evidencia existe y su hash coincide, y que no hay bloqueos. Los botones del chat ("Confirmo sol-004") solo envían ese texto: el servidor decide con las mismas reglas, sin poderes especiales.

**Un bloqueo también llama a `oc_crear` una vez, a propósito.** El prompt lo pide para que quede constancia del intento en `out/control.csv` (HU-5). La herramienta lo rechaza ("Bloqueada: RC1"); en el chat se ve como un paso en rojo, y es el control funcionando, no el modelo saltándoselo.

## 4. Elección del modelo

- **Proveedor y modelo:** Gemini, `gemini-3.5-flash-lite` por defecto (estable, económico y pensado para agentes con herramientas). Alternativas ya soportadas cambiando `LLM_MODEL`: `gemini-3.6-flash` y `gemini-3.8-flash`.
- **Por qué:** el usuario tenía cuenta de Google y la capa gratuita permite una demo pública sin tarjeta. El adaptador (`src/llm/gemini.ts`) está detrás de una interfaz: cambiar de proveedor es escribir otro adaptador, sin tocar el ciclo.
- **Por qué un modelo pequeño alcanza:** las compuertas importantes están en código. Si el modelo orquesta mal, el peor caso es que haga menos pasos o los haga en otro orden; no puede crear una OC dudosa.
- **API usada:** `generateContent` (clave en la cabecera `x-goog-api-key`, nunca en la URL; se devuelven tal cual las firmas de pensamiento que Gemini 3 exige; un reintento ante 429/5xx; errores en español y con la clave tachada).

**Consumo medido con el modelo real** (sesión nueva por caso, en la URL pública):

| Caso | Tokens hasta la respuesta |
|---|---|
| sol-001 (limpio) | 21 862 |
| sol-002 (bloqueado) | 13 155 |
| sol-004 (excepción RC5, queda pendiente) | 22 531 |
| sol-005 (retroactiva RC8, queda pendiente) | 22 393 |
| Pregunta sobre una regla (sin herramientas) | 2 864 |

Un caso cuesta entre 13 mil y 23 mil tokens; el turno de confirmación agrega un poco más (no se midió aparte). Cada paso reenvía el historial, por eso crece con el número de herramientas.

**Costo en dinero:** con la capa gratuita es cero, pero no pude verificar desde aquí ni sus límites ni su precio de pago (la página remite al panel de AI Studio, que exige sesión). La cuenta se hace así: `costo por caso = tokens del caso × precio por millón de tokens del modelo ÷ 1 000 000`, con los tokens de la tabla y el precio vigente que muestre el panel de AI Studio. Los topes del servidor acotan el gasto máximo diario (`MAX_TOKENS_GLOBAL_DIARIO`, por defecto 1 500 000, es decir, unos 60–100 casos al día).

**Privacidad:** no se sabe si Google usa los datos de la capa gratuita para mejorar sus productos, por eso todo el demo usa solo datos ficticios.

## 5. Matriz de controles (RC1–RC10)

Implementados en `src/dominio/controles.ts`, con prueba automática cada uno. No se agregaron controles extra más allá de los diez del PRD (ver sección 8 y 12).

| # | Regla | Tipo | Cómo se implementó | Caso que la dispara |
|---|---|---|---|---|
| RC1 | Proveedor existe y está activo | Bloqueo | Por NIT normalizado (`900.555.111-2` → `900555111`); sin NIT, por nombre sin tildes ni puntuación | sol-002 |
| RC2 | Aprobación presente, "Aprobado" y de un aprobador del centro | Bloqueo | Correo comparado sin tildes ni mayúsculas; "No aprobado" no cuenta (falla del lado seguro) | sol-003 |
| RC3 | Valor ≤ tope del aprobador en ese centro | Bloqueo | Comparación numérica de montos parseados con punto de miles | — |
| RC4 | Subárea pertenece al centro | Bloqueo | Contra el maestro de centros | — |
| RC5 | Cotización vs solicitud ≤ 2 % | Confirmación | Comparación con enteros, sin errores de redondeo en el borde; sin cotización también confirma | sol-004 |
| RC6 | IVA ausente → se deriva del proveedor | Confirmación + derivado | `indicador_iva_default` del proveedor, con la fuente anotada | sol-006 |
| RC7 | Condiciones de pago ausentes → derivado | Derivado | Del maestro de proveedores; solo se informa | sol-006 |
| RC8 | Factura anterior a la solicitud → retroactiva | Confirmación | Compara el día de la factura con el de la solicitud; marca `retroactiva` en `control.csv` | sol-005 |
| RC9 | Aprobación no anterior a la solicitud | Confirmación | Compara solo el día escrito (la aprobación trae hora y zona, la solicitud no) | — |
| RC10 | cantidad × precio = total (± 1) | Bloqueo | Aritmética entera | — |

**La más difícil: RC2 en sol-003.** El aprobador `fvargas` sí tiene autoridad (tope de 80 M), pero en CC-3030, no en CC-2020, que es el centro de la solicitud. Un control que solo miró el tope lo habría dejado pasar. Por eso RC2 verifica la pareja aprobador-centro y no solo el monto; además los 74 M de la solicitud superan el máximo de CC-2020 (30 M).

Datos trampa que se tratan explícitamente: NIT con puntos y dígito de verificación, montos en texto con punto de miles, correos con tildes, fechas con y sin hora, y descripciones de más de 40 caracteres (se cortan en la última palabra completa y el original queda en `trazabilidad.json`).

## 6. Diseño del adaptador SAP real

Hoy `src/sap/mock.ts` implementa la interfaz `SapAdapter` sobre archivos. El real sería otra clase con la misma interfaz; el agente no cambia.

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA), con el SAP Integration Suite o API Management como puerta si la empresa ya lo tiene.** Razones, dada una viabilidad no confirmada: es la vía soportada por SAP para crear OC desde fuera, habla HTTP/JSON (se integra con cualquier servicio sin librerías propietarias), no exige instalar nada en el agente y respeta las validaciones y autorizaciones de SAP. Si el sistema fuera ECC y no S/4, la alternativa equivalente es el BAPI `BAPI_PO_CREATE1` expuesto como servicio por el middleware. RFC directo y carga por archivo quedan como Plan B.

**Mapeo del payload (7.4) a la estructura real** (los nombres exactos se confirman contra el servicio de la instalación):

| Payload | SAP |
|---|---|
| `sociedad`, `organizacion_compras` | Cabecera: sociedad y organización de compras |
| `proveedor.codigo_sap` | Cabecera: proveedor (`Supplier`) |
| `moneda`, `condiciones_pago` | Cabecera: moneda y condiciones de pago |
| `referencia.solicitud_id` | Campo de referencia externa de la cabecera (clave de idempotencia) |
| `posiciones[]` | Ítems de la OC: texto breve (40 caracteres), cantidad, unidad, precio |
| `centro_costo`, `subarea` | Imputación contable de cada ítem |
| `indicador_iva` | Código de impuesto del ítem |
| `aprobador`, `evidencia_sha256` | No tienen campo estándar: el PDF se adjunta a la OC por el servicio de adjuntos (GOS) y el hash se guarda en el texto de cabecera |
| `excepciones` | Texto de cabecera (para que contabilidad vea qué se aprobó con excepción) |

**Autenticación y credenciales.** Un usuario técnico de SAP con los permisos mínimos para crear OC (no uno personal), autenticado por OAuth 2.0 o certificado según lo que permita la instalación. Las credenciales viven en un gestor de secretos del servicio de despliegue y se inyectan como variables de entorno al adaptador. Nunca están en el prompt, en el repositorio ni en lo que ve el modelo.

**Idempotencia y errores.** El `solicitud_id` viaja como referencia externa de la cabecera. Antes de crear, el adaptador llama a `buscarOrdenPorReferencia`; si ya existe, devuelve esa OC. Si la llamada a crear termina en timeout o error de red, **no se reintenta a ciegas**: primero se consulta por referencia, porque la OC pudo haberse creado. La creación con cabecera e ítems en una sola petición es transaccional en SAP, así que un error parcial (cabecera sin ítems) no debería ocurrir; si SAP responde con error de validación se devuelve al chat con su mensaje, sin reintento, y `control.csv` lo registra como intento fallido.

**Limitación de hoy que esto resuelve:** el mock es atómico solo dentro de un proceso. Con varios servidores haría falta una restricción única en la base o la idempotencia de SAP, que es justo lo que aporta la referencia externa.

**Precio e IVA (riesgo de integración).** Los precios de la solicitud y la cotización dicen "IVA incl." y la posición además lleva un indicador de IVA (C1 = 19 %). En un SAP real el impuesto podría cobrarse dos veces (sol-001: 95 000 × 1,19 × 120 = 13 566 000 en vez de 11 400 000). En el demo se usa el precio de la solicitud tal cual para que cada valor sea trazable; para producción hay que enviar el precio neto (la cotización trae la base gravable, 9 579 832 en sol-001) o marcar el ítem como "IVA incluido".

**Plan B si la conexión no es viable.** El agente igual ahorra el trabajo pesado: lee, valida, deriva datos y genera la evidencia. Puede entregar la OC lista para pegar (una tabla campo por campo en el orden de las pantallas de SAP GUI) o un archivo de carga masiva (CSV/LSMW) que la analista cargue en bloque. El ahorro sigue siendo la validación y la digitación manual, y el registro de control no cambia.

## 7. Lectura del proceso (OC retroactivas)

**Qué le diría a la dirección.** Una OC retroactiva es una compra que ya ocurrió: cuando se pide la OC, la factura ya existe. En los datos de prueba pasa en 1 de 6 casos (sol-005: cotización del 5 de agosto, factura del 10, solicitud del 27). Es un síntoma, no un error de digitación: alguien compró antes de que existiera el compromiso presupuestal, así que los controles de aprobación y de tope se aplican *después* de gastar, que es cuando ya no sirven para evitar nada. Además la cotización se salta, por lo que no hay comparación de precios.

Hoy el agente **no las rechaza ni las oculta**: las marca (`retroactiva = true` en `out/control.csv`), exige confirmación y deja el dato medible. La política (tolerar con marca o rechazar) es de la dirección, y el PRD la deja fuera del alcance.

**Cambio de proceso que propondría.**
1. Medir primero, antes de prohibir: un mes con el agente marcando, y un reporte simple (porcentaje por área, por proveedor y por monto).
2. Pedir la OC *antes* de recibir la factura: el solicitante abre la solicitud al decidir comprar, no cuando llega la factura. El proveedor debe recibir el número de OC al aceptar el pedido.
3. Una regla de tolerancia por monto: bajo cierto valor, retroactiva con marca y justificación breve; sobre ese valor, aprobación explícita del líder y de contabilidad.
4. Reportar a cada líder sus retroactivas, para que el dato cambie el comportamiento y no solo llene un archivo.

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **La confirmación humana la decide el código**: el modelo no ve `confirmado` y el ciclo solo lo agrega ante una confirmación explícita posterior | Dejar al modelo decidir si el usuario confirmó | Un modelo puede equivocarse o ser manipulado por el texto de un correo. En código la regla es fija y se prueba. El costo es rigidez: "Sin problema, confirmo" se vuelve a preguntar (falla hacia "no confirmó"). |
| 2 | **Bun + TypeScript estricto + zod** | Node con `tsx` y más herramientas | Un solo ejecutable corre TypeScript, pruebas y empaquetado del front; menos piezas que explicar en 2 horas. |
| 3 | **Front en React empaquetado por Bun, CSS a mano** | HTML plano (poco claro para ver pasos y confirmaciones) y Vite + Tailwind (demasiado para el tiempo) | El chat necesita mostrar herramientas, pendiente de confirmación y estados; React lo resuelve sin una cadena de herramientas aparte. |
| 4 | **Cada sesión con su propio SAP simulado** | Un solo `out/` compartido | En una URL pública el segundo visitante que procese sol-001 recibiría "ya existía". El costo: las sesiones viven en memoria y se pierden al reiniciar. |
| 5 | **Solo RC1–RC10, sin controles extra** | Agregar validación de moneda, montos ≤ 0, códigos inexistentes, NIT cruzado | Tiempo. Se documentan como limitaciones (sección 12). Los datos inválidos nunca se inventan: devuelven error. |
| 6 | **`generateContent` de Gemini** | La API nueva Interactions (recomendada por Google para proyectos nuevos) | Era la que se podía verificar con la documentación sin una clave; sigue soportada. Migrar sería cambiar `gemini.ts`, sin tocar el ciclo. |
| 7 | **Despliegue en Render con Docker** | Fly.io | Render tiene plan gratuito y lee el Dockerfile y el `render.yaml` del repo, con un Blueprint de pocos pasos. El costo: el servicio se duerme tras unos 15 minutos sin visitas y la primera carga tarda cerca de un minuto. |
| 8 | **Al modelo se le muestra solo `caso`; el resto se recalcula del disco** | Pasar el paquete entero por el modelo | Evita que el modelo "arregle" un monto (riesgo del PRD) y ahorra tokens. |

## 9. Supuestos

- Los maestros de los fixtures están completos; en producción se consultan en SAP en tiempo real.
- El correo de aprobación es evidencia suficiente. Auditoría puede exigir firma digital.
- **La unidad de medida (`UN`, `H`, `MES`) no viene en ningún dato**: se infiere de la descripción ("hora" → `H`, "mensual" → `MES`, si no `UN`). Una descripción como "Licencia con 8 horas de soporte" daría `H` por error.
- sol-001 dice "vigencia 12 meses" pero son 120 licencias: la unidad es `UN`, no `MES`; solo el precio explícitamente mensual cuenta como `MES`.
- Las fechas se manejan en hora de Colombia: a las 9:30 p. m. en Bogotá ya es "mañana" en UTC, y la fecha de negocio es la de Colombia.
- El precio de la solicitud incluye IVA y se usa tal cual (ver sección 6).
- No hay usuarios: `confirmado_por` guarda `sesion:<id>`; en producción sería la persona autenticada.
- La cotización solo se lee por su total; un parser por ítems daría más trazabilidad.
- Una cotización "con vigencia de N días" se convierte en fecha sumando a su emisión.

## 10. Cobertura

| Historia | Estado | Cómo se verifica |
|---|---|---|
| HU-1 Leer el paquete | Hecho | `oc_leer_paquete`; adjunto ausente → `faltantes`, sin excepciones; factura ilegible también se reporta |
| HU-2 Validar controles | Hecho | RC1–RC10; `{ apta, bloqueos, confirmaciones, derivados }` con `accion_sugerida` |
| HU-3 Construir el payload | Hecho | Validado con zod; trazabilidad en `out/<caso>/trazabilidad.json` |
| HU-4 Evidencia | Hecho (P0 y P1) | `aprobacion.txt` con sha256 y `aprobacion.pdf`, deterministas |
| HU-5 Crear la OC | Hecho | Numeración desde 4500000001, idempotencia, `out/control.csv` con cada intento |
| HU-6 Errores | Hecho | `{ ok: false, error }` legible; JSON roto, monto no numérico, ruta peligrosa |
| `demo.ts` sin modelo | Hecho | 6 de 6 casos y 5 de 5 comprobaciones; sale con código 0 |
| Chat web con pasos, banner y botones de confirmación | Hecho | Verificado en navegador (escritorio, celular, modo claro y oscuro) |
| Modelo real en URL pública | Hecho | Probado con sol-001, 002, 004, 005 y una pregunta de conocimiento |
| Bonus `modulo/` | No hecho | Fuera del alcance por tiempo |
| Lectura real de `.xlsx` y PDF | No hecho | Los fixtures traen JSON y texto (P1 opcional) |

**Verificación automática:** 471 pruebas en 19 archivos y tipos estrictos sin errores (`bun run verificar`). Además se rompieron a propósito 8 defensas del agente y 10 del servidor, y las pruebas detectaron las 18.

**Qué falta para producción:** adaptador SAP real (sección 6), maestros consultados en vivo, autenticación por usuario, almacén compartido de sesiones y límites para varias réplicas, firma de la evidencia, y los controles extra de la sección 12.

## 11. Uso de IA

Declaro los asistentes de IA que usé para construir esta solución:

| Asistente | Para qué lo usé |
|---|---|
| **Claude** (Anthropic) | **Asistente de código:** escribir y revisar el código y los comentarios del repositorio, con mi aprobación paso a paso. **Investigación técnica:** consultar la documentación vigente de la API de Gemini y la de las herramientas del proyecto. **Pruebas y revisión de calidad:** escribir pruebas, romper defensas a propósito para comprobar que las pruebas las detectan y revisar el chat en el navegador. |

**Gemini** no es una herramienta con la que construí: es el motor del agente en tiempo de ejecución (sección 4).

**Cómo trabajé:** cada tarea se explicó antes de hacerse, yo aprobaba el plan y revisaba cada commit antes de subirlo. Las decisiones de diseño las tomé yo entre las opciones que se me presentaron.

**Qué descarté de lo que se propuso, y por qué:**
- **Más controles que RC1–RC10** (moneda, montos negativos, cruces de NIT): se dejaron fuera por tiempo y quedan documentados como limitación.
- **HTML plano y Vite + Tailwind** para el front: el primero era poco claro, el segundo demasiado para el tiempo.
- **Dejar que el modelo decida si el usuario confirmó:** se cambió por una regla en código.
- **La API Interactions de Gemini:** no se pudo verificar sin clave.
- Una declaración de uso de IA que no nombrara al asistente: se rechazó; el PRD exige declarar cuáles se usaron.

**Lo que no pude comprobar con el asistente:** los límites y el precio de la capa gratuita de Gemini, y si Google usa esos datos para mejorar sus productos.

## 12. Riesgos para producción y mitigación

| Riesgo | Mitigación |
|---|---|
| **IVA cobrado dos veces** (precio con IVA + indicador de IVA) | Enviar precio neto o marcar el ítem como "IVA incluido"; prueba con una OC real antes de activar (sección 6) |
| **El modelo "arregla" un monto o confirma por el usuario** | Los montos salen de las herramientas, que recalculan del disco; el modelo no ve `confirmado`, `paquete` ni `payload`; las confirmaciones las decide el código. Probado con 8 mutaciones |
| **Instrucciones escondidas en un correo** | Al modelo no llega el texto del correo ni de la cotización; aun si obedeciera una, no puede crear una OC dudosa. Probado |
| **Gasto abusivo de la clave del modelo** | Clave de acceso con bloqueo por fuerza bruta, límite por visitante, tope global diario y tope por sesión |
| **Despliegue de una sola instancia** (sesiones y límites en memoria) | Almacén compartido (por ejemplo Redis) y sesiones persistentes para escalar |
| **Límites por IP** (varias personas tras una misma red comparten cupo) | Límite por usuario autenticado |
| **Clave de acceso compartida** | Autenticación por usuario; servir siempre por HTTPS (Render lo hace) |
| **Conexión a SAP no viable** | Plan B de la sección 6: OC lista para pegar o archivo de carga masiva |
| **Doble creación con varios procesos** | Idempotencia de SAP con referencia externa; consultar antes de reintentar |
| **Confirmación ligada a los códigos y no a los montos** (si un dato cambia entre mostrar y confirmar sin cambiar los códigos, sigue valiendo) | Guardar una huella de lo mostrado y compararla al confirmar |
| **Modelo pequeño que orquesta mal las herramientas** | Las compuertas están en código; si fallara con frecuencia, `LLM_MODEL=gemini-3.6-flash` |
| **Controles que faltan:** moneda distinta de COP/USD o no convertida (RC3 y RC5 no la miran), montos en cero o negativos que cuadren, códigos de IVA o de pago inexistentes, proveedor por nombre con dos coincidencias (toma la primera), NIT de la cotización sin contrastar | Agregar esos controles antes de producción |
| **El plan gratuito de Render duerme el servicio** | Abrirlo unos minutos antes de una demo, o pasar a un plan de pago |
| **Evidencia sin firma digital** | Firmar el PDF o adjuntar el `.eml` original si auditoría lo exige |
| **PDF con fuentes estándar** (emojis y otros alfabetos salen como `?`; el `.txt` conserva todo) | Incrustar una fuente Unicode |
| **Si falla la escritura del log, la herramienta sigue sin avisar** | Alerta o log centralizado |
| **Datos de la capa gratuita de Gemini** (uso por Google no verificado) | Solo datos ficticios en el demo; en producción, un plan que garantice no usar los datos |
