// =====================================================================
// paquete.test.ts — Pruebas de la lectura del paquete y de oc_leer_paquete.
//
// Se prueba con los 6 casos reales del reto y con casos rotos que se
// arman en carpetas temporales (sin tocar los fixtures).
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EsquemaPaquete, type Paquete, type Resultado } from "../esquemas.ts";
import { leer_paquete } from "../tools/oc.ts";
import { esAprobado, leerPaquete, sumarDias } from "./paquete.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");
const CARPETA_CASOS = join(RAIZ, "fixtures", "reto-03", "solicitudes");

// Si el resultado no es ok, la prueba falla con el motivo; si lo es, devuelve el paquete
function datosDe(resultado: Resultado<Paquete>): Paquete {
  if (!resultado.ok) throw new Error(`Se esperaba ok, pero falló: ${resultado.error}`);
  return resultado.data;
}

// Si el resultado es ok, la prueba falla; si no lo es, devuelve el mensaje de error
function errorDe(resultado: Resultado<Paquete>): string {
  if (resultado.ok) throw new Error("Se esperaba un error, pero salió ok");
  return resultado.error;
}

// Copia los archivos reales de un caso, salvo los excluidos
function archivosDe(caso: string, excluir: string[] = []): Record<string, string> {
  const carpeta = join(CARPETA_CASOS, caso);
  const salida: Record<string, string> = {};
  for (const nombre of readdirSync(carpeta)) {
    if (!excluir.includes(nombre)) salida[nombre] = readFileSync(join(carpeta, nombre), "utf-8");
  }
  return salida;
}

// Crea una raíz de proyecto temporal con un solo caso ("caso-x") y los archivos dados
const raicesTemporales: string[] = [];
function crearRaizConCaso(archivos: Record<string, string>): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-prueba-"));
  raicesTemporales.push(raiz);
  const carpeta = join(raiz, "fixtures", "reto-03", "solicitudes", "caso-x");
  mkdirSync(carpeta, { recursive: true });
  for (const [nombre, contenido] of Object.entries(archivos)) {
    writeFileSync(join(carpeta, nombre), contenido);
  }
  return raiz;
}

afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Los 6 casos reales
// ---------------------------------------------------------------------

// Valores esperados, escritos a mano a partir de los fixtures
const ESPERADOS = {
  "sol-001": { numero: "COT-TS-2026-0451", nit: "900555111", total: 11400000, validez: "2026-09-17", de: "mlopez@periferia-ficticia.com" },
  "sol-002": { numero: "SDN-0093", nit: "901999000", total: 8500000, validez: "2026-09-05", de: "mlopez@periferia-ficticia.com" },
  "sol-003": { numero: "MA-2026-1177", nit: "830111222", total: 74000000, validez: "2026-10-04", de: "fvargas@periferia-ficticia.com" },
  "sol-004": { numero: "CA-2026-0310", nit: "901222333", total: 26500000, validez: "2026-09-14", de: "dgarcia@periferia-ficticia.com" },
  "sol-005": { numero: "PC-5520", nit: "800444555", total: 3200000, validez: "2026-09-04", de: "rtorres@periferia-ficticia.com" },
  "sol-006": { numero: "COT-TS-2026-0468", nit: "900555111", total: 5400000, validez: "2026-09-27", de: "mlopez@periferia-ficticia.com" },
};

