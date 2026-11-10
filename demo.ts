// =====================================================================
// demo.ts — Demostración SIN modelo de lenguaje.
//
// Procesa los 6 casos de fixtures/reto-03/solicitudes/ llamando a las
// herramientas por el mismo camino que usará el agente (registro.ts), sin
// clave de ningún proveedor y sin red. Se ejecuta con:   bun run demo.ts
//
// Qué muestra:
//   - Cada caso paso a paso, con un resumen de cada herramienta.
//   - La IDEMPOTENCIA: sol-001 se pide dos veces y devuelve la misma OC.
//   - La CONFIRMACIÓN explícita: sol-004 y sol-005 piden confirmación y solo
//     se crean cuando la analista (simulada) confirma. sol-006 queda pendiente.
//   - Los GUARDARRAÍLES: ruta peligrosa, bloqueo que no se salta con
//     confirmado: true, y confirmar sin haber mostrado antes.
//   - Una tabla final y los archivos que quedan en out/.
//
// DETERMINISMO: el reloj está fijo (3 de septiembre de 2026, la fecha de
// referencia del PRD), el orden de los casos es fijo y no hay nada aleatorio:
// dos ejecuciones dejan exactamente los mismos archivos en out/.
//
// Termina con código 0 si todo salió como se esperaba y con 1 si no, así que
// también sirve como prueba de aceptación ejecutable.
// =====================================================================

import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { leerControl } from "./src/dominio/control.ts";
import type { ContextoHerramienta, Paquete, ResultadoValidacion } from "./src/esquemas.ts";
import { ejecutarHerramienta, type EjecucionHerramienta } from "./src/tools/registro.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Tipos y plan de la demo
// ---------------------------------------------------------------------

type Estado = "creada" | "bloqueada" | "pendiente";

// Lo que se espera de cada caso (la demo se autoverifica contra esto)
type Esperado = {
  apta: boolean;
  bloqueos: string[];
  confirmaciones: string[];
  retroactiva: boolean;
  estado: Estado;
  numeroOc: string | null;
};

type PlanCaso = {
  caso: string;
  confirma: boolean; // la analista simulada confirma las excepciones
  repite: boolean; // se pide crear dos veces la misma solicitud (idempotencia)
  intentoIndebido: boolean; // antes, alguien intenta confirmar sin que se haya mostrado
  esperado: Esperado;
};

const PLAN: PlanCaso[] = [
  { caso: "sol-001", confirma: false, repite: true, intentoIndebido: false,
    esperado: { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false, estado: "creada", numeroOc: "4500000001" } },
  { caso: "sol-002", confirma: false, repite: false, intentoIndebido: false,
    esperado: { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false, estado: "bloqueada", numeroOc: null } },
  { caso: "sol-003", confirma: false, repite: false, intentoIndebido: false,
    esperado: { apta: false, bloqueos: ["RC2"], confirmaciones: [], retroactiva: false, estado: "bloqueada", numeroOc: null } },
  { caso: "sol-004", confirma: true, repite: false, intentoIndebido: false,
    esperado: { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false, estado: "creada", numeroOc: "4500000002" } },
  { caso: "sol-005", confirma: true, repite: false, intentoIndebido: false,
    esperado: { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true, estado: "creada", numeroOc: "4500000003" } },
  { caso: "sol-006", confirma: false, repite: false, intentoIndebido: true,
    esperado: { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false, estado: "pendiente", numeroOc: null } },
];

// Una fila de la tabla final
export type FilaResumen = {
  caso: string;
  solicitud: string;
  apta: boolean;
  bloqueos: string[];
  confirmaciones: string[];
  retroactiva: boolean;
  estado: Estado;
  numeroOc: string | null;
  resultado: string;
};

// Una comprobación puntual (idempotencia, confirmación explícita, guardarraíles)
export type Comprobacion = { nombre: string; ok: boolean; detalle: string };

