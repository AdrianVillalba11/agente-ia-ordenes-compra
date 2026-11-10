// =====================================================================
// ciclo.ts — El ciclo del agente.
//
// Por cada mensaje del usuario se repite este vaivén:
//   modelo -> (pide herramientas) -> se ejecutan -> resultados al modelo -> ...
// hasta que el modelo responde con texto, o hasta el tope de pasos del turno.
//
// Las herramientas se ejecutan por el mismo "recepcionista" que usa la demo
// (registro.ts): valida argumentos, ejecuta, resume y anota en out/log.jsonl.
//
// REGLAS QUE ESTE ARCHIVO HACE CUMPLIR (en código, no en el prompt):
//   CA1  Tope de pasos por turno; al alcanzarlo se responde con lo que hay.
//   CA3  La confirmación humana la decide ESTE código: el modelo no ve el
//        argumento "confirmado". Se agrega solo si había un pendiente de un
//        turno anterior y el último mensaje del usuario es una confirmación
//        explícita (ver confirmacion.ts). Un modelo confundido, o engañado por
//        el texto de un correo, no puede crear una OC con dudas.
//   CA5  Un error del modelo o de una herramienta se muestra en español claro
//        y la sesión sigue viva.
//   Costo: tope de tokens por sesión, de longitud del mensaje y de salida.
//
// CASOS DELICADOS que este archivo cuida:
//   - El historial siempre queda bien formado (roles alternados, cada
//     llamada a herramienta seguida de sus resultados), incluso si el modelo
//     falla a mitad de un turno: los proveedores rechazan historiales rotos.
//   - Solo se aceptan los argumentos visibles del modelo ("caso"); todo lo
//     demás que envíe se descarta.
//   - Dos mensajes simultáneos de la misma sesión no se mezclan.
// =====================================================================

import type { Configuracion } from "../config.ts";
import type { ContextoHerramienta } from "../esquemas.ts";
import {
  ErrorLlm,
  type AdaptadorLlm,
  type BloqueResultadoHerramienta,
  type BloqueTexto,
  type BloqueUsoHerramienta,
  type DefinicionHerramienta,
  type MensajeLlm,
  type RespuestaLlm,
} from "../llm/adapter.ts";
import { definicionesParaModelo, ejecutarHerramienta, filtrarArgumentosDelModelo, resultadoParaModelo } from "../tools/registro.ts";
import { casosQueSeConfirman } from "./confirmacion.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Tipos
// ---------------------------------------------------------------------

// Una llamada a herramienta tal como se muestra en el chat
export type LlamadaVisible = {
  herramienta: string;
  argumentos: Record<string, unknown>;
  ok: boolean;
  resumen: string;
  requiereConfirmacion: boolean;
  confirmadoPorUsuario: boolean; // el ciclo agregó "confirmado" porque el usuario lo confirmó
};

// Un mensaje del historial visible (lo que devuelve GET /api/sessions/:id)
export type EntradaVisible = {
  rol: "usuario" | "asistente";
  texto: string;
  llamadas: LlamadaVisible[];
  necesitaConfirmacion?: boolean;
  esError?: boolean;
};

export type Sesion = {
  id: string;
  mensajes: MensajeLlm[]; // el historial que ve el modelo
  visibles: EntradaVisible[]; // el historial que ve la persona
  turno: number;
  tokensUsados: number;
  pendientes: Map<string, string[]>; // caso -> códigos de las confirmaciones que se mostraron y esperan respuesta
  ocupada: boolean; // hay un mensaje en proceso
  // La carpeta de trabajo propia de esta sesión (con sus fixtures y su SAP simulado). Si no tiene,
  // se usa la raíz del agente. Así dos visitantes no comparten órdenes ni confirmaciones.
  raiz?: string;
};

export function crearSesion(id: string, raiz?: string): Sesion {
  return {
    id,
    mensajes: [],
    visibles: [],
    turno: 0,
    tokensUsados: 0,
    pendientes: new Map(),
    ocupada: false,
    ...(raiz === undefined ? {} : { raiz }),
  };
}

// Lo que devuelve cada turno (el PRD pide reply, toolCalls y needsConfirmation)
export type RespuestaTurno = {
  reply: string;
  toolCalls: LlamadaVisible[];
  needsConfirmation: boolean;
  pendientes: string[];
  tokensTurno: number;
  tokensSesion: number;
  error: string | null;
};

