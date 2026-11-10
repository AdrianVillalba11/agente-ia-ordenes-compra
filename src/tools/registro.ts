// =====================================================================
// registro.ts — El "recepcionista" de las herramientas.
//
// Es el único punto por el que se ejecutan las herramientas, tanto desde
// el agente como desde demo.ts. Hace cuatro cosas:
//   1. Les da el nombre que ve el modelo: "<archivo>_<export>", por ejemplo
//      oc_leer_paquete (regla del PRD).
//   2. Valida los argumentos con zod ANTES de ejecutar; si no cumplen,
//      devuelve un error legible al modelo en lugar de lanzar una excepción.
//   3. Resume cada resultado en una frase (lo que verá el chat y la demo).
//   4. Anota cada llamada en out/log.jsonl (requisito CA4 del PRD).
//
// CASOS DELICADOS que este archivo cuida:
//   - Nunca lanza: un nombre desconocido, argumentos inválidos o una falla
//     interna se devuelven como { ok: false, error }.
//   - El log nunca rompe una herramienta: si no se puede escribir, la
//     llamada sigue y se devuelve su resultado.
//   - Los argumentos se recortan en el log (un payload completo ocuparía
//     cientos de caracteres).
// =====================================================================

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { describirErrorZod } from "../dominio/archivos.ts";
import { respuestaError, type ContextoHerramienta } from "../esquemas.ts";
import type { DefinicionHerramienta } from "../llm/adapter.ts";
import * as herramientasOc from "./oc.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Registro de herramientas
// ---------------------------------------------------------------------

// Forma común de toda herramienta (contrato del PRD). "args: never" permite
// guardar herramientas con distintos argumentos en un mismo registro; los
// argumentos ya vienen validados por zod cuando se ejecutan.
type Herramienta = {
  description: string;
  args: Record<string, z.ZodType>;
  execute: (args: never, ctx: ContextoHerramienta) => Promise<string>;
};

// Orden con el que se presentan las herramientas (el del proceso)
const ORDEN_LOGICO = ["leer_paquete", "validar", "construir_payload", "generar_evidencia", "crear"];

// Cada export de oc.ts es una herramienta; su nombre es "oc_" + el nombre del export.
// Si algún día oc.ts exportara algo que no es una herramienta, esto no compilaría.
const REGISTRO: ReadonlyMap<string, Herramienta> = (() => {
  const entradas: [string, Herramienta][] = [];
  for (const [exportacion, herramienta] of Object.entries(herramientasOc)) {
    entradas.push([exportacion, herramienta]);
  }
  const posicion = (exportacion: string): number => {
    const indice = ORDEN_LOGICO.indexOf(exportacion);
    return indice === -1 ? ORDEN_LOGICO.length : indice;
  };
  entradas.sort(([a], [b]) => posicion(a) - posicion(b));
  return new Map(entradas.map(([exportacion, herramienta]) => [`oc_${exportacion}`, herramienta]));
})();

// Los nombres y descripciones que se le muestran al modelo
export function listarHerramientas(): { nombre: string; descripcion: string }[] {
  return [...REGISTRO.entries()].map(([nombre, herramienta]) => ({ nombre, descripcion: herramienta.description }));
}

// ---------------------------------------------------------------------
// BLOQUE 2 — Leer y resumir las respuestas
// ---------------------------------------------------------------------

export type RespuestaHerramienta = {
  ok: boolean;
  data?: unknown;
  error?: string;
  requiere_confirmacion?: boolean;
  confirmaciones?: unknown;
};

// Interpreta el texto JSON que devuelve una herramienta; null si no cumple el contrato { ok, ... }
export function analizarRespuesta(texto: string): RespuestaHerramienta | null {
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    return null;
  }
  if (typeof crudo !== "object" || crudo === null) return null;
  const objeto = crudo as Record<string, unknown>;
  if (typeof objeto.ok !== "boolean") return null;
  return {
    ok: objeto.ok,
    data: objeto.data,
    error: typeof objeto.error === "string" ? objeto.error : undefined,
    requiere_confirmacion: objeto.requiere_confirmacion === true,
    confirmaciones: objeto.confirmaciones,
  };
}

