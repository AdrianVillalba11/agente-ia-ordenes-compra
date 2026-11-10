// =====================================================================
// instrucciones.ts — Carga las instrucciones del agente.
//
// El PRD pide separar tres cosas:
//   - COMPORTAMIENTO: cómo se debe portar el agente -> agent/prompt.md
//   - CONOCIMIENTO: cómo funciona el proceso -> src/knowledge/ordenes-compra.md
//   - EJECUCIÓN: lo que hace de verdad -> src/tools/
// Aquí se unen las dos primeras en el texto de instrucciones que recibe el
// modelo. Así, cambiar una regla de negocio o la forma de responder es
// editar un archivo de texto, sin tocar el servidor ni el ciclo.
// =====================================================================

import { join } from "node:path";
import { leerTextoOpcional } from "../dominio/archivos.ts";
import type { Resultado } from "../esquemas.ts";

// Une el prompt y el conocimiento. Si falta alguno de los dos archivos, lo dice con claridad.
export function cargarInstrucciones(raizProyecto: string): Resultado<string> {
  const prompt = leerTextoOpcional(join(raizProyecto, "agent", "prompt.md"));
  if (prompt === null) return { ok: false, error: "Falta el archivo agent/prompt.md con las instrucciones del agente." };

  const conocimiento = leerTextoOpcional(join(raizProyecto, "src", "knowledge", "ordenes-compra.md"));
  if (conocimiento === null) {
    return { ok: false, error: "Falta el archivo src/knowledge/ordenes-compra.md con el conocimiento del proceso." };
  }

  // Los saltos de línea se normalizan para que el texto sea el mismo en cualquier sistema
  const unir = (texto: string): string => texto.replace(/\r\n/g, "\n").trim();
  return { ok: true, data: `${unir(prompt)}\n\n---\n\n${unir(conocimiento)}\n` };
}
