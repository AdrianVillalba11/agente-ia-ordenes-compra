// =====================================================================
// modulo.test.ts — El módulo reutilizable usa las MISMAS piezas que la aplicación.
//
// El PRD (bonus) evalúa que modulo/ no tenga copias divergentes. Aquí se comprueba:
//   - agent.md y SKILL.md son exactamente cabecera + los archivos de la aplicación
//   - las herramientas de modulo/tools/oc.ts son los mismos objetos que usa la aplicación
//   - las cabeceras traen lo que piden otras plataformas
// Si falla la primera, se arregla con: bun run modulo
// =====================================================================

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cargarInstrucciones } from "./agente/instrucciones.ts";
import * as herramientasModulo from "../modulo/tools/oc.ts";
import * as herramientasApp from "./tools/oc.ts";
import { RUTA_AGENTE_MODULO, RUTA_SKILL_MODULO, normalizar, textosDelModulo } from "../modulo/generar.ts";

const raiz = join(import.meta.dir, "..");
const leer = (ruta: string): string => normalizar(readFileSync(join(raiz, ruta), "utf8"));

describe("módulo reutilizable", () => {
  test("agent.md es la cabecera más el prompt de la aplicación, sin diferencias", () => {
    expect(leer(RUTA_AGENTE_MODULO)).toBe(normalizar(textosDelModulo(raiz).agente));
  });

  test("SKILL.md es la cabecera más el conocimiento de la aplicación, sin diferencias", () => {
    expect(leer(RUTA_SKILL_MODULO)).toBe(normalizar(textosDelModulo(raiz).skill));
  });

  test("lo que recibe el modelo sale del prompt y el conocimiento que el módulo empaqueta", () => {
    const instrucciones = cargarInstrucciones(raiz);
    if (!instrucciones.ok) throw new Error(instrucciones.error);
    const sinCabecera = (texto: string): string => texto.replace(/^---\n[\s\S]*?\n---\n\n/, "").trim();
    expect(instrucciones.data).toContain(sinCabecera(leer(RUTA_AGENTE_MODULO)));
    expect(instrucciones.data).toContain(sinCabecera(leer(RUTA_SKILL_MODULO)));
  });

  test("las herramientas del módulo son las mismas de la aplicación", () => {
    const nombresApp = Object.keys(herramientasApp).sort();
    expect(nombresApp.length).toBe(5);
    expect(Object.keys(herramientasModulo).sort()).toEqual(nombresApp);
    for (const nombre of nombresApp) {
      const deApp = (herramientasApp as Record<string, unknown>)[nombre];
      const deModulo = (herramientasModulo as Record<string, unknown>)[nombre];
      expect(deModulo).toBe(deApp); // el mismo objeto, no una copia
    }
  });

  test("agent.md declara descripción, modo primario y permisos que niegan editar y ejecutar", () => {
    const texto = leer(RUTA_AGENTE_MODULO);
    const cabecera = texto.split("\n---\n")[0] ?? "";
    expect(cabecera.startsWith("---\n")).toBe(true);
    expect(cabecera).toContain("description:");
    expect(cabecera).toContain("mode: primary");
    expect(cabecera).toMatch(/permission:\n {2}edit: deny\n {2}bash: deny/);
  });

  test("SKILL.md declara nombre y descripción", () => {
    const cabecera = leer(RUTA_SKILL_MODULO).split("\n---\n")[0] ?? "";
    expect(cabecera).toContain("name: ordenes-compra");
    expect(cabecera).toContain("description:");
  });
});
