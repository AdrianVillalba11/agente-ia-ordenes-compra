// =====================================================================
// crear.test.ts — Pruebas de la herramienta oc_crear y de la comprobación
// de la evidencia.
//
// Es la prueba de extremo a extremo de las herramientas: recorre los 6
// casos reales como lo haría la analista (generar evidencia, crear,
// confirmar) y comprueba el archivo del SAP simulado y el registro de
// control, línea por línea. Trabaja sobre copias temporales de los fixtures
// y con un reloj fijo, así los resultados son exactos y repetibles.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { construirEvidencia, evidenciaCoincide } from "./evidencia.ts";
import { leerControl } from "./control.ts";
import type { ContextoHerramienta, OrdenCompra } from "../esquemas.ts";
import { construir_payload, crear, generar_evidencia } from "../tools/oc.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");
const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];

// 2026-11-10 02:30 UTC son las 9:30 p. m. del 9 de noviembre en Colombia
const RELOJ_FIJO = (): Date => new Date("2026-11-10T02:30:00Z");
const TS_FIJO = "2026-11-10T02:30:00.000Z";
const ENCABEZADO_CONTROL = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts";

type RespuestaCrear = {
  ok: boolean;
  data?: { numero_oc: string; fecha: string; idempotente: boolean };
  error?: string;
  requiere_confirmacion?: boolean;
  confirmaciones?: { codigo: string }[];
};

const raicesTemporales: string[] = [];

// Copia temporal de los fixtures: las herramientas escriben en out/ de esa copia
function copiarFixtures(): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-crear-"));
  raicesTemporales.push(raiz);
  cpSync(join(RAIZ, "fixtures"), join(raiz, "fixtures"), { recursive: true });
  return raiz;
}

function contexto(raiz: string, sesion = "prueba"): ContextoHerramienta {
  return { directory: raiz, sessionId: sesion, ahora: RELOJ_FIJO };
}

async function generarEvidencia(raiz: string, caso: string): Promise<void> {
  await generar_evidencia.execute({ caso }, contexto(raiz));
}

async function crearOc(
  raiz: string,
  args: Parameters<typeof crear.execute>[0],
  sesion = "prueba",
): Promise<RespuestaCrear> {
  return JSON.parse(await crear.execute(args, contexto(raiz, sesion))) as RespuestaCrear;
}

type RegistroOrden = { numero_oc: string; fecha: string; orden: OrdenCompra };

// Órdenes guardadas en el SAP simulado (vacío si aún no hay archivo)
function leerOrdenes(raiz: string): RegistroOrden[] {
  const ruta = join(raiz, "out", "sap", "ordenes.jsonl");
  if (!existsSync(ruta)) return [];
  return readFileSync(ruta, "utf-8")
    .split("\n")
    .filter((linea) => linea.trim() !== "")
    .map((linea) => JSON.parse(linea) as RegistroOrden);
}

function leerControlCrudo(raiz: string): string {
  return readFileSync(join(raiz, "out", "control.csv"), "utf-8");
}

function rutaCaso(raiz: string, caso: string, archivo: string): string {
  return join(raiz, "fixtures", "reto-03", "solicitudes", caso, archivo);
}

afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Los 6 casos, de principio a fin
// ---------------------------------------------------------------------

