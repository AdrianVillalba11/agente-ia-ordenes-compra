// =====================================================================
// gemini.test.ts — Pruebas del adaptador de Gemini y de la fábrica.
//
// NO hacen ninguna llamada real: la red se reemplaza por una simulada que
// devuelve respuestas con el formato documentado por Google. Comprueban lo
// que se envía (formato, cabeceras, clave), cómo se lee la respuesta, que
// las firmas de pensamiento se devuelven intactas, los reintentos, los
// tiempos límite y que cada error salga en español sin filtrar la clave.
// Se ejecutan con: bun test
// =====================================================================

import { describe, expect, test } from "bun:test";
import { leerConfiguracion } from "../config.ts";
import { ErrorLlm, type DefinicionHerramienta, type MensajeLlm, type OpcionesLlm } from "./adapter.ts";
import { crearAdaptadorLlm } from "./fabrica.ts";
import { AdaptadorGemini, type LlamadaRed } from "./gemini.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes: red simulada y datos de ejemplo
// ---------------------------------------------------------------------

// Una clave inventada, que no se parece a ninguna real (para no confundir a los escáneres de secretos)
const CLAVE = "clave-falsa-solo-para-pruebas";
const MODELO = "gemini-3.5-flash-lite";
const OPCIONES: OpcionesLlm = { sistema: "Eres un agente de compras.", maxTokensSalida: 500, tiempoLimiteMs: 1000 };

const HERRAMIENTAS: DefinicionHerramienta[] = [
  {
    nombre: "oc_validar",
    descripcion: "Valida un caso contra los maestros",
    parametros: { type: "object", properties: { caso: { type: "string", description: "Nombre del caso" } }, required: ["caso"] },
  },
];

const MENSAJE_INICIAL: MensajeLlm = { rol: "usuario", bloques: [{ tipo: "texto", texto: "Procesa sol-001" }] };

type CuerpoGemini = {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: string; parts: Record<string, unknown>[] }[];
  tools?: { functionDeclarations: { name: string; description: string; parametersJsonSchema: unknown }[] }[];
  generationConfig: Record<string, unknown>;
};

type Programada = Response | Error | ((init: RequestInit) => Promise<Response>);
type Llamada = { url: string; init: RequestInit };

// Una red que va entregando, en orden, las respuestas programadas y recuerda cada llamada
function redFalsa(programadas: Programada[]): { red: LlamadaRed; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  const pendientes = [...programadas];
  const red: LlamadaRed = async (url, init) => {
    llamadas.push({ url, init });
    const siguiente = pendientes.shift();
    if (siguiente === undefined) throw new Error("La red simulada no tenía más respuestas programadas");
    if (siguiente instanceof Error) throw siguiente;
    return typeof siguiente === "function" ? siguiente(init) : siguiente;
  };
  return { red, llamadas };
}

const json = (cuerpo: unknown, estado = 200): Response =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { "content-type": "application/json" } });

const cuerpoDe = (llamada: Llamada | undefined): CuerpoGemini => JSON.parse(String(llamada?.init.body)) as CuerpoGemini;

const USO = { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 };

const RESPUESTA_TEXTO = {
  candidates: [{ content: { role: "model", parts: [{ text: "Hola, ¿qué caso procesamos?" }] }, finishReason: "STOP" }],
  usageMetadata: USO,
};

// El modelo pide una herramienta; la firma de pensamiento viaja pegada a la llamada
const RESPUESTA_LLAMADA = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ thoughtSignature: "FIRMA-OPACA-123", functionCall: { name: "oc_validar", id: "fc-9", args: { caso: "sol-001" } } }],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: USO,
};

function adaptador(programadas: Programada[]): { gemini: AdaptadorGemini; llamadas: Llamada[]; esperas: number[] } {
  const { red, llamadas } = redFalsa(programadas);
  const esperas: number[] = [];
  const gemini = new AdaptadorGemini(CLAVE, MODELO, red, async (ms) => {
    esperas.push(ms);
  });
  return { gemini, llamadas, esperas };
}