// Navega por un objeto desconocido: leer(d, "a", "b") equivale a d.a.b (o undefined si no existe)
function leer(valor: unknown, ...ruta: string[]): unknown {
  let actual: unknown = valor;
  for (const clave of ruta) {
    if (typeof actual !== "object" || actual === null) return undefined;
    actual = (actual as Record<string, unknown>)[clave];
  }
  return actual;
}

const texto = (valor: unknown): string => (typeof valor === "string" ? valor : "?");
const cantidad = (valor: unknown): number => (Array.isArray(valor) ? valor.length : 0);
const sino = (valor: unknown): string => (valor === true ? "sí" : "no");
const recortar = (valor: string, maximo = 160): string => (valor.length > maximo ? `${valor.slice(0, maximo)}...` : valor);

// Lista de códigos de regla: [{codigo:"RC5"},{codigo:"RC8"}] -> "RC5, RC8" (o "-" si no hay)
function codigos(lista: unknown): string {
  if (!Array.isArray(lista) || lista.length === 0) return "-";
  return lista.map((hallazgo) => texto(leer(hallazgo, "codigo"))).join(", ");
}

function resumirError(herramienta: string, respuesta: RespuestaHerramienta): string {
  if (respuesta.requiere_confirmacion) return `Requiere confirmación: ${codigos(respuesta.confirmaciones)}`;

  const error = respuesta.error ?? "sin detalle";
  if (herramienta === "oc_crear" && error.includes("bloqueos")) {
    const reglas = [...error.matchAll(/^- (RC\d+|SAP):/gm)].map((coincidencia) => coincidencia[1] ?? "?");
    if (reglas.length > 0) return `Bloqueada: ${reglas.join(", ")}`;
  }
  return `Error: ${recortar(error.split("\n")[0] ?? error)}`;
}

// Una frase que describe el resultado de una herramienta (para el chat, la demo y el log)
export function resumirResultado(herramienta: string, respuesta: RespuestaHerramienta): string {
  if (!respuesta.ok) return resumirError(herramienta, respuesta);

  const d = respuesta.data;
  switch (herramienta) {
    case "oc_leer_paquete":
      return `Paquete de ${texto(leer(d, "solicitud", "solicitud_id"))}: cotización ${leer(d, "cotizacion") === null ? "no" : "sí"}, aprobación ${leer(d, "aprobacion") === null ? "no" : "sí"}, factura ${leer(d, "factura") === null ? "no" : "sí"}, faltantes: ${cantidad(leer(d, "faltantes"))}`;
    case "oc_validar":
      return `apta: ${sino(leer(d, "apta"))} | bloqueos: ${codigos(leer(d, "bloqueos"))} | confirmaciones: ${codigos(leer(d, "confirmaciones"))} | retroactiva: ${sino(leer(d, "retroactiva"))}`;
    case "oc_construir_payload":
      return `OC armada con ${cantidad(leer(d, "orden", "posiciones"))} posición(es); excepciones: ${codigos(leer(d, "orden", "excepciones"))}; advertencias: ${cantidad(leer(d, "advertencias"))}`;
    case "oc_generar_evidencia": {
      const pdf = leer(d, "ruta_pdf");
      return `Evidencia en ${texto(leer(d, "ruta"))} y ${typeof pdf === "string" ? pdf : "sin PDF"} (sha256 ${texto(leer(d, "sha256")).slice(0, 12)}...)`;
    }
    case "oc_crear":
      return `OC ${texto(leer(d, "numero_oc"))} ${leer(d, "idempotente") === true ? "ya existía (idempotente)" : "creada"}, fecha ${texto(leer(d, "fecha"))}`;
    default:
      return "ok";
  }
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Ejecutar una herramienta
// ---------------------------------------------------------------------

export type EjecucionHerramienta = {
  herramienta: string;
  ok: boolean;
  error: string | null;
  resumen: string; // una frase, para el chat y la demo
  respuesta: string; // el JSON que ve el modelo
  requiereConfirmacion: boolean; // el chat debe resaltar que se espera una confirmación
};

// Ejecuta la herramienta validando sus argumentos; siempre devuelve un texto JSON { ok, ... }
async function ejecutarSinRegistro(nombre: string, argumentos: unknown, ctx: ContextoHerramienta): Promise<string> {
  const herramienta = REGISTRO.get(nombre);
  if (herramienta === undefined) {
    const disponibles = [...REGISTRO.keys()].join(", ");
    return respuestaError(`Herramienta desconocida "${nombre}". Herramientas disponibles: ${disponibles}.`);
  }

  // El backend valida antes de ejecutar y le devuelve el error al modelo
  const validados = z.object(herramienta.args).safeParse(argumentos ?? {});
  if (!validados.success) {
    return respuestaError(
      `Argumentos inválidos para ${nombre}: ${describirErrorZod(validados.error)}. Revisa la descripción de la herramienta.`,
    );
  }

  try {
    return await herramienta.execute(validados.data as never, ctx);
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error);
    return respuestaError(`La herramienta ${nombre} falló: ${motivo}`);
  }
}

