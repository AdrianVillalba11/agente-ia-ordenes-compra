// =====================================================================
// control.test.ts — Pruebas del registro de control (out/control.csv).
//
// Cubren el formato exacto de las filas, el escapado de comas y comillas,
// la lectura que ignora líneas dañadas y la regla de las confirmaciones
// pendientes. Escriben en carpetas temporales.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dividirLineaCsv,
  escaparCsv,
  hayPendienteIgual,
  leerControl,
  registrarControl,
  type FilaControl,
} from "./control.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts";
const TS = "2026-11-10T02:30:00.000Z";

const FILA: FilaControl = {
  solicitud_id: "SOL-2026-004",
  resultado: "pendiente_confirmacion",
  numero_oc: null,
  retroactiva: false,
  bloqueos: [],
  confirmaciones: ["RC5"],
  ts: TS,
};

const raicesTemporales: string[] = [];
function nuevaRaiz(): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-control-"));
  raicesTemporales.push(raiz);
  return raiz;
}

function leerArchivo(raiz: string): string {
  return readFileSync(join(raiz, "out", "control.csv"), "utf-8");
}

afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — CSV: escapar y dividir
// ---------------------------------------------------------------------

describe("escaparCsv y dividirLineaCsv", () => {
  test("un valor normal queda igual", () => {
    expect(escaparCsv("SOL-2026-001")).toBe("SOL-2026-001");
  });

  test("un valor con coma o comilla va entre comillas, y las comillas se duplican", () => {
    expect(escaparCsv("a,b")).toBe('"a,b"');
    expect(escaparCsv('dijo "hola"')).toBe('"dijo ""hola"""');
  });

  test("dividir respeta las comillas y los campos vacíos", () => {
    expect(dividirLineaCsv('a,"b,c","d""e",')).toEqual(["a", "b,c", 'd"e', ""]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Escribir y leer
// ---------------------------------------------------------------------

describe("registrarControl y leerControl", () => {
  test("la primera fila crea el archivo con encabezado, con el formato exacto del PRD", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, FILA);
    expect(leerArchivo(raiz)).toBe(`${ENCABEZADO}\nSOL-2026-004,pendiente_confirmacion,,false,,RC5,${TS}\n`);
  });

  test("el encabezado se escribe una sola vez", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, FILA);
    registrarControl(raiz, { ...FILA, resultado: "creada", numero_oc: "4500000002" });

    const lineas = leerArchivo(raiz).split("\n").filter((l) => l !== "");
    expect(lineas).toEqual([
      ENCABEZADO,
      `SOL-2026-004,pendiente_confirmacion,,false,,RC5,${TS}`,
      `SOL-2026-004,creada,4500000002,false,,RC5,${TS}`,
    ]);
  });

  test("varios códigos se separan con punto y coma, y la retroactiva se escribe como true", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, { ...FILA, resultado: "bloqueada", retroactiva: true, bloqueos: ["RC1", "RC4"], confirmaciones: ["RC5", "RC8"] });
    expect(leerArchivo(raiz)).toContain(`SOL-2026-004,bloqueada,,true,RC1;RC4,RC5;RC8,${TS}`);
  });

  test("lo escrito se lee idéntico, incluso con comas y comillas en el identificador", () => {
    const raiz = nuevaRaiz();
    const rara: FilaControl = { ...FILA, solicitud_id: 'SOL "X", segunda', resultado: "creada", numero_oc: "4500000001" };
    registrarControl(raiz, rara);
    registrarControl(raiz, FILA);
    expect(leerControl(raiz)).toEqual([rara, FILA]);
  });

  test("sin archivo no hay filas", () => {
    expect(leerControl(nuevaRaiz())).toEqual([]);
  });

  test("las líneas dañadas se ignoran y las buenas se conservan", () => {
    const raiz = nuevaRaiz();
    mkdirSync(join(raiz, "out"), { recursive: true });
    writeFileSync(
      join(raiz, "out", "control.csv"),
      [
        ENCABEZADO,
        `SOL-1,creada,4500000001,false,,,${TS}`,
        "basura sin comas",
        `SOL-2,solo,tres,campos`,
        `SOL-3,resultado_inventado,,false,,,${TS}`,
        `SOL-4,creada,4500000002,quizas,,,${TS}`,
        `SOL-5,bloqueada,,true,RC2,,${TS}\r`, // con salto de línea de Windows
        "",
      ].join("\n"),
    );

    const filas = leerControl(raiz);
    expect(filas.map((f) => f.solicitud_id)).toEqual(["SOL-1", "SOL-5"]);
    expect(filas[1]).toEqual({ solicitud_id: "SOL-5", resultado: "bloqueada", numero_oc: null, retroactiva: true, bloqueos: ["RC2"], confirmaciones: [], ts: TS });
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — ¿Se mostró ya esta confirmación?
// ---------------------------------------------------------------------

describe("hayPendienteIgual", () => {
  test("sin registro previo no hay nada pendiente", () => {
    expect(hayPendienteIgual(nuevaRaiz(), "SOL-2026-004", ["RC5"])).toBe(false);
  });

  test("tras un pendiente con las mismas confirmaciones, sí", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, FILA);
    expect(hayPendienteIgual(raiz, "SOL-2026-004", ["RC5"])).toBe(true);
  });

  test("el orden de los códigos no importa", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, { ...FILA, confirmaciones: ["RC5", "RC8"] });
    expect(hayPendienteIgual(raiz, "SOL-2026-004", ["RC8", "RC5"])).toBe(true);
  });

  test("si las confirmaciones cambiaron respecto a lo que se mostró, no vale", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, FILA); // se mostró solo RC5
    expect(hayPendienteIgual(raiz, "SOL-2026-004", ["RC5", "RC9"])).toBe(false);
    expect(hayPendienteIgual(raiz, "SOL-2026-004", [])).toBe(false);
  });

  test("lo mostrado para otra solicitud no vale para esta", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, FILA);
    expect(hayPendienteIgual(raiz, "SOL-2026-005", ["RC5"])).toBe(false);
  });

  test("un intento que no quedó pendiente (creada, bloqueada) no cuenta como mostrado", () => {
    const raiz = nuevaRaiz();
    registrarControl(raiz, { ...FILA, resultado: "creada", numero_oc: "4500000001" });
    registrarControl(raiz, { ...FILA, resultado: "bloqueada" });
    expect(hayPendienteIgual(raiz, "SOL-2026-004", ["RC5"])).toBe(false);
  });
});
