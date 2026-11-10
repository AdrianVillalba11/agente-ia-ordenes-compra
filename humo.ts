// =====================================================================
// humo.ts — Prueba de humo con el modelo REAL (necesita tu API key).
//
// Todo lo demás del proyecto se prueba con un modelo falso y una red
// simulada. Este script es el único que habla de verdad con Gemini, para
// comprobar que la clave, el modelo y el formato de las llamadas funcionan.
//
// Uso:
//   bun run humo.ts               prueba de conexión + un caso completo (sol-001)
//   bun run humo.ts --completo    además, la confirmación humana con sol-004
//
// Cada ejecución GASTA tokens de tu cuota (un caso completo son unas decenas
// de miles). Trabaja sobre una copia temporal de los fixtures y la borra al
// terminar: no toca tu carpeta out/.
//
// La clave se lee de LLM_API_KEY (o GEMINI_API_KEY) y NUNCA se imprime.
// =====================================================================

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agente, crearSesion, type RespuestaTurno, type Sesion } from "./src/agente/ciclo.ts";
import { cargarInstrucciones } from "./src/agente/instrucciones.ts";
import { leerConfiguracion } from "./src/config.ts";
import { ErrorLlm } from "./src/llm/adapter.ts";
import { crearAdaptadorLlm } from "./src/llm/fabrica.ts";

const escribir = (texto = ""): void => console.log(texto);

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes para mostrar un turno
// ---------------------------------------------------------------------

// Muestra lo que pasó en un turno: las herramientas que usó el modelo, su respuesta y los tokens
function mostrarTurno(mensaje: string, respuesta: RespuestaTurno, segundos: number): void {
  escribir(`  Usuario: ${mensaje}`);
  for (const llamada of respuesta.toolCalls) {
    const aviso = llamada.confirmadoPorUsuario ? "  [confirmado por el usuario]" : "";
    escribir(`   - ${llamada.herramienta} -> ${llamada.resumen}${aviso}`);
  }
  escribir("  Respuesta del agente:");
  for (const parrafo of respuesta.reply.split("\n")) escribir(`    ${parrafo}`);
  escribir(`  (${segundos.toFixed(1)} s, ${respuesta.tokensTurno} tokens en este turno, ${respuesta.tokensSesion} en la sesión)`);
  if (respuesta.error !== null) escribir(`  ERROR: ${respuesta.error}`);
  if (respuesta.needsConfirmation) escribir(`  Esperando confirmación de: ${respuesta.pendientes.join(", ")}`);
}

// Un turno completo, con su tiempo
async function turno(agente: Agente, sesion: Sesion, mensaje: string): Promise<RespuestaTurno> {
  const inicio = Date.now();
  const respuesta = await agente.procesarMensaje(sesion, mensaje);
  mostrarTurno(mensaje, respuesta, (Date.now() - inicio) / 1000);
  return respuesta;
}

// ---------------------------------------------------------------------
// BLOQUE 2 — La prueba
// ---------------------------------------------------------------------

