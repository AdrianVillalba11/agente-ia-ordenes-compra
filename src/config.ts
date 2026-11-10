// =====================================================================
// config.ts — Configuración a partir de variables de entorno.
//
// Es el ÚNICO lugar donde se lee la clave del modelo. Bun carga el
// archivo .env automáticamente (el .env está en .gitignore: la clave
// nunca va al repositorio).
//
// CASOS DELICADOS que este archivo cuida:
//   - La clave nunca se imprime, ni se devuelve en la descripción pública
//     (que es lo que puede mostrar /api/health).
//   - Un valor numérico inválido (vacío, texto, negativo) no rompe nada:
//     se usa el valor por defecto.
// =====================================================================

// ---------------------------------------------------------------------
// BLOQUE 1 — Forma de la configuración y valores por defecto
// ---------------------------------------------------------------------

export type Configuracion = {
  proveedor: string; // hoy solo está implementado "gemini"
  modelo: string;
  claveApi: string | null; // null si no se configuró; NUNCA se imprime
  maxIteracionesPorTurno: number; // tope de pasos modelo -> herramientas en un turno (CA1)
  maxTokensPorSesion: number; // tope de gasto de una sesión
  maxTokensSalida: number; // tope de lo que el modelo puede escribir en una respuesta
  tiempoLimiteLlmMs: number; // cuánto se espera al modelo antes de rendirse
  puerto: number;
};

// Modelo estable y económico que la documentación de Google recomienda para agentes con herramientas
export const MODELO_POR_DEFECTO = "gemini-3.5-flash-lite";

// ---------------------------------------------------------------------
// BLOQUE 2 — Lectura
// ---------------------------------------------------------------------

// Un número entero >= mínimo, o el valor por defecto si no viene o es inválido
function entero(valor: string | undefined, porDefecto: number, minimo = 1): number {
  if (valor === undefined || valor.trim() === "") return porDefecto;
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= minimo ? numero : porDefecto;
}

// Un texto sin espacios sobrantes, o el valor por defecto si viene vacío
function texto(valor: string | undefined, porDefecto: string): string {
  const limpio = valor?.trim();
  return limpio === undefined || limpio === "" ? porDefecto : limpio;
}

// Lee la configuración. "entorno" se puede indicar en las pruebas; por defecto son las variables reales.
export function leerConfiguracion(entorno: Record<string, string | undefined> = process.env): Configuracion {
  // Se acepta LLM_API_KEY y, como alternativa, GEMINI_API_KEY (el nombre que usa Google)
  const clave = texto(entorno.LLM_API_KEY, "") || texto(entorno.GEMINI_API_KEY, "");

  return {
    proveedor: texto(entorno.LLM_PROVIDER, "gemini").toLowerCase(),
    modelo: texto(entorno.LLM_MODEL, MODELO_POR_DEFECTO),
    claveApi: clave === "" ? null : clave,
    maxIteracionesPorTurno: entero(entorno.MAX_ITERACIONES_POR_TURNO, 25),
    maxTokensPorSesion: entero(entorno.MAX_TOKENS_POR_SESION, 300000),
    maxTokensSalida: entero(entorno.MAX_TOKENS_SALIDA, 2048),
    tiempoLimiteLlmMs: entero(entorno.TIEMPO_LIMITE_LLM_MS, 60000),
    puerto: entero(entorno.PORT, 3000),
  };
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Lo que se puede mostrar en público
// ---------------------------------------------------------------------

// Descripción sin la clave (solo si hay una configurada). Es lo que puede devolver /api/health.
export function descripcionPublica(config: Configuracion): {
  proveedor: string;
  modelo: string;
  claveConfigurada: boolean;
  maxIteracionesPorTurno: number;
  maxTokensPorSesion: number;
} {
  return {
    proveedor: config.proveedor,
    modelo: config.modelo,
    claveConfigurada: config.claveApi !== null,
    maxIteracionesPorTurno: config.maxIteracionesPorTurno,
    maxTokensPorSesion: config.maxTokensPorSesion,
  };
}