export type DependenciasAgente = {
  llm: AdaptadorLlm;
  instrucciones: string; // prompt + conocimiento
  config: Pick<Configuracion, "maxIteracionesPorTurno" | "maxTokensPorSesion" | "maxTokensSalida" | "tiempoLimiteLlmMs">;
  raiz: string; // raíz del proyecto
  ahora?: () => Date;
  herramientas?: DefinicionHerramienta[]; // por defecto, las del registro
};

// ---------------------------------------------------------------------
// BLOQUE 2 — Mensajes fijos y límites
// ---------------------------------------------------------------------

const MAX_CARACTERES_MENSAJE = 4000;
const MENSAJE_VACIO = "Escribe un mensaje para continuar.";
const MENSAJE_LARGO = `Tu mensaje es demasiado largo (máximo ${MAX_CARACTERES_MENSAJE} caracteres). Resúmelo e inténtalo de nuevo.`;
const MENSAJE_OCUPADA = "Todavía estoy procesando tu mensaje anterior. Espera mi respuesta antes de enviar otro.";
const MENSAJE_LIMITE_SESION = "Esta sesión alcanzó su límite de uso. Abre una sesión nueva para continuar.";
const MENSAJE_SIN_RESPUESTA = "El modelo no devolvió ninguna respuesta de texto. Intenta reformular tu mensaje.";
const AVISO_CIERRE =
  "AVISO DEL SISTEMA: se alcanzó el máximo de pasos permitidos en este turno. Responde ahora, sin llamar herramientas, con lo que ya lograste y lo que falta por hacer.";

// ---------------------------------------------------------------------
// BLOQUE 3 — Ayudantes
// ---------------------------------------------------------------------

const esUso = (bloque: BloqueTexto | BloqueUsoHerramienta): bloque is BloqueUsoHerramienta => bloque.tipo === "uso_herramienta";

// El texto de una respuesta del modelo (puede venir en varias partes)
function textoDe(bloques: (BloqueTexto | BloqueUsoHerramienta)[]): string {
  return bloques
    .filter((bloque): bloque is BloqueTexto => bloque.tipo === "texto")
    .map((bloque) => bloque.texto)
    .join("\n")
    .trim();
}

function asistenteConTexto(texto: string): MensajeLlm {
  return { rol: "asistente", bloques: [{ tipo: "texto", texto }] };
}

// Los códigos de las confirmaciones que devolvió oc_crear
function codigosDeConfirmaciones(respuesta: string): string[] {
  try {
    const confirmaciones = (JSON.parse(respuesta) as { confirmaciones?: { codigo?: unknown }[] }).confirmaciones;
    return (confirmaciones ?? []).map((c) => (typeof c.codigo === "string" ? c.codigo : "?"));
  } catch {
    return [];
  }
}

// El mensaje de un error del modelo, ya en español
function mensajeDeError(error: unknown): string {
  if (error instanceof ErrorLlm) return error.message;
  const motivo = error instanceof Error ? error.message : String(error);
  return `Error inesperado al consultar el modelo: ${motivo}`;
}

// ---------------------------------------------------------------------
// BLOQUE 4 — El agente
// ---------------------------------------------------------------------

export class Agente {
  private readonly llm: AdaptadorLlm;
  private readonly instrucciones: string;
  private readonly config: DependenciasAgente["config"];
  private readonly raiz: string;
  private readonly ahora: (() => Date) | undefined;
  private readonly herramientas: DefinicionHerramienta[];

  constructor(dependencias: DependenciasAgente) {
    this.llm = dependencias.llm;
    this.instrucciones = dependencias.instrucciones;
    this.config = dependencias.config;
    this.raiz = dependencias.raiz;
    this.ahora = dependencias.ahora;
    this.herramientas = dependencias.herramientas ?? definicionesParaModelo();
  }

  // Procesa un mensaje del usuario y devuelve la respuesta del turno. Nunca lanza.
  async procesarMensaje(sesion: Sesion, mensaje: string): Promise<RespuestaTurno> {
    const texto = mensaje.trim();

    // Estos rechazos no tocan el historial ni gastan tokens
    if (sesion.ocupada) return this.rechazo(sesion, MENSAJE_OCUPADA);
    if (texto === "") return this.rechazo(sesion, MENSAJE_VACIO);
    if (texto.length > MAX_CARACTERES_MENSAJE) return this.rechazo(sesion, MENSAJE_LARGO);

    sesion.ocupada = true;
    try {
      return await this.ejecutarTurno(sesion, texto);
    } finally {
      sesion.ocupada = false;
    }
  }

