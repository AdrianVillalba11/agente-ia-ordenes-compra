// =====================================================================
// sesiones.test.ts — Pruebas del almacén de sesiones.
//
// Comprueban lo más importante: que cada sesión tenga su carpeta propia
// (para que dos visitantes no se pisen), que un identificador malicioso no
// pueda salirse de su carpeta, y que las sesiones caduquen y se expulsen
// sin acumularse. Usan un reloj controlado: no esperan nada de verdad.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ejecutarHerramienta } from "../tools/registro.ts";
import { AlmacenSesiones, PATRON_ID_SESION } from "./sesiones.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");
const limpieza: string[] = [];

// Un reloj que se mueve solo cuando la prueba lo dice
function relojControlado(inicio = 1_000_000): { reloj: () => number; avanzar: (ms: number) => void } {
  let ahora = inicio;
  return { reloj: () => ahora, avanzar: (ms) => (ahora += ms) };
}

function almacenNuevo(opciones: { maxSesiones?: number; ttlMs?: number; reloj?: () => number } = {}): { almacen: AlmacenSesiones; base: string } {
  const base = mkdtempSync(join(tmpdir(), "oc-almacen-"));
  limpieza.push(base);
  const almacen = new AlmacenSesiones({
    raizProyecto: RAIZ,
    directorioBase: base,
    maxSesiones: opciones.maxSesiones ?? 10,
    ttlMs: opciones.ttlMs ?? 60_000,
    ...(opciones.reloj === undefined ? {} : { ahora: opciones.reloj }),
  });
  return { almacen, base };
}

// La sesión o falla la prueba con el motivo
function crear(almacen: AlmacenSesiones, id: string) {
  const resultado = almacen.obtenerOCrear(id);
  if (!resultado.ok) throw new Error(resultado.error);
  return resultado.data;
}

