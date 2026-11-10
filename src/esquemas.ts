// =====================================================================
// esquemas.ts — El "idioma común" del proyecto.
//
// Cada tipo se define UNA sola vez como esquema zod. De ese esquema
// salen dos cosas: la validación en tiempo de ejecución (¿el dato real
// cumple la forma?) y el tipo de TypeScript (¿lo usamos bien al programar?).
// Los nombres de campos coinciden con los fixtures y con el PRD
// (solicitud_id, centro_costo, ...) para no tener que traducirlos.
// =====================================================================

import { z } from "zod";

// ---------------------------------------------------------------------
// BLOQUE 1 — Entradas del caso (lo que llega por correo)
// ---------------------------------------------------------------------

// Correo de entrada. Solo guardamos lo que usa el agente; zod descarta
// el resto de campos (para, adjuntos, nota_fixture).
export const EsquemaCorreo = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
});

// Solicitud de compra (el Excel normalizado a JSON).
// Los campos con .optional() PUEDEN faltar: sol-006 no trae NIT,
// indicador de IVA ni condiciones de pago, y el agente debe derivarlos.
export const EsquemaSolicitud = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.string(),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string(),
});

// Cotización del proveedor. Sus datos se extraen del texto (cotizacion.txt).
// "numero" no está en el PRD, pero lo añadimos porque el payload necesita
// la referencia de la cotización (cotizacion_ref).
export const EsquemaCotizacion = z.object({
  numero: z.string().nullable(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number(),
  moneda: z.string(),
  validez_hasta: z.string().nullable(),
  texto: z.string(),
});

// Aprobación del líder. "aprobado" es true si el cuerpo contiene "Aprobado".
export const EsquemaAprobacion = z.object({
  de: z.string(),
  fecha: z.string(),
  aprobado: z.boolean(),
  texto: z.string(),
});

// Factura (solo existe en el caso retroactivo, sol-005).
export const EsquemaFactura = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number(),
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Paquete normalizado (lo que devuelve oc_leer_paquete)
// ---------------------------------------------------------------------

// Todo el caso en un solo objeto. Si un adjunto no existe va como null
// y su nombre se anota en "faltantes" (así nunca se lanza una excepción).
export const EsquemaPaquete = z.object({
  correo: EsquemaCorreo,
  solicitud: EsquemaSolicitud,
  cotizacion: EsquemaCotizacion.nullable(),
  aprobacion: EsquemaAprobacion.nullable(),
  factura: EsquemaFactura.nullable(),
  faltantes: z.array(z.string()),
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Orden de compra (el payload que iría a SAP)
// ---------------------------------------------------------------------

// Una línea de la orden. Aquí viven los límites que impone SAP:
// descripción de máximo 40 caracteres y unidades de un catálogo fijo.
export const EsquemaPosicion = z.object({
  numero: z.number().int().positive(), // 10, 20, 30...
  descripcion: z.string().max(40),
  cantidad: z.number().positive(),
  unidad: z.enum(["UN", "H", "MES"]),
  precio_unitario: z.number().nonnegative(),
  centro_costo: z.string(),
  subarea: z.string(),
  indicador_iva: z.string(), // código, ej. "C1"
});

// Una excepción registrada en la OC (por ejemplo, una confirmación aceptada).
export const EsquemaExcepcion = z.object({
  codigo: z.string(),
  detalle: z.string(),
  confirmado_por: z.string().nullable(),
});

// La orden de compra completa. Sociedad y organización de compras son
// fijas ("1000") según el PRD, por eso usamos z.literal.
export const EsquemaOrdenCompra = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(), // código, ej. "Z030"
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z.array(EsquemaPosicion).min(1),
  excepciones: z.array(EsquemaExcepcion),
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Maestros (las "bases de datos" corporativas simuladas)
// ---------------------------------------------------------------------

export const EsquemaProveedor = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});

// Cada centro de costo lista quién puede aprobar y hasta qué monto (tope).
export const EsquemaCentroCosto = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(
    z.object({ email: z.string(), nombre: z.string(), tope: z.number() }),
  ),
});

export const EsquemaIndicadorIva = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number(),
});

export const EsquemaCondicionPago = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number(),
});

// ---------------------------------------------------------------------
// BLOQUE 4B — Resultado de la validación (lo que devuelve oc_validar)
// ---------------------------------------------------------------------

