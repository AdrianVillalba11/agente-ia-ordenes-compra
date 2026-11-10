// =====================================================================
// paquete.ts — Leer un caso y armar el "Paquete" normalizado.
//
// Un caso es una carpeta con varios archivos (correo, solicitud,
// cotización, aprobación y, a veces, factura). Aquí se leen y se
// convierten en un solo objeto con la forma de esquemas.ts.
//
// La cotización y la factura son TEXTO con formato fijo; sus datos se
// extraen con expresiones regulares (extracción determinista, sin LLM).
//
// CASOS DELICADOS que este archivo cuida:
//   1. El nombre del caso es una entrada externa: se valida para que
//      nadie pueda leer archivos fuera de los fixtures ("../../.env").
//   2. Ningún archivo ausente o ilegible lanza una excepción: el campo va
//      en null y el motivo queda en "faltantes", visible para el humano.
//   3. Que el cuerpo diga "Aprobado" no basta: "No aprobado" no cuenta.
//   4. La validez de la cotización viene en días; se calcula la fecha.
//   5. Montos y NIT se limpian con las utilidades de normalizar.ts.
// =====================================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  EsquemaCorreo,
  EsquemaPaquete,
  EsquemaSolicitud,
  type Aprobacion,
  type Cotizacion,
  type Factura,
  type Paquete,
  type Resultado,
} from "../esquemas.ts";
import { describirErrorZod, leerJsonValidado, leerTextoOpcional } from "./archivos.ts";
import { normalizarNit, normalizarTexto, parsearMonto, soloDia } from "./normalizar.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Constantes y validación del nombre del caso
// ---------------------------------------------------------------------

// Carpeta de los casos, relativa a la raíz del proyecto
export const RUTA_SOLICITUDES = "fixtures/reto-03/solicitudes";

// Solo letras, números y guiones: impide "../", "/" y "\" en el nombre del caso
export const NOMBRE_CASO_VALIDO = /^[A-Za-z0-9-]+$/;

// ---------------------------------------------------------------------
// BLOQUE 2 — Ayudante de búsqueda en texto
// ---------------------------------------------------------------------

// (La lectura segura de archivos JSON y de texto vive en archivos.ts,
// porque también la usa la carga de maestros.)

