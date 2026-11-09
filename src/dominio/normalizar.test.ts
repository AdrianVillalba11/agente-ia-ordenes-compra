// =====================================================================
// normalizar.test.ts — Pruebas de las utilidades de normalización.
//
// Cada bloque protege uno de los "casos delicados" de normalizar.ts.
// Se ejecutan con: bun test
// Además de casos inventados, se prueba contra los 6 casos reales del reto.
// =====================================================================

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  esFechaAnterior,
  normalizarNit,
  normalizarNombre,
  normalizarTexto,
  parsearMonto,
  soloDia,
} from "./normalizar.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes para leer los fixtures reales
// ---------------------------------------------------------------------

const RAIZ_FIXTURES = `${import.meta.dir}/../../fixtures/reto-03`;
const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];

function leerTexto(ruta: string): string {
  return readFileSync(`${RAIZ_FIXTURES}/${ruta}`, "utf-8");
}

function leerJson<T>(ruta: string): T {
  return JSON.parse(leerTexto(ruta)) as T;
}

// Busca el valor esperado de un caso y falla con un mensaje claro si no está definido.
// (No se usa un valor por defecto: un "null" por defecto podría coincidir por error
// con el resultado de un monto inválido y esconder un fallo.)
function esperadoDe<T>(tabla: Record<string, T>, caso: string): T {
  const valor = tabla[caso];
  if (valor === undefined) throw new Error(`Falta el valor esperado para ${caso}`);
  return valor;
}

// ---------------------------------------------------------------------
// BLOQUE 2 — NIT (caso delicado 1: el dígito de verificación)
// ---------------------------------------------------------------------

