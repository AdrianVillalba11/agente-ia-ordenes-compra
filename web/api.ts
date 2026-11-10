// =====================================================================
// api.ts — La comunicación del chat con el servidor.
//
// Los tipos de las respuestas se toman del propio servidor (solo tipos,
// que desaparecen al empaquetar): así chat y servidor no pueden quedar
// describiendo formatos distintos.
// =====================================================================

import type { EntradaVisible, RespuestaTurno } from "../src/agente/ciclo.ts";

export type Salud = {
  ok: boolean;
  proveedor: string;
  modelo: string;
  claveConfigurada: boolean;
  requiereClaveDeAcceso: boolean;
};

export type Historial = {
  id: string;
  turnos: number;
  tokensUsados: number;
  pendientes: string[];
  mensajes: EntradaVisible[];
};

// Un error de la API, con un mensaje listo para mostrar a la persona
export class ErrorApi extends Error {
  readonly estado: number; // 0 si ni siquiera se pudo conectar
  readonly requiereClave: boolean;
  readonly reintentarEnSegundos: number | null;

  constructor(mensaje: string, estado: number, requiereClave = false, reintentarEnSegundos: number | null = null) {
    super(mensaje);
    this.name = "ErrorApi";
    this.estado = estado;
    this.requiereClave = requiereClave;
    this.reintentarEnSegundos = reintentarEnSegundos;
  }
}

async function pedir<T>(ruta: string, opciones: { metodo?: string; cuerpo?: unknown; clave?: string | null } = {}): Promise<T> {
  let respuesta: Response;
  try {
    respuesta = await fetch(ruta, {
      method: opciones.metodo ?? "GET",
      headers: {
        ...(opciones.cuerpo === undefined ? {} : { "content-type": "application/json" }),
        ...(opciones.clave ? { "x-clave-acceso": opciones.clave } : {}),
      },
      ...(opciones.cuerpo === undefined ? {} : { body: JSON.stringify(opciones.cuerpo) }),
    });
  } catch {
    throw new ErrorApi("No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.", 0);
  }

  let datos: unknown = null;
  try {
    datos = await respuesta.json();
  } catch {
    // Algunas respuestas de error (por ejemplo un cuerpo demasiado grande) no son JSON
  }
  const objeto = typeof datos === "object" && datos !== null ? (datos as Record<string, unknown>) : {};

  if (!respuesta.ok) {
    throw new ErrorApi(
      typeof objeto.error === "string" ? objeto.error : `El servidor respondió con un error (${respuesta.status}).`,
      respuesta.status,
      objeto.requiereClaveDeAcceso === true,
      typeof objeto.reintentarEnSegundos === "number" ? objeto.reintentarEnSegundos : null,
    );
  }
  return datos as T;
}

export const obtenerSalud = (): Promise<Salud> => pedir<Salud>("/api/health");

export const obtenerHistorial = (sessionId: string, clave: string | null): Promise<Historial> =>
  pedir<Historial>(`/api/sessions/${encodeURIComponent(sessionId)}`, { clave });

export const enviarMensaje = (sessionId: string, message: string, clave: string | null): Promise<RespuestaTurno> =>
  pedir<RespuestaTurno>("/api/chat", { metodo: "POST", cuerpo: { sessionId, message }, clave });
