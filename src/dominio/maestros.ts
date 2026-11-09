// =====================================================================
// maestros.ts — Carga de los 4 maestros corporativos (simulados).
//
// Los maestros son las "bases de datos" contra las que se valida cada
// caso: proveedores, centros de costo (con aprobadores y topes),
// indicadores de IVA y condiciones de pago.
//
// Cada archivo se valida con su esquema zod al cargarlo: si un maestro
// está corrupto el error se detecta aquí, con un mensaje claro, y no
// como un fallo extraño dentro de una regla de control.
// En producción esta carga se reemplazaría por consultas a SAP en tiempo real.
// =====================================================================

import { join } from "node:path";
import { z } from "zod";
import {
  EsquemaCentroCosto,
  EsquemaCondicionPago,
  EsquemaIndicadorIva,
  EsquemaProveedor,
  type CentroCosto,
  type CondicionPago,
  type IndicadorIva,
  type Proveedor,
  type Resultado,
} from "../esquemas.ts";
import { leerJsonValidado } from "./archivos.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Forma de los maestros cargados
// ---------------------------------------------------------------------

export type Maestros = {
  proveedores: Proveedor[];
  centrosCosto: CentroCosto[];
  indicadoresIva: IndicadorIva[];
  condicionesPago: CondicionPago[];
};

// Carpeta de los maestros, relativa a la raíz del proyecto
const RUTA_MAESTROS = "fixtures/reto-03/maestros";

// ---------------------------------------------------------------------
// BLOQUE 2 — Carga
// ---------------------------------------------------------------------

// Carga y valida los 4 maestros. Nunca lanza: si falta uno o está
// corrupto, devuelve un error que dice cuál.
export function cargarMaestros(raizProyecto: string): Resultado<Maestros> {
  const carpeta = join(raizProyecto, RUTA_MAESTROS);

  const proveedores = leerJsonValidado(carpeta, "proveedores.json", z.array(EsquemaProveedor));
  if (!proveedores.ok) return { ok: false, error: `Maestro no disponible: ${proveedores.error}` };

  const centrosCosto = leerJsonValidado(carpeta, "centros-costo.json", z.array(EsquemaCentroCosto));
  if (!centrosCosto.ok) return { ok: false, error: `Maestro no disponible: ${centrosCosto.error}` };

  const indicadoresIva = leerJsonValidado(carpeta, "indicadores-iva.json", z.array(EsquemaIndicadorIva));
  if (!indicadoresIva.ok) return { ok: false, error: `Maestro no disponible: ${indicadoresIva.error}` };

  const condicionesPago = leerJsonValidado(carpeta, "condiciones-pago.json", z.array(EsquemaCondicionPago));
  if (!condicionesPago.ok) return { ok: false, error: `Maestro no disponible: ${condicionesPago.error}` };

  return {
    ok: true,
    data: {
      proveedores: proveedores.data,
      centrosCosto: centrosCosto.data,
      indicadoresIva: indicadoresIva.data,
      condicionesPago: condicionesPago.data,
    },
  };
}
