// =====================================================================
// server.test.ts — Pruebas del servidor HTTP.
//
// Cada prueba arranca un servidor REAL en un puerto libre y lo llama por
// HTTP, con el modelo guionado detrás (sin claves ni red externa). Además
// de que la API haga lo que debe, se prueba lo que pasará en una URL
// pública: fuerza bruta contra la clave de acceso, suplantación de la IP,
// cuerpos enormes, topes de uso e intentos de que se filtre la clave.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leerConfiguracion, type Configuracion } from "./config.ts";
import { ErrorLlm } from "./llm/adapter.ts";
import { decir, fallar, flujoCompleto, ModeloGuionado, pedir, type Paso } from "./pruebas/modelo-guionado.ts";
import { crearServidor, type Servidor } from "./server.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..");
// Claves inventadas, que no se parecen a ninguna real (para no confundir a los escáneres de secretos)
const CLAVE_API = "clave-falsa-solo-para-pruebas";
const CLAVE_ACCESO = "acceso-falso-para-pruebas";
const RELOJ_FIJO = (): Date => new Date("2026-11-10T02:30:00Z");

const servidores: Servidor[] = [];

type Opciones = {
  pasos?: Paso[];
  config?: Partial<Configuracion>;
  sinModelo?: boolean;
  servirFront?: boolean;
  directorioSesiones?: string;
};

type Entorno = { servidor: Servidor; modelo: ModeloGuionado; url: string };

function levantar(opciones: Opciones = {}): Entorno {
  const modelo = new ModeloGuionado(opciones.pasos ?? []);
  const servidor = crearServidor({
    config: { ...leerConfiguracion({}), ...opciones.config },
    llm: opciones.sinModelo === true ? null : modelo,
    instrucciones: "INSTRUCCIONES DE PRUEBA",
    raizProyecto: RAIZ,
    puerto: 0, // un puerto libre cualquiera
    servirFront: opciones.servirFront ?? false,
    ahora: RELOJ_FIJO,
    ...(opciones.directorioSesiones === undefined ? {} : { directorioSesiones: opciones.directorioSesiones }),
  });
  servidores.push(servidor);
  return { servidor, modelo, url: servidor.url };
}

type Respuesta = { estado: number; cabeceras: Headers; texto: string; json: Record<string, unknown> };

async function llamar(
  url: string,
  ruta: string,
  opciones: { metodo?: string; cuerpo?: unknown; cabeceras?: Record<string, string>; crudo?: string } = {},
): Promise<Respuesta> {
  const respuesta = await fetch(`${url}${ruta}`, {
    method: opciones.metodo ?? "GET",
    headers: { ...(opciones.cuerpo !== undefined || opciones.crudo !== undefined ? { "content-type": "application/json" } : {}), ...opciones.cabeceras },
    ...(opciones.crudo !== undefined ? { body: opciones.crudo } : opciones.cuerpo !== undefined ? { body: JSON.stringify(opciones.cuerpo) } : {}),
  });
  const texto = await respuesta.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    // Algunas respuestas (por ejemplo un 413) no son JSON
  }
  return { estado: respuesta.status, cabeceras: respuesta.headers, texto, json };
}

// Un mensaje de chat
const chat = (url: string, sessionId: string, message: string, cabeceras: Record<string, string> = {}): Promise<Respuesta> =>
  llamar(url, "/api/chat", { metodo: "POST", cuerpo: { sessionId, message }, cabeceras });

type LlamadaVista = { herramienta: string; resumen: string; confirmadoPorUsuario: boolean };
const llamadasDe = (r: Respuesta): LlamadaVista[] => (r.json.toolCalls ?? []) as LlamadaVista[];

afterAll(async () => {
  for (const servidor of servidores) await servidor.detener();
});

// ---------------------------------------------------------------------
// BLOQUE 2 — La API funciona
// ---------------------------------------------------------------------

