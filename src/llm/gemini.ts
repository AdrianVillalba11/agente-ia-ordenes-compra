// =====================================================================
// gemini.ts — Adaptador del modelo para Gemini (API generateContent).
//
// Traduce entre los tipos neutrales de adapter.ts y el formato de la
// API REST de Gemini, y traduce sus errores a mensajes claros en español.
// No usa ninguna librería: es una llamada HTTP con fetch, y la red se
// puede reemplazar en las pruebas.
//
// Formato verificado en la documentación oficial de Google (nov. 2026):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent
//   cabecera x-goog-api-key; cuerpo con systemInstruction, contents, tools
//   (functionDeclarations con parametersJsonSchema) y generationConfig.
//
// CASOS DELICADOS que este archivo cuida:
//   - La clave viaja SOLO en la cabecera (nunca en la URL) y se oculta de
//     cualquier mensaje de error que se muestre.
//   - Gemini 3 exige devolver sus "firmas de pensamiento" tal como llegaron:
//     la respuesta original del modelo se guarda y se reenvía sin tocarla.
//   - Nunca se envía "temperature": los modelos recientes la ignoran.
//   - Un fallo temporal (límite por minuto, servidor ocupado) se reintenta
//     una vez; una demora excesiva o un fallo de red no se reintentan.
//   - Todo error sale como ErrorLlm con un mensaje en español: la sesión
//     del chat nunca muere por un error del proveedor.
// =====================================================================

import {
  ErrorLlm,
  type AdaptadorLlm,
  type BloqueResultadoHerramienta,
  type BloqueTexto,
  type BloqueUsoHerramienta,
  type DefinicionHerramienta,
  type MensajeLlm,
  type OpcionesLlm,
  type RespuestaLlm,
} from "./adapter.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Constantes
// ---------------------------------------------------------------------

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Códigos HTTP que suelen ser temporales: se reintenta una vez
const ESTADOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);

// Motivos de fin de respuesta que Gemini informa y que no son una respuesta normal
const BLOQUEADOS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);
const INVALIDOS = new Set([
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "MISSING_THOUGHT_SIGNATURE",
  "MALFORMED_RESPONSE",
]);

// La forma de hacer una llamada de red; se puede reemplazar en las pruebas
export type LlamadaRed = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------
// BLOQUE 2 — Ayudantes para leer JSON desconocido
// ---------------------------------------------------------------------

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
}

const numero = (valor: unknown): number => (typeof valor === "number" && Number.isFinite(valor) ? valor : 0);
const recortar = (valor: string, maximo = 200): string => (valor.length > maximo ? `${valor.slice(0, maximo)}...` : valor);

// ---------------------------------------------------------------------
// BLOQUE 3 — De los tipos neutrales al formato de Gemini
// ---------------------------------------------------------------------

// Gemini pide que la respuesta de una función sea un objeto
function comoObjeto(resultado: unknown): Record<string, unknown> {
  return objeto(resultado) ?? { resultado };
}

function parteDeUsuario(bloque: BloqueTexto | BloqueResultadoHerramienta): Record<string, unknown> {
  if (bloque.tipo === "texto") return { text: bloque.texto };
  return {
    functionResponse: {
      name: bloque.nombre,
      ...(bloque.idExterno === undefined ? {} : { id: bloque.idExterno }),
      response: comoObjeto(bloque.resultado),
    },
  };
}

function parteDeAsistente(bloque: BloqueTexto | BloqueUsoHerramienta): Record<string, unknown> {
  if (bloque.tipo === "texto") return { text: bloque.texto };
  return {
    functionCall: {
      name: bloque.nombre,
      ...(bloque.idExterno === undefined ? {} : { id: bloque.idExterno }),
      args: bloque.argumentos,
    },
  };
}

function aContenido(mensaje: MensajeLlm): Record<string, unknown> {
  if (mensaje.rol === "usuario") return { role: "user", parts: mensaje.bloques.map(parteDeUsuario) };

  // La respuesta original del modelo se reenvía tal cual: incluye las firmas de pensamiento
  const original = objeto(mensaje.crudo);
  if (original !== null && Array.isArray(original.parts)) return { role: "model", ...original };

  return { role: "model", parts: mensaje.bloques.map(parteDeAsistente) };
}

