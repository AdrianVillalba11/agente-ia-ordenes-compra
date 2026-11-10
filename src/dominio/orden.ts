// =====================================================================
// orden.ts — Construcción de la orden de compra (OC) para SAP.
//
// construirOrden toma el paquete ya validado y arma el objeto OrdenCompra
// tal como quedaría en SAP. Además devuelve:
//   - la trazabilidad: de dónde sale cada valor (solicitud, maestro,
//     derivado...), para que auditoría pueda comprobarlo;
//   - advertencias: cosas que el agente decidió y debe informar
//     (descripción acortada, unidad inferida).
//
// Es una función PURA: no lee ni escribe archivos (eso lo hace la herramienta).
//
// CASOS DELICADOS que este archivo cuida:
//   - La descripción de SAP admite 40 caracteres: se corta en la última
//     palabra completa y el texto original queda en la trazabilidad.
//   - La unidad (UN, H, MES) no viene en los datos: se infiere con una regla
//     conservadora. "vigencia 12 meses" NO es MES (son 120 licencias).
//   - El precio de la solicitud INCLUYE IVA (ver nota junto al precio).
//   - El esquema zod de la OC es la red de seguridad final: una moneda que
//     no sea COP/USD o una cantidad en cero se rechazan aquí, no en silencio.
//   - Una confirmación pendiente nunca se da por aceptada: va en "excepciones"
//     con confirmado_por en null hasta que un humano la acepte.
// =====================================================================

import {
  EsquemaOrdenCompra,
  type OrdenCompra,
  type Paquete,
  type Resultado,
  type ResultadoValidacion,
} from "../esquemas.ts";
import { describirErrorZod } from "./archivos.ts";
import { normalizarTexto } from "./normalizar.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Tipos del resultado
// ---------------------------------------------------------------------

// Una línea de la trazabilidad: qué valor, de dónde sale y una nota opcional
export type EntradaTrazabilidad = {
  campo: string;
  valor: unknown;
  fuente: string; // solicitud, cotizacion, correo, aprobacion, evidencia, maestro.proveedores, derivado, constante, validacion
  nota?: string;
};

export type ResultadoOrden = {
  orden: OrdenCompra;
  trazabilidad: EntradaTrazabilidad[];
  advertencias: string[];
};

// Límite de caracteres del texto breve de una posición en SAP
export const LIMITE_DESCRIPCION = 40;

// ---------------------------------------------------------------------
// BLOQUE 2 — Descripción acortada
// ---------------------------------------------------------------------

