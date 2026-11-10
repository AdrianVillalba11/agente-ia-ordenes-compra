// =====================================================================
// adapter.ts — Contrato del adaptador del modelo de lenguaje.
//
// El ciclo del agente solo conoce esta interfaz, con tipos propios y
// neutrales (no los de ningún proveedor). Cambiar de proveedor significa
// escribir otro archivo que cumpla este contrato, sin tocar el ciclo
// (requisito del PRD). Hoy lo implementa Gemini (gemini.ts).
// =====================================================================

// ---------------------------------------------------------------------
// BLOQUE 1 — Mensajes de la conversación
// ---------------------------------------------------------------------

export type BloqueTexto = { tipo: "texto"; texto: string };

// El modelo pide ejecutar una herramienta
export type BloqueUsoHerramienta = {
  tipo: "uso_herramienta";
  id: string; // identificador propio de esta llamada
  idExterno?: string; // el identificador que le puso el proveedor, si lo hay (se devuelve en el resultado)
  nombre: string;
  argumentos: Record<string, unknown>;
};

// El resultado de una herramienta, de vuelta al modelo
export type BloqueResultadoHerramienta = {
  tipo: "resultado_herramienta";
  idUso: string;
  idExterno?: string;
  nombre: string;
  resultado: unknown; // el JSON { ok, ... } que devolvió la herramienta
};

export type MensajeLlm =
  | { rol: "usuario"; bloques: (BloqueTexto | BloqueResultadoHerramienta)[] }
  // "crudo" es la respuesta original del proveedor; se reenvía sin tocar cuando el proveedor
  // lo exige (Gemini 3 pide devolver sus "firmas de pensamiento" tal como llegaron)
  | { rol: "asistente"; bloques: (BloqueTexto | BloqueUsoHerramienta)[]; crudo?: unknown };

// ---------------------------------------------------------------------
// BLOQUE 2 — Herramientas, opciones y respuesta
// ---------------------------------------------------------------------

// Lo que el modelo ve de una herramienta
export type DefinicionHerramienta = {
  nombre: string;
  descripcion: string;
  parametros: Record<string, unknown>; // esquema JSON de los argumentos
};

export type OpcionesLlm = {
  sistema: string; // las instrucciones del agente (prompt + conocimiento)
  maxTokensSalida: number;
  tiempoLimiteMs: number;
};

export type UsoTokens = { entrada: number; salida: number; total: number };

export type RespuestaLlm = {
  bloques: (BloqueTexto | BloqueUsoHerramienta)[];
  crudo?: unknown;
  uso: UsoTokens;
  truncada?: boolean; // el modelo se quedó sin espacio para terminar su respuesta
};

// ---------------------------------------------------------------------
// BLOQUE 3 — La interfaz y los errores
// ---------------------------------------------------------------------

export interface AdaptadorLlm {
  readonly proveedor: string;
  readonly modelo: string;
  enviar(mensajes: MensajeLlm[], herramientas: DefinicionHerramienta[], opciones: OpcionesLlm): Promise<RespuestaLlm>;
}

export type TipoErrorLlm = "clave" | "limite" | "servidor" | "tiempo" | "red" | "respuesta" | "bloqueo" | "otro";

// Un error del proveedor. Su mensaje ya está escrito en español claro para mostrarlo en el chat (CA5).
export class ErrorLlm extends Error {
  readonly tipo: TipoErrorLlm;

  constructor(mensaje: string, tipo: TipoErrorLlm) {
    super(mensaje);
    this.name = "ErrorLlm";
    this.tipo = tipo;
  }
}
