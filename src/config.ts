// =====================================================================
// config.ts — Configuración a partir de variables de entorno.
//
// Es el ÚNICO lugar donde se leen la clave del modelo y la clave de acceso.
// Bun carga el archivo .env automáticamente (el .env está en .gitignore:
// las claves nunca van al repositorio).
//
// CASOS DELICADOS que este archivo cuida:
//   - Las claves nunca se imprimen, ni se devuelven en la descripción pública
//     (que es lo que puede mostrar /api/health).
//   - Un valor numérico inválido (vacío, texto, negativo) no rompe nada:
//     se usa el valor por defecto.
// =====================================================================

// ---------------------------------------------------------------------
// BLOQUE 1 — Forma de la configuración y valores por defecto
// ---------------------------------------------------------------------

export type Configuracion = {
  // --- El modelo ---
  proveedor: string; // hoy solo está implementado "gemini"
  modelo: string;
  claveApi: string | null; // null si no se configuró; NUNCA se imprime
  maxIteracionesPorTurno: number; // tope de pasos modelo -> herramientas en un turno (CA1)
  maxTokensPorSesion: number; // tope de gasto de una sesión
  maxTokensSalida: number; // tope de lo que el modelo puede escribir en una respuesta
  tiempoLimiteLlmMs: number; // cuánto se espera al modelo antes de rendirse

  // --- El servidor ---
  puerto: number;
  claveDeAcceso: string | null; // si existe, el chat la exige; NUNCA se imprime
  maxMensajesPorIp: number; // mensajes que puede enviar un visitante en la ventana
  ventanaIpSegundos: number; // duración de esa ventana
  maxTokensGlobalDiario: number; // tope de tokens de TODO el servidor por día
  maxSesiones: number; // sesiones activas a la vez
  ttlSesionMinutos: number; // una sesión sin uso caduca después de esto
  confiarEnProxy: boolean; // si hay un proxy confiable delante, la IP del visitante viene de x-forwarded-for
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

// "true", "1" o "si" activan una opción; cualquier otra cosa la deja apagada
function activado(valor: string | undefined): boolean {
  return ["true", "1", "si", "sí"].includes((valor ?? "").trim().toLowerCase());
}

// Lee la configuración. "entorno" se puede indicar en las pruebas; por defecto son las variables reales.
export function leerConfiguracion(entorno: Record<string, string | undefined> = process.env): Configuracion {
  // Se acepta LLM_API_KEY y, como alternativa, GEMINI_API_KEY (el nombre que usa Google)
  const clave = texto(entorno.LLM_API_KEY, "") || texto(entorno.GEMINI_API_KEY, "");
  const claveDeAcceso = texto(entorno.CLAVE_DE_ACCESO, "");

  return {
    proveedor: texto(entorno.LLM_PROVIDER, "gemini").toLowerCase(),
    modelo: texto(entorno.LLM_MODEL, MODELO_POR_DEFECTO),
    claveApi: clave === "" ? null : clave,
    maxIteracionesPorTurno: entero(entorno.MAX_ITERACIONES_POR_TURNO, 25),
    maxTokensPorSesion: entero(entorno.MAX_TOKENS_POR_SESION, 300000),
    maxTokensSalida: entero(entorno.MAX_TOKENS_SALIDA, 2048),
    tiempoLimiteLlmMs: entero(entorno.TIEMPO_LIMITE_LLM_MS, 60000),

    puerto: entero(entorno.PORT, 3000),
    claveDeAcceso: claveDeAcceso === "" ? null : claveDeAcceso,
    maxMensajesPorIp: entero(entorno.MAX_MENSAJES_POR_IP, 30),
    ventanaIpSegundos: entero(entorno.VENTANA_IP_SEGUNDOS, 600),
    maxTokensGlobalDiario: entero(entorno.MAX_TOKENS_GLOBAL_DIARIO, 1500000),
    maxSesiones: entero(entorno.MAX_SESIONES, 100),
    ttlSesionMinutos: entero(entorno.TTL_SESION_MINUTOS, 120),
    confiarEnProxy: activado(entorno.CONFIAR_EN_PROXY),
  };
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Lo que se puede mostrar en público
// ---------------------------------------------------------------------

// Descripción sin ninguna clave (solo dice si hay una configurada). Es lo que puede devolver /api/health.
export function descripcionPublica(config: Configuracion): {
  proveedor: string;
  modelo: string;
  claveConfigurada: boolean;
  requiereClaveDeAcceso: boolean;
  maxIteracionesPorTurno: number;
  maxTokensPorSesion: number;
} {
  return {
    proveedor: config.proveedor,
    modelo: config.modelo,
    claveConfigurada: config.claveApi !== null,
    requiereClaveDeAcceso: config.claveDeAcceso !== null,
    maxIteracionesPorTurno: config.maxIteracionesPorTurno,
    maxTokensPorSesion: config.maxTokensPorSesion,
  };
}