// Acorta un texto a como máximo "maximo" caracteres, cortando en la última
// palabra completa para no dejar una palabra partida.
//   "Renovación licencias antivirus corporativo 120 puestos, ..."
//     -> "Renovación licencias antivirus"
// Si no hay un espacio razonable (en la segunda mitad), corta seco en el límite.
export function acortarDescripcion(texto: string, maximo: number = LIMITE_DESCRIPCION): string {
  const limpio = texto.trim().replace(/\s+/g, " ");
  if (limpio.length <= maximo) return limpio;

  const corte = limpio.slice(0, maximo);
  // Si justo después del límite hay un espacio, la última palabra cabe completa
  const ultimoEspacio = limpio[maximo] === " " ? maximo : corte.lastIndexOf(" ");
  const resultado = ultimoEspacio >= maximo / 2 ? corte.slice(0, ultimoEspacio) : corte;

  // Se quitan espacios y signos de puntuación que hayan quedado al final del corte
  return resultado.replace(/[\s,;:.\-]+$/, "");
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Unidad de medida inferida
// ---------------------------------------------------------------------

// La unidad no viene en la solicitud: se infiere de su descripción.
//   "horas"                          -> H
//   "por mes", "mensual"...          -> MES
//   cualquier otra cosa              -> UN  (ante la duda, la más conservadora)
// OJO: "vigencia 12 meses" NO activa MES; solo las expresiones de precio mensual.
export function inferirUnidad(descripcion: string): "UN" | "H" | "MES" {
  const texto = normalizarTexto(descripcion);
  if (/\bhoras?\b/.test(texto)) return "H";
  if (/\b(por mes|mensual(es)?|mensualidad(es)?)\b/.test(texto)) return "MES";
  return "UN";
}

// ---------------------------------------------------------------------
// BLOQUE 4 — Construcción de la orden
// ---------------------------------------------------------------------

// Devuelve un texto sin espacios o undefined si viene vacío
function textoOpcional(valor: string | undefined): string | undefined {
  const limpio = valor?.trim();
  return limpio === undefined || limpio === "" ? undefined : limpio;
}

export function construirOrden(
  paquete: Paquete,
  validacion: ResultadoValidacion,
  evidenciaSha256: string,
): Resultado<ResultadoOrden> {
  const { solicitud, correo, cotizacion, aprobacion } = paquete;

  // 1. Con bloqueos no hay OC que construir
  if (!validacion.apta) {
    const codigos = validacion.bloqueos.map((b) => b.codigo).join(", ");
    return { ok: false, error: `El caso tiene bloqueos (${codigos}); no se puede construir la OC hasta resolverlos.` };
  }

  // 2. Datos imprescindibles que la validación debió dejar disponibles
  const proveedor = validacion.derivados.proveedor;
  if (proveedor === undefined) return { ok: false, error: "No se resolvió el proveedor en la validación." };
  if (aprobacion === null) return { ok: false, error: "No hay correo de aprobación en el paquete." };

  // 3. Condiciones de pago e IVA: de la solicitud o, si faltan, derivados del proveedor
  const pagoSolicitud = textoOpcional(solicitud.condiciones_pago);
  const pagoDerivado = validacion.derivados.condiciones_pago;
  const condicionesPago = pagoSolicitud ?? pagoDerivado?.valor;
  const ivaSolicitud = textoOpcional(solicitud.indicador_iva);
  const ivaDerivado = validacion.derivados.indicador_iva;
  const indicadorIva = ivaSolicitud ?? ivaDerivado?.valor;
  if (condicionesPago === undefined || indicadorIva === undefined) {
    return { ok: false, error: "Faltan las condiciones de pago o el indicador de IVA y no se pudieron derivar del proveedor." };
  }

  // 4. Descripción acortada y unidad inferida (ambas se informan como advertencias)
  const advertencias: string[] = [];
  const descripcion = acortarDescripcion(solicitud.descripcion);
  const textoOriginal = solicitud.descripcion.trim().replace(/\s+/g, " ");
  const fueAcortada = descripcion !== textoOriginal;
  if (fueAcortada) {
    advertencias.push(
      `La descripción se acortó a ${LIMITE_DESCRIPCION} caracteres: "${descripcion}" (original: "${textoOriginal}").`,
    );
  }
  const unidad = inferirUnidad(solicitud.descripcion);
  advertencias.push(`Unidad de medida inferida: ${unidad} (a partir de la descripción; no viene en la solicitud).`);

  // 5. La orden. El esquema zod la valida al final.
  const candidata = {
    referencia: {
      solicitud_id: solicitud.solicitud_id,
      correo_id: correo.id,
      cotizacion_ref: cotizacion?.numero ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: solicitud.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: aprobacion.de.trim(),
      fecha_aprobacion: aprobacion.fecha,
      evidencia_sha256: evidenciaSha256,
    },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: solicitud.cantidad,
        unidad,
        // OJO (riesgo documentado): este precio INCLUYE IVA, tal como viene en la
        // solicitud y la cotización ("Precio unitario (IVA incl.)"), y la posición
        // lleva además un indicador de IVA. Un SAP real podría sumar el impuesto
        // otra vez. Aquí se usa el valor de la solicitud para mantener cada dato
        // trazable; en producción hay que enviar el precio neto o marcar el
        // indicador como "IVA incluido" (ver SOLUCION.md).
        precio_unitario: solicitud.valor_unitario,
        centro_costo: solicitud.centro_costo,
        subarea: solicitud.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    // Las confirmaciones quedan pendientes: ninguna se da por aceptada aquí
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  };

  const validada = EsquemaOrdenCompra.safeParse(candidata);
  if (!validada.success) {
    return { ok: false, error: `No se pudo armar la OC (${describirErrorZod(validada.error)}).` };
  }
  const orden = validada.data;

  // 6. Trazabilidad: de dónde sale cada valor
  const trazabilidad: EntradaTrazabilidad[] = [];
  const anotar = (campo: string, valor: unknown, fuente: string, nota?: string): void => {
    trazabilidad.push(nota === undefined ? { campo, valor, fuente } : { campo, valor, fuente, nota });
  };
  const posicion = orden.posiciones[0];
  if (posicion === undefined) return { ok: false, error: "La OC no tiene posiciones." };

  anotar("referencia.solicitud_id", orden.referencia.solicitud_id, "solicitud");
  anotar("referencia.correo_id", orden.referencia.correo_id, "correo");
  anotar("referencia.cotizacion_ref", orden.referencia.cotizacion_ref, "cotizacion");
  anotar("sociedad", orden.sociedad, "constante", "Valor fijo definido en el PRD");
  anotar("organizacion_compras", orden.organizacion_compras, "constante", "Valor fijo definido en el PRD");
  anotar("proveedor.codigo_sap", orden.proveedor.codigo_sap, "maestro.proveedores");
  anotar("proveedor.nit", orden.proveedor.nit, "maestro.proveedores");
  anotar("proveedor.nombre", orden.proveedor.nombre, "maestro.proveedores");
  anotar("moneda", orden.moneda, "solicitud");
  if (pagoSolicitud !== undefined) anotar("condiciones_pago", orden.condiciones_pago, "solicitud");
  else anotar("condiciones_pago", orden.condiciones_pago, "derivado", pagoDerivado?.fuente);
  anotar("aprobador.email", orden.aprobador.email, "aprobacion");
  anotar("aprobador.fecha_aprobacion", orden.aprobador.fecha_aprobacion, "aprobacion");
  anotar("aprobador.evidencia_sha256", orden.aprobador.evidencia_sha256, "evidencia", "Hash de aprobacion.txt");
  anotar("posiciones[0].numero", posicion.numero, "constante", "Primera posición de la OC");
  anotar(
    "posiciones[0].descripcion",
    posicion.descripcion,
    "solicitud",
    fueAcortada ? `Acortada a ${LIMITE_DESCRIPCION} caracteres. Original: "${textoOriginal}"` : undefined,
  );
  anotar("posiciones[0].cantidad", posicion.cantidad, "solicitud");
  anotar("posiciones[0].unidad", posicion.unidad, "derivado", "Inferida de la descripción de la solicitud");
  anotar("posiciones[0].precio_unitario", posicion.precio_unitario, "solicitud", "El precio incluye IVA (así viene en la solicitud y la cotización)");
  anotar("posiciones[0].centro_costo", posicion.centro_costo, "solicitud");
  anotar("posiciones[0].subarea", posicion.subarea, "solicitud");
  if (ivaSolicitud !== undefined) anotar("posiciones[0].indicador_iva", posicion.indicador_iva, "solicitud");
  else anotar("posiciones[0].indicador_iva", posicion.indicador_iva, "derivado", ivaDerivado?.fuente);
  anotar(
    "excepciones",
    orden.excepciones.map((e) => e.codigo),
    "validacion",
    "Confirmaciones pendientes de la validación (RC1 a RC10)",
  );

  return { ok: true, data: { orden, trazabilidad, advertencias } };
}
