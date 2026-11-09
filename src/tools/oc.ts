// =====================================================================
// oc.ts — Herramientas del agente de órdenes de compra.
//
// Cada herramienta es un objeto con tres partes (contrato del PRD):
//   - description: una frase; es lo único que el modelo lee para decidir
//                  cuándo usarla.
//   - args:        esquemas zod de sus argumentos, cada uno con .describe().
//   - execute:     devuelve un string JSON { ok, data } o { ok: false, error }
//                  y NUNCA lanza una excepción.
//
// El modelo las ve como "<archivo>_<export>", por ejemplo "oc_leer_paquete".
// Estas funciones son delgadas: la lógica de negocio vive en src/dominio/.
// =====================================================================

import { z } from "zod";
import { leerPaquete, NOMBRE_CASO_VALIDO } from "../dominio/paquete.ts";
import { respuestaError, respuestaOk, type ContextoHerramienta } from "../esquemas.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — oc_leer_paquete
// ---------------------------------------------------------------------

export const leer_paquete = {
  description:
    "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y devuelve el paquete normalizado, con la lista de adjuntos faltantes.",
  args: {
    caso: z
      .string()
      .regex(NOMBRE_CASO_VALIDO, "Solo letras, números y guiones")
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001"),
  },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    try {
      const resultado = leerPaquete(args.caso, ctx.directory);
      return resultado.ok ? respuestaOk(resultado.data) : respuestaError(resultado.error);
    } catch (error) {
      // Red de seguridad: una falla imprevista (permisos, disco) no debe
      // tumbar al agente; se devuelve como un error legible.
      const motivo = error instanceof Error ? error.message : String(error);
      return respuestaError(`Error inesperado al leer el paquete: ${motivo}`);
    }
  },
};
