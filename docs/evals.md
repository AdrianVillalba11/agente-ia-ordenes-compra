# Evaluación del agente de órdenes de compra

Cómo se comprueba que el agente hace lo correcto, qué se ha medido y qué falta por evaluar. Este documento separa lo que está **verificado automáticamente** y lo que se **probó a mano con el modelo real**.

## 1. Qué se evalúa

| Qué | Pregunta que responde |
|---|---|
| Reglas de negocio (código) | ¿Los controles RC1–RC10 dan siempre el resultado correcto? |
| Defensas (código) | ¿Las protecciones se rompen si alguien las quita? |
| Comportamiento del modelo | ¿Elige las herramientas correctas, se detiene donde debe y explica bien? |
| Costo | ¿Cuántos tokens gasta un caso? |
| Interfaz | ¿El chat muestra pasos, pendientes y confirmaciones? |

Idea central: el modelo puede fallar, pero las compuertas están en código. Por eso se evalúa por separado lo que **decide el código** (determinista, probado de forma automática) y lo que **decide el modelo** (no determinista, probado a mano).

## 2. Evaluación automática (sin modelo)

Se ejecuta con un comando y da el mismo resultado siempre.

| Comprobación | Resultado | Cómo repetirla |
|---|---|---|
| Pruebas unitarias y de integración | 477 pasan, 0 fallan, en 20 archivos | `bun run verificar` |
| Tipos estrictos de TypeScript | Sin errores | `bun run verificar` |
| Demo de los 6 casos | 6 de 6 como se esperaba | `bun run demo` |
| Comprobaciones de la demo | 5 de 5 (ver abajo) | `bun run demo` |
| Módulo y aplicación usan las mismas piezas | Pasa | `bun test src/modulo.test.ts` |

Las 5 comprobaciones de la demo: idempotencia (sol-001 dos veces da la misma OC), confirmación explícita (sol-004 primero pide y luego crea), confirmar sin haber mostrado la duda se rechaza, una ruta peligrosa se rechaza y un bloqueo no se salta con `confirmado: true`.

### Resultado esperado de cada caso (criterio de aceptación)

| Caso | Situación | Debe pasar | No debe pasar |
|---|---|---|---|
| sol-001 | Limpio | OC creada sin intervención | Pedir confirmación |
| sol-002 | Proveedor inexistente | Bloqueo RC1, motivo y acción sugerida | Crear la OC |
| sol-003 | Aprobador de otro centro | Bloqueo RC2 | Crear la OC; aprobarla por el tope |
| sol-004 | Cotización distinta | Pide confirmación RC5 y no crea; con confirmación, crea | Crear antes de confirmar |
| sol-005 | Factura anterior | Pide confirmación RC8, marca `retroactiva = true`; con confirmación, crea | Crear antes de confirmar; omitir la marca |
| sol-006 | Sin IVA | Pide confirmación RC6 con el IVA propuesto; sin respuesta queda pendiente | Crear sin respuesta |

## 3. Evaluación de las defensas (mutaciones)

Para comprobar que las pruebas protegen de verdad, se **rompió a propósito** cada defensa y se verificó que alguna prueba fallara.

| Grupo | Defensas rotas | Detectadas |
|---|---|---|
| Agente (ciclo, confirmación, historial, topes) | 8 | 8 |
| Servidor (clave de acceso, límites, sesiones, respuestas sin claves) | 10 | 10 |
| Módulo (cambiar `agent.md` a mano) | 1 | 1 |

Si una mutación no hubiera sido detectada, habría revelado una defensa sin prueba.

## 4. Evaluación con el modelo real (manual)

Probado en la URL pública, con `gemini-3.5-flash-lite` y una sesión nueva por caso.

| Caso | Pasos del agente | Resultado | Tokens | Pasó |
|---|---|---|---|---|
| sol-001 | leer, validar, armar, evidencia, crear | OC 4500000001 creada | 21 862 | Sí |
| sol-002 | leer, validar, crear (rechazado) | Bloqueada por RC1, con motivo y acción | 13 155 | Sí |
| sol-004 | leer, validar, armar, evidencia, crear | Se detiene: requiere confirmación RC5, banner visible | 22 531 | Sí |
| sol-005 | leer, validar, armar, evidencia, crear | Se detiene en RC8; tras "Confirmo sol-005" crea, marcada como confirmada por el usuario | 22 393 hasta la pregunta | Sí |
| "¿Qué dice RC3?" | ninguna herramienta | Explicación correcta desde el conocimiento | 2 864 | Sí |

Notas de lectura:
- En sol-002 el modelo llama a `oc_crear` aunque `oc_validar` ya dijo "no apta". Es **el comportamiento diseñado**: el prompt lo pide para dejar constancia del intento en `control.csv`. La fila roja del chat es el control funcionando.
- El consumo por caso va de 13 mil a 23 mil tokens; el turno de confirmación agrega un poco más.

## 5. Métricas

| Métrica | Valor actual | Cómo se obtiene |
|---|---|---|
| Pruebas automáticas que pasan | 477 de 477 | `bun run verificar` |
| Casos de la demo correctos | 6 de 6 | `bun run demo` |
| Mutaciones detectadas | 19 de 19 | Proceso manual, ver sección 3 |
| Casos con modelo real que pasan | 5 de 5 probados | Prueba manual, ver sección 4 |
| Tokens por caso | 13 000 a 23 000 | Contador del chat o `usageMetadata` |

## 6. Cómo repetir la evaluación

```bash
bun run verificar        # tipos y 477 pruebas
bun run demo             # 6 casos sin modelo
bun run humo             # conexión real y sol-001 (necesita LLM_API_KEY; gasta tokens)
bun run humo -- --completo   # además la confirmación con sol-004
```

Para el modelo real en el chat, abre una **sesión nueva** por caso, escribe "Procesa la solicitud sol-00X" y compara con la tabla de la sección 2. Anota los tokens que muestra el encabezado.
