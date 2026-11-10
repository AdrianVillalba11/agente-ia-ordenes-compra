// =====================================================================
// generar.ts — Arma las piezas de texto del módulo reutilizable (bonus del PRD).
//
// El módulo no tiene copias propias del prompt ni del conocimiento: las genera
// a partir de los MISMOS archivos que usa la aplicación (agent/prompt.md y
// src/knowledge/ordenes-compra.md), poniéndoles solo la cabecera que piden
// otras plataformas de agentes. Una prueba (src/modulo.test.ts) falla si los
// archivos de modulo/ dejan de coincidir con lo que sale de aquí.
//
// Uso: bun run modulo   (reescribe modulo/agent.md y modulo/skill/.../SKILL.md)
// =====================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// --- Bloque 1: cabeceras de cada pieza ---

const CABECERA_AGENTE = `---
description: Asistente de la analista administrativa que lee solicitudes de compra, valida los controles contra los maestros, arma la orden de compra y la crea en SAP. Las excepciones las devuelve a la analista para que las confirme.
mode: primary
permission:
  edit: deny
  bash: deny
---`;

const CABECERA_SKILL = `---
name: ordenes-compra
description: Cómo funciona el proceso de órdenes de compra: el paquete de la compra, los controles RC1 a RC10 (bloqueos, confirmaciones y derivados), las órdenes retroactivas y cuándo se pide confirmación a la analista.
---`;

// --- Bloque 2: rutas (el módulo y la aplicación comparten estos dos archivos) ---

export const RUTA_PROMPT = join("agent", "prompt.md");
export const RUTA_CONOCIMIENTO = join("src", "knowledge", "ordenes-compra.md");
export const RUTA_AGENTE_MODULO = join("modulo", "agent.md");
export const RUTA_SKILL_MODULO = join("modulo", "skill", "ordenes-compra", "SKILL.md");

// Mismo texto en cualquier sistema operativo: saltos de línea \n y sin espacios sobrantes
export function normalizar(texto: string): string {
  return texto.replace(/\r\n/g, "\n").trim() + "\n";
}

// --- Bloque 3: el texto que debe tener cada archivo del módulo ---

export function textosDelModulo(raiz: string): { agente: string; skill: string } {
  const prompt = normalizar(readFileSync(join(raiz, RUTA_PROMPT), "utf8"));
  const conocimiento = normalizar(readFileSync(join(raiz, RUTA_CONOCIMIENTO), "utf8"));
  return {
    agente: `${CABECERA_AGENTE}\n\n${prompt}`,
    skill: `${CABECERA_SKILL}\n\n${conocimiento}`,
  };
}

// --- Bloque 4: escribir los archivos (solo al ejecutar este archivo directamente) ---

if (import.meta.main) {
  const raiz = join(import.meta.dir, "..");
  const textos = textosDelModulo(raiz);
  for (const [ruta, texto] of [
    [RUTA_AGENTE_MODULO, textos.agente],
    [RUTA_SKILL_MODULO, textos.skill],
  ] as const) {
    const destino = join(raiz, ruta);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, texto, "utf8");
    console.log(`Escrito ${ruta}`);
  }
}