describe("GET /api/health", () => {
  test("dice que está vivo, con el proveedor y el modelo, y sin ninguna clave", async () => {
    const { url } = levantar({ config: { claveApi: CLAVE_API, claveDeAcceso: CLAVE_ACCESO } });
    const respuesta = await llamar(url, "/api/health");

    expect(respuesta.estado).toBe(200);
    expect(respuesta.json).toMatchObject({
      ok: true,
      proveedor: "gemini",
      modelo: "gemini-3.5-flash-lite",
      claveConfigurada: true,
      requiereClaveDeAcceso: true,
      sesionesActivas: 0,
    });
    expect(respuesta.texto).not.toContain(CLAVE_API);
    expect(respuesta.texto).not.toContain(CLAVE_ACCESO);
  });

  test("responde sin pedir la clave de acceso (el chat necesita saber si debe pedirla)", async () => {
    const { url } = levantar({ config: { claveDeAcceso: CLAVE_ACCESO } });
    expect((await llamar(url, "/api/health")).estado).toBe(200);
  });

  test("sin clave del modelo lo dice", async () => {
    const { url } = levantar({ sinModelo: true });
    expect((await llamar(url, "/api/health")).json.claveConfigurada).toBe(false);
  });
});

describe("POST /api/chat", () => {
  test("procesa un caso limpio y devuelve respuesta, herramientas usadas y tokens", async () => {
    const { url } = levantar({ pasos: [...flujoCompleto("sol-001"), decir("Listo, la OC quedó creada.")] });
    const respuesta = await chat(url, "visitante-aaa-1", "Procesa sol-001");

    expect(respuesta.estado).toBe(200);
    expect(respuesta.json).toMatchObject({ reply: "Listo, la OC quedó creada.", needsConfirmation: false, error: null, tokensSesion: 500 });
    expect(llamadasDe(respuesta).map((l) => l.herramienta)).toEqual([
      "oc_leer_paquete",
      "oc_validar",
      "oc_construir_payload",
      "oc_generar_evidencia",
      "oc_crear",
    ]);
    expect(llamadasDe(respuesta).at(-1)?.resumen).toBe("OC 4500000001 creada, fecha 2026-11-09");
  });

  test("dos visitantes distintos procesan sol-001 y los dos obtienen la OC 4500000001", async () => {
    const { url } = levantar({ pasos: [...flujoCompleto("sol-001"), decir("Listo A."), ...flujoCompleto("sol-001"), decir("Listo B.")] });
    const a = await chat(url, "visitante-aaa-1", "Procesa sol-001");
    const b = await chat(url, "visitante-bbb-1", "Procesa sol-001");

    expect(llamadasDe(a).at(-1)?.resumen).toBe("OC 4500000001 creada, fecha 2026-11-09");
    expect(llamadasDe(b).at(-1)?.resumen).toBe("OC 4500000001 creada, fecha 2026-11-09"); // no "ya existía"
  });

  test("la confirmación humana funciona por HTTP: pregunta primero, crea cuando el usuario confirma", async () => {
    const { url, modelo } = levantar({ pasos: [...flujoCompleto("sol-004"), decir("¿Confirmas crear la OC con la excepción RC5?")] });
    const primera = await chat(url, "visitante-aaa-1", "Procesa sol-004. No la crees hasta que confirme.");
    expect(primera.json).toMatchObject({ needsConfirmation: true, pendientes: ["sol-004"] });

    const intermedio = await llamar(url, "/api/sessions/visitante-aaa-1");
    expect(intermedio.json.pendientes).toEqual(["sol-004"]);

    modelo.agregar(pedir(["oc_crear", { caso: "sol-004" }]), decir("Creada."));
    const segunda = await chat(url, "visitante-aaa-1", "Confirmo");
    expect(segunda.json).toMatchObject({ needsConfirmation: false, pendientes: [] });
    expect(llamadasDe(segunda)[0]).toMatchObject({ herramienta: "oc_crear", confirmadoPorUsuario: true });
  });

  test("sin clave del modelo el chat no se rompe: explica qué falta", async () => {
    const { url } = levantar({ sinModelo: true });
    const respuesta = await chat(url, "visitante-aaa-1", "Hola");

    expect(respuesta.estado).toBe(200);
    expect(String(respuesta.json.reply)).toContain("Falta la clave del modelo");
    expect(respuesta.json.error).not.toBeNull();
  });

  test("un error del modelo se informa, y el siguiente mensaje de la sesión funciona", async () => {
    const { url, modelo } = levantar({ pasos: [fallar(new ErrorLlm("El servicio del modelo no está disponible.", "servidor"))] });
    const primera = await chat(url, "visitante-aaa-1", "Hola");
    expect(primera.estado).toBe(200);
    expect(primera.json.reply).toBe("El servicio del modelo no está disponible.");

    modelo.agregar(decir("Ya estoy de vuelta."));
    const segunda = await chat(url, "visitante-aaa-1", "¿Sigues ahí?");
    expect(segunda.json).toMatchObject({ reply: "Ya estoy de vuelta.", error: null });
  });
});

