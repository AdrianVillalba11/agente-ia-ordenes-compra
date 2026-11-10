// =====================================================================
// server.ts — El servidor HTTP: la API del chat y la página web.
//
// Rutas (las del PRD, sección 6.4):
//   POST /api/chat           { sessionId, message } -> { reply, toolCalls, needsConfirmation, ... }
//   GET  /api/sessions/:id   historial completo de la sesión
//   GET  /api/health         { ok, provider, model, ... } sin ninguna clave
//   GET  /                   el chat (React, empaquetado por Bun)
//
// Es una capa FINA: toda la lógica vive en el ciclo del agente y en las
// herramientas. Aquí solo se valida lo que llega, se protege la clave del
// modelo y se responde.
//
// PROTECCIONES (la URL será pública y la clave del modelo es tuya):
//   1. Clave de acceso opcional (CLAVE_DE_ACCESO): sin ella no se usa el modelo.
//      Los intentos fallidos se limitan, y quien agota sus intentos queda
//      bloqueado aunque después acierte (no se puede adivinar por fuerza bruta).
//   2. Límite de mensajes por visitante (por IP).
//   3. Tope global de tokens por día, para todo el servidor.
//   4. Cada sesión trabaja en su propia carpeta (sin tocar la de los demás).
//   5. Se valida todo lo que llega, el cuerpo tiene un tamaño máximo, y NINGUNA
//      respuesta puede contener las claves (se tachan antes de enviarse).
// =====================================================================

import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import paginaWeb from "../web/index.html";
import { Agente } from "./agente/ciclo.ts";
import { cargarInstrucciones } from "./agente/instrucciones.ts";
import { AlmacenSesiones, PATRON_ID_SESION } from "./agente/sesiones.ts";
import { descripcionPublica, leerConfiguracion, type Configuracion } from "./config.ts";
import { describirErrorZod } from "./dominio/archivos.ts";
import { ErrorLlm, type AdaptadorLlm } from "./llm/adapter.ts";
import { crearAdaptadorLlm } from "./llm/fabrica.ts";
import { LimitadorPorVentana, PresupuestoDiario } from "./servidor/limites.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Tipos y piezas pequeñas
// ---------------------------------------------------------------------

export type OpcionesServidor = {
  config: Configuracion;
  llm: AdaptadorLlm | null; // null si falta la clave del modelo: el chat responde con ese aviso
  motivoSinLlm?: string;
  instrucciones: string;
  raizProyecto: string;
  puerto?: number; // por defecto el de la configuración; 0 = uno libre cualquiera (pruebas)
  servirFront?: boolean; // por defecto true
  directorioSesiones?: string;
  ahora?: () => Date;
};

export type Servidor = {
  url: string;
  puerto: number;
  almacen: AlmacenSesiones;
  detener(): Promise<void>;
};

// El cuerpo que se espera en POST /api/chat
const EsquemaChat = z.object({
  sessionId: z.string().regex(PATRON_ID_SESION, "debe tener entre 8 y 64 letras, números, guiones o guiones bajos"),
  message: z.string().trim().min(1, "no puede estar vacío").max(4000, "máximo 4000 caracteres"),
});

// Cuando falta la clave del modelo, el chat sigue funcionando y responde con este aviso (CA5)
class AdaptadorNoDisponible implements AdaptadorLlm {
  readonly proveedor: string;
  readonly modelo: string;
  private readonly motivo: string;

  constructor(proveedor: string, modelo: string, motivo: string) {
    this.proveedor = proveedor;
    this.modelo = modelo;
    this.motivo = motivo;
  }

  async enviar(): Promise<never> {
    throw new ErrorLlm(this.motivo, "clave");
  }
}

// Compara dos claves sin dar pistas por el tiempo que tarda (se comparan sus huellas)
function clavesIguales(a: string, b: string): boolean {
  const huella = (texto: string): Buffer => createHash("sha256").update(texto).digest();
  return timingSafeEqual(huella(a), huella(b));
}

// Tacha las claves de cualquier texto que vaya a salir del servidor
function ocultarSecretos(texto: string, secretos: string[]): string {
  return secretos.reduce((resultado, secreto) => (secreto.length >= 4 ? resultado.split(secreto).join("***") : resultado), texto);
}

const CABECERAS_BASE = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

// ---------------------------------------------------------------------
// BLOQUE 2 — Crear el servidor
// ---------------------------------------------------------------------