function construirCuerpo(
  mensajes: MensajeLlm[],
  herramientas: DefinicionHerramienta[],
  opciones: OpcionesLlm,
): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: opciones.sistema }] },
    contents: mensajes.map(aContenido),
    ...(herramientas.length === 0
      ? {}
      : {
          tools: [
            {
              functionDeclarations: herramientas.map((h) => ({
                name: h.nombre,
                description: h.descripcion,
                parametersJsonSchema: h.parametros,
              })),
            },
          ],
        }),
    generationConfig: { maxOutputTokens: opciones.maxTokensSalida },
  };
}

// ---------------------------------------------------------------------
// BLOQUE 4 — Errores HTTP en español
// ---------------------------------------------------------------------

// El mensaje técnico que envía Google, si lo hay: { "error": { "message": "..." } }
function mensajeDeGoogle(textoRespuesta: string): string | null {
  try {
    const mensaje = objeto(objeto(JSON.parse(textoRespuesta))?.error)?.message;
    return typeof mensaje === "string" ? mensaje : null;
  } catch {
    return null;
  }
}

function errorDeHttp(estado: number, textoRespuesta: string, modelo: string): ErrorLlm {
  const detalle = mensajeDeGoogle(textoRespuesta) ?? "";
  const claveInvalida = /api key|api_key/i.test(detalle) && estado === 400;

  if (estado === 401 || estado === 403 || claveInvalida) {
    return new ErrorLlm("La clave del modelo no es válida o no tiene permiso. Revisa la variable LLM_API_KEY.", "clave");
  }
  if (estado === 404) {
    return new ErrorLlm(`El modelo "${modelo}" no existe o no está disponible para esta clave. Revisa LLM_MODEL.`, "otro");
  }
  if (estado === 429) {
    return new ErrorLlm(
      "Se alcanzó el límite de uso del proveedor del modelo. Espera un momento e inténtalo de nuevo.",
      "limite",
    );
  }
  if (estado >= 500) {
    return new ErrorLlm("El servicio del modelo no está disponible en este momento. Inténtalo de nuevo en unos minutos.", "servidor");
  }
  return new ErrorLlm(`El proveedor del modelo rechazó la solicitud (${estado})${detalle === "" ? "" : `: ${recortar(detalle)}`}.`, "otro");
}

// ---------------------------------------------------------------------
// BLOQUE 5 — El adaptador
// ---------------------------------------------------------------------

export class AdaptadorGemini implements AdaptadorLlm {
  readonly proveedor = "gemini";
  readonly modelo: string;
  private readonly claveApi: string;
  private readonly llamarRed: LlamadaRed;
  private readonly esperar: (ms: number) => Promise<void>;
  private contadorLlamadas = 0;

  // "llamarRed" y "esperar" se pueden reemplazar en las pruebas
  constructor(
    claveApi: string,
    modelo: string,
    llamarRed: LlamadaRed = (url, init) => fetch(url, init),
    esperar: (ms: number) => Promise<void> = (ms) => new Promise((resolver) => setTimeout(resolver, ms)),
  ) {
    this.claveApi = claveApi;
    this.modelo = modelo;
    this.llamarRed = llamarRed;
    this.esperar = esperar;
  }

  // Quita la clave de cualquier texto que se vaya a mostrar
  private ocultarClave(texto: string): string {
    return this.claveApi === "" ? texto : texto.split(this.claveApi).join("***");
  }