export type ResumenDemo = {
  filas: FilaResumen[];
  comprobaciones: Comprobacion[];
  diferencias: string[]; // lo que no salió como se esperaba (vacío si todo bien)
  correcto: boolean;
};

// Reloj fijo: 3 de septiembre de 2026, 3:00 p. m. en Colombia
const RELOJ_DEMO = (): Date => new Date("2026-09-03T15:00:00-05:00");

// ---------------------------------------------------------------------
// BLOQUE 2 — Limpieza de out/ (con seguridad)
// ---------------------------------------------------------------------

// Borra SOLO la carpeta out/ de este proyecto. Antes comprueba que la raíz sea
// realmente la de este proyecto (que tenga los fixtures del reto) para no borrar
// la carpeta out/ de otro lugar por equivocación.
function limpiarSalida(raiz: string): void {
  const raizAbsoluta = resolve(raiz);
  const salida = join(raizAbsoluta, "out");
  if (!existsSync(join(raizAbsoluta, "fixtures", "reto-03"))) {
    throw new Error(`La carpeta ${raizAbsoluta} no parece la raíz del proyecto (no tiene fixtures/reto-03); no se borra nada.`);
  }
  if (basename(salida) !== "out" || dirname(salida) !== raizAbsoluta) {
    throw new Error("Ruta de salida inesperada; no se borra nada.");
  }
  rmSync(salida, { recursive: true, force: true });
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Ayudantes para ejecutar y leer resultados
// ---------------------------------------------------------------------

// El "data" de una herramienta, o null si falló
function datos<T>(ejecucion: EjecucionHerramienta): T | null {
  const analizada = JSON.parse(ejecucion.respuesta) as { ok: boolean; data?: T };
  return analizada.ok && analizada.data !== undefined ? analizada.data : null;
}

// Las confirmaciones pendientes que devolvió oc_crear
function confirmacionesDe(ejecucion: EjecucionHerramienta): { codigo: string; detalle: string }[] {
  const analizada = JSON.parse(ejecucion.respuesta) as { confirmaciones?: { codigo: string; detalle: string }[] };
  return analizada.confirmaciones ?? [];
}

const codigosDe = (hallazgos: { codigo: string }[]): string[] => hallazgos.map((h) => h.codigo);
const mismos = (a: string[], b: string[]): boolean => a.join(",") === b.join(",");

// Ejecuta una herramienta, imprime el paso numerado y devuelve el resultado
function crearEjecutor(ctx: ContextoHerramienta, escribir: (linea: string) => void) {
  let paso = 0;
  return {
    reiniciar: (): void => {
      paso = 0;
    },
    ejecutar: async (nombre: string, argumentos: unknown, etiqueta: string = nombre): Promise<EjecucionHerramienta> => {
      paso++;
      const ejecucion = await ejecutarHerramienta(nombre, argumentos, ctx);
      escribir(` ${paso}. ${etiqueta.padEnd(28)} -> ${ejecucion.resumen}`);
      return ejecucion;
    },
  };
}

// ---------------------------------------------------------------------
// BLOQUE 4 — Un caso, de principio a fin
// ---------------------------------------------------------------------

type Ejecutor = ReturnType<typeof crearEjecutor>;

async function procesarCaso(
  plan: PlanCaso,
  ejecutor: Ejecutor,
  escribir: (linea: string) => void,
  comprobaciones: Comprobacion[],
): Promise<FilaResumen> {
  const { caso } = plan;
  escribir("");
  escribir(`== ${caso} ${"=".repeat(64 - caso.length)}`);
  ejecutor.reiniciar();

  // 1 y 2. Leer el paquete y validarlo contra los maestros
  const leido = await ejecutor.ejecutar("oc_leer_paquete", { caso });
  const paquete = datos<Paquete>(leido);
  const validado = await ejecutor.ejecutar("oc_validar", { caso });
  const validacion = datos<ResultadoValidacion>(validado);

  // 3 y 4. Con un caso sin bloqueos se arma la OC y se genera su evidencia
  if (validacion?.apta === true) {
    await ejecutor.ejecutar("oc_construir_payload", { caso });
    await ejecutor.ejecutar("oc_generar_evidencia", { caso });
  }

  // Un intento indebido: alguien confirma sin que se haya mostrado nada
  if (plan.intentoIndebido) {
    const indebido = await ejecutor.ejecutar("oc_crear", { caso, confirmado: true }, "oc_crear (sin mostrar)");
    const rechazado = !indebido.ok && indebido.requiereConfirmacion && (indebido.error ?? "").includes("aún no se mostró");
    escribir("    ^ Alguien intenta confirmar sin que se haya mostrado la duda. La herramienta responde:");
    escribir(`      "${(indebido.error ?? "").split("\n")[0] ?? ""}"`);
    comprobaciones.push({
      nombre: "Confirmar sin haberlo mostrado se rechaza",
      ok: rechazado,
      detalle: rechazado ? "No se puede confirmar algo que aún no se mostró" : "NO se rechazó",
    });
  }

  // 5. Crear la OC
  let creacion = await ejecutor.ejecutar("oc_crear", { caso });

  // Si hay dudas, se muestran; la analista (simulada) confirma o la OC queda pendiente
  if (creacion.requiereConfirmacion) {
    const pendientes = confirmacionesDe(creacion);
    for (const pendiente of pendientes) escribir(`    ${pendiente.codigo}: ${pendiente.detalle}`);

    if (plan.confirma) {
      escribir(`    [analista simulada] "Confirmo crear la OC con estas excepciones: ${codigosDe(pendientes).join(", ")}."`);
      creacion = await ejecutor.ejecutar("oc_crear", { caso, confirmado: true }, "oc_crear (confirmado)");
      if (caso === "sol-004") {
        comprobaciones.push({
          nombre: "Confirmación explícita (sol-004): primero pide, luego crea",
          ok: creacion.ok,
          detalle: creacion.resumen,
        });
      }
    } else {
      escribir("    La analista no responde todavía: la OC queda pendiente y no se crea nada.");
    }
  }

  // Idempotencia: pedir otra vez la misma solicitud devuelve la misma OC
  if (plan.repite && creacion.ok) {
    escribir("    -- se pide crear la misma solicitud otra vez --");
    const repetida = await ejecutor.ejecutar("oc_crear", { caso }, "oc_crear (otra vez)");
    const primera = datos<{ numero_oc: string }>(creacion);
    const segunda = datos<{ numero_oc: string; idempotente: boolean }>(repetida);
    comprobaciones.push({
      nombre: "Idempotencia (sol-001 dos veces): misma OC, sin duplicar",
      ok: primera !== null && segunda !== null && segunda.numero_oc === primera.numero_oc && segunda.idempotente,
      detalle: repetida.resumen,
    });
  }

  // Fila de la tabla final
  const estado: Estado = creacion.ok ? "creada" : creacion.requiereConfirmacion ? "pendiente" : "bloqueada";
  const numeroOc = creacion.ok ? (datos<{ numero_oc: string }>(creacion)?.numero_oc ?? null) : null;
  const confirmaciones = codigosDe(validacion?.confirmaciones ?? []);
  const resultado =
    estado === "creada"
      ? `OC ${numeroOc ?? "?"} creada`
      : estado === "pendiente"
        ? `Pendiente de confirmación: ${confirmaciones.join(", ")}`
        : creacion.resumen;

  return {
    caso,
    solicitud: paquete?.solicitud.solicitud_id ?? "?",
    apta: validacion?.apta ?? false,
    bloqueos: codigosDe(validacion?.bloqueos ?? []),
    confirmaciones,
    retroactiva: validacion?.retroactiva ?? false,
    estado,
    numeroOc,
    resultado,
  };
}

// ---------------------------------------------------------------------
// BLOQUE 5 — Guardarraíles que no dependen de ningún caso en particular
// ---------------------------------------------------------------------

async function comprobarGuardarrailes(ejecutor: Ejecutor, escribir: (linea: string) => void, comprobaciones: Comprobacion[]): Promise<void> {
  escribir("");
  escribir(`== Guardarraíles ${"=".repeat(49)}`);
  ejecutor.reiniciar();

  // Una ruta fuera de los fixtures no se puede leer
  const ruta = await ejecutor.ejecutar("oc_leer_paquete", { caso: "../../.env" }, "oc_leer_paquete (ruta mala)");
  comprobaciones.push({ nombre: "Una ruta peligrosa se rechaza", ok: !ruta.ok, detalle: ruta.resumen });

  // Confirmar no salta un bloqueo
  const bloqueo = await ejecutor.ejecutar("oc_crear", { caso: "sol-002", confirmado: true }, "oc_crear (confirmado)");
  comprobaciones.push({
    nombre: "Un bloqueo no se salta con confirmado: true",
    ok: !bloqueo.ok && !bloqueo.requiereConfirmacion && bloqueo.resumen.startsWith("Bloqueada"),
    detalle: bloqueo.resumen,
  });
}

// ---------------------------------------------------------------------
// BLOQUE 6 — Presentación: tabla y archivos generados
// ---------------------------------------------------------------------

function imprimirTabla(filas: FilaResumen[], escribir: (linea: string) => void): void {
  const sino = (valor: boolean): string => (valor ? "sí" : "no");
  const lista = (codigos: string[]): string => (codigos.length === 0 ? "-" : codigos.join(", "));
  const encabezados = ["Caso", "Solicitud", "Apta", "Bloqueos", "Confirmaciones", "Retroactiva", "Resultado"];
  const cuerpo = filas.map((f) => [f.caso, f.solicitud, sino(f.apta), lista(f.bloqueos), lista(f.confirmaciones), sino(f.retroactiva), f.resultado]);
  const anchos = encabezados.map((titulo, i) => Math.max(titulo.length, ...cuerpo.map((fila) => (fila[i] ?? "").length)));
  const linea = (celdas: string[]): string => celdas.map((celda, i) => celda.padEnd(anchos[i] ?? 0)).join("  ").trimEnd();

  escribir(linea(encabezados));
  escribir(linea(anchos.map((ancho) => "-".repeat(ancho))));
  for (const fila of cuerpo) escribir(linea(fila));
}

function contarLineas(ruta: string): number {
  if (!existsSync(ruta)) return 0;
  return readFileSync(ruta, "utf-8").split("\n").filter((linea) => linea.trim() !== "").length;
}

function imprimirArchivos(raiz: string, escribir: (linea: string) => void): void {
  escribir("Archivos generados en out/ (ábrelos para ver el detalle):");
  escribir(`  out/sap/ordenes.jsonl   ${contarLineas(join(raiz, "out", "sap", "ordenes.jsonl"))} órdenes en el SAP simulado`);
  escribir(`  out/control.csv         ${leerControl(raiz).length} intentos registrados (creada, ya_existente, bloqueada, pendiente)`);
  escribir(`  out/log.jsonl           ${contarLineas(join(raiz, "out", "log.jsonl"))} llamadas a herramientas`);
  escribir("  out/sol-00X/            evidencia de aprobación (txt y pdf) y trazabilidad de cada OC armada");
}

// ---------------------------------------------------------------------
// BLOQUE 7 — La demo completa
// ---------------------------------------------------------------------

// Ejecuta toda la demo sobre la carpeta "raiz" del proyecto. "escribir" recibe cada línea
// de salida (por defecto, la consola); así la demo también se puede probar.
export async function ejecutarDemo(raiz: string, escribir: (linea: string) => void = console.log): Promise<ResumenDemo> {
  const raizAbsoluta = resolve(raiz);
  limpiarSalida(raizAbsoluta);

  escribir("DEMO sin modelo de lenguaje - Reto 3: Órdenes de compra en SAP");
  escribir("Fecha simulada: 2026-09-03 (reloj fijo: el resultado es idéntico en cada ejecución)");
  escribir("La carpeta out/ se limpió y se regenera desde cero.");

  const ctx: ContextoHerramienta = { directory: raizAbsoluta, sessionId: "demo", ahora: RELOJ_DEMO };
  const ejecutor = crearEjecutor(ctx, escribir);
  const comprobaciones: Comprobacion[] = [];
  const filas: FilaResumen[] = [];

  for (const plan of PLAN) filas.push(await procesarCaso(plan, ejecutor, escribir, comprobaciones));
  await comprobarGuardarrailes(ejecutor, escribir, comprobaciones);

  // Tabla final
  escribir("");
  escribir(`== Resumen ${"=".repeat(55)}`);
  imprimirTabla(filas, escribir);
  escribir("");
  imprimirArchivos(raizAbsoluta, escribir);

  // Autoverificación: cada caso contra lo esperado, y cada comprobación
  const diferencias: string[] = [];
  for (const plan of PLAN) {
    const fila = filas.find((f) => f.caso === plan.caso);
    const e = plan.esperado;
    if (fila === undefined) {
      diferencias.push(`${plan.caso}: no se procesó`);
      continue;
    }
    if (fila.apta !== e.apta) diferencias.push(`${plan.caso}: se esperaba apta=${e.apta} y fue ${fila.apta}`);
    if (!mismos(fila.bloqueos, e.bloqueos)) diferencias.push(`${plan.caso}: bloqueos ${fila.bloqueos.join(",") || "-"} en vez de ${e.bloqueos.join(",") || "-"}`);
    if (!mismos(fila.confirmaciones, e.confirmaciones)) diferencias.push(`${plan.caso}: confirmaciones ${fila.confirmaciones.join(",") || "-"} en vez de ${e.confirmaciones.join(",") || "-"}`);
    if (fila.retroactiva !== e.retroactiva) diferencias.push(`${plan.caso}: retroactiva=${fila.retroactiva} en vez de ${e.retroactiva}`);
    if (fila.estado !== e.estado) diferencias.push(`${plan.caso}: estado ${fila.estado} en vez de ${e.estado}`);
    if (fila.numeroOc !== e.numeroOc) diferencias.push(`${plan.caso}: OC ${fila.numeroOc ?? "ninguna"} en vez de ${e.numeroOc ?? "ninguna"}`);
  }
  for (const comprobacion of comprobaciones) {
    if (!comprobacion.ok) diferencias.push(`Comprobación fallida: ${comprobacion.nombre} (${comprobacion.detalle})`);
  }

  const casosBien = PLAN.length - new Set(diferencias.map((d) => d.split(":")[0])).size;
  const comprobacionesBien = comprobaciones.filter((c) => c.ok).length;
  escribir("");
  escribir("Comprobaciones:");
  for (const c of comprobaciones) escribir(`  [${c.ok ? "OK" : "FALLA"}] ${c.nombre}`);
  escribir("");
  if (diferencias.length === 0) {
    escribir(`RESULTADO: ${PLAN.length} de ${PLAN.length} casos como se esperaba; ${comprobacionesBien} de ${comprobaciones.length} comprobaciones correctas.`);
  } else {
    escribir(`RESULTADO: HAY DIFERENCIAS (${casosBien} de ${PLAN.length} casos bien):`);
    for (const diferencia of diferencias) escribir(`  - ${diferencia}`);
  }

  return { filas, comprobaciones, diferencias, correcto: diferencias.length === 0 };
}

// ---------------------------------------------------------------------
// BLOQUE 8 — Ejecución desde la terminal
// ---------------------------------------------------------------------

if (import.meta.main) {
  const resumen = await ejecutarDemo(import.meta.dir);
  process.exit(resumen.correcto ? 0 : 1);
}