describe("normalizarNit", () => {
  test("quita los puntos y el dígito de verificación", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111");
  });

  test("un NIT ya limpio queda igual (idempotente)", () => {
    expect(normalizarNit("900555111")).toBe("900555111");
    expect(normalizarNit(normalizarNit("900.555.111-2"))).toBe("900555111");
  });

  test("ignora un prefijo de texto", () => {
    expect(normalizarNit("NIT 830.111.222-8")).toBe("830111222");
  });

  test("un texto sin dígitos da cadena vacía, no un valor inventado", () => {
    expect(normalizarNit("sin nit")).toBe("");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Montos (caso delicado 2: el punto de miles)
// ---------------------------------------------------------------------

describe("parsearMonto", () => {
  test("entiende el punto como separador de miles", () => {
    expect(parsearMonto("COP 11.400.000")).toBe(11400000);
    expect(parsearMonto("$ 1.500")).toBe(1500);
  });

  test("por qué no se usa parseFloat: daría un monto 1000 veces menor", () => {
    expect(parseFloat("11.400.000")).toBe(11.4);
  });

  test("acepta números sin separadores", () => {
    expect(parsearMonto("11400000")).toBe(11400000);
  });

  test("entiende coma decimal y punto decimal", () => {
    expect(parsearMonto("1.234,56")).toBe(1234.56);
    expect(parsearMonto("1,234.56")).toBe(1234.56);
    expect(parsearMonto("3,5")).toBe(3.5);
  });

  test("ignora puntuación al final del texto", () => {
    expect(parsearMonto("COP 3.200.000.")).toBe(3200000);
  });

  test("devuelve null si no hay un número (caso delicado 5)", () => {
    expect(parsearMonto("abc")).toBeNull();
    expect(parsearMonto("")).toBeNull();
    expect(parsearMonto("COP")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Texto (caso delicado 4: tildes y mayúsculas)
// ---------------------------------------------------------------------

describe("normalizarTexto y normalizarNombre", () => {
  test("los correos con tildes y mayúsculas se comparan igual", () => {
    expect(normalizarTexto("Sofía.Herrera@Periferia-Ficticia.com")).toBe(
      "sofia.herrera@periferia-ficticia.com",
    );
  });

  test("colapsa espacios repetidos", () => {
    expect(normalizarTexto("  Cloud   Andina ")).toBe("cloud andina");
  });

  test("el nombre de empresa pierde puntuación y tildes", () => {
    expect(normalizarNombre("Papelería Central Ltda.")).toBe("papeleria central ltda");
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe("tecnosuministros s a s");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Fechas (caso delicado 3: hora y zona horaria)
// ---------------------------------------------------------------------

describe("soloDia y esFechaAnterior", () => {
  test("toma el día escrito, sin convertir la zona horaria", () => {
    expect(soloDia("2026-08-26T18:45:00-05:00")).toBe("2026-08-26");
  });

  test("a las 22:30 en Colombia sigue siendo el mismo día (en UTC sería el siguiente)", () => {
    expect(soloDia("2026-08-26T22:30:00-05:00")).toBe("2026-08-26");
  });

  test("acepta una fecha sin hora", () => {
    expect(soloDia("2026-08-20")).toBe("2026-08-20");
  });

  test("rechaza fechas inválidas con null", () => {
    expect(soloDia("ayer")).toBeNull();
    expect(soloDia("2026-13-01")).toBeNull();
    expect(soloDia("2026-02-30")).toBeNull();
  });

  test("compara solo el día: la factura del 10-ago es anterior a la solicitud del 27-ago", () => {
    expect(esFechaAnterior("2026-08-10", "2026-08-27")).toBe(true);
  });

  test("el mismo día no es anterior, aunque la hora sea menor", () => {
    expect(esFechaAnterior("2026-08-26T09:00:00-05:00", "2026-08-26")).toBe(false);
  });

  test("con una fecha inválida devuelve null, no un sí o un no inventado", () => {
    expect(esFechaAnterior("ayer", "2026-08-27")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — Los 6 casos reales del reto
// ---------------------------------------------------------------------

describe("datos reales de los fixtures", () => {
  type FilaProveedor = { nit: string };
  type Aprobacion = { fecha: string };
  type Solicitud = { fecha_solicitud: string };

  const nitsDelMaestro = new Set(
    leerJson<FilaProveedor[]>("maestros/proveedores.json").map((p) => p.nit),
  );

  // Totales que trae cada cotización, escritos a mano para detectar errores del parser
  const totalesEsperados: Record<string, number> = {
    "sol-001": 11400000,
    "sol-002": 8500000,
    "sol-003": 74000000,
    "sol-004": 26500000,
    "sol-005": 3200000,
    "sol-006": 5400000,
  };

  // Día de la aprobación de cada caso, escrito a mano
  const diasAprobacion: Record<string, string> = {
    "sol-001": "2026-08-21",
    "sol-002": "2026-08-22",
    "sol-003": "2026-08-25",
    "sol-004": "2026-08-26",
    "sol-005": "2026-08-28",
    "sol-006": "2026-08-29",
  };

  for (const caso of CASOS) {
    test(`${caso}: total, NIT y fechas se normalizan bien`, () => {
      const cotizacion = leerTexto(`solicitudes/${caso}/cotizacion.txt`);

      // El total de la cotización se convierte al número correcto
      const lineaTotal = cotizacion.match(/^TOTAL \(IVA incluido\):\s*(.+)$/m)?.[1] ?? "";
      expect(parsearMonto(lineaTotal)).toBe(esperadoDe(totalesEsperados, caso));

      // El NIT de la cotización coincide con el del maestro (salvo sol-002, que no existe: RC1)
      const lineaNit = cotizacion.match(/^NIT:\s*(.+)$/m)?.[1] ?? "";
      expect(nitsDelMaestro.has(normalizarNit(lineaNit))).toBe(caso !== "sol-002");

      // La fecha de la aprobación se reduce al día correcto
      const aprobacion = leerJson<Aprobacion>(`solicitudes/${caso}/aprobacion.json`);
      expect(soloDia(aprobacion.fecha)).toBe(esperadoDe(diasAprobacion, caso));

      // Ninguna aprobación es anterior a su solicitud en estos casos (RC9 no se activa)
      const solicitud = leerJson<Solicitud>(`solicitudes/${caso}/solicitud.json`);
      expect(esFechaAnterior(aprobacion.fecha, solicitud.fecha_solicitud)).toBe(false);
    });
  }

  test("sol-005: la factura es anterior a la solicitud (será retroactiva en RC8)", () => {
    const factura = leerTexto("solicitudes/sol-005/factura.txt");
    const fechaFactura = factura.match(/^Fecha de emisión:\s*(.+)$/m)?.[1] ?? "";
    const solicitud = leerJson<Solicitud>("solicitudes/sol-005/solicitud.json");
    expect(esFechaAnterior(fechaFactura, solicitud.fecha_solicitud)).toBe(true);
  });
});