// Los argumentos en una línea, recortada (un payload entero sería enorme)
function compactar(argumentos: unknown): string {
  let serializado: string;
  try {
    serializado = JSON.stringify(argumentos) ?? "undefined";
  } catch {
    serializado = "(no serializable)";
  }
  return serializado.length > 300 ? `${serializado.slice(0, 300)}…` : serializado;
}

// Agrega una línea a out/log.jsonl. Si no se puede escribir, la llamada sigue: el log nunca rompe una herramienta.
function anotarEnLog(ctx: ContextoHerramienta, linea: Record<string, unknown>): void {
  try {
    const carpeta = join(ctx.directory, "out");
    mkdirSync(carpeta, { recursive: true });
    appendFileSync(join(carpeta, "log.jsonl"), `${JSON.stringify(linea)}\n`, "utf-8");
  } catch {
    // Sin log, pero la herramienta ya hizo su trabajo
  }
}

// Punto de entrada: ejecuta una herramienta por su nombre, la resume y la anota en el log.
export async function ejecutarHerramienta(
  nombre: string,
  argumentos: unknown,
  ctx: ContextoHerramienta,
): Promise<EjecucionHerramienta> {
  const textoCrudo = await ejecutarSinRegistro(nombre, argumentos, ctx);

  // Si la herramienta no cumplió el contrato { ok, ... }, se informa en vez de propagar basura
  const analizada = analizarRespuesta(textoCrudo);
  const respuesta = analizada === null ? respuestaError(`La herramienta ${nombre} devolvió una respuesta inválida.`) : textoCrudo;
  const final: RespuestaHerramienta = analizada ?? { ok: false, error: `La herramienta ${nombre} devolvió una respuesta inválida.` };

  const resumen = resumirResultado(nombre, final);
  const caso = leer(argumentos, "caso");
  anotarEnLog(ctx, {
    ts: (ctx.ahora ?? (() => new Date()))().toISOString(),
    sesion: ctx.sessionId,
    herramienta: nombre,
    caso: typeof caso === "string" ? caso : null,
    argumentos: compactar(argumentos),
    ok: final.ok,
    resumen,
  });

  return {
    herramienta: nombre,
    ok: final.ok,
    error: final.error ?? null,
    resumen,
    respuesta,
    requiereConfirmacion: final.requiere_confirmacion === true,
  };
}

