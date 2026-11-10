// =====================================================================
// demo.test.ts — Pruebas de demo.ts.
//
// La demo es parte de lo que se entrega, así que también se prueba: que
// termine bien, que sea determinista, que limpie out/ con seguridad y que
// deje en out/ exactamente lo que dice mostrar. Todo sobre copias
// temporales de los fixtures, para no tocar tu carpeta out/.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejecutarDemo, type ResumenDemo } from "../demo.ts";
import { leerControl } from "./dominio/control.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..");
const raicesTemporales: string[] = [];

function copiarFixtures(): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-demo-"));
  raicesTemporales.push(raiz);
  cpSync(join(RAIZ, "fixtures"), join(raiz, "fixtures"), { recursive: true });
  return raiz;
}

// Ejecuta la demo y devuelve el resumen y todo lo que imprimió
async function correr(raiz: string): Promise<{ resumen: ResumenDemo; salida: string[] }> {
  const salida: string[] = [];
  const resumen = await ejecutarDemo(raiz, (linea) => salida.push(linea));
  return { resumen, salida };
}

const leer = (raiz: string, ...ruta: string[]): string => readFileSync(join(raiz, ...ruta), "utf-8");

afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Resultado de la demo
// ---------------------------------------------------------------------

describe("ejecutarDemo: resultado", () => {
  test("termina bien: los 6 casos salen como el PRD espera y todas las comprobaciones pasan", async () => {
    const { resumen } = await correr(copiarFixtures());

    expect(resumen.diferencias).toEqual([]);
    expect(resumen.correcto).toBe(true);
    expect(resumen.comprobaciones).toHaveLength(5);
    expect(resumen.comprobaciones.every((c) => c.ok)).toBe(true);
  });

  test("la tabla final tiene, por caso, apta, bloqueos, confirmaciones, retroactiva y OC o motivo", async () => {
    const { resumen } = await correr(copiarFixtures());

    expect(
      resumen.filas.map((f) => [f.caso, f.apta, f.bloqueos, f.confirmaciones, f.retroactiva, f.numeroOc, f.resultado]),
    ).toEqual([
      ["sol-001", true, [], [], false, "4500000001", "OC 4500000001 creada"],
      ["sol-002", false, ["RC1"], [], false, null, "Bloqueada: RC1"],
      ["sol-003", false, ["RC2"], [], false, null, "Bloqueada: RC2"],
      ["sol-004", true, [], ["RC5"], false, "4500000002", "OC 4500000002 creada"],
      ["sol-005", true, [], ["RC8"], true, "4500000003", "OC 4500000003 creada"],
      ["sol-006", true, [], ["RC6"], false, null, "Pendiente de confirmación: RC6"],
    ]);
  });

  test("lo que imprime muestra la idempotencia, la confirmación de sol-004 y el veredicto final", async () => {
    const { salida } = await correr(copiarFixtures());
    const texto = salida.join("\n");

    expect(texto).toContain("DEMO sin modelo de lenguaje");
    expect(texto).toContain("oc_crear (otra vez)");
    expect(texto).toContain("OC 4500000001 ya existía (idempotente)");
    expect(texto).toContain("COP 26.500.000"); // los dos valores que se confirman en sol-004
    expect(texto).toContain("COP 25.000.000");
    expect(texto).toContain('[analista simulada] "Confirmo crear la OC con estas excepciones: RC5."');
    expect(texto).toContain("oc_crear (confirmado)");
    expect(texto).toContain("No se puede confirmar algo que aún no se mostró");
    expect(texto).toContain("RESULTADO: 6 de 6 casos como se esperaba; 5 de 5 comprobaciones correctas.");
  });

  test("lo que deja en out/ coincide con lo que anuncia", async () => {
    const raiz = copiarFixtures();
    await correr(raiz);

    // 3 órdenes: sol-001, sol-004 y sol-005 (sol-006 queda pendiente)
    const ordenes = leer(raiz, "out", "sap", "ordenes.jsonl").split("\n").filter((l) => l !== "");
    expect(ordenes).toHaveLength(3);

    // El control: un intento por llamada a oc_crear, con la retroactiva marcada en sol-005
    const control = leerControl(raiz);
    expect(control).toHaveLength(11);
    expect(control.filter((f) => f.solicitud_id === "SOL-2026-006").map((f) => f.resultado)).toEqual([
      "pendiente_confirmacion",
      "pendiente_confirmacion",
    ]);
    expect(control.filter((f) => f.solicitud_id === "SOL-2026-005").every((f) => f.retroactiva)).toBe(true);

    // El log: todas las llamadas a herramientas, todas con la hora de la demo
    const log = leer(raiz, "out", "log.jsonl").split("\n").filter((l) => l !== "");
    expect(log).toHaveLength(32);
    expect(log.every((linea) => linea.includes('"ts":"2026-09-03T20:00:00.000Z"'))).toBe(true);

    // La evidencia de cada caso sin bloqueos
    for (const caso of ["sol-001", "sol-004", "sol-005", "sol-006"]) {
      expect(existsSync(join(raiz, "out", caso, "aprobacion.txt"))).toBe(true);
      expect(existsSync(join(raiz, "out", caso, "aprobacion.pdf"))).toBe(true);
      expect(existsSync(join(raiz, "out", caso, "trazabilidad.json"))).toBe(true);
    }
    // Los bloqueados no llegan a armar nada
    expect(existsSync(join(raiz, "out", "sol-002"))).toBe(false);
    expect(existsSync(join(raiz, "out", "sol-003"))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Determinismo
// ---------------------------------------------------------------------

describe("ejecutarDemo: determinismo", () => {
  test("dos ejecuciones en carpetas distintas dan la misma salida y los mismos archivos, byte a byte", async () => {
    const [a, b] = [copiarFixtures(), copiarFixtures()];
    const primera = await correr(a);
    const segunda = await correr(b);

    expect(segunda.salida).toEqual(primera.salida);
    for (const archivo of [
      ["out", "control.csv"],
      ["out", "log.jsonl"],
      ["out", "sap", "ordenes.jsonl"],
      ["out", "sol-004", "aprobacion.txt"],
      ["out", "sol-004", "trazabilidad.json"],
    ]) {
      expect(leer(b, ...archivo)).toBe(leer(a, ...archivo));
    }
    expect(readFileSync(join(b, "out", "sol-004", "aprobacion.pdf")).equals(readFileSync(join(a, "out", "sol-004", "aprobacion.pdf")))).toBe(true);
  });

  test("ejecutarla dos veces en la misma carpeta da lo mismo: no se acumula nada entre ejecuciones", async () => {
    const raiz = copiarFixtures();
    const primera = await correr(raiz);
    const segunda = await correr(raiz);

    expect(segunda.salida).toEqual(primera.salida);
    expect(segunda.resumen.filas[0]?.numeroOc).toBe("4500000001"); // la numeración vuelve a empezar
    expect(leerControl(raiz)).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Limpieza de out/ con seguridad
// ---------------------------------------------------------------------

describe("ejecutarDemo: limpieza de out/", () => {
  test("lo que hubiera antes en out/ desaparece, incluso un SAP con órdenes viejas", async () => {
    const raiz = copiarFixtures();
    mkdirSync(join(raiz, "out", "sap"), { recursive: true });
    writeFileSync(join(raiz, "out", "basura.txt"), "algo viejo");
    writeFileSync(join(raiz, "out", "sap", "ordenes.jsonl"), "esto dañaría la numeración\n");

    const { resumen } = await correr(raiz);

    expect(existsSync(join(raiz, "out", "basura.txt"))).toBe(false);
    expect(resumen.correcto).toBe(true);
    expect(resumen.filas[0]?.numeroOc).toBe("4500000001");
  });

  test("en una carpeta que no es la raíz del proyecto no borra nada y avisa", async () => {
    const ajena = mkdtempSync(join(tmpdir(), "oc-ajena-"));
    raicesTemporales.push(ajena);
    mkdirSync(join(ajena, "out"), { recursive: true });
    writeFileSync(join(ajena, "out", "importante.txt"), "no se debe borrar");

    await expect(ejecutarDemo(ajena, () => {})).rejects.toThrow("no parece la raíz del proyecto");
    expect(existsSync(join(ajena, "out", "importante.txt"))).toBe(true);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Sin modelo de lenguaje
// ---------------------------------------------------------------------

describe("demo.ts no necesita modelo ni red", () => {
  test("no importa nada del modelo de lenguaje, no lee claves y no hace llamadas de red", () => {
    const codigo = readFileSync(join(RAIZ, "demo.ts"), "utf-8");
    expect(codigo).not.toMatch(/src\/llm/);
    expect(codigo).not.toMatch(/api[_-]?key/i);
    expect(codigo).not.toMatch(/process\.env/);
    expect(codigo).not.toMatch(/\bfetch\(/);
  });
});
