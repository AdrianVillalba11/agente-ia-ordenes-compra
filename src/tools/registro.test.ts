// =====================================================================
// registro.test.ts — Pruebas del "recepcionista" de herramientas.
//
// Cubren los nombres de las herramientas, la validación de argumentos,
// los errores, los resúmenes de cada resultado y el log out/log.jsonl.
// Trabajan sobre copias temporales de los fixtures y con un reloj fijo.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leerPaquete } from "../dominio/paquete.ts";
import type { ContextoHerramienta } from "../esquemas.ts";
import { analizarRespuesta, ejecutarHerramienta, listarHerramientas, type EjecucionHerramienta } from "./registro.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");

// 2026-11-10 02:30 UTC son las 9:30 p. m. del 9 de noviembre en Colombia
const RELOJ_FIJO = (): Date => new Date("2026-11-10T02:30:00Z");
const TS_FIJO = "2026-11-10T02:30:00.000Z";

const raicesTemporales: string[] = [];

function copiarFixtures(): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-registro-"));
  raicesTemporales.push(raiz);
  cpSync(join(RAIZ, "fixtures"), join(raiz, "fixtures"), { recursive: true });
  return raiz;
}

function contexto(raiz: string): ContextoHerramienta {
  return { directory: raiz, sessionId: "prueba", ahora: RELOJ_FIJO };
}

type LineaLog = {
  ts: string;
  sesion: string;
  herramienta: string;
  caso: string | null;
  argumentos: string;
  ok: boolean;
  resumen: string;
};

function leerLog(raiz: string): LineaLog[] {
  return readFileSync(join(raiz, "out", "log.jsonl"), "utf-8")
    .split("\n")
    .filter((linea) => linea.trim() !== "")
    .map((linea) => JSON.parse(linea) as LineaLog);
}

afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Nombres de las herramientas
// ---------------------------------------------------------------------