// ---------------------------------------------------------------------
// BLOQUE 4 — Lo que ve el modelo
// ---------------------------------------------------------------------
//
// El modelo solo ve y puede enviar el argumento "caso". Los demás argumentos
// del contrato del PRD siguen existiendo en el código (la demo y las pruebas los
// usan), pero se le ocultan por dos razones:
//   - paquete, derivados y payload solo sirven para contrastar contra el disco:
//     mostrárselos solo le daría la oportunidad de alterar un valor y costaría tokens;
//   - confirmado NO lo decide el modelo: lo decide el ciclo del agente, a partir
//     de lo que escribió el usuario (ver src/agente/confirmacion.ts).

const ARGUMENTOS_OCULTOS = new Set(["paquete", "derivados", "payload", "confirmado"]);

// Deja solo lo esencial del esquema JSON (tipo, descripción, valores posibles, propiedades
// y obligatorios), para que cualquier proveedor lo acepte sin quejarse de campos que no conoce.
function simplificarEsquema(esquema: unknown): Record<string, unknown> {
  const origen = typeof esquema === "object" && esquema !== null ? (esquema as Record<string, unknown>) : {};
  const salida: Record<string, unknown> = {};

  for (const clave of ["type", "description", "enum", "required"]) {
    if (clave in origen) salida[clave] = origen[clave];
  }
  if (typeof origen.properties === "object" && origen.properties !== null) {
    salida.properties = Object.fromEntries(
      Object.entries(origen.properties as Record<string, unknown>).map(([nombre, propiedad]) => [nombre, simplificarEsquema(propiedad)]),
    );
  }
  if (origen.items !== undefined) salida.items = simplificarEsquema(origen.items);
  return salida;
}

// Nombre, descripción y argumentos de cada herramienta, tal como se le muestran al modelo
export function definicionesParaModelo(): DefinicionHerramienta[] {
  return [...REGISTRO.entries()].map(([nombre, herramienta]) => {
    const visibles = Object.fromEntries(Object.entries(herramienta.args).filter(([argumento]) => !ARGUMENTOS_OCULTOS.has(argumento)));
    return {
      nombre,
      descripcion: herramienta.description,
      parametros: simplificarEsquema(z.toJSONSchema(z.object(visibles))),
    };
  });
}

// Deja pasar solo los argumentos visibles. Si el modelo envía uno oculto (por ejemplo
// "confirmado: true" por su cuenta), simplemente se descarta.
export function filtrarArgumentosDelModelo(nombre: string, argumentos: unknown): Record<string, unknown> {
  const herramienta = REGISTRO.get(nombre);
  if (herramienta === undefined || typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) return {};

  const permitidos = new Set(Object.keys(herramienta.args).filter((argumento) => !ARGUMENTOS_OCULTOS.has(argumento)));
  return Object.fromEntries(Object.entries(argumentos as Record<string, unknown>).filter(([argumento]) => permitidos.has(argumento)));
}

// El resultado de una herramienta, listo para el modelo. Se le quitan los textos completos
// de la cotización y del correo de aprobación: no los necesita (las conclusiones ya vienen
// como datos), cuestan tokens y son justo donde alguien podría esconder instrucciones.
export function resultadoParaModelo(nombre: string, respuesta: string): Record<string, unknown> {
  const ilegible = { ok: false, error: "La herramienta devolvió una respuesta ilegible." };
  let crudo: unknown;
  try {
    crudo = JSON.parse(respuesta);
  } catch {
    return ilegible;
  }
  if (typeof crudo !== "object" || crudo === null || Array.isArray(crudo)) return ilegible;

  const resultado = structuredClone(crudo) as Record<string, unknown>;
  if (nombre === "oc_leer_paquete") {
    const datos = resultado.data;
    for (const parte of ["cotizacion", "aprobacion"]) {
      const bloque = typeof datos === "object" && datos !== null ? (datos as Record<string, unknown>)[parte] : undefined;
      if (typeof bloque === "object" && bloque !== null) delete (bloque as Record<string, unknown>).texto;
    }
  }
  return resultado;
}