  private rechazo(sesion: Sesion, mensaje: string): RespuestaTurno {
    return {
      reply: mensaje,
      toolCalls: [],
      needsConfirmation: sesion.pendientes.size > 0,
      pendientes: [...sesion.pendientes.keys()],
      tokensTurno: 0,
      tokensSesion: sesion.tokensUsados,
      error: mensaje,
    };
  }

  // ---------------------------------------------------------------------
  // Un turno completo
  // ---------------------------------------------------------------------

  private async ejecutarTurno(sesion: Sesion, texto: string): Promise<RespuestaTurno> {
    sesion.turno += 1;

    // CA3: qué casos confirma ESTE mensaje. Se decide antes de que el modelo haga nada,
    // y solo con lo que quedó pendiente en turnos anteriores: lo que el modelo muestre
    // durante este turno no puede confirmarse en este mismo turno.
    const confirmados = casosQueSeConfirman(texto, [...sesion.pendientes.keys()]);

    sesion.mensajes.push({ rol: "usuario", bloques: [{ tipo: "texto", texto }] });
    sesion.visibles.push({ rol: "usuario", texto, llamadas: [] });

    const llamadasTurno: LlamadaVisible[] = [];
    const tokensAntes = sesion.tokensUsados;
    let respuesta = "";
    let error: string | null = null;
    let iteraciones = 0;

    for (;;) {
      // Costo: tope de tokens de la sesión
      if (sesion.tokensUsados >= this.config.maxTokensPorSesion) {
        respuesta = MENSAJE_LIMITE_SESION;
        error = respuesta;
        sesion.mensajes.push(asistenteConTexto(respuesta));
        break;
      }

      // CA1: tope de pasos del turno; se responde con lo que hay y lo que falta
      if (iteraciones >= this.config.maxIteracionesPorTurno) {
        respuesta = await this.cierreForzado(sesion, llamadasTurno);
        break;
      }
      iteraciones++;

      // El modelo
      let salida: RespuestaLlm;
      try {
        salida = await this.llm.enviar(sesion.mensajes, this.herramientas, {
          sistema: this.instrucciones,
          maxTokensSalida: this.config.maxTokensSalida,
          tiempoLimiteMs: this.config.tiempoLimiteLlmMs,
        });
      } catch (fallo) {
        // CA5: mensaje claro, y se deja un aviso en el historial para que siga bien formado
        error = mensajeDeError(fallo);
        respuesta = error;
        sesion.mensajes.push(asistenteConTexto(`[Error técnico: ${error}]`));
        break;
      }
      sesion.tokensUsados += salida.uso.total;

      // Una respuesta vacía no se guarda tal cual: el proveedor rechaza mensajes sin contenido
      if (salida.bloques.length === 0) {
        respuesta = MENSAJE_SIN_RESPUESTA;
        sesion.mensajes.push(asistenteConTexto(respuesta));
        break;
      }
      sesion.mensajes.push({ rol: "asistente", bloques: salida.bloques, crudo: salida.crudo });

      // Sin herramientas: es la respuesta final
      const usos = salida.bloques.filter(esUso);
      if (usos.length === 0) {
        respuesta = textoDe(salida.bloques) || MENSAJE_SIN_RESPUESTA;
        if (salida.truncada === true) respuesta += "\n\n(La respuesta se cortó por su longitud; pídeme que continúe si falta algo.)";
        break;
      }

      // Con herramientas: se ejecutan EN ORDEN y sus resultados vuelven al modelo, todos juntos
      const resultados: BloqueResultadoHerramienta[] = [];
      for (const uso of usos) resultados.push(await this.ejecutarUso(uso, sesion, confirmados, llamadasTurno));
      sesion.mensajes.push({ rol: "usuario", bloques: resultados });
    }

    // Si quedan confirmaciones pendientes, la respuesta de este turno es una pregunta abierta
    const pendientes = [...sesion.pendientes.keys()];
    sesion.visibles.push({
      rol: "asistente",
      texto: respuesta,
      llamadas: llamadasTurno,
      necesitaConfirmacion: pendientes.length > 0,
      esError: error !== null,
    });

    return {
      reply: respuesta,
      toolCalls: llamadasTurno,
      needsConfirmation: pendientes.length > 0,
      pendientes,
      tokensTurno: sesion.tokensUsados - tokensAntes,
      tokensSesion: sesion.tokensUsados,
      error,
    };
  }