describe("listarHerramientas", () => {
  test("las 5 herramientas del PRD, con su nombre '<archivo>_<export>' y en el orden del proceso", () => {
    expect(listarHerramientas().map((h) => h.nombre)).toEqual([
      "oc_leer_paquete",
      "oc_validar",
      "oc_construir_payload",
      "oc_generar_evidencia",
      "oc_crear",
    ]);
  });

  test("cada una tiene una descripción (es lo único que el modelo lee para decidir cuándo usarla)", () => {
    for (const herramienta of listarHerramientas()) {
      expect(herramienta.descripcion.length).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Argumentos inválidos y herramientas desconocidas
// ---------------------------------------------------------------------

describe("ejecutarHerramienta: errores", () => {
  test("sin los argumentos obligatorios devuelve un error legible que nombra el campo", async () => {
    const e = await ejecutarHerramienta("oc_validar", {}, contexto(copiarFixtures()));
    expect(e.ok).toBe(false);
    expect(e.error).toContain("Argumentos inválidos para oc_validar");
    expect(e.error).toContain("caso");
    expect(e.resumen).toStartWith("Error: Argumentos inválidos");
    expect(JSON.parse(e.respuesta)).toMatchObject({ ok: false });
  });

  test("un argumento del tipo equivocado se rechaza nombrando el campo", async () => {
    const e = await ejecutarHerramienta("oc_crear", { caso: "sol-001", confirmado: "sí" }, contexto(copiarFixtures()));
    expect(e.ok).toBe(false);
    expect(e.error).toContain("confirmado");
  });

  test("un caso con ruta peligrosa se rechaza antes de ejecutar nada", async () => {
    const raiz = copiarFixtures();
    const e = await ejecutarHerramienta("oc_leer_paquete", { caso: "../../.env" }, contexto(raiz));
    expect(e.ok).toBe(false);
    expect(e.error).toContain("Argumentos inválidos");
    expect(existsSync(join(raiz, "out", "control.csv"))).toBe(false);
  });

  test("una herramienta desconocida lista las disponibles", async () => {
    const e = await ejecutarHerramienta("oc_borrar_todo", { caso: "sol-001" }, contexto(copiarFixtures()));
    expect(e.ok).toBe(false);
    expect(e.error).toContain('Herramienta desconocida "oc_borrar_todo"');
    expect(e.error).toContain("oc_crear");
  });

  test("argumentos que no son un objeto no hacen fallar al registro", async () => {
    const raiz = copiarFixtures();
    for (const argumentos of ["sol-001", 42, null, undefined]) {
      const e = await ejecutarHerramienta("oc_leer_paquete", argumentos, contexto(raiz));
      expect(e.ok).toBe(false);
    }
  });

  test("argumentos imposibles de serializar no lanzan y se anotan como tales en el log", async () => {
    const raiz = copiarFixtures();
    const circular: Record<string, unknown> = { caso: "sol-001" };
    circular.yo = circular;

    const e = await ejecutarHerramienta("oc_leer_paquete", circular, contexto(raiz));
    expect(e.ok).toBe(true); // el campo extra se ignora
    expect(leerLog(raiz)[0]?.argumentos).toBe("(no serializable)");
  });

  test("un caso inexistente es un error de la herramienta, también resumido", async () => {
    const e = await ejecutarHerramienta("oc_leer_paquete", { caso: "sol-999" }, contexto(copiarFixtures()));
    expect(e.ok).toBe(false);
    expect(e.resumen).toStartWith('Error: El caso "sol-999" no existe');
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Resumen de cada resultado
// ---------------------------------------------------------------------

describe("ejecutarHerramienta: resúmenes", () => {
  test("recorrido de sol-001: el resumen de cada herramienta", async () => {
    const raiz = copiarFixtures();
    const ctx = contexto(raiz);
    const ejecutar = (nombre: string, argumentos: unknown): Promise<EjecucionHerramienta> => ejecutarHerramienta(nombre, argumentos, ctx);

    expect((await ejecutar("oc_leer_paquete", { caso: "sol-001" })).resumen).toBe(
      "Paquete de SOL-2026-001: cotización sí, aprobación sí, factura no, faltantes: 0",
    );
    expect((await ejecutar("oc_validar", { caso: "sol-001" })).resumen).toBe(
      "apta: sí | bloqueos: - | confirmaciones: - | retroactiva: no",
    );
    expect((await ejecutar("oc_construir_payload", { caso: "sol-001" })).resumen).toBe(
      "OC armada con 1 posición(es); excepciones: -; advertencias: 2",
    );
    expect((await ejecutar("oc_generar_evidencia", { caso: "sol-001" })).resumen).toBe(
      "Evidencia en out/sol-001/aprobacion.txt y out/sol-001/aprobacion.pdf (sha256 c2466ccea168...)",
    );
    expect((await ejecutar("oc_crear", { caso: "sol-001" })).resumen).toBe("OC 4500000001 creada, fecha 2026-11-09");
    expect((await ejecutar("oc_crear", { caso: "sol-001" })).resumen).toBe(
      "OC 4500000001 ya existía (idempotente), fecha 2026-11-09",
    );
  });

  test("sol-005 se resume como retroactiva y sol-004 como pendiente de RC5", async () => {
    const raiz = copiarFixtures();
    const ctx = contexto(raiz);
    expect((await ejecutarHerramienta("oc_validar", { caso: "sol-005" }, ctx)).resumen).toBe(
      "apta: sí | bloqueos: - | confirmaciones: RC8 | retroactiva: sí",
    );
    await ejecutarHerramienta("oc_generar_evidencia", { caso: "sol-004" }, ctx);
    const pendiente = await ejecutarHerramienta("oc_crear", { caso: "sol-004" }, ctx);
    expect(pendiente.ok).toBe(false);
    expect(pendiente.requiereConfirmacion).toBe(true);
    expect(pendiente.resumen).toBe("Requiere confirmación: RC5");
    expect(pendiente.error).toContain("Requiere confirmación humana");
  });

  test("un bloqueo se resume con las reglas que lo causan", async () => {
    const raiz = copiarFixtures();
    const e = await ejecutarHerramienta("oc_crear", { caso: "sol-003" }, contexto(raiz));
    expect(e.ok).toBe(false);
    expect(e.requiereConfirmacion).toBe(false);
    expect(e.resumen).toBe("Bloqueada: RC2");
  });
});

describe("analizarRespuesta", () => {
  test("acepta el contrato { ok, ... }", () => {
    expect(analizarRespuesta('{"ok":true,"data":{"a":1}}')).toMatchObject({ ok: true, data: { a: 1 } });
    expect(analizarRespuesta('{"ok":false,"error":"mal"}')).toMatchObject({ ok: false, error: "mal" });
  });

  test("rechaza lo que no cumple el contrato", () => {
    expect(analizarRespuesta("esto no es JSON")).toBeNull();
    expect(analizarRespuesta('{"ok":"sí"}')).toBeNull();
    expect(analizarRespuesta("[1,2]")).toBeNull();
    expect(analizarRespuesta("null")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — El log out/log.jsonl
// ---------------------------------------------------------------------

describe("log de llamadas", () => {
  test("cada llamada deja una línea con hora, sesión, herramienta, caso, argumentos, resultado y resumen", async () => {
    const raiz = copiarFixtures();
    const ctx = contexto(raiz);
    await ejecutarHerramienta("oc_leer_paquete", { caso: "sol-001" }, ctx);
    await ejecutarHerramienta("oc_validar", { caso: "sol-002" }, ctx);

    const log = leerLog(raiz);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({
      ts: TS_FIJO,
      sesion: "prueba",
      herramienta: "oc_leer_paquete",
      caso: "sol-001",
      argumentos: '{"caso":"sol-001"}',
      ok: true,
      resumen: "Paquete de SOL-2026-001: cotización sí, aprobación sí, factura no, faltantes: 0",
    });
    expect(log[1]).toMatchObject({ herramienta: "oc_validar", caso: "sol-002", ok: true });
  });

  test("también quedan anotados los intentos rechazados, con el caso que se intentó", async () => {
    const raiz = copiarFixtures();
    await ejecutarHerramienta("oc_leer_paquete", { caso: "../../.env" }, contexto(raiz));

    const [linea] = leerLog(raiz);
    expect(linea).toMatchObject({ herramienta: "oc_leer_paquete", caso: "../../.env", ok: false });
    expect(linea?.resumen).toStartWith("Error: Argumentos inválidos");
  });

  test("el log deja ver si se llamó con confirmado: true (auditoría)", async () => {
    const raiz = copiarFixtures();
    await ejecutarHerramienta("oc_generar_evidencia", { caso: "sol-004" }, contexto(raiz));
    await ejecutarHerramienta("oc_crear", { caso: "sol-004", confirmado: true }, contexto(raiz));

    const ultima = leerLog(raiz).at(-1);
    expect(ultima?.argumentos).toContain('"confirmado":true');
    expect(ultima?.resumen).toBe("Requiere confirmación: RC5"); // confirmar directo no vale
  });

  test("los argumentos muy largos se recortan", async () => {
    const raiz = copiarFixtures();
    const paquete = leerPaquete("sol-001", RAIZ);
    if (!paquete.ok) throw new Error(paquete.error);

    const e = await ejecutarHerramienta("oc_validar", { caso: "sol-001", paquete: paquete.data }, contexto(raiz));
    expect(e.ok).toBe(true); // el paquete enviado es idéntico, así que se acepta

    const [linea] = leerLog(raiz);
    expect(linea?.argumentos).toHaveLength(301);
    expect(linea?.argumentos.endsWith("…")).toBe(true);
  });

  test("si el log no se puede escribir, la herramienta igual responde", async () => {
    const raiz = copiarFixtures();
    writeFileSync(join(raiz, "out"), "esto es un archivo, no una carpeta"); // impide crear out/log.jsonl

    const e = await ejecutarHerramienta("oc_leer_paquete", { caso: "sol-001" }, contexto(raiz));
    expect(e.ok).toBe(true);
    expect(e.resumen).toStartWith("Paquete de SOL-2026-001");
  });
});
