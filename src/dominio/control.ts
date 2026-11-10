// =====================================================================
// control.ts — Registro de control de cada intento de crear una OC.
//
// Contabilidad y auditoría consumen out/control.csv: una fila por cada
// intento (creada, ya existente, bloqueada o pendiente de confirmación),
// con las columnas que fija el PRD:
//   solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts
// Es aquí donde queda medida la compra retroactiva que quiere ver la dirección.
//
// También sirve de memoria de las confirmaciones pendientes: oc_crear solo
// acepta una confirmación si antes se mostró (se registró como pendiente).
//
// CASOS DELICADOS que este archivo cuida:
//   - Los textos con comas o comillas se escapan al escribir y se leen igual.
//   - Una línea dañada se ignora al leer: en el peor caso no cuenta como
//     "pendiente" y se vuelve a pedir la confirmación (falla del lado seguro).
// =====================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------
// BLOQUE 1 — Tipos y formato del archivo
// ---------------------------------------------------------------------

export type ResultadoControl = "creada" | "ya_existente" | "bloqueada" | "pendiente_confirmacion";

export type FilaControl = {
  solicitud_id: string;
  resultado: ResultadoControl;
  numero_oc: string | null;
  retroactiva: boolean;
  bloqueos: string[]; // códigos de regla, por ejemplo ["RC1"]
  confirmaciones: string[]; // códigos de regla, por ejemplo ["RC5"]
  ts: string; // fecha y hora ISO del intento
};

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts";
const RESULTADOS: ResultadoControl[] = ["creada", "ya_existente", "bloqueada", "pendiente_confirmacion"];

function rutaControl(raizProyecto: string): string {
  return join(raizProyecto, "out", "control.csv");
}

// ---------------------------------------------------------------------
// BLOQUE 2 — CSV: escapar y dividir líneas
// ---------------------------------------------------------------------

// Un valor con coma, comilla o salto de línea va entre comillas, y sus comillas se duplican
export function escaparCsv(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

// Divide una línea CSV en campos respetando las comillas
export function dividirLineaCsv(linea: string): string[] {
  const campos: string[] = [];
  let actual = "";
  let entreComillas = false;

  for (let i = 0; i < linea.length; i++) {
    const caracter = linea.charAt(i);
    if (entreComillas) {
      if (caracter === '"' && linea.charAt(i + 1) === '"') {
        actual += '"'; // comilla duplicada = una comilla
        i++;
      } else if (caracter === '"') {
        entreComillas = false;
      } else {
        actual += caracter;
      }
    } else if (caracter === '"') {
      entreComillas = true;
    } else if (caracter === ",") {
      campos.push(actual);
      actual = "";
    } else {
      actual += caracter;
    }
  }
  campos.push(actual);
  return campos;
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Escribir y leer el registro
// ---------------------------------------------------------------------

// Agrega una fila al final de out/control.csv (con encabezado si el archivo es nuevo)
export function registrarControl(raizProyecto: string, fila: FilaControl): void {
  const ruta = rutaControl(raizProyecto);
  mkdirSync(dirname(ruta), { recursive: true });

  const campos = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join(";"),
    fila.confirmaciones.join(";"),
    fila.ts,
  ];
  const linea = campos.map(escaparCsv).join(",");
  // Encabezado y fila se escriben en una sola operación
  appendFileSync(ruta, `${existsSync(ruta) ? "" : `${ENCABEZADO}\n`}${linea}\n`, "utf-8");
}

// Lee todas las filas válidas; ignora el encabezado y las líneas dañadas
export function leerControl(raizProyecto: string): FilaControl[] {
  const ruta = rutaControl(raizProyecto);
  if (!existsSync(ruta)) return [];

  const filas: FilaControl[] = [];
  for (const linea of readFileSync(ruta, "utf-8").split("\n")) {
    const limpia = linea.replace(/\r$/, "");
    if (limpia === "" || limpia === ENCABEZADO) continue;

    const campos = dividirLineaCsv(limpia);
    const [solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts] = campos;
    const resultadoValido = RESULTADOS.find((r) => r === resultado);
    if (
      campos.length !== 7 ||
      solicitud_id === undefined ||
      resultadoValido === undefined ||
      (retroactiva !== "true" && retroactiva !== "false") ||
      ts === undefined
    ) {
      continue; // línea dañada: no cuenta
    }
    filas.push({
      solicitud_id,
      resultado: resultadoValido,
      numero_oc: numero_oc === undefined || numero_oc === "" ? null : numero_oc,
      retroactiva: retroactiva === "true",
      bloqueos: bloqueos === undefined || bloqueos === "" ? [] : bloqueos.split(";"),
      confirmaciones: confirmaciones === undefined || confirmaciones === "" ? [] : confirmaciones.split(";"),
      ts,
    });
  }
  return filas;
}

// ---------------------------------------------------------------------
// BLOQUE 4 — ¿Se mostró ya esta confirmación?
// ---------------------------------------------------------------------

// ¿Hay un intento anterior de esta solicitud que quedó pendiente con EXACTAMENTE
// estas confirmaciones (en cualquier orden)? Solo entonces se puede confirmar:
// no se puede aceptar algo que antes no se mostró.
export function hayPendienteIgual(raizProyecto: string, solicitud_id: string, confirmaciones: string[]): boolean {
  const clave = (codigos: string[]): string => [...codigos].sort().join(";");
  return leerControl(raizProyecto).some(
    (fila) =>
      fila.solicitud_id === solicitud_id &&
      fila.resultado === "pendiente_confirmacion" &&
      clave(fila.confirmaciones) === clave(confirmaciones),
  );
}