// Busca una línea con una expresión regular y devuelve el primer grupo, sin espacios
function buscar(texto: string, expresion: RegExp): string | null {
  return expresion.exec(texto)?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Fechas derivadas
// ---------------------------------------------------------------------

// Suma días a una fecha "YYYY-MM-DD" y devuelve otra fecha "YYYY-MM-DD".
// Se calcula en UTC puro (sin horas) para que el cambio de mes y de año sea exacto.
//   ("2026-08-18", 30) -> "2026-09-17"
export function sumarDias(dia: string, dias: number): string | null {
  const base = soloDia(dia);
  if (base === null) return null;
  const milisegundos = Date.UTC(
    Number(base.slice(0, 4)),
    Number(base.slice(5, 7)) - 1,
    Number(base.slice(8, 10)) + dias,
  );
  return new Date(milisegundos).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// BLOQUE 4 — Extracción de la cotización (texto con formato fijo)
// ---------------------------------------------------------------------

// Línea de total, igual en cotización y factura:
//   "TOTAL (IVA incluido): COP 11.400.000"  o  "TOTAL: COP 3.200.000"
const EXPRESION_TOTAL = /^TOTAL(?: \(IVA incluido\))?:\s*(.+)$/m;

// Extrae los datos de la cotización. Si falta algo imprescindible
// (total, moneda o proveedor) devuelve un error con el motivo.
export function extraerCotizacion(texto: string): Resultado<Cotizacion> {
  const lineaTotal = buscar(texto, EXPRESION_TOTAL);
  const total = lineaTotal === null ? null : parsearMonto(lineaTotal);
  if (total === null) return { ok: false, error: "no se pudo leer el total" };

  const moneda = lineaTotal?.match(/\b[A-Z]{3}\b/)?.[0];
  if (moneda === undefined) return { ok: false, error: "no se pudo leer la moneda" };

  const proveedor = buscar(texto, /^Proveedor:\s*(.+)$/m);
  if (proveedor === null) return { ok: false, error: "no se pudo leer el proveedor" };

  // El NIT se guarda ya limpio (solo dígitos); si no hay, queda en null
  const nitTexto = buscar(texto, /^NIT:\s*(.+)$/m);
  const nit = nitTexto === null ? null : normalizarNit(nitTexto) || null;

  // La validez viene en días ("30 días"); se convierte en una fecha límite
  const fechaTexto = buscar(texto, /^Fecha:\s*(.+)$/m);
  const fecha = fechaTexto === null ? null : soloDia(fechaTexto);
  const diasTexto = buscar(texto, /^Validez de la oferta:\s*(\d+)/mi);
  const validez_hasta =
    fecha !== null && diasTexto !== null ? sumarDias(fecha, Number(diasTexto)) : null;

  return {
    ok: true,
    data: {
      numero: buscar(texto, /^COTIZACI[OÓ]N\s+(\S+)/m),
      proveedor,
      nit,
      total,
      moneda,
      validez_hasta,
      texto,
    },
  };
}

// ---------------------------------------------------------------------
// BLOQUE 5 — Extracción de la factura
// ---------------------------------------------------------------------

// Extrae número, fecha de emisión y total de la factura (solo existe en sol-005).
export function extraerFactura(texto: string): Resultado<Factura> {
  const numero = buscar(texto, /^FACTURA.*?\bNo\.?\s*(\S+)/m);
  if (numero === null) return { ok: false, error: "no se pudo leer el número" };

  const fechaTexto = buscar(texto, /^Fecha de emisi[oó]n:\s*(.+)$/m);
  const fecha = fechaTexto === null ? null : soloDia(fechaTexto);
  if (fecha === null) return { ok: false, error: "no se pudo leer la fecha de emisión" };

  const lineaTotal = buscar(texto, EXPRESION_TOTAL);
  const total = lineaTotal === null ? null : parsearMonto(lineaTotal);
  if (total === null) return { ok: false, error: "no se pudo leer el total" };

  return { ok: true, data: { numero, fecha, total } };
}

// ---------------------------------------------------------------------
// BLOQUE 6 — Aprobación
// ---------------------------------------------------------------------

// Forma cruda del archivo aprobacion.json (solo lo que usamos)
const EsquemaAprobacionCruda = z.object({
  de: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
});

// ¿El cuerpo del correo aprueba el gasto? Debe decir "aprobado" y NO estar negado.
//   "Aprobado por 25 millones según la solicitud." -> true
//   "No aprobado" / "No está aprobado"             -> false
// Ante la duda responde false: el costo de un falso "no aprobado" es que
// un humano revise; el de un falso "aprobado" es un gasto sin autorización.
export function esAprobado(cuerpo: string): boolean {
  const texto = normalizarTexto(cuerpo); // sin tildes ni mayúsculas
  const dice = /\baprobado\b/.test(texto);
  const niega = /\b(no|sin|nunca|ni)\s+(\w+\s+){0,2}aprobado\b/.test(texto);
  return dice && !niega;
}

// ---------------------------------------------------------------------
// BLOQUE 6B — Comparar dos paquetes
// ---------------------------------------------------------------------

// Serializa un valor con las llaves ordenadas, para que dos objetos iguales
// den el mismo texto aunque sus llaves vengan en otro orden.
function serializarEstable(valor: unknown): string {
  return JSON.stringify(valor, (_llave, contenido: unknown) => {
    if (contenido === null || typeof contenido !== "object" || Array.isArray(contenido)) return contenido;
    return Object.fromEntries(Object.entries(contenido as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

// ¿Son idénticos dos valores (paquetes, derivados...)? Se usa para detectar que
// el modelo alteró algo que debía enviar tal cual.
export function valoresIguales(a: unknown, b: unknown): boolean {
  return serializarEstable(a) === serializarEstable(b);
}

// ---------------------------------------------------------------------
// BLOQUE 7 — Armado del paquete completo
// ---------------------------------------------------------------------

// Lista los casos disponibles, para dar un mensaje de error útil
function listarCasos(carpetaSolicitudes: string): string {
  try {
    return readdirSync(carpetaSolicitudes).sort().join(", ");
  } catch {
    return "(no se pudo leer la carpeta de casos)";
  }
}

// Lee los archivos de un caso y devuelve el Paquete.
//   - Faltan correo.json o solicitud.json (o están rotos) -> error: no se puede seguir.
//   - Falta o es ilegible la cotización, la aprobación o la factura -> ese campo va
//     en null y el motivo en "faltantes". Un humano decide con todo a la vista.
// Nunca lanza una excepción.
export function leerPaquete(caso: string, raizProyecto: string): Resultado<Paquete> {
  // 1. El nombre del caso debe ser seguro
  if (!NOMBRE_CASO_VALIDO.test(caso)) {
    return { ok: false, error: `Nombre de caso inválido: "${caso}". Solo se permiten letras, números y guiones.` };
  }

  // 2. La carpeta del caso debe existir
  const carpetaSolicitudes = join(raizProyecto, RUTA_SOLICITUDES);
  const carpeta = join(carpetaSolicitudes, caso);
  if (!existsSync(carpeta) || !statSync(carpeta).isDirectory()) {
    return { ok: false, error: `El caso "${caso}" no existe. Casos disponibles: ${listarCasos(carpetaSolicitudes)}.` };
  }

  // 3. Archivos obligatorios: sin ellos no hay paquete
  const correo = leerJsonValidado(carpeta, "correo.json", EsquemaCorreo);
  if (!correo.ok) return { ok: false, error: `Paquete incompleto: ${correo.error}` };
  const solicitud = leerJsonValidado(carpeta, "solicitud.json", EsquemaSolicitud);
  if (!solicitud.ok) return { ok: false, error: `Paquete incompleto: ${solicitud.error}` };

  const faltantes: string[] = [];

  // 4. Cotización: ausente o ilegible -> null + motivo en faltantes
  let cotizacion: Cotizacion | null = null;
  const textoCotizacion = leerTextoOpcional(join(carpeta, "cotizacion.txt"));
  if (textoCotizacion === null) {
    faltantes.push("cotizacion.txt");
  } else {
    const resultado = extraerCotizacion(textoCotizacion);
    if (resultado.ok) cotizacion = resultado.data;
    else faltantes.push(`cotizacion.txt: ${resultado.error}`);
  }

  // 5. Aprobación: ausente o ilegible -> null + motivo en faltantes
  let aprobacion: Aprobacion | null = null;
  if (leerTextoOpcional(join(carpeta, "aprobacion.json")) === null) {
    faltantes.push("aprobacion.json");
  } else {
    const resultado = leerJsonValidado(carpeta, "aprobacion.json", EsquemaAprobacionCruda);
    if (resultado.ok) {
      const { de, fecha, cuerpo } = resultado.data;
      aprobacion = { de, fecha, aprobado: esAprobado(cuerpo), texto: cuerpo };
    } else {
      faltantes.push(resultado.error.replace(/\.$/, ""));
    }
  }

  // 6. Factura: es opcional (solo existe en el caso retroactivo), así que su
  //    ausencia NO es un faltante. Pero si existe y no se puede leer SÍ se avisa:
  //    una factura ilegible podría esconder una compra retroactiva (RC8).
  let factura: Factura | null = null;
  const textoFactura = leerTextoOpcional(join(carpeta, "factura.txt"));
  if (textoFactura !== null) {
    const resultado = extraerFactura(textoFactura);
    if (resultado.ok) factura = resultado.data;
    else faltantes.push(`factura.txt: ${resultado.error}`);
  }

  // 7. Última verificación: el paquete armado debe cumplir su propio esquema
  const paquete = EsquemaPaquete.safeParse({
    correo: correo.data,
    solicitud: solicitud.data,
    cotizacion,
    aprobacion,
    factura,
    faltantes,
  });
  if (!paquete.success) {
    return { ok: false, error: `No se pudo armar el paquete (${describirErrorZod(paquete.error)}).` };
  }
  return { ok: true, data: paquete.data };
}
