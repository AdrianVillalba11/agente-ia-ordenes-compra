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
import { leerTextoOpcional } from "../dominio/archivos.ts";
import { validarPaquete } from "../dominio/controles.ts";
import { hayPendienteIgual, registrarControl, type FilaControl } from "../dominio/control.ts";
import { construirEvidencia, evidenciaCoincide } from "../dominio/evidencia.ts";
import { generarPdfEvidencia } from "../dominio/evidencia-pdf.ts";
import { cargarMaestros } from "../dominio/maestros.ts";
import { construirOrden } from "../dominio/orden.ts";
import { leerPaquete, NOMBRE_CASO_VALIDO, valoresIguales } from "../dominio/paquete.ts";
import {
  EsquemaDerivados,
  EsquemaOrdenCompra,
  EsquemaPaquete,
  respuestaError,
  respuestaOk,
  respuestaRequiereConfirmacion,
  type ContextoHerramienta,
  type Derivados,
  type Hallazgo,
  type OrdenCompra,
  type Paquete,
  type Resultado,
  type ResultadoValidacion,
} from "../esquemas.ts";
import { ErrorSap } from "../sap/adapter.ts";
import { SapMock } from "../sap/mock.ts";

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

// ---------------------------------------------------------------------
// BLOQUE 5 — oc_generar_evidencia
// ---------------------------------------------------------------------

export const generar_evidencia = {
  description:
    "Genera la evidencia de aprobación de un caso en out/<caso>/aprobacion.txt y aprobacion.pdf, con encabezados, cuerpo y sha256 del contenido, y devuelve las rutas y el hash.",
  args: { caso: ARGUMENTO_CASO },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    try {
      // La evidencia es una copia fiel del correo de aprobación: no depende de la validación
      const evidencia = construirEvidencia(args.caso, ctx.directory);
      if (!evidencia.ok) return respuestaError(evidencia.error);

      // El .txt es lo obligatorio: se escribe primero
      const carpetaSalida = join(ctx.directory, "out", args.caso);
      mkdirSync(carpetaSalida, { recursive: true });
      writeFileSync(join(carpetaSalida, "aprobacion.txt"), evidencia.data.texto, "utf-8");

      // El PDF es un complemento: si falla, el .txt ya quedó escrito y solo se avisa
      const advertencias: string[] = [];
      let rutaPdf: string | null = null;
      try {
        const pdf = await generarPdfEvidencia(evidencia.data);
        writeFileSync(join(carpetaSalida, "aprobacion.pdf"), pdf.bytes);
        rutaPdf = `out/${args.caso}/aprobacion.pdf`;
        if (pdf.caracteresReemplazados.length > 0) {
          advertencias.push(
            `El PDF no admite estos caracteres y se reemplazaron por "?": ${pdf.caracteresReemplazados.join(" ")}. El archivo .txt conserva el texto completo.`,
          );
        }
      } catch (error) {
        const motivo = error instanceof Error ? error.message : String(error);
        advertencias.push(`No se pudo generar el PDF (${motivo}); la evidencia en .txt sí quedó escrita.`);
      }

      return respuestaOk({
        ruta: `out/${args.caso}/aprobacion.txt`,
        ruta_pdf: rutaPdf,
        sha256: evidencia.data.sha256,
        advertencias,
      });
    } catch (error) {
      return errorInesperado("al generar la evidencia", error);
    }
  },
};

// ---------------------------------------------------------------------
// BLOQUE 6 — oc_crear
// ---------------------------------------------------------------------

// Lista legible de hallazgos para los mensajes de error
function describirHallazgos(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => `- ${h.codigo}: ${h.detalle} Acción: ${h.accion_sugerida}`).join("\n");
}