// ---------------------------------------------------------------------
// BLOQUE 2 — Lo que se envía
// ---------------------------------------------------------------------

describe("AdaptadorGemini: la petición", () => {
  test("usa el formato de Gemini: URL del modelo, clave en la cabecera y cuerpo con instrucciones, mensajes y herramientas", async () => {
    const { gemini, llamadas } = adaptador([json(RESPUESTA_TEXTO)]);
    await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);

    const [llamada] = llamadas;
    expect(llamada?.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`);
    expect(llamada?.init.method).toBe("POST");
    expect((llamada?.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(CLAVE);

    const cuerpo = cuerpoDe(llamada);
    expect(cuerpo.systemInstruction).toEqual({ parts: [{ text: "Eres un agente de compras." }] });
    expect(cuerpo.contents).toEqual([{ role: "user", parts: [{ text: "Procesa sol-001" }] }]);
    expect(cuerpo.tools).toEqual([
      {
        functionDeclarations: [
          { name: "oc_validar", description: "Valida un caso contra los maestros", parametersJsonSchema: HERRAMIENTAS[0]?.parametros },
        ],
      },
    ]);
    expect(cuerpo.generationConfig).toEqual({ maxOutputTokens: 500 });
  });

  test("la clave viaja solo en la cabecera, nunca en la URL ni en el cuerpo", async () => {
    const { gemini, llamadas } = adaptador([json(RESPUESTA_TEXTO)]);
    await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);

    expect(llamadas[0]?.url).not.toContain(CLAVE);
    expect(String(llamadas[0]?.init.body)).not.toContain(CLAVE);
  });

  test("no envía 'temperature' (los modelos recientes la ignoran)", async () => {
    const { gemini, llamadas } = adaptador([json(RESPUESTA_TEXTO)]);
    await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);
    expect(String(llamadas[0]?.init.body)).not.toContain("temperature");
  });

  test("sin herramientas no envía el bloque 'tools'", async () => {
    const { gemini, llamadas } = adaptador([json(RESPUESTA_TEXTO)]);
    await gemini.enviar([MENSAJE_INICIAL], [], OPCIONES);
    expect(cuerpoDe(llamadas[0]).tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Lo que se recibe
// ---------------------------------------------------------------------

describe("AdaptadorGemini: la respuesta", () => {
  test("lee el texto y los tokens usados (los de pensamiento también cuentan)", async () => {
    const { gemini } = adaptador([json(RESPUESTA_TEXTO)]);
    const respuesta = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);

    expect(respuesta.bloques).toEqual([{ tipo: "texto", texto: "Hola, ¿qué caso procesamos?" }]);
    expect(respuesta.uso).toEqual({ entrada: 100, salida: 25, total: 125 });
    expect(respuesta.truncada).toBeUndefined();
  });

  test("lee una llamada a herramienta con su nombre, argumentos e identificador del proveedor", async () => {
    const { gemini } = adaptador([json(RESPUESTA_LLAMADA), json(RESPUESTA_LLAMADA)]);
    const primera = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);
    const segunda = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);

    expect(primera.bloques).toEqual([
      { tipo: "uso_herramienta", id: "llamada-1", idExterno: "fc-9", nombre: "oc_validar", argumentos: { caso: "sol-001" } },
    ]);
    expect(segunda.bloques[0]).toMatchObject({ id: "llamada-2" }); // cada llamada recibe un identificador propio distinto
  });

  test("sin totalTokenCount, el total es la suma", async () => {
    const sinTotal = { ...RESPUESTA_TEXTO, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } };
    const { gemini } = adaptador([json(sinTotal)]);
    expect((await gemini.enviar([MENSAJE_INICIAL], [], OPCIONES)).uso).toEqual({ entrada: 10, salida: 4, total: 14 });
  });

  test("los resúmenes de 'pensamiento' no se muestran como texto", async () => {
    const conPensamiento = {
      ...RESPUESTA_TEXTO,
      candidates: [{ content: { role: "model", parts: [{ text: "pensando en voz alta", thought: true }, { text: "Respuesta final" }] }, finishReason: "STOP" }],
    };
    const { gemini } = adaptador([json(conPensamiento)]);
    expect((await gemini.enviar([MENSAJE_INICIAL], [], OPCIONES)).bloques).toEqual([{ tipo: "texto", texto: "Respuesta final" }]);
  });

  test("una respuesta cortada por longitud se marca como truncada", async () => {
    const cortada = { ...RESPUESTA_TEXTO, candidates: [{ ...RESPUESTA_TEXTO.candidates[0], finishReason: "MAX_TOKENS" }] };
    const { gemini } = adaptador([json(cortada)]);
    expect((await gemini.enviar([MENSAJE_INICIAL], [], OPCIONES)).truncada).toBe(true);
  });

  test("sin id del proveedor la llamada igual se lee, y el resultado no lleva id", async () => {
    const sinId = {
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "oc_validar", args: { caso: "sol-001" } } }] }, finishReason: "STOP" }],
      usageMetadata: USO,
    };
    const { gemini, llamadas } = adaptador([json(sinId), json(RESPUESTA_TEXTO)]);
    const primera = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);
    const uso = primera.bloques[0];
    if (uso?.tipo !== "uso_herramienta") throw new Error("Se esperaba una llamada a herramienta");
    expect(uso.idExterno).toBeUndefined();

    await gemini.enviar(
      [MENSAJE_INICIAL, { rol: "asistente", bloques: primera.bloques }, { rol: "usuario", bloques: [{ tipo: "resultado_herramienta", idUso: uso.id, nombre: uso.nombre, resultado: { ok: true } }] }],
      HERRAMIENTAS,
      OPCIONES,
    );
    const respuestaFuncion = cuerpoDe(llamadas[1]).contents[2]?.parts[0]?.functionResponse as Record<string, unknown>;
    expect(respuestaFuncion).toEqual({ name: "oc_validar", response: { ok: true } }); // sin "id"
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Firmas de pensamiento y resultados de herramientas
// ---------------------------------------------------------------------

describe("AdaptadorGemini: devolver la conversación", () => {
  test("reenvía la respuesta original del modelo tal cual, con su firma de pensamiento, y el resultado con su id", async () => {
    const { gemini, llamadas } = adaptador([json(RESPUESTA_LLAMADA), json(RESPUESTA_TEXTO)]);
    const primera = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);
    const uso = primera.bloques[0];
    if (uso?.tipo !== "uso_herramienta") throw new Error("Se esperaba una llamada a herramienta");

    await gemini.enviar(
      [
        MENSAJE_INICIAL,
        { rol: "asistente", bloques: primera.bloques, crudo: primera.crudo },
        {
          rol: "usuario",
          bloques: [{ tipo: "resultado_herramienta", idUso: uso.id, idExterno: uso.idExterno, nombre: uso.nombre, resultado: { ok: true, data: { apta: true } } }],
        },
      ],
      HERRAMIENTAS,
      OPCIONES,
    );

    const { contents } = cuerpoDe(llamadas[1]);
    // El turno del modelo es EXACTAMENTE el que llegó, con su thoughtSignature
    const contenidoOriginal = RESPUESTA_LLAMADA.candidates[0]?.content ?? { role: "model", parts: [] };
    expect(contents[1]).toEqual(contenidoOriginal);
    expect(contents[1]?.parts[0]?.thoughtSignature).toBe("FIRMA-OPACA-123");
    // Y el resultado vuelve como functionResponse, con el id de la llamada
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "oc_validar", id: "fc-9", response: { ok: true, data: { apta: true } } } }],
    });
  });

  test("un mensaje del asistente sin respuesta original (por ejemplo, un aviso de error) se arma desde sus bloques", async () => {
    const { gemini, llamadas } = adaptador([json(RESPUESTA_TEXTO)]);
    await gemini.enviar(
      [MENSAJE_INICIAL, { rol: "asistente", bloques: [{ tipo: "texto", texto: "Hubo un error técnico." }] }, { rol: "usuario", bloques: [{ tipo: "texto", texto: "Reintenta" }] }],
      [],
      OPCIONES,
    );
    expect(cuerpoDe(llamadas[0]).contents[1]).toEqual({ role: "model", parts: [{ text: "Hubo un error técnico." }] });
  });

  test("un resultado que no es un objeto se envuelve, porque Gemini pide un objeto", async () => {
    const { gemini, llamadas } = adaptador([json(RESPUESTA_TEXTO)]);
    await gemini.enviar(
      [{ rol: "usuario", bloques: [{ tipo: "resultado_herramienta", idUso: "x", nombre: "oc_validar", resultado: "texto suelto" }] }],
      [],
      OPCIONES,
    );
    expect(cuerpoDe(llamadas[0]).contents[0]?.parts[0]).toEqual({
      functionResponse: { name: "oc_validar", response: { resultado: "texto suelto" } },
    });
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — Errores del proveedor, en español y sin filtrar la clave
// ---------------------------------------------------------------------

describe("AdaptadorGemini: errores", () => {
  // Captura el error que lanza enviar()
  async function errorDe(programadas: Programada[]): Promise<ErrorLlm> {
    const { gemini } = adaptador(programadas);
    const error = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES).catch((e: unknown) => e);
    if (!(error instanceof ErrorLlm)) throw new Error(`Se esperaba un ErrorLlm y llegó: ${String(error)}`);
    return error;
  }

  test("una clave inválida (400 'API key not valid'), 401 o 403 dan el aviso de clave", async () => {
    const clave400 = await errorDe([json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, 400)]);
    expect(clave400.tipo).toBe("clave");
    expect(clave400.message).toContain("LLM_API_KEY");
    expect((await errorDe([json({ error: { message: "x" } }, 401)])).tipo).toBe("clave");
    expect((await errorDe([json({ error: { message: "x" } }, 403)])).tipo).toBe("clave");
  });

  test("un modelo inexistente (404) nombra el modelo", async () => {
    const error = await errorDe([json({ error: { message: "not found" } }, 404)]);
    expect(error.message).toContain(MODELO);
  });

  test("el límite de uso (429) se explica y se reintentó una vez antes de rendirse", async () => {
    const { gemini, llamadas, esperas } = adaptador([json({ error: {} }, 429), json({ error: {} }, 429)]);
    const error = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorLlm);
    expect((error as ErrorLlm).tipo).toBe("limite");
    expect((error as ErrorLlm).message).toContain("límite de uso");
    expect(llamadas).toHaveLength(2);
    expect(esperas).toEqual([1000]);
  });

  test("un servidor caído (500, 503) se reintenta y, si sigue, se explica", async () => {
    const error = await errorDe([json({ error: {} }, 503), json({ error: {} }, 500)]);
    expect(error.tipo).toBe("servidor");
    expect(error.message).toContain("no está disponible");
  });

  test("un fallo temporal que se recupera en el reintento sale bien", async () => {
    const { gemini, llamadas, esperas } = adaptador([json({ error: {} }, 503), json(RESPUESTA_TEXTO)]);
    const respuesta = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES);

    expect(respuesta.bloques).toHaveLength(1);
    expect(llamadas).toHaveLength(2);
    expect(esperas).toEqual([1000]);
  });

  test("una solicitud rechazada (400) no se reintenta y muestra el motivo del proveedor", async () => {
    const { gemini, llamadas } = adaptador([json({ error: { message: "Invalid JSON payload received" } }, 400)]);
    const error = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, OPCIONES).catch((e: unknown) => e);

    expect((error as ErrorLlm).tipo).toBe("otro");
    expect((error as ErrorLlm).message).toContain("Invalid JSON payload received");
    expect(llamadas).toHaveLength(1);
  });

  test("una demora excesiva corta la espera y se explica", async () => {
    // Una red que nunca responde, salvo para avisar que fue cancelada
    const sinRespuesta: Programada = (init) =>
      new Promise<Response>((_, rechazar) => {
        init.signal?.addEventListener("abort", () => rechazar(new DOMException("cancelada", "AbortError")));
      });
    const { red } = redFalsa([sinRespuesta]);
    const gemini = new AdaptadorGemini(CLAVE, MODELO, red);

    const error = await gemini.enviar([MENSAJE_INICIAL], HERRAMIENTAS, { ...OPCIONES, tiempoLimiteMs: 20 }).catch((e: unknown) => e);
    expect((error as ErrorLlm).tipo).toBe("tiempo");
    expect((error as ErrorLlm).message).toContain("tardó demasiado");
  });

  test("un fallo de red se explica sin mostrar el detalle técnico", async () => {
    const error = await errorDe([new Error("ECONNRESET 10.0.0.1:443")]);
    expect(error.tipo).toBe("red");
    expect(error.message).not.toContain("ECONNRESET");
  });

  test("una respuesta que no es JSON se explica", async () => {
    const error = await errorDe([new Response("<html>error</html>", { status: 200 })]);
    expect(error.tipo).toBe("respuesta");
  });

  test("una petición bloqueada por seguridad, con o sin candidato, se explica", async () => {
    const porPrompt = await errorDe([json({ promptFeedback: { blockReason: "SAFETY" } })]);
    expect(porPrompt.tipo).toBe("bloqueo");

    const porRespuesta = await errorDe([json({ candidates: [{ finishReason: "SAFETY", content: { role: "model", parts: [] } }] })]);
    expect(porRespuesta.tipo).toBe("bloqueo");
  });

  test("una llamada a herramienta mal formada o sin firma se informa con su motivo", async () => {
    for (const motivo of ["MALFORMED_FUNCTION_CALL", "MISSING_THOUGHT_SIGNATURE"]) {
      const error = await errorDe([json({ candidates: [{ finishReason: motivo, content: { role: "model", parts: [] } }] })]);
      expect(error.tipo).toBe("respuesta");
      expect(error.message).toContain(motivo);
    }
  });

  test("una respuesta sin ningún candidato se informa", async () => {
    expect((await errorDe([json({})])).tipo).toBe("respuesta");
  });

  test("si el proveedor devolviera la clave en su mensaje de error, se oculta", async () => {
    const error = await errorDe([json({ error: { message: `Campo inválido en la petición con ${CLAVE} dentro` } }, 400)]);
    expect(error.message).not.toContain(CLAVE);
    expect(error.message).toContain("***");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — La fábrica de adaptadores
// ---------------------------------------------------------------------

describe("crearAdaptadorLlm", () => {
  test("con clave y proveedor gemini crea el adaptador, con el modelo configurado", () => {
    const config = leerConfiguracion({ LLM_API_KEY: CLAVE, LLM_MODEL: "gemini-3.6-flash" });
    const resultado = crearAdaptadorLlm(config);
    if (!resultado.ok) throw new Error(resultado.error);
    expect(resultado.data.proveedor).toBe("gemini");
    expect(resultado.data.modelo).toBe("gemini-3.6-flash");
  });

  test("sin clave da un error claro que dice qué variable definir", () => {
    const resultado = crearAdaptadorLlm(leerConfiguracion({}));
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error).toContain("LLM_API_KEY");
  });

  test("un proveedor no implementado da un error claro", () => {
    const resultado = crearAdaptadorLlm(leerConfiguracion({ LLM_PROVIDER: "otro", LLM_API_KEY: CLAVE }));
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error).toContain("no soportado");
  });
});