// Un hallazgo es un problema o duda detectado por una regla de control.
// Siempre trae el código de la regla, la razón con los valores y qué hacer.
export const EsquemaHallazgo = z.object({
  codigo: z.string(), // "RC1", "RC2", ...
  detalle: z.string(),
  accion_sugerida: z.string(),
});

// Un valor que el agente completó desde un maestro, con su fuente (trazabilidad).
export const EsquemaDerivado = z.object({
  valor: z.string(),
  fuente: z.string(),
});

// Lo que el agente completó por su cuenta. Se pasa a oc_construir_payload.
export const EsquemaDerivados = z.object({
  // Proveedor encontrado en el maestro (de ahí sale el código SAP)
  proveedor: z
    .object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() })
    .optional(),
  indicador_iva: EsquemaDerivado.optional(),
  condiciones_pago: EsquemaDerivado.optional(),
});

export const EsquemaResultadoValidacion = z.object({
  apta: z.boolean(), // true si no hay ningún bloqueo
  bloqueos: z.array(EsquemaHallazgo), // impiden crear la OC
  confirmaciones: z.array(EsquemaHallazgo), // permiten crear solo si un humano confirma
  derivados: EsquemaDerivados,
  retroactiva: z.boolean(), // RC8: la OC se pide después de recibir la factura
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Tipos de TypeScript derivados de los esquemas
// ---------------------------------------------------------------------

export type Correo = z.infer<typeof EsquemaCorreo>;
export type Solicitud = z.infer<typeof EsquemaSolicitud>;
export type Cotizacion = z.infer<typeof EsquemaCotizacion>;
export type Aprobacion = z.infer<typeof EsquemaAprobacion>;
export type Factura = z.infer<typeof EsquemaFactura>;
export type Paquete = z.infer<typeof EsquemaPaquete>;
export type Posicion = z.infer<typeof EsquemaPosicion>;
export type Excepcion = z.infer<typeof EsquemaExcepcion>;
export type OrdenCompra = z.infer<typeof EsquemaOrdenCompra>;
export type Proveedor = z.infer<typeof EsquemaProveedor>;
export type CentroCosto = z.infer<typeof EsquemaCentroCosto>;
export type IndicadorIva = z.infer<typeof EsquemaIndicadorIva>;
export type CondicionPago = z.infer<typeof EsquemaCondicionPago>;
export type Hallazgo = z.infer<typeof EsquemaHallazgo>;
export type Derivados = z.infer<typeof EsquemaDerivados>;
export type ResultadoValidacion = z.infer<typeof EsquemaResultadoValidacion>;

// ---------------------------------------------------------------------
// BLOQUE 6 — Contrato de respuesta de las herramientas
// ---------------------------------------------------------------------

// Toda herramienta responde { ok: true, data } o { ok: false, error }
// y NUNCA lanza una excepción hacia el agente (regla del PRD).
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string };

// Las herramientas devuelven un string JSON; estos dos ayudantes lo arman
// para que ninguna herramienta repita ese formato a mano.
export function respuestaOk<T>(data: T): string {
  const resultado: Resultado<T> = { ok: true, data };
  return JSON.stringify(resultado);
}

export function respuestaError(error: string): string {
  const resultado: Resultado<never> = { ok: false, error };
  return JSON.stringify(resultado);
}

// Un error especial: la acción necesita la confirmación de una persona. Además del
// mensaje lleva la marca "requiere_confirmacion" y la lista de lo que hay que
// confirmar, para que el chat pueda resaltarlo y mostrarlo.
export function respuestaRequiereConfirmacion(error: string, confirmaciones: Hallazgo[]): string {
  return JSON.stringify({ ok: false, error, requiere_confirmacion: true, confirmaciones });
}

// ---------------------------------------------------------------------
// BLOQUE 7 — Contexto que recibe cada herramienta
// ---------------------------------------------------------------------

// "directory" es la raíz del proyecto: las herramientas resuelven sus rutas
// desde ahí y nunca usan rutas absolutas (regla del PRD).
// "ahora" es el reloj; si no se indica se usa la hora real. Las pruebas y la
// demo lo fijan para que los resultados sean exactos y repetibles.
export type ContextoHerramienta = { directory: string; sessionId: string; ahora?: () => Date };
