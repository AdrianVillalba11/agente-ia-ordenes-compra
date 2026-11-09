// =====================================================================
// controles.ts — Las reglas de control RC1 a RC10 del PRD.
//
// validarPaquete es una función PURA: recibe el paquete y los maestros
// ya cargados y devuelve el resultado, sin leer archivos. Por eso se
// prueba con datos armados en memoria.
//
// Hay una función pequeña por regla. Se evalúan TODAS (no se detiene la
// primera falla) para que la analista vea todos los problemas de una vez.
// Los resultados salen siempre en el orden RC1, RC2, ... (determinista).
//
//   Bloqueo       -> impide crear la OC.
//   Confirmación  -> la OC se puede crear solo si un humano la acepta.
//   Derivado      -> valor que el agente completó desde un maestro.
//
// CASOS DELICADOS que este archivo cuida:
//   - sol-003: quien aprueba tiene tope alto, pero en OTRO centro de costo.
//     El bloqueo es por RC2 (no es aprobador de ese centro), no por RC3.
//   - sol-006: sin NIT se busca el proveedor por nombre normalizado
//     (coincidencia exacta, sin aproximaciones).
//   - El 2 % de RC5 se compara con enteros, sin divisiones ni redondeos.
//   - Correos y fechas se comparan normalizados (sin tildes, solo el día).
//   - Un dato que no se puede leer nunca se asume bueno: se pide confirmación.
// =====================================================================

import type { CentroCosto, Derivados, Hallazgo, Paquete, Proveedor, ResultadoValidacion } from "../esquemas.ts";
import type { Maestros } from "./maestros.ts";
import { esFechaAnterior, normalizarNit, normalizarNombre, normalizarTexto, soloDia } from "./normalizar.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Acumulador de hallazgos y formato de textos
// ---------------------------------------------------------------------

// Cada regla agrega aquí lo que encuentra
type Acumulador = { bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Derivados };

// Un aprobador de un centro de costo, con su tope
type Aprobador = CentroCosto["aprobadores"][number];

function bloquear(acc: Acumulador, codigo: string, detalle: string, accion_sugerida: string): void {
  acc.bloqueos.push({ codigo, detalle, accion_sugerida });
}

function confirmar(acc: Acumulador, codigo: string, detalle: string, accion_sugerida: string): void {
  acc.confirmaciones.push({ codigo, detalle, accion_sugerida });
}

