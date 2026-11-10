// =====================================================================
// mock.test.ts — Pruebas del SAP simulado.
//
// Cubren la numeración, la idempotencia, la atomicidad ante llamadas
// simultáneas, el archivo dañado, la fecha en Colombia y la consulta de
// proveedores. Escriben en carpetas temporales, nunca en el proyecto.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validarPaquete } from "../dominio/controles.ts";
import { cargarMaestros } from "../dominio/maestros.ts";
import { construirOrden } from "../dominio/orden.ts";
import { leerPaquete } from "../dominio/paquete.ts";
import type { OrdenCompra } from "../esquemas.ts";
import { ErrorSap } from "./adapter.ts";
import { diaEnBogota, PRIMER_NUMERO_OC, SapMock } from "./mock.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");
// 2026-11-10 02:30 UTC son las 9:30 p. m. del 9 de noviembre en Colombia
const RELOJ = (): Date => new Date("2026-11-10T02:30:00Z");

// Una OC real (la de sol-001) con la solicitud que se indique
function ordenConId(solicitudId: string): OrdenCompra {
  const maestros = cargarMaestros(RAIZ);
  const paquete = leerPaquete("sol-001", RAIZ);
  if (!maestros.ok || !paquete.ok) throw new Error("No se pudieron cargar los fixtures");
  const construida = construirOrden(paquete.data, validarPaquete(paquete.data, maestros.data), "a".repeat(64));
  if (!construida.ok) throw new Error(construida.error);
  const orden = construida.data.orden;
  return { ...orden, referencia: { ...orden.referencia, solicitud_id: solicitudId } };
}

const raicesTemporales: string[] = [];
function nuevaRaiz(): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-sap-"));
  raicesTemporales.push(raiz);
  return raiz;
}

function rutaOrdenes(raiz: string): string {
  return join(raiz, "out", "sap", "ordenes.jsonl");
}

// Líneas escritas en ordenes.jsonl
function lineasDe(raiz: string): string[] {
  return readFileSync(rutaOrdenes(raiz), "utf-8")
    .split("\n")
    .filter((linea) => linea.trim() !== "");
}

afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Fecha en Colombia
// ---------------------------------------------------------------------