export function crearServidor(opciones: OpcionesServidor): Servidor {
  const { config, raizProyecto } = opciones;
  const ahora = opciones.ahora ?? (() => new Date());

  const llm =
    opciones.llm ??
    new AdaptadorNoDisponible(
      config.proveedor,
      config.modelo,
      opciones.motivoSinLlm ?? "Falta la clave del modelo. Define LLM_API_KEY en el archivo .env.",
    );
  const agente = new Agente({
    llm,
    instrucciones: opciones.instrucciones,
    config,
    raiz: raizProyecto,
    ...(opciones.ahora === undefined ? {} : { ahora: opciones.ahora }),
  });

  const almacen = new AlmacenSesiones({
    raizProyecto,
    ...(opciones.directorioSesiones === undefined ? {} : { directorioBase: opciones.directorioSesiones }),
    maxSesiones: config.maxSesiones,
    ttlMs: config.ttlSesionMinutos * 60_000,
  });
  const limitadorMensajes = new LimitadorPorVentana(config.maxMensajesPorIp, config.ventanaIpSegundos * 1000);
  const limitadorClaveIncorrecta = new LimitadorPorVentana(10, 10 * 60_000); // 10 intentos fallidos cada 10 minutos
  const presupuesto = new PresupuestoDiario(config.maxTokensGlobalDiario, ahora);

  // Cada minuto: caducan sesiones y se libera memoria de los límites
  const mantenimiento = setInterval(() => {
    almacen.limpiarCaducadas();
    limitadorMensajes.purgar();
    limitadorClaveIncorrecta.purgar();
  }, 60_000);
  mantenimiento.unref();

  const secretos = [config.claveApi, config.claveDeAcceso].filter((clave): clave is string => clave !== null);

  // --- Respuestas ---

  // Toda respuesta sale por aquí: JSON, con cabeceras de seguridad y sin ninguna clave
  const responder = (estado: number, cuerpo: unknown, extra: Record<string, string> = {}): Response =>
    new Response(ocultarSecretos(JSON.stringify(cuerpo), secretos), { status: estado, headers: { ...CABECERAS_BASE, ...extra } });

  const limitado = (mensaje: string, segundos: number): Response =>
    responder(429, { error: mensaje, reintentarEnSegundos: segundos }, { "retry-after": String(segundos) });

  // La IP del visitante. Detrás de un proxy de confianza se toma el ÚLTIMO valor de x-forwarded-for
  // (el que agregó el proxy); los anteriores los puede escribir el propio visitante.
  const ipDe = (req: Request): string => {
    if (config.confiarEnProxy) {
      const ultimo = (req.headers.get("x-forwarded-for") ?? "")
        .split(",")
        .map((parte) => parte.trim())
        .filter((parte) => parte !== "")
        .at(-1);
      if (ultimo !== undefined) return ultimo;
    }
    return servidor.requestIP(req)?.address ?? "desconocida";
  };

  // --- Clave de acceso ---

  // null si puede pasar; si no, la respuesta que hay que devolver
  const comprobarAcceso = (req: Request): Response | null => {
    if (config.claveDeAcceso === null) return null;
    const ip = ipDe(req);

    // Quien ya agotó sus intentos fallidos está bloqueado, aunque ahora acierte la clave
    const estado = limitadorClaveIncorrecta.consultar(ip);
    if (!estado.permitido) {
      return limitado("Demasiados intentos con una clave incorrecta. Espera un momento e inténtalo de nuevo.", estado.reintentarEnSegundos);
    }
    if (clavesIguales(req.headers.get("x-clave-acceso") ?? "", config.claveDeAcceso)) return null;

    limitadorClaveIncorrecta.permitir(ip); // este intento fallido cuenta
    return responder(401, { error: "Se necesita la clave de acceso.", requiereClaveDeAcceso: true });
  };

  // --- Rutas ---

  const salud = (): Response => responder(200, { ok: true, ...descripcionPublica(config), sesionesActivas: almacen.cantidad });

  const chat = async (req: Request): Promise<Response> => {
    const sinAcceso = comprobarAcceso(req);
    if (sinAcceso !== null) return sinAcceso;

    // Límite por visitante: antes de hacer cualquier otro trabajo
    const limite = limitadorMensajes.permitir(ipDe(req));
    if (!limite.permitido) {
      return limitado(`Enviaste demasiados mensajes seguidos. Espera ${limite.reintentarEnSegundos} segundos e inténtalo de nuevo.`, limite.reintentarEnSegundos);
    }

    let crudo: unknown;
    try {
      crudo = await req.json();
    } catch {
      return responder(400, { error: "El cuerpo de la petición debe ser un JSON válido." });
    }
    const datos = EsquemaChat.safeParse(crudo);
    if (!datos.success) return responder(400, { error: `Petición inválida: ${describirErrorZod(datos.error)}.` });

    if (presupuesto.agotado()) {
      return responder(429, { error: "La demo agotó su cupo de uso de hoy. Vuelve a intentarlo mañana." });
    }

    const sesion = almacen.obtenerOCrear(datos.data.sessionId);
    if (!sesion.ok) return responder(503, { error: sesion.error });

    const turno = await agente.procesarMensaje(sesion.data, datos.data.message);
    presupuesto.registrar(turno.tokensTurno);
    return responder(200, turno);
  };

  const historial = (req: Request, id: string): Response => {
    const sinAcceso = comprobarAcceso(req);
    if (sinAcceso !== null) return sinAcceso;
    if (!PATRON_ID_SESION.test(id)) return responder(400, { error: "Identificador de sesión inválido." });

    const sesion = almacen.obtener(id);
    if (sesion === null) return responder(404, { error: "La sesión no existe o caducó." });
    return responder(200, {
      id: sesion.id,
      turnos: sesion.turno,
      tokensUsados: sesion.tokensUsados,
      pendientes: [...sesion.pendientes.keys()],
      mensajes: sesion.visibles,
    });
  };

  const metodoNoPermitido = (permitido: string): Response => responder(405, { error: `Método no permitido: usa ${permitido}.` }, { allow: permitido });

  // --- El servidor ---

  const servidor = Bun.serve({
    port: opciones.puerto ?? config.puerto,
    development: false, // el chat se empaqueta y minimiza; sin recarga en caliente
    maxRequestBodySize: 64 * 1024, // un mensaje de chat pesa muy poco: lo demás se rechaza
    routes: {
      // La página (React, empaquetada por Bun); en las pruebas de la API se puede omitir
      "/": opciones.servirFront === false ? () => responder(404, { error: "No encontrado." }) : paginaWeb,
      "/api/health": (req) => (req.method === "GET" ? salud() : metodoNoPermitido("GET")),
      "/api/chat": (req) => (req.method === "POST" ? chat(req) : metodoNoPermitido("POST")),
      "/api/sessions/:id": (req) => (req.method === "GET" ? historial(req, req.params.id) : metodoNoPermitido("GET")),
    },
    fetch: () => responder(404, { error: "No encontrado." }),
    error: (error) => {
      console.error("Error interno del servidor:", ocultarSecretos(error.message, secretos));
      return responder(500, { error: "Error interno del servidor." });
    },
  });

  return {
    url: servidor.url.origin,
    puerto: servidor.port ?? 0,
    almacen,
    detener: async () => {
      clearInterval(mantenimiento);
      await servidor.stop(true);
      almacen.cerrar();
    },
  };
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Arranque desde la terminal
// ---------------------------------------------------------------------

export async function iniciar(): Promise<Servidor> {
  const raizProyecto = join(import.meta.dir, "..");
  const config = leerConfiguracion();

  const instrucciones = cargarInstrucciones(raizProyecto);
  if (!instrucciones.ok) throw new Error(instrucciones.error);

  // Sin clave del modelo el servidor arranca igual: el chat explica qué falta
  const adaptador = crearAdaptadorLlm(config);
  if (!adaptador.ok) console.warn(`AVISO: ${adaptador.error} El chat funcionará, pero responderá con este aviso.`);

  const servidor = crearServidor({
    config,
    llm: adaptador.ok ? adaptador.data : null,
    ...(adaptador.ok ? {} : { motivoSinLlm: adaptador.error }),
    instrucciones: instrucciones.data,
    raizProyecto,
  });

  console.log(`Servidor listo en ${servidor.url}`);
  console.log(`Modelo: ${config.proveedor}/${config.modelo} | clave del modelo: ${config.claveApi === null ? "NO configurada" : "configurada"} | clave de acceso: ${config.claveDeAcceso === null ? "no (abierto)" : "sí"}`);

  // Al apagar, se borran las carpetas de las sesiones
  const apagar = (): void => {
    void servidor.detener().then(() => process.exit(0));
  };
  process.on("SIGINT", apagar);
  process.on("SIGTERM", apagar);
  return servidor;
}

if (import.meta.main) {
  await iniciar();
}
