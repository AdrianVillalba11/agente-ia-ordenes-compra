// =====================================================================
// modelo-guionado.ts — Un "modelo" de mentira para las pruebas.
//
// Sigue un guion: en cada llamada ejecuta el siguiente paso, sin red ni
// claves. Sirve para probar el ciclo del agente y el servidor en los
// escenarios más peligrosos (un modelo que intenta confirmar solo, que se
// cae a mitad de un turno, que no deja de pedir herramientas...).
//
// Solo lo usan las pruebas; el servidor real usa el adaptador de Gemini.
// =====================================================================

import type { AdaptadorLlm, DefinicionHerramienta, MensajeLlm, OpcionesLlm, RespuestaLlm } from "../llm/adapter.ts";

// Lo que el modelo recibió en una llamada
export type Peticion = { mensajes: MensajeLlm[]; herramientas: DefinicionHerramienta[]; opciones: OpcionesLlm };

// Un paso del guion: devuelve la respuesta del modelo, o un error si el modelo "falla"
export type Paso = (peticion: Peticion) => RespuestaLlm | Error | Promise<RespuestaLlm | Error>;

export class ModeloGuionado implements AdaptadorLlm {
  readonly proveedor = "falso";
  readonly modelo = "guionado";
  readonly peticiones: Peticion[] = [];
  private readonly pasos: Paso[];

  constructor(pasos: Paso[]) {
    this.pasos = [...pasos];
  }

  agregar(...pasos: Paso[]): void {
    this.pasos.push(...pasos);
  }

  async enviar(mensajes: MensajeLlm[], herramientas: DefinicionHerramienta[], opciones: OpcionesLlm): Promise<RespuestaLlm> {
    // Se guarda una copia de lo que el modelo recibió en ese momento (el historial sigue creciendo)
    const peticion: Peticion = { mensajes: structuredClone(mensajes), herramientas, opciones };
    this.peticiones.push(peticion);

    const paso = this.pasos.shift();
    if (paso === undefined) throw new Error("El guion del modelo falso se agotó");
    const resultado = await paso(peticion);
    if (resultado instanceof Error) throw resultado;
    return resultado;
  }
}

let contadorIds = 0;

export const usoDe = (tokens: number) => ({ entrada: tokens, salida: 0, total: tokens });

// El modelo responde con texto
export const decir =
  (texto: string, tokens = 100): Paso =>
  () => ({ bloques: [{ tipo: "texto", texto }], uso: usoDe(tokens) });

// El modelo pide una o varias herramientas a la vez
export const pedir =
  (...llamadas: [string, Record<string, unknown>][]): Paso =>
  () => ({
    bloques: llamadas.map(([nombre, argumentos]) => ({ tipo: "uso_herramienta" as const, id: `u${++contadorIds}`, nombre, argumentos })),
    uso: usoDe(100),
  });

// El modelo falla
export const fallar =
  (error: Error): Paso =>
  () =>
    error;

// El recorrido normal de un caso sin bloqueos: leer, validar, armar la OC y la evidencia, y pedir crearla
export const flujoCompleto = (caso: string): Paso[] => [
  pedir(["oc_leer_paquete", { caso }]),
  pedir(["oc_validar", { caso }]),
  pedir(["oc_construir_payload", { caso }], ["oc_generar_evidencia", { caso }]), // dos a la vez
  pedir(["oc_crear", { caso }]),
];