export const crear = {
  description:
    "Crea la orden de compra de un caso en el SAP simulado si no tiene bloqueos, tiene su evidencia de aprobación y las confirmaciones pendientes fueron confirmadas por el usuario; si la solicitud ya tiene orden, devuelve la existente.",
  args: {
    caso: ARGUMENTO_CASO,
    payload: EsquemaOrdenCompra.optional().describe(
      "Opcional. Si se envía, debe ser idéntico a la orden devuelta por oc_construir_payload; siempre se crea la orden reconstruida desde el disco.",
    ),
    confirmado: z
      .boolean()
      .optional()
      .describe(
        "Solo true si el usuario confirmó de forma explícita, en su mensaje más reciente, las confirmaciones que se le mostraron. Nunca lo deduzcas ni lo pongas por tu cuenta.",
      ),
  },
  async execute(
    args: { caso: string; payload?: OrdenCompra; confirmado?: boolean },
    ctx: ContextoHerramienta,
  ): Promise<string> {
    try {
      // 0. Preparar: leer, validar y reconstruir todo desde el disco
      const preparado = prepararCaso(args.caso, undefined, undefined, ctx);
      if (!preparado.ok) return respuestaError(preparado.error);
      const { paquete, validacion } = preparado.data;

      const solicitudId = paquete.solicitud.solicitud_id;
      const ahora = ctx.ahora ?? (() => new Date());
      const sap = new SapMock(ctx.directory, ahora);
      const codigos = (hallazgos: Hallazgo[]): string[] => hallazgos.map((h) => h.codigo);

      // Deja constancia del intento en out/control.csv
      const registrar = (
        resultado: FilaControl["resultado"],
        numeroOc: string | null,
        bloqueos: string[] = codigos(validacion.bloqueos),
      ): void => {
        registrarControl(ctx.directory, {
          solicitud_id: solicitudId,
          resultado,
          numero_oc: numeroOc,
          retroactiva: validacion.retroactiva,
          bloqueos,
          confirmaciones: codigos(validacion.confirmaciones),
          ts: ahora().toISOString(),
        });
      };

      // 1. Idempotencia: si la solicitud ya tiene orden, se devuelve esa
      const existente = await sap.buscarOrdenPorReferencia(solicitudId);
      if (existente !== null) {
        registrar("ya_existente", existente.numero_oc);
        return respuestaOk({ numero_oc: existente.numero_oc, fecha: existente.fecha, idempotente: true });
      }

      // 2. Los bloqueos no se pueden saltar, ni siquiera con confirmado: true
      if (!validacion.apta) {
        registrar("bloqueada", null);
        return respuestaError(
          `El caso ${args.caso} tiene bloqueos y no se puede crear la OC:\n${describirHallazgos(validacion.bloqueos)}`,
        );
      }

      // 3. Reconstruir la orden desde el disco; el modelo no puede alterarla
      const evidencia = construirEvidencia(args.caso, ctx.directory);
      if (!evidencia.ok) return respuestaError(evidencia.error);
      const construida = construirOrden(paquete, validacion, evidencia.data.sha256);
      if (!construida.ok) return respuestaError(construida.error);
      const orden = construida.data.orden;
      if (args.payload !== undefined && !valoresIguales(args.payload, orden)) {
        return respuestaError(
          `El payload enviado no coincide con la orden del caso ${args.caso}. Se crea siempre la orden reconstruida desde el disco: usa exactamente la que devolvió oc_construir_payload.`,
        );
      }

      // 4. La evidencia de aprobación debe existir y ser la de esta orden
      const evidenciaEscrita = leerTextoOpcional(join(ctx.directory, "out", args.caso, "aprobacion.txt"));
      if (evidenciaEscrita === null) {
        return respuestaError(
          `Falta la evidencia de aprobación (out/${args.caso}/aprobacion.txt). Ejecuta oc_generar_evidencia y vuelve a intentar.`,
        );
      }
      if (!evidenciaCoincide(evidenciaEscrita, orden.aprobador.evidencia_sha256)) {
        return respuestaError(
          `La evidencia out/${args.caso}/aprobacion.txt no coincide con la aprobación del caso (fue alterada o es de otra aprobación). Vuelve a ejecutar oc_generar_evidencia.`,
        );
      }

      // 5. Confirmaciones: solo se aceptan si antes se mostraron
      const pendientes = validacion.confirmaciones;
      if (pendientes.length > 0) {
        if (args.confirmado !== true) {
          registrar("pendiente_confirmacion", null);
          return respuestaRequiereConfirmacion(
            `Requiere confirmación humana antes de crear la OC de ${solicitudId}. Muestra esto al usuario y espera su respuesta:\n${describirHallazgos(pendientes)}`,
            pendientes,
          );
        }
        if (!hayPendienteIgual(ctx.directory, solicitudId, codigos(pendientes))) {
          registrar("pendiente_confirmacion", null);
          return respuestaRequiereConfirmacion(
            `No se puede confirmar algo que aún no se mostró. Muestra primero al usuario las confirmaciones pendientes y espera su respuesta; solo entonces vuelve a llamar con confirmado: true.\n${describirHallazgos(pendientes)}`,
            pendientes,
          );
        }
      }

      // 6. SAP debe reconocer al proveedor como activo, con el mismo código
      const proveedorSap = await sap.consultarProveedor(orden.proveedor.nit);
      if (proveedorSap === null || !proveedorSap.activo || proveedorSap.codigo_sap !== orden.proveedor.codigo_sap) {
        registrar("bloqueada", null, ["SAP"]);
        return respuestaError(
          `SAP no reconoce al proveedor ${orden.proveedor.nombre} (NIT ${orden.proveedor.nit}) como activo con el código ${orden.proveedor.codigo_sap}.`,
        );
      }

      // 7. Crear. Las excepciones quedan confirmadas por la sesión que las aceptó.
      const confirmadoPor = `sesion:${ctx.sessionId}`;
      const ordenFinal: OrdenCompra = {
        ...orden,
        excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: confirmadoPor })),
      };
      const creada = await sap.crearOrden(ordenFinal);
      const yaExistia = creada.ya_existia === true; // otra llamada simultánea pudo crearla antes
      registrar(yaExistia ? "ya_existente" : "creada", creada.numero_oc);
      return respuestaOk({ numero_oc: creada.numero_oc, fecha: creada.fecha, idempotente: yaExistia });
    } catch (error) {
      // Un error esperado de SAP (archivo dañado) se muestra tal cual
      if (error instanceof ErrorSap) return respuestaError(error.message);
      return errorInesperado("al crear la orden", error);
    }
  },
};
