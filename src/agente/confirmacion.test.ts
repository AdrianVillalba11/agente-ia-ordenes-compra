// =====================================================================
// confirmacion.test.ts — Pruebas de la regla "¿confirmó el usuario?".
//
// Es el control de seguridad más importante del agente, así que se
// prueba con frases reales de usuario: las que SÍ confirman, las que no
// y, sobre todo, las ambiguas. La regla debe fallar siempre hacia el
// lado seguro: ante la duda, "no confirmó".
// Se ejecutan con: bun test
// =====================================================================

import { describe, expect, test } from "bun:test";
import { casosQueSeConfirman, esConfirmacionExplicita } from "./confirmacion.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Qué mensajes son una confirmación
// ---------------------------------------------------------------------

describe("esConfirmacionExplicita: lo que sí confirma", () => {
  const CONFIRMAN = [
    "Confirmo",
    "confirmo",
    "CONFIRMO",
    "Sí",
    "si",
    "Sí, confirmo",
    "Sí, créala",
    "¡Sí!",
    "Adelante",
    "De acuerdo, procede",
    "Procede",
    "Confirmo crear la OC con estas excepciones",
    "Confirmo sol-004",
    "ok",
    "Ok.",
    "Dale",
    "Apruebo",
    "Autorizo la creación",
    "Crea la orden",
    "Confirmo aun con la diferencia del 6 %",
  ];

  for (const mensaje of CONFIRMAN) {
    test(`"${mensaje}"`, () => {
      expect(esConfirmacionExplicita(mensaje)).toBe(true);
    });
  }
});

describe("esConfirmacionExplicita: lo que NO confirma", () => {
  const NO_CONFIRMAN = [
    // Negaciones y dudas
    "No",
    "no confirmo",
    "No, no la crees",
    "Todavía no",
    "Espera, déjame revisar",
    "Cancela",
    "Cancélalo",
    "Mejor no",
    "Rechazo la excepción",
    "Detente",
    "Confirmo pero no la crees todavía",
    "Sin problema, confirmo", // "sin" cuenta como duda: ante la duda, se vuelve a preguntar
    // Preguntas
    "¿Confirmo?",
    "¿Qué pasa si confirmo?",
    "Sí, pero dime primero cuánto es la diferencia, ¿sí?",
    "Cuál es la diferencia?",
    // Una palabra afirmativa en medio de una oración que no es una confirmación
    "Si hay algún problema, avísame",
    "Dime si la OC quedó bien",
    "Necesito crear otra solicitud más tarde",
    "Crea otra solicitud",
    // Instrucciones y saludos
    "Procesa sol-005",
    "Hola",
    "Muéstrame la OC",
    "Qué significa RC5",
    // Vacíos
    "",
    "   ",
    "...",
  ];

  for (const mensaje of NO_CONFIRMAN) {
    test(`"${mensaje}"`, () => {
      expect(esConfirmacionExplicita(mensaje)).toBe(false);
    });
  }

  test("un mensaje largo no se trata como una confirmación, aunque contenga 'sí' o 'confirmo'", () => {
    const largo = `Confirmo ${"y además quiero que revises muchas otras cosas ".repeat(10)}`;
    expect(largo.length).toBeGreaterThan(200);
    expect(esConfirmacionExplicita(largo)).toBe(false);
  });

  test("tampoco confirma un mensaje con una negación aunque tenga una afirmación fuerte", () => {
    expect(esConfirmacionExplicita("Confirmo, no")).toBe(false);
    expect(esConfirmacionExplicita("De acuerdo, pero espera")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — A qué casos se refiere una confirmación
// ---------------------------------------------------------------------

describe("casosQueSeConfirman", () => {
  test("con un solo caso pendiente, 'Confirmo' se refiere a ese", () => {
    expect(casosQueSeConfirman("Confirmo", ["sol-004"])).toEqual(["sol-004"]);
  });

  test("con varios casos pendientes y sin decir cuál, no se confirma ninguno", () => {
    expect(casosQueSeConfirman("Confirmo", ["sol-004", "sol-005"])).toEqual([]);
    expect(casosQueSeConfirman("Sí, adelante", ["sol-004", "sol-005"])).toEqual([]);
  });

  test("con varios pendientes, se confirma solo el que se nombra", () => {
    expect(casosQueSeConfirman("Confirmo sol-005", ["sol-004", "sol-005"])).toEqual(["sol-005"]);
  });

  test("se pueden nombrar varios, sin importar mayúsculas", () => {
    expect(casosQueSeConfirman("CONFIRMO SOL-004 y SOL-005", ["sol-004", "sol-005", "sol-006"])).toEqual(["sol-004", "sol-005"]);
  });

  test("nombrar un caso que NO está pendiente no confirma el pendiente: no se adivina", () => {
    expect(casosQueSeConfirman("Confirmo sol-002", ["sol-004"])).toEqual([]);
  });

  test("si nombra uno pendiente y otro que no lo está, solo cuenta el pendiente", () => {
    expect(casosQueSeConfirman("Confirmo sol-004 y sol-002", ["sol-004"])).toEqual(["sol-004"]);
  });

  test("'sol-0040' es otro caso, no 'sol-004'", () => {
    expect(casosQueSeConfirman("Confirmo sol-0040", ["sol-004"])).toEqual([]);
  });

  test("si el mensaje no es una confirmación explícita, no se confirma nada aunque nombre el caso", () => {
    expect(casosQueSeConfirman("No confirmo sol-004", ["sol-004"])).toEqual([]);
    expect(casosQueSeConfirman("¿Confirmo sol-004?", ["sol-004"])).toEqual([]);
    expect(casosQueSeConfirman("Procesa sol-004", ["sol-004"])).toEqual([]);
  });

  test("sin casos pendientes no hay nada que confirmar", () => {
    expect(casosQueSeConfirman("Confirmo", [])).toEqual([]);
    expect(casosQueSeConfirman("Confirmo sol-004", [])).toEqual([]);
  });

  test("no modifica la lista de pendientes que recibe", () => {
    const pendientes = ["sol-004"];
    const resultado = casosQueSeConfirman("Confirmo", pendientes);
    resultado.push("sol-999");
    expect(pendientes).toEqual(["sol-004"]);
  });
});