describe("GET /api/sessions/:id", () => {
  test("devuelve el historial completo de la sesión", async () => {
    const { url } = levantar({ pasos: [...flujoCompleto("sol-001"), decir("Listo.")] });
    await chat(url, "visitante-aaa-1", "Procesa sol-001");
    const historial = await llamar(url, "/api/sessions/visitante-aaa-1");

    expect(historial.estado).toBe(200);
    expect(historial.json).toMatchObject({ id: "visitante-aaa-1", turnos: 1, tokensUsados: 500, pendientes: [] });
    const mensajes = historial.json.mensajes as { rol: string; texto: string; llamadas: unknown[] }[];
    expect(mensajes.map((m) => [m.rol, m.texto])).toEqual([
      ["usuario", "Procesa sol-001"],
      ["asistente", "Listo."],
    ]);
    expect(mensajes[1]?.llamadas).toHaveLength(5);
  });

  test("una sesión que no existe da 404 y un identificador malicioso da 400", async () => {
    const { url } = levantar();
    expect((await llamar(url, "/api/sessions/no-existe-1")).estado).toBe(404);
    expect((await llamar(url, "/api/sessions/corto")).estado).toBe(400);
    expect((await llamar(url, "/api/sessions/..%2F..%2Fetc%2Fpasswd")).estado).toBe(400);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Validación de lo que llega
// ---------------------------------------------------------------------

describe("validación de las peticiones", () => {
  test("un cuerpo que no es JSON se rechaza con un mensaje claro", async () => {
    const { url } = levantar();
    const respuesta = await llamar(url, "/api/chat", { metodo: "POST", crudo: "esto no es json" });
    expect(respuesta.estado).toBe(400);
    expect(String(respuesta.json.error)).toContain("JSON válido");
  });

  test("faltan campos o tienen el tipo equivocado: 400 que nombra el campo", async () => {
    const { url } = levantar();
    const sinMensaje = await llamar(url, "/api/chat", { metodo: "POST", cuerpo: { sessionId: "visitante-aaa-1" } });
    expect(sinMensaje.estado).toBe(400);
    expect(String(sinMensaje.json.error)).toContain("message");

    const sinSesion = await llamar(url, "/api/chat", { metodo: "POST", cuerpo: { message: "Hola" } });
    expect(String(sinSesion.json.error)).toContain("sessionId");

    const tipoMalo = await llamar(url, "/api/chat", { metodo: "POST", cuerpo: { sessionId: 12345678, message: ["Hola"] } });
    expect(tipoMalo.estado).toBe(400);
  });

  test("un identificador de sesión malicioso se rechaza antes de tocar el disco", async () => {
    const { url, servidor } = levantar();
    for (const sessionId of ["../../etc/passwd", "corto", "con espacio 1", "a/b/c/d/e/f/g/h"]) {
      expect((await chat(url, sessionId, "Hola")).estado).toBe(400);
    }
    expect(servidor.almacen.cantidad).toBe(0);
  });

  test("un mensaje vacío, de solo espacios o demasiado largo se rechaza", async () => {
    const { url } = levantar();
    expect((await chat(url, "visitante-aaa-1", "")).estado).toBe(400);
    expect((await chat(url, "visitante-aaa-1", "     ")).estado).toBe(400);
    expect((await chat(url, "visitante-aaa-1", "a".repeat(4001))).estado).toBe(400);
  });

  test("un cuerpo enorme se corta con 413 antes de procesarlo", async () => {
    const { url } = levantar();
    const respuesta = await llamar(url, "/api/chat", { metodo: "POST", cuerpo: { sessionId: "visitante-aaa-1", message: "a".repeat(100_000) } });
    expect(respuesta.estado).toBe(413);
  });

  test("un método equivocado da 405 con JSON y dice cuál usar", async () => {
    const { url } = levantar();
    const chatConGet = await llamar(url, "/api/chat");
    expect(chatConGet.estado).toBe(405);
    expect(chatConGet.cabeceras.get("allow")).toBe("POST");
    expect(chatConGet.json.error).toBeDefined();

    expect((await llamar(url, "/api/health", { metodo: "POST", cuerpo: {} })).estado).toBe(405);
    expect((await llamar(url, "/api/sessions/visitante-aaa-1", { metodo: "DELETE" })).estado).toBe(405);
  });

  test("una ruta desconocida da 404 con JSON", async () => {
    const { url } = levantar();
    const respuesta = await llamar(url, "/api/no-existe");
    expect(respuesta.estado).toBe(404);
    expect(respuesta.json.error).toBeDefined();
  });

  test("todas las respuestas de la API llevan cabeceras de seguridad y no se guardan en caché", async () => {
    const { url } = levantar();
    for (const respuesta of [await llamar(url, "/api/health"), await llamar(url, "/api/no-existe"), await chat(url, "corto", "Hola")]) {
      expect(respuesta.cabeceras.get("x-content-type-options")).toBe("nosniff");
      expect(respuesta.cabeceras.get("x-frame-options")).toBe("DENY");
      expect(respuesta.cabeceras.get("cache-control")).toBe("no-store");
      expect(respuesta.cabeceras.get("content-type")).toContain("application/json");
    }
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Clave de acceso
// ---------------------------------------------------------------------

describe("clave de acceso", () => {
  test("sin la clave, con una incorrecta o con la correcta", async () => {
    const { url } = levantar({ config: { claveDeAcceso: CLAVE_ACCESO }, pasos: [decir("Hola.")] });

    const sin = await chat(url, "visitante-aaa-1", "Hola");
    expect(sin.estado).toBe(401);
    expect(sin.json.requiereClaveDeAcceso).toBe(true);

    const mala = await chat(url, "visitante-aaa-1", "Hola", { "x-clave-acceso": "otra-clave" });
    expect(mala.estado).toBe(401);

    const buena = await chat(url, "visitante-aaa-1", "Hola", { "x-clave-acceso": CLAVE_ACCESO });
    expect(buena.estado).toBe(200);
    expect(buena.json.reply).toBe("Hola.");
  });

  test("el historial de una sesión también exige la clave", async () => {
    const { url } = levantar({ config: { claveDeAcceso: CLAVE_ACCESO }, pasos: [decir("Hola.")] });
    await chat(url, "visitante-aaa-1", "Hola", { "x-clave-acceso": CLAVE_ACCESO });

    expect((await llamar(url, "/api/sessions/visitante-aaa-1")).estado).toBe(401);
    expect((await llamar(url, "/api/sessions/visitante-aaa-1", { cabeceras: { "x-clave-acceso": CLAVE_ACCESO } })).estado).toBe(200);
  });

  test("la clave nunca aparece en ninguna respuesta, ni siquiera en los errores", async () => {
    const { url } = levantar({ config: { claveDeAcceso: CLAVE_ACCESO } });
    const respuestas = [
      await chat(url, "visitante-aaa-1", "Hola"),
      await chat(url, "visitante-aaa-1", "Hola", { "x-clave-acceso": CLAVE_ACCESO + "-mal" }),
      await llamar(url, "/api/health"),
    ];
    for (const respuesta of respuestas) expect(respuesta.texto).not.toContain(CLAVE_ACCESO);
  });

  test("no se puede adivinar por fuerza bruta: tras 10 intentos fallidos el visitante queda bloqueado, incluso con la clave correcta", async () => {
    const { url } = levantar({ config: { claveDeAcceso: CLAVE_ACCESO, confiarEnProxy: true }, pasos: [decir("Hola."), decir("Hola.")] });
    const atacante = { "x-forwarded-for": "6.6.6.6" };

    for (let intento = 1; intento <= 10; intento++) {
      expect((await chat(url, "visitante-aaa-1", "Hola", { ...atacante, "x-clave-acceso": `intento-${intento}` })).estado).toBe(401);
    }
    // El intento 11, con una clave incorrecta, ya no recibe un 401 sino un bloqueo
    const bloqueado = await chat(url, "visitante-aaa-1", "Hola", { ...atacante, "x-clave-acceso": "intento-11" });
    expect(bloqueado.estado).toBe(429);
    expect(bloqueado.cabeceras.get("retry-after")).not.toBeNull();

    // Aunque ahora acierte, sigue bloqueado
    const conLaBuena = await chat(url, "visitante-aaa-1", "Hola", { ...atacante, "x-clave-acceso": CLAVE_ACCESO });
    expect(conLaBuena.estado).toBe(429);

    // Otro visitante no se ve afectado
    const otro = await chat(url, "visitante-bbb-1", "Hola", { "x-forwarded-for": "7.7.7.7", "x-clave-acceso": CLAVE_ACCESO });
    expect(otro.estado).toBe(200);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Límites de uso
// ---------------------------------------------------------------------

describe("límites de uso", () => {
  test("un visitante que envía demasiados mensajes recibe 429 con el tiempo de espera", async () => {
    const { url } = levantar({
      config: { maxMensajesPorIp: 2, confiarEnProxy: true },
      pasos: [decir("Uno."), decir("Dos."), decir("Tres.")],
    });
    const visitante = { "x-forwarded-for": "5.5.5.5" };

    expect((await chat(url, "visitante-aaa-1", "Uno", visitante)).estado).toBe(200);
    expect((await chat(url, "visitante-aaa-1", "Dos", visitante)).estado).toBe(200);
    const tercera = await chat(url, "visitante-aaa-1", "Tres", visitante);

    expect(tercera.estado).toBe(429);
    expect(Number(tercera.cabeceras.get("retry-after"))).toBeGreaterThan(0);
    expect(String(tercera.json.error)).toContain("demasiados mensajes");
    expect(tercera.json.reintentarEnSegundos).toBeGreaterThan(0);

    // Otro visitante, con su propia IP, sí puede
    expect((await chat(url, "visitante-bbb-1", "Hola", { "x-forwarded-for": "8.8.8.8" })).estado).toBe(200);
  });

  test("detrás de un proxy de confianza se usa el ÚLTIMO valor de x-forwarded-for: el visitante no puede cambiarlo para saltarse el límite", async () => {
    const { url } = levantar({ config: { maxMensajesPorIp: 1, confiarEnProxy: true }, pasos: [decir("Uno."), decir("Dos.")] });

    // El proxy agrega al final la IP real (2.2.2.2); el visitante inventa la primera
    expect((await chat(url, "visitante-aaa-1", "Uno", { "x-forwarded-for": "1.1.1.1, 2.2.2.2" })).estado).toBe(200);
    expect((await chat(url, "visitante-aaa-1", "Dos", { "x-forwarded-for": "9.9.9.9, 2.2.2.2" })).estado).toBe(429);
  });

  test("sin proxy de confianza, x-forwarded-for se ignora por completo", async () => {
    const { url } = levantar({ config: { maxMensajesPorIp: 1, confiarEnProxy: false }, pasos: [decir("Uno."), decir("Dos.")] });
    expect((await chat(url, "visitante-aaa-1", "Uno", { "x-forwarded-for": "1.1.1.1" })).estado).toBe(200);
    expect((await chat(url, "visitante-aaa-1", "Dos", { "x-forwarded-for": "9.9.9.9" })).estado).toBe(429); // misma IP real
  });

  test("al agotarse el tope diario de tokens de TODO el servidor, nadie más usa el modelo", async () => {
    const { url } = levantar({
      config: { maxTokensGlobalDiario: 150, maxMensajesPorIp: 100 },
      pasos: [decir("Uno.", 100), decir("Dos.", 100), decir("Tres.", 100)],
    });

    expect((await chat(url, "visitante-aaa-1", "Uno")).estado).toBe(200); // 100 de 150
    expect((await chat(url, "visitante-bbb-1", "Dos")).estado).toBe(200); // 200 de 150: se pasó, pero esa ya estaba en curso
    const agotado = await chat(url, "visitante-ccc-1", "Tres");

    expect(agotado.estado).toBe(429);
    expect(String(agotado.json.error)).toContain("cupo de uso de hoy");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — Secretos y cierre
// ---------------------------------------------------------------------

describe("secretos y cierre", () => {
  test("si un error del modelo trajera la clave del modelo en su texto, se tacha antes de salir", async () => {
    const { url } = levantar({ config: { claveApi: CLAVE_API }, pasos: [fallar(new Error(`falló la llamada con ${CLAVE_API} dentro`))] });
    const respuesta = await chat(url, "visitante-aaa-1", "Hola");

    expect(respuesta.estado).toBe(200);
    expect(respuesta.texto).not.toContain(CLAVE_API);
    expect(respuesta.texto).toContain("***");
  });

  test("la clave tampoco sale por el historial de la sesión", async () => {
    const { url } = levantar({ config: { claveApi: CLAVE_API }, pasos: [fallar(new Error(`falló con ${CLAVE_API}`))] });
    await chat(url, "visitante-aaa-1", "Hola");
    const historial = await llamar(url, "/api/sessions/visitante-aaa-1");
    expect(historial.texto).not.toContain(CLAVE_API);
  });

  test("al detener el servidor se borran las carpetas de las sesiones y deja de responder", async () => {
    const base = mkdtempSync(join(tmpdir(), "oc-servidor-"));
    const { url, servidor } = levantar({ directorioSesiones: base, pasos: [decir("Hola.")] });
    await chat(url, "visitante-aaa-1", "Hola");
    expect(readdirSync(base)).toEqual(["visitante-aaa-1"]);

    await servidor.detener();
    expect(existsSync(base)).toBe(false);
    await expect(llamar(url, "/api/health")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------
// BLOQUE 7 — La página web
// ---------------------------------------------------------------------

describe("la página web", () => {
  test("GET / sirve el chat como HTML y su código empaquetado", async () => {
    const { url } = levantar({ servirFront: true });
    const pagina = await llamar(url, "/");

    expect(pagina.estado).toBe(200);
    expect(pagina.cabeceras.get("content-type")).toContain("text/html");
    expect(pagina.texto).toContain('id="raiz"');
    expect(pagina.texto).toContain("Agente de órdenes de compra");
  }, 30_000);

  test("sin servir el front, GET / da 404 en JSON", async () => {
    const { url } = levantar({ servirFront: false });
    expect((await llamar(url, "/")).estado).toBe(404);
  });
});