describe("flujo completo de los 6 casos reales", () => {
  test("cada caso termina como el PRD espera, y el SAP y el control quedan exactos", async () => {
    const raiz = copiarFixtures();
    for (const caso of CASOS) await generarEvidencia(raiz, caso);

    // sol-001: caso limpio, se crea sin intervención humana
    const s1 = await crearOc(raiz, { caso: "sol-001" });
    expect(s1.ok).toBe(true);
    expect(s1.data).toEqual({ numero_oc: "4500000001", fecha: "2026-11-09", idempotente: false });

    // sol-001 otra vez: idempotencia, el mismo número y ninguna orden nueva
    const s1bis = await crearOc(raiz, { caso: "sol-001" });
    expect(s1bis.data).toEqual({ numero_oc: "4500000001", fecha: "2026-11-09", idempotente: true });
    expect(leerOrdenes(raiz)).toHaveLength(1);

    // sol-002 y sol-003: bloqueadas, con la razón y la acción sugerida
    const s2 = await crearOc(raiz, { caso: "sol-002" });
    expect(s2.ok).toBe(false);
    expect(s2.error).toContain("RC1");
    expect(s2.error).toContain("alta del proveedor");
    const s3 = await crearOc(raiz, { caso: "sol-003" });
    expect(s3.ok).toBe(false);
    expect(s3.error).toContain("RC2");

    // sol-004, sol-005 y sol-006: piden confirmación, y solo se crean al confirmarse
    const esperadas: [string, string, string][] = [
      ["sol-004", "RC5", "4500000002"],
      ["sol-005", "RC8", "4500000003"],
      ["sol-006", "RC6", "4500000004"],
    ];
    for (const [caso, codigo, numero] of esperadas) {
      const pendiente = await crearOc(raiz, { caso });
      expect(pendiente.ok).toBe(false);
      expect(pendiente.requiere_confirmacion).toBe(true);
      expect(pendiente.confirmaciones?.map((c) => c.codigo)).toEqual([codigo]);

      const creada = await crearOc(raiz, { caso, confirmado: true });
      expect(creada.ok).toBe(true);
      expect(creada.data?.numero_oc).toBe(numero);
      expect(creada.data?.idempotente).toBe(false);
    }

    // El SAP simulado guarda 4 órdenes, numeradas en orden
    expect(leerOrdenes(raiz).map((r) => r.numero_oc)).toEqual(["4500000001", "4500000002", "4500000003", "4500000004"]);
    expect(leerOrdenes(raiz).map((r) => r.orden.referencia.solicitud_id)).toEqual([
      "SOL-2026-001",
      "SOL-2026-004",
      "SOL-2026-005",
      "SOL-2026-006",
    ]);

    // El registro de control: una fila por intento, exactamente
    expect(leerControlCrudo(raiz)).toBe(
      [
        ENCABEZADO_CONTROL,
        `SOL-2026-001,creada,4500000001,false,,,${TS_FIJO}`,
        `SOL-2026-001,ya_existente,4500000001,false,,,${TS_FIJO}`,
        `SOL-2026-002,bloqueada,,false,RC1,,${TS_FIJO}`,
        `SOL-2026-003,bloqueada,,false,RC2,,${TS_FIJO}`,
        `SOL-2026-004,pendiente_confirmacion,,false,,RC5,${TS_FIJO}`,
        `SOL-2026-004,creada,4500000002,false,,RC5,${TS_FIJO}`,
        `SOL-2026-005,pendiente_confirmacion,,true,,RC8,${TS_FIJO}`,
        `SOL-2026-005,creada,4500000003,true,,RC8,${TS_FIJO}`,
        `SOL-2026-006,pendiente_confirmacion,,false,,RC6,${TS_FIJO}`,
        `SOL-2026-006,creada,4500000004,false,,RC6,${TS_FIJO}`,
        "",
      ].join("\n"),
    );
  });

  test("sol-005: la compra retroactiva queda marcada en el control, tanto al quedar pendiente como al crearse", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-005");
    await crearOc(raiz, { caso: "sol-005" });
    await crearOc(raiz, { caso: "sol-005", confirmado: true });

    const filas = leerControl(raiz);
    expect(filas.map((f) => f.resultado)).toEqual(["pendiente_confirmacion", "creada"]);
    expect(filas.every((f) => f.retroactiva)).toBe(true);
  });

  test("el resultado es reproducible: dos ejecuciones iguales dejan los mismos archivos", async () => {
    const [a, b] = [copiarFixtures(), copiarFixtures()];
    for (const raiz of [a, b]) {
      await generarEvidencia(raiz, "sol-004");
      await crearOc(raiz, { caso: "sol-004" });
      await crearOc(raiz, { caso: "sol-004", confirmado: true });
    }
    expect(leerControlCrudo(a)).toBe(leerControlCrudo(b));
    expect(readFileSync(join(a, "out", "sap", "ordenes.jsonl"), "utf-8")).toBe(
      readFileSync(join(b, "out", "sap", "ordenes.jsonl"), "utf-8"),
    );
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Bloqueos: nunca se saltan
// ---------------------------------------------------------------------

describe("bloqueos", () => {
  test("confirmado: true no salta un bloqueo: no se crea y queda registrado", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-002");
    const respuesta = await crearOc(raiz, { caso: "sol-002", confirmado: true });

    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("bloqueos");
    expect(leerOrdenes(raiz)).toEqual([]);
    expect(leerControl(raiz).map((f) => f.resultado)).toEqual(["bloqueada"]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Confirmación humana: se muestra primero, se confirma después
// ---------------------------------------------------------------------

describe("confirmaciones", () => {
  test("confirmar directo, sin haber mostrado nada, no crea la OC y deja el pendiente registrado", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-004");

    const directa = await crearOc(raiz, { caso: "sol-004", confirmado: true });
    expect(directa.ok).toBe(false);
    expect(directa.requiere_confirmacion).toBe(true);
    expect(directa.error).toContain("aún no se mostró");
    expect(leerOrdenes(raiz)).toEqual([]);
    expect(leerControl(raiz).map((f) => f.resultado)).toEqual(["pendiente_confirmacion"]);

    // Ahora que quedó mostrada, la confirmación sí vale
    const confirmada = await crearOc(raiz, { caso: "sol-004", confirmado: true });
    expect(confirmada.ok).toBe(true);
    expect(confirmada.data?.numero_oc).toBe("4500000001");
  });

  test("si lo confirmable cambió después de mostrarse, la confirmación anterior ya no sirve", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-004");
    await crearOc(raiz, { caso: "sol-004" }); // se muestra solo RC5

    // La solicitud pasa a ser posterior a la aprobación: aparece también RC9
    const ruta = rutaCaso(raiz, "sol-004", "solicitud.json");
    const solicitud = JSON.parse(readFileSync(ruta, "utf-8")) as Record<string, unknown>;
    writeFileSync(ruta, JSON.stringify({ ...solicitud, fecha_solicitud: "2026-08-27" }));

    const respuesta = await crearOc(raiz, { caso: "sol-004", confirmado: true });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.confirmaciones?.map((c) => c.codigo)).toEqual(["RC5", "RC9"]);
    expect(leerOrdenes(raiz)).toEqual([]);
  });

  test("las excepciones de la OC quedan confirmadas por la sesión que las aceptó", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-004");
    await crearOc(raiz, { caso: "sol-004" }, "sesion-77");
    await crearOc(raiz, { caso: "sol-004", confirmado: true }, "sesion-77");

    const [registro] = leerOrdenes(raiz);
    expect(registro?.orden.excepciones).toHaveLength(1);
    expect(registro?.orden.excepciones[0]).toMatchObject({ codigo: "RC5", confirmado_por: "sesion:sesion-77" });
  });

  test("una OC sin confirmaciones se crea de una vez, sin excepciones", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    expect((await crearOc(raiz, { caso: "sol-001" })).ok).toBe(true);
    expect(leerOrdenes(raiz)[0]?.orden.excepciones).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — La evidencia es obligatoria y debe ser la de la OC
// ---------------------------------------------------------------------

describe("evidencia de aprobación", () => {
  test("sin evidencia no se crea la OC, y el mensaje dice qué hacer", async () => {
    const raiz = copiarFixtures();
    const respuesta = await crearOc(raiz, { caso: "sol-001" });

    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("oc_generar_evidencia");
    expect(leerOrdenes(raiz)).toEqual([]);
    expect(existsSync(join(raiz, "out", "control.csv"))).toBe(false); // no es un intento de negocio
  });

  test("una evidencia alterada (una letra distinta) se detecta", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    const ruta = join(raiz, "out", "sol-001", "aprobacion.txt");
    writeFileSync(ruta, readFileSync(ruta, "utf-8").replace("Aprobado,", "Rechazado,"));

    const respuesta = await crearOc(raiz, { caso: "sol-001" });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("no coincide");
    expect(leerOrdenes(raiz)).toEqual([]);
  });

  test("la evidencia de otra aprobación no vale", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    await generarEvidencia(raiz, "sol-004");
    writeFileSync(join(raiz, "out", "sol-001", "aprobacion.txt"), readFileSync(join(raiz, "out", "sol-004", "aprobacion.txt")));

    expect((await crearOc(raiz, { caso: "sol-001" })).error).toContain("no coincide");
  });

  test("una evidencia guardada con saltos de línea de Windows sigue siendo válida", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    const ruta = join(raiz, "out", "sol-001", "aprobacion.txt");
    writeFileSync(ruta, readFileSync(ruta, "utf-8").replace(/\n/g, "\r\n"));

    expect((await crearOc(raiz, { caso: "sol-001" })).ok).toBe(true);
  });
});

describe("evidenciaCoincide", () => {
  const evidencia = construirEvidencia("sol-001", RAIZ);
  if (!evidencia.ok) throw new Error(evidencia.error);
  const { texto, sha256 } = evidencia.data;

  test("coincide con su propio texto y hash", () => {
    expect(evidenciaCoincide(texto, sha256)).toBe(true);
  });

  test("no coincide si el contenido cambió, aunque la línea del hash siga igual", () => {
    expect(evidenciaCoincide(texto.replace("Aprobado", "Aprobada"), sha256)).toBe(false);
  });

  test("no coincide con el hash de otra aprobación", () => {
    expect(evidenciaCoincide(texto, "0".repeat(64))).toBe(false);
  });

  test("no coincide si falta la línea del hash o el texto está vacío", () => {
    expect(evidenciaCoincide("De: alguien\n\nHola", sha256)).toBe(false);
    expect(evidenciaCoincide("", sha256)).toBe(false);
  });

  test("tolera los saltos de línea de Windows", () => {
    expect(evidenciaCoincide(texto.replace(/\n/g, "\r\n"), sha256)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — El modelo no puede alterar la orden
// ---------------------------------------------------------------------

describe("payload enviado por el modelo", () => {
  async function ordenDeConstruirPayload(raiz: string, caso: string): Promise<OrdenCompra> {
    const respuesta = JSON.parse(await construir_payload.execute({ caso }, contexto(raiz))) as {
      data: { orden: OrdenCompra };
    };
    return respuesta.data.orden;
  }

  test("un payload idéntico al de oc_construir_payload se acepta", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    const payload = await ordenDeConstruirPayload(raiz, "sol-001");
    expect((await crearOc(raiz, { caso: "sol-001", payload })).ok).toBe(true);
  });

  test("un payload con el precio cambiado se rechaza y no se crea nada", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    const payload = await ordenDeConstruirPayload(raiz, "sol-001");
    const posicion = payload.posiciones[0];
    if (posicion === undefined) throw new Error("La OC no tiene posiciones");
    const manipulado: OrdenCompra = { ...payload, posiciones: [{ ...posicion, precio_unitario: 1 }] };

    const respuesta = await crearOc(raiz, { caso: "sol-001", payload: manipulado });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("no coincide");
    expect(leerOrdenes(raiz)).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 7 — Llamadas simultáneas y fallas
// ---------------------------------------------------------------------

describe("simultaneidad y errores", () => {
  test("dos llamadas a la vez para la misma solicitud crean una sola orden", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    const [a, b] = await Promise.all([crearOc(raiz, { caso: "sol-001" }), crearOc(raiz, { caso: "sol-001" })]);

    expect(a.ok && b.ok).toBe(true);
    expect(a.data?.numero_oc).toBe("4500000001");
    expect(b.data?.numero_oc).toBe("4500000001");
    expect([a.data?.idempotente, b.data?.idempotente].sort()).toEqual([false, true]);
    expect(leerOrdenes(raiz)).toHaveLength(1);
    expect(leerControl(raiz).map((f) => f.resultado).sort()).toEqual(["creada", "ya_existente"]);
  });

  test("un archivo del SAP dañado da un error claro, sin crear nada y sin llamarlo inesperado", async () => {
    const raiz = copiarFixtures();
    await generarEvidencia(raiz, "sol-001");
    mkdirSync(join(raiz, "out", "sap"), { recursive: true });
    writeFileSync(join(raiz, "out", "sap", "ordenes.jsonl"), "esto no es json\n");

    const respuesta = await crearOc(raiz, { caso: "sol-001" });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("dañado");
    expect(respuesta.error).not.toContain("inesperado");
    expect(readFileSync(join(raiz, "out", "sap", "ordenes.jsonl"), "utf-8")).toBe("esto no es json\n");
  });

  test("un caso peligroso o inexistente da error y no deja registro", async () => {
    const raiz = copiarFixtures();
    expect((await crearOc(raiz, { caso: "../../.env" })).ok).toBe(false);
    expect((await crearOc(raiz, { caso: "sol-999" })).ok).toBe(false);
    expect(existsSync(join(raiz, "out"))).toBe(false);
  });
});