afterAll(() => {
  for (const carpeta of limpieza) rmSync(carpeta, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Crear sesiones
// ---------------------------------------------------------------------

describe("crear sesiones", () => {
  test("cada sesión tiene su carpeta propia con una copia de los fixtures", () => {
    const { almacen, base } = almacenNuevo();
    const sesion = crear(almacen, "sesion-uno-1");

    expect(sesion.raiz).toBe(join(base, "sesion-uno-1"));
    expect(existsSync(join(base, "sesion-uno-1", "fixtures", "reto-03", "maestros", "proveedores.json"))).toBe(true);
    expect(existsSync(join(base, "sesion-uno-1", "fixtures", "reto-03", "solicitudes", "sol-004", "solicitud.json"))).toBe(true);
    expect(almacen.cantidad).toBe(1);
  });

  test("pedir el mismo id devuelve la misma sesión, sin recrear su carpeta", () => {
    const { almacen, base } = almacenNuevo();
    const primera = crear(almacen, "sesion-uno-1");
    writeFileSync(join(base, "sesion-uno-1", "marca.txt"), "ya estaba");

    const segunda = crear(almacen, "sesion-uno-1");
    expect(segunda).toBe(primera);
    expect(existsSync(join(base, "sesion-uno-1", "marca.txt"))).toBe(true);
    expect(almacen.cantidad).toBe(1);
  });

  test("obtener solo devuelve sesiones que ya existen", () => {
    const { almacen } = almacenNuevo();
    expect(almacen.obtener("sesion-uno-1")).toBeNull();
    const sesion = crear(almacen, "sesion-uno-1");
    expect(almacen.obtener("sesion-uno-1")).toBe(sesion);
  });

  test("copiar los fixtures a una sesión no toca los originales ni las demás sesiones", () => {
    const { almacen, base } = almacenNuevo();
    crear(almacen, "sesion-aaaa-1");
    crear(almacen, "sesion-bbbb-1");

    const ruta = (id: string) => join(base, id, "fixtures", "reto-03", "solicitudes", "sol-001", "solicitud.json");
    const original = readFileSync(join(RAIZ, "fixtures", "reto-03", "solicitudes", "sol-001", "solicitud.json"), "utf-8");
    writeFileSync(ruta("sesion-aaaa-1"), "{ alterado en la sesión A }");

    expect(readFileSync(ruta("sesion-bbbb-1"), "utf-8")).toBe(original);
    expect(readFileSync(join(RAIZ, "fixtures", "reto-03", "solicitudes", "sol-001", "solicitud.json"), "utf-8")).toBe(original);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Identificadores peligrosos
// ---------------------------------------------------------------------

describe("identificadores de sesión", () => {
  test("acepta UUID y nombres con letras, números, guion y guion bajo", () => {
    const { almacen } = almacenNuevo();
    for (const id of ["3f2504e0-4f89-41d3-9a0c-0305e82c3301", "abc_DEF-123", "12345678", "x".repeat(64)]) {
      expect(almacen.obtenerOCrear(id).ok).toBe(true);
    }
  });

  test("rechaza ids peligrosos o malformados y no crea ninguna carpeta", () => {
    const { almacen, base } = almacenNuevo();
    const peligrosos = [
      "",
      "corto",
      "../../etc/passwd",
      "..\\..\\Windows",
      "abc/defgh12",
      "abc.defgh12",
      "con espacio 1",
      "x".repeat(65),
      "sesion;rm -rf",
      "sesión-con-tilde",
      "%2e%2e%2fsecreto",
    ];
    for (const id of peligrosos) {
      const resultado = almacen.obtenerOCrear(id);
      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.error).toContain("Identificador de sesión inválido");
    }
    expect(readdirSync(base)).toEqual([]);
    expect(almacen.cantidad).toBe(0);
  });

  test("el patrón exportado coincide con lo que se acepta", () => {
    expect(PATRON_ID_SESION.test("abcdefgh")).toBe(true);
    expect(PATRON_ID_SESION.test("abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Aislamiento: el motivo de todo esto
// ---------------------------------------------------------------------

describe("aislamiento entre visitantes", () => {
  test("dos sesiones procesan sol-001 y las dos obtienen la OC 4500000001 (no se pisan)", async () => {
    const { almacen } = almacenNuevo();
    const ordenes: string[] = [];

    for (const id of ["visitante-a-1", "visitante-b-1"]) {
      const sesion = crear(almacen, id);
      const contexto = { directory: sesion.raiz ?? "", sessionId: id };
      await ejecutarHerramienta("oc_generar_evidencia", { caso: "sol-001" }, contexto);
      const creada = await ejecutarHerramienta("oc_crear", { caso: "sol-001" }, contexto);
      expect(creada.resumen).toContain("creada"); // no "ya existía"
      ordenes.push(creada.resumen.split(" ")[1] ?? "");
    }
    expect(ordenes).toEqual(["4500000001", "4500000001"]);
  });

  test("lo que escribe una sesión no aparece en la otra", async () => {
    const { almacen } = almacenNuevo();
    const a = crear(almacen, "visitante-a-1");
    const b = crear(almacen, "visitante-b-1");
    const contexto = { directory: a.raiz ?? "", sessionId: "visitante-a-1" };
    await ejecutarHerramienta("oc_generar_evidencia", { caso: "sol-001" }, contexto);
    await ejecutarHerramienta("oc_crear", { caso: "sol-001" }, contexto);

    expect(existsSync(join(a.raiz ?? "", "out", "sap", "ordenes.jsonl"))).toBe(true);
    expect(existsSync(join(b.raiz ?? "", "out"))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Caducidad
// ---------------------------------------------------------------------

describe("caducidad de sesiones", () => {
  test("una sesión sin uso caduca, y su carpeta se borra", () => {
    const { reloj, avanzar } = relojControlado();
    const { almacen, base } = almacenNuevo({ ttlMs: 1000, reloj });
    crear(almacen, "sesion-uno-1");

    avanzar(1000); // justo en el límite todavía vive
    expect(almacen.obtener("sesion-uno-1")).not.toBeNull();

    avanzar(1001);
    expect(almacen.obtener("sesion-uno-1")).toBeNull();
    expect(existsSync(join(base, "sesion-uno-1"))).toBe(false);
    expect(almacen.cantidad).toBe(0);
  });

  test("usar la sesión renueva su tiempo de vida", () => {
    const { reloj, avanzar } = relojControlado();
    const { almacen } = almacenNuevo({ ttlMs: 1000, reloj });
    crear(almacen, "sesion-uno-1");

    avanzar(900);
    expect(almacen.obtener("sesion-uno-1")).not.toBeNull(); // se usa a los 900
    avanzar(900); // ahora van 1800 desde el inicio, pero solo 900 desde el último uso
    expect(almacen.obtener("sesion-uno-1")).not.toBeNull();
  });

  test("pedir un id caducado crea una sesión nueva y limpia", () => {
    const { reloj, avanzar } = relojControlado();
    const { almacen } = almacenNuevo({ ttlMs: 1000, reloj });
    const vieja = crear(almacen, "sesion-uno-1");
    vieja.tokensUsados = 999;

    avanzar(5000);
    const nueva = crear(almacen, "sesion-uno-1");
    expect(nueva).not.toBe(vieja);
    expect(nueva.tokensUsados).toBe(0);
  });

  test("limpiarCaducadas quita solo las vencidas y cuenta cuántas", () => {
    const { reloj, avanzar } = relojControlado();
    const { almacen, base } = almacenNuevo({ ttlMs: 1000, reloj });
    crear(almacen, "sesion-vieja-1");
    avanzar(800);
    crear(almacen, "sesion-joven-1");
    avanzar(400); // la vieja lleva 1200 sin uso; la joven, 400

    expect(almacen.limpiarCaducadas()).toBe(1);
    expect(readdirSync(base)).toEqual(["sesion-joven-1"]);
  });

  test("una sesión en medio de un turno no se borra aunque haya caducado", () => {
    const { reloj, avanzar } = relojControlado();
    const { almacen, base } = almacenNuevo({ ttlMs: 1000, reloj });
    const sesion = crear(almacen, "sesion-uno-1");
    sesion.ocupada = true;

    avanzar(5000);
    expect(almacen.limpiarCaducadas()).toBe(0);
    expect(almacen.obtener("sesion-uno-1")).toBe(sesion);
    expect(existsSync(join(base, "sesion-uno-1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — Capacidad
// ---------------------------------------------------------------------

describe("capacidad del almacén", () => {
  test("al llenarse, expulsa la sesión MENOS usada y borra su carpeta", () => {
    const { reloj, avanzar } = relojControlado();
    const { almacen, base } = almacenNuevo({ maxSesiones: 2, reloj });
    crear(almacen, "sesion-aaaa-1");
    avanzar(10);
    crear(almacen, "sesion-bbbb-1");
    avanzar(10);
    almacen.obtener("sesion-aaaa-1"); // la A se usa de nuevo: ahora la menos usada es la B
    avanzar(10);

    crear(almacen, "sesion-cccc-1");
    expect(almacen.cantidad).toBe(2);
    expect(almacen.obtener("sesion-bbbb-1")).toBeNull();
    expect(readdirSync(base).sort()).toEqual(["sesion-aaaa-1", "sesion-cccc-1"]);
  });

  test("nunca expulsa una sesión que está en medio de un turno", () => {
    const { reloj, avanzar } = relojControlado();
    const { almacen } = almacenNuevo({ maxSesiones: 2, reloj });
    const a = crear(almacen, "sesion-aaaa-1");
    avanzar(10);
    crear(almacen, "sesion-bbbb-1");
    a.ocupada = true; // la más antigua está ocupada

    crear(almacen, "sesion-cccc-1");
    expect(almacen.obtener("sesion-aaaa-1")).toBe(a); // se salvó
    expect(almacen.obtener("sesion-bbbb-1")).toBeNull(); // se expulsó la siguiente menos usada
  });

  test("si todas están ocupadas, rechaza la nueva con un mensaje claro y no expulsa a nadie", () => {
    const { almacen } = almacenNuevo({ maxSesiones: 2 });
    crear(almacen, "sesion-aaaa-1").ocupada = true;
    crear(almacen, "sesion-bbbb-1").ocupada = true;

    const resultado = almacen.obtenerOCrear("sesion-cccc-1");
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error).toContain("límite de sesiones activas");
    expect(almacen.cantidad).toBe(2);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 7 — Eliminar y cerrar
// ---------------------------------------------------------------------

describe("eliminar y cerrar", () => {
  test("eliminar borra la sesión y su carpeta; eliminar una inexistente no hace nada", () => {
    const { almacen, base } = almacenNuevo();
    crear(almacen, "sesion-uno-1");
    almacen.eliminar("sesion-uno-1");
    almacen.eliminar("sesion-uno-1");
    almacen.eliminar("no-existe-1");

    expect(almacen.cantidad).toBe(0);
    expect(readdirSync(base)).toEqual([]);
  });

  test("cerrar borra todas las carpetas, incluida la base", () => {
    const { almacen, base } = almacenNuevo();
    crear(almacen, "sesion-aaaa-1");
    crear(almacen, "sesion-bbbb-1");
    almacen.cerrar();

    expect(almacen.cantidad).toBe(0);
    expect(existsSync(base)).toBe(false);
  });

  test("sin directorio indicado crea uno temporal propio, y cerrar lo borra", () => {
    const almacen = new AlmacenSesiones({ raizProyecto: RAIZ, maxSesiones: 5, ttlMs: 60_000 });
    const sesion = crear(almacen, "sesion-uno-1");
    const base = dirname(sesion.raiz ?? "");
    expect(existsSync(base)).toBe(true);
    expect(base.startsWith(tmpdir())).toBe(true);

    almacen.cerrar();
    expect(existsSync(base)).toBe(false);
  });
});
