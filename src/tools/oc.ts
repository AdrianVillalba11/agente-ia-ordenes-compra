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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { validarPaquete } from "../dominio/controles.ts";
import { construirEvidencia } from "../dominio/evidencia.ts";
import { cargarMaestros } from "../dominio/maestros.ts";
import { construirOrden } from "../dominio/orden.ts";
import { leerPaquete, NOMBRE_CASO_VALIDO, valoresIguales } from "../dominio/paquete.ts";
import {
  EsquemaDerivados,
  EsquemaPaquete,
  respuestaError,
  respuestaOk,
  type ContextoHerramienta,
  type Derivados,
  type Paquete,
  type Resultado,
  type ResultadoValidacion,
} from "../esquemas.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Piezas compartidas por las herramientas
// ---------------------------------------------------------------------

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

// Lo que necesitan las herramientas que trabajan sobre un caso ya validado
type CasoPreparado = { paquete: Paquete; validacion: ResultadoValidacion };

// Lee el caso del disco, contrasta lo que haya enviado el modelo y lo valida.
// La fuente de verdad es SIEMPRE el disco: si el modelo envía un paquete (o unos
// derivados) distintos, se rechaza para que no pueda "arreglar" un valor.
function prepararCaso(
  caso: string,
  paqueteEnviado: Paquete | undefined,
  derivadosEnviados: Derivados | undefined,
  ctx: ContextoHerramienta,
): Resultado<CasoPreparado> {
  const delDisco = leerPaquete(caso, ctx.directory);
  if (!delDisco.ok) return { ok: false, error: delDisco.error };

  if (paqueteEnviado !== undefined && !valoresIguales(paqueteEnviado, delDisco.data)) {
    return {
      ok: false,
      error: `El paquete enviado no coincide con el del caso ${caso}. La validación usa siempre el paquete leído del disco: vuelve a llamar a oc_leer_paquete y no modifiques sus valores.`,
    };
  }

  const maestros = cargarMaestros(ctx.directory);
  if (!maestros.ok) return { ok: false, error: maestros.error };

  const validacion = validarPaquete(delDisco.data, maestros.data);

  if (derivadosEnviados !== undefined && !valoresIguales(derivadosEnviados, validacion.derivados)) {
    return {
      ok: false,
      error: `Los derivados enviados no coinciden con los calculados para el caso ${caso}. Usa exactamente los que devolvió oc_validar.`,
    };
  }

  return { ok: true, data: { paquete: delDisco.data, validacion } };
}

// ---------------------------------------------------------------------
// BLOQUE 2 — oc_leer_paquete
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
// BLOQUE 3 — oc_validar
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
      const preparado = prepararCaso(args.caso, args.paquete, undefined, ctx);
      return preparado.ok ? respuestaOk(preparado.data.validacion) : respuestaError(preparado.error);
    } catch (error) {
      return errorInesperado("al validar el caso", error);
    }
  },
};

// ---------------------------------------------------------------------
// BLOQUE 4 — oc_construir_payload
// ---------------------------------------------------------------------

export const construir_payload = {
  description:
    "Arma la orden de compra tal como quedaría en SAP para un caso sin bloqueos, guarda en out/<caso>/trazabilidad.json de dónde sale cada valor y devuelve la orden con sus advertencias.",
  args: {
    caso: ARGUMENTO_CASO,
    paquete: EsquemaPaquete.optional().describe(
      "Opcional. Si se envía, debe ser idéntico al devuelto por oc_leer_paquete; siempre se usa el paquete leído del disco.",
    ),
    derivados: EsquemaDerivados.optional().describe(
      "Opcional. Si se envían, deben ser idénticos a los devueltos por oc_validar; siempre se usan los calculados desde el disco.",
    ),
  },
  async execute(
    args: { caso: string; paquete?: Paquete; derivados?: Derivados },
    ctx: ContextoHerramienta,
  ): Promise<string> {
    try {
      const preparado = prepararCaso(args.caso, args.paquete, args.derivados, ctx);
      if (!preparado.ok) return respuestaError(preparado.error);
      const { paquete, validacion } = preparado.data;

      // El hash de la evidencia va dentro de la OC
      const evidencia = construirEvidencia(args.caso, ctx.directory);
      if (!evidencia.ok) return respuestaError(evidencia.error);

      const resultado = construirOrden(paquete, validacion, evidencia.data.sha256);
      if (!resultado.ok) return respuestaError(resultado.error);

      // La trazabilidad se guarda en out/<caso>/ (el nombre del caso ya fue validado)
      const carpetaSalida = join(ctx.directory, "out", args.caso);
      mkdirSync(carpetaSalida, { recursive: true });
      writeFileSync(
        join(carpetaSalida, "trazabilidad.json"),
        JSON.stringify({ caso: args.caso, campos: resultado.data.trazabilidad }, null, 2),
        "utf-8",
      );

      return respuestaOk({
        orden: resultado.data.orden,
        trazabilidad_ruta: `out/${args.caso}/trazabilidad.json`,
        advertencias: resultado.data.advertencias,
      });
    } catch (error) {
      return errorInesperado("al construir la orden", error);
    }
  },
};