async function ejecutarPrueba(): Promise<number> {
  const raiz = import.meta.dir;
  const completo = process.argv.includes("--completo");
  const config = leerConfiguracion();

  escribir("PRUEBA DE HUMO con el modelo real");
  escribir(`Proveedor: ${config.proveedor} | Modelo: ${config.modelo} | Clave configurada: ${config.claveApi === null ? "NO" : "sí"}`);
  escribir(`Topes: ${config.maxIteracionesPorTurno} pasos por turno, ${config.maxTokensPorSesion} tokens por sesión`);
  escribir();

  // La clave, el proveedor y las instrucciones deben estar bien antes de gastar nada
  const adaptador = crearAdaptadorLlm(config);
  if (!adaptador.ok) {
    escribir(`NO SE PUEDE PROBAR: ${adaptador.error}`);
    escribir("Crea tu clave en aistudio.google.com y guárdala en el archivo .env (ver .env.example).");
    return 1;
  }
  const instrucciones = cargarInstrucciones(raiz);
  if (!instrucciones.ok) {
    escribir(`NO SE PUEDE PROBAR: ${instrucciones.error}`);
    return 1;
  }
  const llm = adaptador.data;
  let correctas = 0;
  let total = 0;
  const comprobar = (descripcion: string, bien: boolean, pista = ""): void => {
    total++;
    if (bien) correctas++;
    escribir(`  [${bien ? "OK" : "FALLA"}] ${descripcion}${bien || pista === "" ? "" : `  <- ${pista}`}`);
  };

  // --- Prueba 1: ¿se puede hablar con el modelo? (llamada mínima, sin herramientas) ---
  escribir("== Prueba 1: conexión con el modelo ==");
  try {
    const inicio = Date.now();
    const salida = await llm.enviar(
      [{ rol: "usuario", bloques: [{ tipo: "texto", texto: "Responde solo con la palabra: listo" }] }],
      [],
      { sistema: "Eres un asistente muy breve.", maxTokensSalida: 512, tiempoLimiteMs: config.tiempoLimiteLlmMs },
    );
    const texto = salida.bloques.map((bloque) => (bloque.tipo === "texto" ? bloque.texto : "")).join("").trim();
    escribir(`  El modelo respondió: "${texto}" (${((Date.now() - inicio) / 1000).toFixed(1)} s, ${salida.uso.total} tokens)`);
    comprobar("El modelo responde", texto !== "", "la respuesta llegó vacía");
  } catch (error) {
    // Un error de conexión o de clave: no tiene sentido seguir
    escribir(`  [FALLA] ${error instanceof ErrorLlm ? `${error.message} (tipo: ${error.tipo})` : String(error)}`);
    return 1;
  }

  // --- Pruebas con el agente completo, sobre una copia temporal de los fixtures ---
  const raizTemporal = mkdtempSync(join(tmpdir(), "oc-humo-"));
  cpSync(join(raiz, "fixtures"), join(raizTemporal, "fixtures"), { recursive: true });
  try {
    const agente = new Agente({ llm, instrucciones: instrucciones.data, config, raiz: raizTemporal });

    // --- Prueba 2: un caso limpio de principio a fin ---
    escribir();
    escribir("== Prueba 2: un caso limpio (sol-001) ==");
    const limpio = crearSesion("humo-limpio");
    const respuesta2 = await turno(agente, limpio, "Procesa la solicitud sol-001");
    comprobar(
      "El agente creó la OC de sol-001",
      respuesta2.toolCalls.some((t) => t.herramienta === "oc_crear" && t.ok),
      "no llegó a crear la OC; revisa lo que respondió arriba",
    );
    comprobar("No quedó nada pendiente", !respuesta2.needsConfirmation);

    // --- Prueba 3 (opcional): la confirmación humana ---
    if (completo) {
      escribir();
      escribir("== Prueba 3: confirmación humana (sol-004) ==");
      const conDudas = crearSesion("humo-confirmacion");
      const pregunta = await turno(
        agente,
        conDudas,
        "Procesa la solicitud sol-004. Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.",
      );
      comprobar("Terminó con una pregunta de confirmación", pregunta.needsConfirmation, "no dejó nada pendiente de confirmar");
      comprobar("Todavía no creó la OC", !pregunta.toolCalls.some((t) => t.herramienta === "oc_crear" && t.ok));

      escribir();
      const confirmada = await turno(agente, conDudas, "Confirmo");
      comprobar(
        "Con 'Confirmo' la OC se creó, confirmada por el usuario",
        confirmada.toolCalls.some((t) => t.herramienta === "oc_crear" && t.ok && t.confirmadoPorUsuario),
        "el modelo no volvió a llamar a oc_crear tras la confirmación",
      );
    }
  } finally {
    rmSync(raizTemporal, { recursive: true, force: true });
  }

  escribir();
  escribir(`RESULTADO: ${correctas} de ${total} comprobaciones correctas.`);
  escribir("Mira los tokens de cada turno: sirven para estimar el costo por caso.");
  return correctas === total ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await ejecutarPrueba());
}