  // Una llamada HTTP, con límite de tiempo. Devuelve el estado y el cuerpo.
  private async llamarUnaVez(cuerpo: Record<string, unknown>, tiempoLimiteMs: number): Promise<{ estado: number; texto: string }> {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), tiempoLimiteMs);
    try {
      const respuesta = await this.llamarRed(`${URL_BASE}/${this.modelo}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.claveApi },
        body: JSON.stringify(cuerpo),
        signal: controlador.signal,
      });
      return { estado: respuesta.status, texto: await respuesta.text() };
    } catch {
      if (controlador.signal.aborted) {
        throw new ErrorLlm("El modelo tardó demasiado en responder. Inténtalo de nuevo.", "tiempo");
      }
      throw new ErrorLlm("No se pudo conectar con el servicio del modelo. Revisa la conexión a internet e inténtalo de nuevo.", "red");
    } finally {
      clearTimeout(temporizador);
    }
  }

  async enviar(mensajes: MensajeLlm[], herramientas: DefinicionHerramienta[], opciones: OpcionesLlm): Promise<RespuestaLlm> {
    const cuerpo = construirCuerpo(mensajes, herramientas, opciones);

    // Un reintento si el fallo parece temporal
    let resultado = await this.llamarUnaVez(cuerpo, opciones.tiempoLimiteMs);
    if (ESTADOS_REINTENTABLES.has(resultado.estado)) {
      await this.esperar(1000);
      resultado = await this.llamarUnaVez(cuerpo, opciones.tiempoLimiteMs);
    }

    if (resultado.estado < 200 || resultado.estado >= 300) {
      const error = errorDeHttp(resultado.estado, this.ocultarClave(resultado.texto), this.modelo);
      throw new ErrorLlm(this.ocultarClave(error.message), error.tipo);
    }

    let datos: unknown;
    try {
      datos = JSON.parse(resultado.texto);
    } catch {
      throw new ErrorLlm("El modelo devolvió una respuesta que no se pudo leer. Inténtalo de nuevo.", "respuesta");
    }
    return this.interpretarRespuesta(datos);
  }

  // ---------------------------------------------------------------------
  // De la respuesta de Gemini a los tipos neutrales
  // ---------------------------------------------------------------------

  private interpretarRespuesta(datos: unknown): RespuestaLlm {
    const raiz = objeto(datos);
    const candidatos = raiz?.candidates;
    const candidato = Array.isArray(candidatos) ? objeto(candidatos[0]) : null;

    // Sin candidato: casi siempre es que el filtro de seguridad bloqueó la petición
    if (candidato === null) {
      const bloqueo = objeto(raiz?.promptFeedback)?.blockReason;
      if (typeof bloqueo === "string") {
        throw new ErrorLlm("El modelo no pudo responder por sus filtros de seguridad. Reformula la solicitud.", "bloqueo");
      }
      throw new ErrorLlm("El modelo no devolvió ninguna respuesta. Inténtalo de nuevo.", "respuesta");
    }

    const motivo = typeof candidato.finishReason === "string" ? candidato.finishReason : "STOP";
    if (BLOQUEADOS.has(motivo)) {
      throw new ErrorLlm("El modelo no pudo responder por sus filtros de seguridad. Reformula la solicitud.", "bloqueo");
    }
    if (INVALIDOS.has(motivo)) {
      throw new ErrorLlm(`El modelo generó una respuesta inválida (${motivo}). Inténtalo de nuevo.`, "respuesta");
    }

    // Partes de la respuesta: texto visible y llamadas a herramientas (se omiten los resúmenes de "pensamiento")
    const contenido = objeto(candidato.content);
    const partes = Array.isArray(contenido?.parts) ? contenido.parts : [];
    const bloques: (BloqueTexto | BloqueUsoHerramienta)[] = [];
    for (const parte of partes) {
      const p = objeto(parte);
      if (p === null) continue;

      const llamada = objeto(p.functionCall);
      if (llamada !== null && typeof llamada.name === "string") {
        this.contadorLlamadas++;
        const idExterno = typeof llamada.id === "string" ? llamada.id : undefined;
        bloques.push({
          tipo: "uso_herramienta",
          id: `llamada-${this.contadorLlamadas}`,
          ...(idExterno === undefined ? {} : { idExterno }),
          nombre: llamada.name,
          argumentos: objeto(llamada.args) ?? {},
        });
      } else if (typeof p.text === "string" && p.thought !== true) {
        bloques.push({ tipo: "texto", texto: p.text });
      }
    }

    // Uso de tokens (los de "pensamiento" también cuestan)
    const meta = objeto(raiz?.usageMetadata);
    const entrada = numero(meta?.promptTokenCount) + numero(meta?.toolUsePromptTokenCount);
    const salida = numero(meta?.candidatesTokenCount) + numero(meta?.thoughtsTokenCount);
    const total = typeof meta?.totalTokenCount === "number" ? meta.totalTokenCount : entrada + salida;

    return {
      bloques,
      crudo: contenido ?? undefined,
      uso: { entrada, salida, total },
      ...(motivo === "MAX_TOKENS" ? { truncada: true } : {}),
    };
  }
}