describe("leerPaquete con los 6 casos reales", () => {
  for (const [caso, esperado] of Object.entries(ESPERADOS)) {
    test(`${caso}: cotización, aprobación y esquema`, () => {
      const paquete = datosDe(leerPaquete(caso, RAIZ));

      // El paquete cumple su propio esquema y no le falta nada
      expect(EsquemaPaquete.safeParse(paquete).success).toBe(true);
      expect(paquete.faltantes).toEqual([]);

      // Datos de la cotización (NIT limpio, total correcto, validez calculada)
      expect(paquete.cotizacion?.numero).toBe(esperado.numero);
      expect(paquete.cotizacion?.nit).toBe(esperado.nit);
      expect(paquete.cotizacion?.total).toBe(esperado.total);
      expect(paquete.cotizacion?.moneda).toBe("COP");
      expect(paquete.cotizacion?.validez_hasta).toBe(esperado.validez);

      // La aprobación quedó marcada como aprobada y con su remitente
      expect(paquete.aprobacion?.aprobado).toBe(true);
      expect(paquete.aprobacion?.de).toBe(esperado.de);
    });
  }

  test("solo sol-005 trae factura (FC-88231, 10 de agosto)", () => {
    const conFactura = datosDe(leerPaquete("sol-005", RAIZ)).factura;
    expect(conFactura).toEqual({ numero: "FC-88231", fecha: "2026-08-10", total: 3200000 });

    for (const caso of ["sol-001", "sol-002", "sol-003", "sol-004", "sol-006"]) {
      expect(datosDe(leerPaquete(caso, RAIZ)).factura).toBeNull();
    }
  });

  test("sol-006 llega sin NIT, indicador de IVA ni condiciones de pago", () => {
    const { solicitud } = datosDe(leerPaquete("sol-006", RAIZ));
    expect(solicitud.proveedor_nit).toBeUndefined();
    expect(solicitud.indicador_iva).toBeUndefined();
    expect(solicitud.condiciones_pago).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Caso delicado 1: el nombre del caso es una entrada externa
// ---------------------------------------------------------------------

describe("nombre de caso inválido o inexistente", () => {
  test("rechaza intentos de salir de la carpeta de fixtures", () => {
    for (const intento of ["../../.env", "sol-001/../sol-002", "..", "sol 001", "", "C:\\Windows"]) {
      expect(leerPaquete(intento, RAIZ).ok).toBe(false);
    }
  });

  test("un caso inexistente da un error que lista los casos disponibles", () => {
    const mensaje = errorDe(leerPaquete("sol-999", RAIZ));
    expect(mensaje).toContain("no existe");
    expect(mensaje).toContain("sol-001");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Caso delicado 2: archivos ausentes o rotos, sin excepciones
// ---------------------------------------------------------------------

describe("archivos ausentes o ilegibles", () => {
  test("sin cotización ni aprobación: ambos null y anotados en faltantes", () => {
    const raiz = crearRaizConCaso(archivosDe("sol-001", ["cotizacion.txt", "aprobacion.json"]));
    const paquete = datosDe(leerPaquete("caso-x", raiz));
    expect(paquete.cotizacion).toBeNull();
    expect(paquete.aprobacion).toBeNull();
    expect(paquete.faltantes).toEqual(["cotizacion.txt", "aprobacion.json"]);
  });

  test("cotización ilegible (opción A): null y el motivo queda en faltantes", () => {
    const archivos = { ...archivosDe("sol-001"), "cotizacion.txt": "Texto sin formato" };
    const paquete = datosDe(leerPaquete("caso-x", crearRaizConCaso(archivos)));
    expect(paquete.cotizacion).toBeNull();
    expect(paquete.faltantes).toEqual(["cotizacion.txt: no se pudo leer el total"]);
  });

  test("factura ilegible se avisa: podría esconder una compra retroactiva", () => {
    const archivos = { ...archivosDe("sol-005"), "factura.txt": "pdf escaneado" };
    const paquete = datosDe(leerPaquete("caso-x", crearRaizConCaso(archivos)));
    expect(paquete.factura).toBeNull();
    expect(paquete.faltantes.some((f) => f.startsWith("factura.txt"))).toBe(true);
  });

  test("sin correo.json no hay paquete: error claro", () => {
    const raiz = crearRaizConCaso(archivosDe("sol-001", ["correo.json"]));
    expect(errorDe(leerPaquete("caso-x", raiz))).toContain("correo.json");
  });

  test("solicitud.json roto: error legible, sin excepción", () => {
    const archivos = { ...archivosDe("sol-001"), "solicitud.json": "{ esto no es json" };
    const mensaje = errorDe(leerPaquete("caso-x", crearRaizConCaso(archivos)));
    expect(mensaje).toContain("no es un JSON válido");
  });

  test("monto no numérico en la solicitud: el error nombra el campo", () => {
    const solicitud = JSON.parse(archivosDe("sol-001")["solicitud.json"] ?? "{}") as object;
    const archivos = { ...archivosDe("sol-001"), "solicitud.json": JSON.stringify({ ...solicitud, valor_total: "abc" }) };
    const mensaje = errorDe(leerPaquete("caso-x", crearRaizConCaso(archivos)));
    expect(mensaje).toContain("valor_total");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Caso delicado 3: "Aprobado" no basta si está negado
// ---------------------------------------------------------------------

describe("esAprobado", () => {
  test("reconoce aprobaciones reales", () => {
    expect(esAprobado("Aprobado, proceder con la orden de compra.")).toBe(true);
    expect(esAprobado("Aprobado por 25 millones según la solicitud.")).toBe(true);
    expect(esAprobado("APROBADO")).toBe(true);
  });

  test("no cuenta una aprobación negada", () => {
    expect(esAprobado("No aprobado")).toBe(false);
    expect(esAprobado("No está aprobado todavía")).toBe(false);
    expect(esAprobado("Sin aprobado del comité")).toBe(false);
  });

  test("no cuenta otros mensajes", () => {
    expect(esAprobado("Rechazado")).toBe(false);
    expect(esAprobado("Desaprobado")).toBe(false);
    expect(esAprobado("Lo reviso mañana")).toBe(false);
    expect(esAprobado("")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — Caso delicado 4: validez de la cotización en días
// ---------------------------------------------------------------------

describe("sumarDias", () => {
  test("cambia de mes", () => {
    expect(sumarDias("2026-08-18", 30)).toBe("2026-09-17");
  });

  test("cambia de año", () => {
    expect(sumarDias("2026-12-20", 15)).toBe("2027-01-04");
  });

  test("una fecha inválida da null", () => {
    expect(sumarDias("ayer", 30)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// BLOQUE 7 — La herramienta oc_leer_paquete
// ---------------------------------------------------------------------

describe("herramienta leer_paquete", () => {
  const contexto = { directory: RAIZ, sessionId: "prueba" };

  test("devuelve un string JSON con ok: true y el paquete", async () => {
    const respuesta = await leer_paquete.execute({ caso: "sol-001" }, contexto);
    expect(typeof respuesta).toBe("string");
    const objeto = JSON.parse(respuesta) as { ok: boolean; data?: Paquete };
    expect(objeto.ok).toBe(true);
    expect(objeto.data?.solicitud.solicitud_id).toBe("SOL-2026-001");
  });

  test("con un caso peligroso devuelve ok: false y no lanza", async () => {
    const respuesta = await leer_paquete.execute({ caso: "../../.env" }, contexto);
    const objeto = JSON.parse(respuesta) as { ok: boolean; error?: string };
    expect(objeto.ok).toBe(false);
    expect(objeto.error).toContain("inválido");
  });

  test("el esquema de argumentos también rechaza rutas peligrosas", () => {
    const esquema = z.object(leer_paquete.args);
    expect(esquema.safeParse({ caso: "sol-001" }).success).toBe(true);
    expect(esquema.safeParse({ caso: "../x" }).success).toBe(false);
  });
});
