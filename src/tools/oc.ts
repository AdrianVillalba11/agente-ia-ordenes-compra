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
import { cargarMaestros } from "../dominio/maestros.ts";
import { validarPaquete } from "../dominio/controles.ts";
import { leerPaquete, NOMBRE_CASO_VALIDO, paquetesIguales } from "../dominio/paquete.ts";
import { EsquemaPaquete, respuestaError, respuestaOk, type ContextoHerramienta, type Paquete } from "../esquemas.ts";

// Descripción del argumento "caso", igual en todas las herramientas
const ARGUMENTO_CASO = z
  .string()
  .regex(NOMBRE_CASO_VALIDO, "Solo letras, números y guiones")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001");

// Mensaje de una falla imprevista; evita que una excepción tumbe al agente
function errorInesperado(contexto: string, error: unknown): string {
  const motivo = error instanceof Error ? error.message : String(error);
  return respuestaError(`Error inesperado ${contexto}: ${motivo}`);
}

// ---------------------------------------------------------------------
// BLOQUE 1 — oc_leer_paquete
// ---------------------------------------------------------------------

export const leer_paquete = {
  description:
    "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y devuelve el paquete normalizado, con la lista de adjuntos faltantes.",
  args: { caso: ARGUMENTO_CASO },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    try {
      const resultado = leerPaquete(args.caso, ctx.directory);
      return resultado.ok ? respuestaOk(resultado.data) : respuestaError(resultado.error);
    } catch (error) {
      return errorInesperado("al leer el paquete", error);
    }
  },
};

// ---------------------------------------------------------------------
// BLOQUE 2 — oc_validar
// ---------------------------------------------------------------------

export const validar = {
  description:
    "Valida un caso contra los maestros y las reglas de control RC1 a RC10; devuelve si es apta, los bloqueos, las confirmaciones, los valores derivados y si la compra es retroactiva.",
  args: {
    caso: ARGUMENTO_CASO,
    paquete: EsquemaPaquete.optional().describe(
      "Opcional. Si se envía, debe ser idéntico al devuelto por oc_leer_paquete; la validación siempre usa el paquete leído del disco.",
    ),
  },
  async execute(args: { caso: string; paquete?: Paquete }, ctx: ContextoHerramienta): Promise<string> {
    try {
      // La fuente de verdad es el disco, no lo que envíe el modelo
      const delDisco = leerPaquete(args.caso, ctx.directory);
      if (!delDisco.ok) return respuestaError(delDisco.error);

      // Si el modelo envió un paquete, debe ser idéntico: así no puede "arreglar" un monto
      if (args.paquete !== undefined && !paquetesIguales(args.paquete, delDisco.data)) {
        return respuestaError(
          `El paquete enviado no coincide con el del caso ${args.caso}. La validación usa siempre el paquete leído del disco: vuelve a llamar a oc_leer_paquete y no modifiques sus valores.`,
        );
      }

      const maestros = cargarMaestros(ctx.directory);
      if (!maestros.ok) return respuestaError(maestros.error);

      return respuestaOk(validarPaquete(delDisco.data, maestros.data));
    } catch (error) {
      return errorInesperado("al validar el caso", error);
    }
  },
};