describe("diaEnBogota", () => {
  test("a las 9:30 p. m. en Colombia sigue siendo el día 9, aunque en UTC ya sea el 10", () => {
    expect(diaEnBogota(new Date("2026-11-10T02:30:00Z"))).toBe("2026-11-09");
  });

  test("el cambio de día ocurre a la medianoche de Colombia (05:00 UTC)", () => {
    expect(diaEnBogota(new Date("2026-11-10T04:59:59Z"))).toBe("2026-11-09");
    expect(diaEnBogota(new Date("2026-11-10T05:00:00Z"))).toBe("2026-11-10");
  });

  test("al mediodía coinciden los dos días", () => {
    expect(diaEnBogota(new Date("2026-11-09T17:00:00Z"))).toBe("2026-11-09");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Numeración
// ---------------------------------------------------------------------

describe("SapMock: numeración", () => {
  test("la primera orden es la 4500000001 y las siguientes son consecutivas", async () => {
    const sap = new SapMock(nuevaRaiz(), RELOJ);
    expect(PRIMER_NUMERO_OC).toBe(4500000001);
    expect((await sap.crearOrden(ordenConId("SOL-A"))).numero_oc).toBe("4500000001");
    expect((await sap.crearOrden(ordenConId("SOL-B"))).numero_oc).toBe("4500000002");
    expect((await sap.crearOrden(ordenConId("SOL-C"))).numero_oc).toBe("4500000003");
  });

  test("devuelve la fecha de Colombia y guarda número, fecha y orden completa en el archivo", async () => {
    const raiz = nuevaRaiz();
    const creada = await new SapMock(raiz, RELOJ).crearOrden(ordenConId("SOL-A"));
    expect(creada).toEqual({ numero_oc: "4500000001", fecha: "2026-11-09" });

    const [linea] = lineasDe(raiz);
    const guardada = JSON.parse(linea ?? "{}") as { numero_oc: string; fecha: string; orden: OrdenCompra };
    expect(guardada.numero_oc).toBe("4500000001");
    expect(guardada.fecha).toBe("2026-11-09");
    expect(guardada.orden.referencia.solicitud_id).toBe("SOL-A");
  });

  test("sigue la numeración tras un reinicio (otra instancia sobre el mismo archivo)", async () => {
    const raiz = nuevaRaiz();
    await new SapMock(raiz, RELOJ).crearOrden(ordenConId("SOL-A"));
    const reiniciado = new SapMock(raiz, RELOJ);
    expect((await reiniciado.crearOrden(ordenConId("SOL-B"))).numero_oc).toBe("4500000002");
  });

  test("el siguiente número sale del mayor existente, no de contar líneas", async () => {
    const raiz = nuevaRaiz();
    mkdirSync(join(raiz, "out", "sap"), { recursive: true });
    const orden = ordenConId("SOL-A");
    writeFileSync(rutaOrdenes(raiz), `${JSON.stringify({ numero_oc: "4500000007", fecha: "2026-01-01", orden })}\n`);

    expect((await new SapMock(raiz, RELOJ).crearOrden(ordenConId("SOL-B"))).numero_oc).toBe("4500000008");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Idempotencia y llamadas simultáneas
// ---------------------------------------------------------------------

describe("SapMock: idempotencia y atomicidad", () => {
  test("crear dos veces la misma solicitud devuelve la misma orden y no duplica", async () => {
    const raiz = nuevaRaiz();
    const sap = new SapMock(raiz, RELOJ);
    const primera = await sap.crearOrden(ordenConId("SOL-A"));
    const segunda = await sap.crearOrden(ordenConId("SOL-A"));

    expect(segunda.numero_oc).toBe(primera.numero_oc);
    expect(segunda.ya_existia).toBe(true);
    expect(primera.ya_existia).toBeUndefined();
    expect(lineasDe(raiz)).toHaveLength(1);
  });

  test("buscarOrdenPorReferencia encuentra la existente y devuelve null si no hay", async () => {
    const sap = new SapMock(nuevaRaiz(), RELOJ);
    expect(await sap.buscarOrdenPorReferencia("SOL-A")).toBeNull(); // aún no existe el archivo
    await sap.crearOrden(ordenConId("SOL-A"));
    expect(await sap.buscarOrdenPorReferencia("SOL-A")).toEqual({ numero_oc: "4500000001", fecha: "2026-11-09" });
    expect(await sap.buscarOrdenPorReferencia("SOL-OTRA")).toBeNull();
  });

  test("10 solicitudes distintas a la vez reciben 10 números únicos y consecutivos", async () => {
    const raiz = nuevaRaiz();
    const sap = new SapMock(raiz, RELOJ);
    const creadas = await Promise.all(Array.from({ length: 10 }, (_, i) => sap.crearOrden(ordenConId(`SOL-${i}`))));

    const numeros = creadas.map((c) => c.numero_oc).sort();
    expect(numeros).toEqual(Array.from({ length: 10 }, (_, i) => String(4500000001 + i)));
    expect(lineasDe(raiz)).toHaveLength(10);
  });

  test("la misma solicitud 5 veces a la vez crea una sola orden", async () => {
    const raiz = nuevaRaiz();
    const sap = new SapMock(raiz, RELOJ);
    const resultados = await Promise.all(Array.from({ length: 5 }, () => sap.crearOrden(ordenConId("SOL-A"))));

    expect(new Set(resultados.map((r) => r.numero_oc)).size).toBe(1);
    expect(resultados.filter((r) => r.ya_existia === true)).toHaveLength(4);
    expect(lineasDe(raiz)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Archivo dañado y órdenes inválidas
// ---------------------------------------------------------------------

describe("SapMock: datos dañados", () => {
  async function conArchivoDanado(contenido: string): Promise<{ raiz: string; error: unknown }> {
    const raiz = nuevaRaiz();
    mkdirSync(join(raiz, "out", "sap"), { recursive: true });
    writeFileSync(rutaOrdenes(raiz), contenido);
    const error = await new SapMock(raiz, RELOJ).crearOrden(ordenConId("SOL-A")).catch((e: unknown) => e);
    return { raiz, error };
  }

  test("una línea que no es JSON detiene todo y no escribe nada", async () => {
    const { raiz, error } = await conArchivoDanado("esto no es json\n");
    expect(error).toBeInstanceOf(ErrorSap);
    expect((error as ErrorSap).message).toContain("dañado en la línea 1");
    expect(readFileSync(rutaOrdenes(raiz), "utf-8")).toBe("esto no es json\n");
  });

  test("una línea con JSON válido pero sin la forma de una orden también se rechaza", async () => {
    const { error } = await conArchivoDanado("{}\n");
    expect(error).toBeInstanceOf(ErrorSap);
  });

  test("buscar en un archivo dañado también falla, en vez de responder 'no existe'", async () => {
    const raiz = nuevaRaiz();
    mkdirSync(join(raiz, "out", "sap"), { recursive: true });
    writeFileSync(rutaOrdenes(raiz), "basura\n");
    const error = await new SapMock(raiz, RELOJ).buscarOrdenPorReferencia("SOL-A").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorSap);
  });

  test("SAP rechaza una orden que no cumple el esquema", async () => {
    const raiz = nuevaRaiz();
    const invalida = { ...ordenConId("SOL-A"), sociedad: "2000" } as unknown as OrdenCompra;
    const error = await new SapMock(raiz, RELOJ).crearOrden(invalida).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorSap);
    expect((error as ErrorSap).message).toContain("rechazó");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — Consulta de proveedores
// ---------------------------------------------------------------------

describe("SapMock: consultarProveedor", () => {
  const sap = new SapMock(RAIZ, RELOJ); // solo lee los maestros: no escribe nada

  test("reconoce un NIT con puntos y dígito de verificación", async () => {
    expect(await sap.consultarProveedor("900.555.111-2")).toEqual({ codigo_sap: "100234", activo: true });
  });

  test("un proveedor inactivo se informa como inactivo", async () => {
    expect(await sap.consultarProveedor("901777888")).toEqual({ codigo_sap: "100402", activo: false });
  });

  test("un NIT que no existe da null", async () => {
    expect(await sap.consultarProveedor("901999000")).toBeNull();
  });

  test("sin maestro de proveedores da un error claro de SAP", async () => {
    const error = await new SapMock(nuevaRaiz(), RELOJ).consultarProveedor("900555111").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorSap);
  });
});
