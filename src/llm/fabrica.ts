// =====================================================================
// fabrica.ts — Crea el adaptador del modelo según la configuración.
//
// Es el único lugar que sabe qué proveedores existen. Si algún día se
// agrega otro proveedor de modelos, se agrega aquí y el ciclo del
// agente no cambia.
// =====================================================================

import type { Configuracion } from "../config.ts";
import type { Resultado } from "../esquemas.ts";
import type { AdaptadorLlm } from "./adapter.ts";
import { AdaptadorGemini, type LlamadaRed } from "./gemini.ts";

// Devuelve el adaptador o un error claro si falta la clave o el proveedor no está implementado
export function crearAdaptadorLlm(config: Configuracion, llamarRed?: LlamadaRed): Resultado<AdaptadorLlm> {
  if (config.proveedor !== "gemini") {
    return {
      ok: false,
      error: `Proveedor de modelo no soportado: "${config.proveedor}". Solo está implementado: gemini.`,
    };
  }
  if (config.claveApi === null) {
    return { ok: false, error: "Falta la clave del modelo. Define LLM_API_KEY (o GEMINI_API_KEY) en el archivo .env." };
  }
  return { ok: true, data: new AdaptadorGemini(config.claveApi, config.modelo, llamarRed) };
}
