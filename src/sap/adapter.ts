// =====================================================================
// adapter.ts — Contrato del adaptador de SAP.
//
// El agente nunca habla con SAP directamente: lo hace a través de esta
// interfaz. Hoy la implementa un SAP simulado sobre archivos (mock.ts);
// en producción la implementaría un adaptador real (OData, BAPI o carga
// por archivo; el diseño va en SOLUCION.md) sin tocar el resto del código.
// =====================================================================

import type { OrdenCompra } from "../esquemas.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Tipos de las respuestas
// ---------------------------------------------------------------------

// Lo que SAP sabe de un proveedor
export type ProveedorSap = { codigo_sap: string; activo: boolean };

// Una orden ya creada. "ya_existia" lo marca el adaptador cuando la solicitud
// ya tenía orden y devolvió la existente en lugar de crear otra.
export type OrdenCreada = { numero_oc: string; fecha: string; ya_existia?: boolean };

// ---------------------------------------------------------------------
// BLOQUE 2 — Contrato (interfaz del PRD, sección 7.4)
// ---------------------------------------------------------------------

// Nota: buscarOrdenPorReferencia devuelve también la fecha (el PRD solo pide el
// número) para poder responder la fecha original cuando la OC ya existía.
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<ProveedorSap | null>;
  crearOrden(orden: OrdenCompra): Promise<OrdenCreada>;
  buscarOrdenPorReferencia(solicitud_id: string): Promise<OrdenCreada | null>;
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Error propio del adaptador
// ---------------------------------------------------------------------

// Un error esperado de SAP (por ejemplo, un archivo dañado). La herramienta
// lo muestra tal cual, sin llamarlo "inesperado".
export class ErrorSap extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorSap";
  }
}