// Entero con puntos de miles: 74000000 -> "74.000.000" (sin depender del idioma del sistema)
function formatearMonto(valor: number): string {
  return Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// "COP 74.000.000"
function monto(valor: number, moneda: string): string {
  return `${moneda} ${formatearMonto(valor)}`;
}

// Un texto opcional "falta" si no viene o está vacío
function falta(valor: string | undefined): boolean {
  return valor === undefined || valor.trim() === "";
}

// ---------------------------------------------------------------------
// BLOQUE 2 — RC1: el proveedor existe y está activo
// ---------------------------------------------------------------------

// Se busca por NIT; si la solicitud no trae NIT, por nombre normalizado.
// Devuelve el proveedor encontrado (aunque esté inactivo) para que RC6 y RC7
// puedan derivar valores de él.
function controlRC1(paquete: Paquete, maestros: Maestros, acc: Acumulador): Proveedor | undefined {
  const { proveedor_nit, proveedor_nombre } = paquete.solicitud;
  const nit = proveedor_nit === undefined ? "" : normalizarNit(proveedor_nit);

  let encontrado: Proveedor | undefined;
  let criterio: string;
  if (nit !== "") {
    encontrado = maestros.proveedores.find((p) => normalizarNit(p.nit) === nit);
    criterio = `NIT ${nit}`;
  } else {
    const nombre = normalizarNombre(proveedor_nombre);
    encontrado = maestros.proveedores.find((p) => normalizarNombre(p.nombre) === nombre);
    criterio = `nombre "${proveedor_nombre}" (la solicitud no trae NIT)`;
  }

  if (encontrado === undefined) {
    bloquear(
      acc,
      "RC1",
      `El proveedor no existe en el maestro (buscado por ${criterio}).`,
      "Solicitar el alta del proveedor en el maestro de SAP antes de crear la OC.",
    );
    return undefined;
  }

  acc.derivados.proveedor = { codigo_sap: encontrado.codigo_sap, nit: encontrado.nit, nombre: encontrado.nombre };

  if (!encontrado.activo) {
    bloquear(
      acc,
      "RC1",
      `El proveedor ${encontrado.nombre} (código SAP ${encontrado.codigo_sap}) está inactivo.`,
      "Reactivar el proveedor en el maestro o elegir otro proveedor activo.",
    );
  }
  return encontrado;
}

// ---------------------------------------------------------------------
// BLOQUE 3 — RC2: aprobación válida de un aprobador del centro
// ---------------------------------------------------------------------

// Devuelve el aprobador encontrado en el centro (para que RC3 use su tope).
function controlRC2(paquete: Paquete, centro: CentroCosto | undefined, acc: Acumulador): Aprobador | undefined {
  const { aprobacion, solicitud } = paquete;

  // Sin correo de aprobación no hay nada más que verificar
  if (aprobacion === null) {
    const motivo = paquete.faltantes.find((f) => f.startsWith("aprobacion.json"));
    bloquear(
      acc,
      "RC2",
      `No hay un correo de aprobación utilizable${motivo === undefined ? "" : ` (${motivo})`}.`,
      'Solicitar al líder el correo de aprobación; debe decir "Aprobado".',
    );
    return undefined;
  }

  // El correo debe aprobar de forma explícita
  if (!aprobacion.aprobado) {
    bloquear(
      acc,
      "RC2",
      `El correo de ${aprobacion.de} no contiene una aprobación explícita.`,
      'Pedir al líder que responda con "Aprobado".',
    );
  }

  // Quien aprueba debe figurar como aprobador de ESTE centro de costo
  const correo = normalizarTexto(aprobacion.de);
  const aprobador = centro?.aprobadores.find((a) => normalizarTexto(a.email) === correo);
  if (aprobador !== undefined) return aprobador;

  if (centro === undefined) {
    bloquear(
      acc,
      "RC2",
      `El centro de costo ${solicitud.centro_costo} no existe en el maestro; no se puede verificar que ${aprobacion.de} pueda aprobar.`,
      "Corregir el centro de costo de la solicitud.",
    );
    return undefined;
  }

  const autorizados = centro.aprobadores.map((a) => `${a.email} (tope ${formatearMonto(a.tope)})`).join(", ");
  const topeMaximo = Math.max(...centro.aprobadores.map((a) => a.tope));
  const excede = solicitud.valor_total > topeMaximo;
  bloquear(
    acc,
    "RC2",
    `${aprobacion.de} no figura como aprobador del centro ${centro.centro_costo}. Aprobadores autorizados: ${autorizados}.` +
      (excede
        ? ` Además el valor (${monto(solicitud.valor_total, solicitud.moneda)}) supera el tope máximo del centro (${formatearMonto(topeMaximo)}).`
        : ""),
    excede
      ? "Escalar la aprobación fuera del centro: ningún aprobador del centro alcanza este valor."
      : "Pedir la aprobación a uno de los aprobadores autorizados del centro, con tope suficiente.",
  );
  return undefined;
}

// ---------------------------------------------------------------------
// BLOQUE 4 — RC3: el valor no supera el tope del aprobador
// ---------------------------------------------------------------------

// Solo se evalúa si se encontró al aprobador en el centro (si no, ya bloqueó RC2).
// Un valor exactamente igual al tope SÍ se permite (≤).
function controlRC3(paquete: Paquete, centro: CentroCosto | undefined, aprobador: Aprobador | undefined, acc: Acumulador): void {
  if (aprobador === undefined || centro === undefined) return;
  const { valor_total, moneda } = paquete.solicitud;
  if (valor_total <= aprobador.tope) return;

  const suficientes = centro.aprobadores.filter((a) => a.tope >= valor_total).map((a) => a.email);
  bloquear(
    acc,
    "RC3",
    `El valor (${monto(valor_total, moneda)}) supera el tope de ${aprobador.nombre} (${formatearMonto(aprobador.tope)}) en ${centro.centro_costo}.`,
    suficientes.length > 0
      ? `Pedir la aprobación a un aprobador con tope suficiente: ${suficientes.join(", ")}.`
      : "Ningún aprobador del centro alcanza este valor: escalar la aprobación fuera del centro.",
  );
}

// ---------------------------------------------------------------------
// BLOQUE 5 — RC4: la subárea pertenece al centro de costo
// ---------------------------------------------------------------------

function controlRC4(paquete: Paquete, centro: CentroCosto | undefined, acc: Acumulador): void {
  const { centro_costo, subarea } = paquete.solicitud;

  if (centro === undefined) {
    bloquear(
      acc,
      "RC4",
      `El centro de costo ${centro_costo} no existe en el maestro, por lo que la subárea "${subarea}" no se puede validar.`,
      "Corregir el centro de costo de la solicitud.",
    );
    return;
  }

  const pertenece = centro.subareas.some((s) => normalizarTexto(s) === normalizarTexto(subarea));
  if (!pertenece) {
    bloquear(
      acc,
      "RC4",
      `La subárea "${subarea}" no pertenece al centro ${centro.centro_costo}. Subáreas válidas: ${centro.subareas.join(", ")}.`,
      "Corregir la subárea o el centro de costo de la solicitud.",
    );
  }
}

// ---------------------------------------------------------------------
// BLOQUE 6 — RC5: la cotización coincide con la solicitud (±2 %)
// ---------------------------------------------------------------------

function controlRC5(paquete: Paquete, acc: Acumulador): void {
  const { cotizacion, solicitud } = paquete;

  // Sin cotización (o ilegible) no se puede comparar: lo decide un humano
  if (cotizacion === null) {
    const motivo = paquete.faltantes.find((f) => f.startsWith("cotizacion.txt"));
    confirmar(
      acc,
      "RC5",
      `No hay una cotización utilizable para comparar${motivo === undefined ? "" : ` (${motivo})`}.`,
      "Confirmar que se desea crear la OC sin cotización, o solicitarla al proveedor.",
    );
    return;
  }

  // 2 % de tolerancia con enteros: diferencia × 50 ≤ valor_total equivale a diferencia ≤ 2 %
  // (se evita dividir, así no hay errores de redondeo en el borde exacto del 2 %).
  const diferencia = Math.abs(cotizacion.total - solicitud.valor_total);
  if (diferencia * 50 <= solicitud.valor_total) return;

  const porcentaje =
    solicitud.valor_total > 0 ? ((diferencia / solicitud.valor_total) * 100).toFixed(1).replace(".", ",") : "n/d";
  confirmar(
    acc,
    "RC5",
    `La cotización (${monto(cotizacion.total, cotizacion.moneda)}) difiere de la solicitud (${monto(solicitud.valor_total, solicitud.moneda)}) en ${porcentaje} %, más del 2 % permitido.`,
    "Confirmar con cuál valor se crea la OC o pedir al proveedor una cotización corregida.",
  );
}

// ---------------------------------------------------------------------
// BLOQUE 7 — RC6 y RC7: valores derivados del proveedor
// ---------------------------------------------------------------------

// RC6: sin indicador de IVA se toma el del proveedor y se pide confirmar.
function controlRC6(paquete: Paquete, proveedor: Proveedor | undefined, acc: Acumulador): void {
  if (!falta(paquete.solicitud.indicador_iva) || proveedor === undefined) return;

  acc.derivados.indicador_iva = {
    valor: proveedor.indicador_iva_default,
    fuente: "maestro.proveedores.indicador_iva_default",
  };
  confirmar(
    acc,
    "RC6",
    `La solicitud no trae indicador de IVA; se propone ${proveedor.indicador_iva_default}, el predeterminado de ${proveedor.nombre}.`,
    "Confirmar el indicador de IVA propuesto.",
  );
}

// RC7: sin condiciones de pago se toman las del proveedor. Solo se informa (no pide confirmación).
function controlRC7(paquete: Paquete, proveedor: Proveedor | undefined, acc: Acumulador): void {
  if (!falta(paquete.solicitud.condiciones_pago) || proveedor === undefined) return;

  acc.derivados.condiciones_pago = {
    valor: proveedor.condiciones_pago_default,
    fuente: "maestro.proveedores.condiciones_pago_default",
  };
}

// ---------------------------------------------------------------------
// BLOQUE 8 — RC8: compra retroactiva (la factura es anterior a la solicitud)
// ---------------------------------------------------------------------

// Devuelve true si la OC es retroactiva. Es el dato que la dirección quiere medir.
function controlRC8(paquete: Paquete, acc: Acumulador): boolean {
  const { factura, solicitud } = paquete;

  // Una factura que existe pero no se pudo leer podría esconder una compra retroactiva
  const facturaIlegible = paquete.faltantes.find((f) => f.startsWith("factura.txt"));
  if (factura === null) {
    if (facturaIlegible !== undefined) {
      confirmar(
        acc,
        "RC8",
        `La factura adjunta no se pudo leer (${facturaIlegible}); no se puede descartar que la compra sea retroactiva.`,
        "Revisar la factura a mano y confirmar si la compra es retroactiva.",
      );
    }
    return false;
  }

  const esAnterior = esFechaAnterior(factura.fecha, solicitud.fecha_solicitud);
  if (esAnterior === null) {
    confirmar(
      acc,
      "RC8",
      `No se pudieron comparar las fechas de la factura (${factura.fecha}) y de la solicitud (${solicitud.fecha_solicitud}).`,
      "Revisar las fechas a mano y confirmar si la compra es retroactiva.",
    );
    return false;
  }
  if (!esAnterior) return false;

  confirmar(
    acc,
    "RC8",
    `La factura ${factura.numero} es del ${factura.fecha}, anterior a la solicitud (${solicitud.fecha_solicitud}): la compra es retroactiva.`,
    "Confirmar la excepción; la OC se crea marcada como retroactiva y queda registrada para el control.",
  );
  return true;
}

// ---------------------------------------------------------------------
// BLOQUE 9 — RC9: la aprobación no es anterior a la solicitud
// ---------------------------------------------------------------------

// Se compara solo el día, sin convertir zonas horarias.
function controlRC9(paquete: Paquete, acc: Acumulador): void {
  const { aprobacion, solicitud } = paquete;
  if (aprobacion === null) return; // ya bloqueó RC2

  const esAnterior = esFechaAnterior(aprobacion.fecha, solicitud.fecha_solicitud);
  if (esAnterior === null) {
    confirmar(
      acc,
      "RC9",
      `No se pudieron comparar las fechas de la aprobación (${aprobacion.fecha}) y de la solicitud (${solicitud.fecha_solicitud}).`,
      "Revisar las fechas a mano y confirmar.",
    );
  } else if (esAnterior) {
    confirmar(
      acc,
      "RC9",
      `La aprobación (${soloDia(aprobacion.fecha)}) es anterior a la solicitud (${solicitud.fecha_solicitud}).`,
      "Confirmar que la aprobación corresponde a esta solicitud.",
    );
  }
}

// ---------------------------------------------------------------------
// BLOQUE 10 — RC10: cantidad × valor unitario = valor total (±1)
// ---------------------------------------------------------------------

function controlRC10(paquete: Paquete, acc: Acumulador): void {
  const { cantidad, valor_unitario, valor_total, moneda } = paquete.solicitud;
  const calculado = cantidad * valor_unitario;
  if (Math.abs(calculado - valor_total) <= 1) return;

  bloquear(
    acc,
    "RC10",
    `La cantidad (${cantidad}) × el valor unitario (${formatearMonto(valor_unitario)}) da ${monto(calculado, moneda)}, pero el valor total de la solicitud es ${monto(valor_total, moneda)}.`,
    "Corregir la solicitud: el valor total debe ser cantidad × valor unitario.",
  );
}

// ---------------------------------------------------------------------
// BLOQUE 11 — Punto de entrada: aplica todas las reglas
// ---------------------------------------------------------------------

export function validarPaquete(paquete: Paquete, maestros: Maestros): ResultadoValidacion {
  const acc: Acumulador = { bloqueos: [], confirmaciones: [], derivados: {} };

  // El centro de costo se busca una sola vez; lo usan RC2, RC3 y RC4
  const centroSolicitado = normalizarTexto(paquete.solicitud.centro_costo);
  const centro = maestros.centrosCosto.find((c) => normalizarTexto(c.centro_costo) === centroSolicitado);

  const proveedor = controlRC1(paquete, maestros, acc);
  const aprobador = controlRC2(paquete, centro, acc);
  controlRC3(paquete, centro, aprobador, acc);
  controlRC4(paquete, centro, acc);
  controlRC5(paquete, acc);
  controlRC6(paquete, proveedor, acc);
  controlRC7(paquete, proveedor, acc);
  const retroactiva = controlRC8(paquete, acc);
  controlRC9(paquete, acc);
  controlRC10(paquete, acc);

  return {
    apta: acc.bloqueos.length === 0,
    bloqueos: acc.bloqueos,
    confirmaciones: acc.confirmaciones,
    derivados: acc.derivados,
    retroactiva,
  };
}