  // ---------------------------------------------------------------------
  // Una llamada a herramienta
  // ---------------------------------------------------------------------

  private async ejecutarUso(
    uso: BloqueUsoHerramienta,
    sesion: Sesion,
    confirmados: string[],
    llamadasTurno: LlamadaVisible[],
  ): Promise<BloqueResultadoHerramienta> {
    // Solo pasan los argumentos visibles: lo que el modelo envíe de más se descarta
    const delModelo = filtrarArgumentosDelModelo(uso.nombre, uso.argumentos);
    const caso = typeof delModelo.caso === "string" ? delModelo.caso : null;

    // CA3: "confirmado" lo agrega el ciclo, nunca el modelo
    let argumentos = delModelo;
    let confirmadoPorUsuario = false;
    if (uso.nombre === "oc_crear" && caso !== null && confirmados.includes(caso)) {
      argumentos = { ...delModelo, confirmado: true };
      confirmadoPorUsuario = true;
    }

    const contexto: ContextoHerramienta = {
      directory: sesion.raiz ?? this.raiz, // la carpeta propia de la sesión, si la tiene
      sessionId: sesion.id,
      ...(this.ahora === undefined ? {} : { ahora: this.ahora }),
    };
    const ejecucion = await ejecutarHerramienta(uso.nombre, argumentos, contexto);

    // Se lleva la cuenta de lo que quedó esperando confirmación
    if (uso.nombre === "oc_crear" && caso !== null) {
      if (ejecucion.requiereConfirmacion) {
        sesion.pendientes.set(caso, codigosDeConfirmaciones(ejecucion.respuesta));
      } else if (ejecucion.ok || ejecucion.resumen.startsWith("Bloqueada")) {
        sesion.pendientes.delete(caso); // ya se creó, ya existía, o quedó bloqueada: no hay nada que confirmar
      }
    }

    llamadasTurno.push({
      herramienta: uso.nombre,
      argumentos,
      ok: ejecucion.ok,
      resumen: ejecucion.resumen,
      requiereConfirmacion: ejecucion.requiereConfirmacion,
      confirmadoPorUsuario,
    });

    return {
      tipo: "resultado_herramienta",
      idUso: uso.id,
      ...(uso.idExterno === undefined ? {} : { idExterno: uso.idExterno }),
      nombre: uso.nombre,
      resultado: resultadoParaModelo(uso.nombre, ejecucion.respuesta),
    };
  }

  // ---------------------------------------------------------------------
  // Cierre cuando se agotan los pasos del turno
  // ---------------------------------------------------------------------

  // Una última llamada SIN herramientas, para que el modelo resuma lo que logró y lo que falta.
  // Si también falla, se responde con un texto fijo armado con lo ejecutado.
  private async cierreForzado(sesion: Sesion, llamadasTurno: LlamadaVisible[]): Promise<string> {
    let texto = "";
    try {
      const salida = await this.llm.enviar(sesion.mensajes, [], {
        sistema: `${this.instrucciones}\n\n${AVISO_CIERRE}`,
        maxTokensSalida: this.config.maxTokensSalida,
        tiempoLimiteMs: this.config.tiempoLimiteLlmMs,
      });
      sesion.tokensUsados += salida.uso.total;
      texto = textoDe(salida.bloques);
    } catch {
      // Se usa el texto fijo de abajo
    }

    if (texto === "") {
      const hecho = llamadasTurno
        .slice(-5)
        .map((llamada) => `${llamada.herramienta}: ${llamada.resumen}`)
        .join("; ");
      texto = `Llegué al máximo de ${this.config.maxIteracionesPorTurno} pasos en este turno. Lo último que hice: ${hecho || "nada todavía"}. Pídeme que continúe si falta algo.`;
    }
    sesion.mensajes.push(asistenteConTexto(texto));
    return texto;
  }
}
