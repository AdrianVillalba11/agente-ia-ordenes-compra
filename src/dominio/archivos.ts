// =====================================================================
// archivos.ts — Lectura segura de archivos, compartida por el dominio.
//
// Ninguna de estas funciones lanza una excepción: si algo falla,
// devuelven null o un error legible (regla del PRD).
// =====================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Resultado } from "../esquemas.ts";

// Lee un archivo de texto; devuelve null si no existe o no se puede leer.
// Se quita el BOM inicial, que rompería JSON.parse.
export function leerTextoOpcional(ruta: string): string | null {
  try {
    if (!existsSync(ruta)) return null;
    return readFileSync(ruta, "utf-8").replace(/^﻿/, "");
  } catch {
    return null;
  }
}

// Describe un error de zod en una frase: "valor_total: expected number, ..."
export function describirErrorZod(error: z.ZodError): string {
  return error.issues
    .map((problema) => `${problema.path.map(String).join(".") || "(raíz)"}: ${problema.message}`)
    .join("; ");
}

// Lee un JSON y lo valida contra su esquema. Devuelve un error legible
// (nunca lanza) si el archivo falta, está roto o tiene datos inválidos.
export function leerJsonValidado<T>(carpeta: string, nombre: string, esquema: z.ZodType<T>): Resultado<T> {
  const texto = leerTextoOpcional(join(carpeta, nombre));
  if (texto === null) return { ok: false, error: `Falta el archivo ${nombre}.` };

  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    return { ok: false, error: `${nombre} no es un JSON válido.` };
  }

  const resultado = esquema.safeParse(crudo);
  if (!resultado.success) {
    return { ok: false, error: `${nombre} tiene datos inválidos (${describirErrorZod(resultado.error)}).` };
  }
  return { ok: true, data: resultado.data };
}
