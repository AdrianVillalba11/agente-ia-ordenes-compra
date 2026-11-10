// =====================================================================
// evidencia.ts — Evidencia de la aprobación del líder.
//
// Auditoría necesita el correo de aprobación como evidencia adjunta a la
// OC. Aquí se construye su texto (encabezados + cuerpo) y se calcula su
// sha256, una "huella" que cambia si alguien modifica una sola letra.
//
// El cálculo es DETERMINISTA y vive aquí porque lo usan dos herramientas:
//   - oc_construir_payload pone el sha256 dentro de la OC.
//   - oc_generar_evidencia escribe el archivo con ese mismo texto.
// Así el hash de la OC y el del archivo siempre coinciden.
//
// CASOS DELICADOS que este archivo cuida:
//   - El hash se calcula solo sobre el contenido (encabezados + cuerpo),
//     nunca sobre la línea del propio hash.
//   - Los saltos de línea se normalizan a "\n" para que el hash sea el
//     mismo en Windows, Mac y Linux.
// =====================================================================

import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Resultado } from "../esquemas.ts";
import { leerJsonValidado } from "./archivos.ts";
import { NOMBRE_CASO_VALIDO, RUTA_SOLICITUDES } from "./paquete.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Forma del resultado y del archivo de aprobación
// ---------------------------------------------------------------------

export type Evidencia = {
  texto: string; // lo que se escribe en aprobacion.txt (contenido + línea del hash)
  sha256: string; // hash del contenido, en hexadecimal
  // Las partes por separado, para que el PDF pueda darles formato
  encabezados: { de: string; para: string; fecha: string; asunto: string };
  cuerpo: string;
};

// Campos de aprobacion.json que forman la evidencia (el PRD pide de, para, fecha, asunto y cuerpo)
const EsquemaAprobacionCompleta = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Hash
// ---------------------------------------------------------------------

// sha256 en hexadecimal de un texto, tomado como UTF-8
export function calcularSha256(contenido: string): string {
  return createHash("sha256").update(contenido, "utf8").digest("hex");
}

// ---------------------------------------------------------------------
// BLOQUE 2B — Comprobar una evidencia ya escrita
// ---------------------------------------------------------------------

// Texto que separa el contenido de la línea del hash en aprobacion.txt
export const SEPARADOR_HASH = "\n\n---\nsha256: ";

// ¿El archivo aprobacion.txt es íntegro y corresponde a este hash?
// Se recalcula el hash del contenido que está en el archivo: si alguien cambió una
// letra, o el archivo es de otra aprobación, no coincide. Se tolera que el archivo
// haya sido guardado con saltos de línea de Windows.
export function evidenciaCoincide(textoArchivo: string, shaEsperado: string): boolean {
  const normalizado = textoArchivo.replace(/\r\n/g, "\n");
  const indice = normalizado.lastIndexOf(SEPARADOR_HASH);
  if (indice === -1) return false;

  const contenido = normalizado.slice(0, indice);
  const declarado = normalizado.slice(indice + SEPARADOR_HASH.length).trim();
  return calcularSha256(contenido) === shaEsperado && declarado === shaEsperado;
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Construcción de la evidencia
// ---------------------------------------------------------------------

// Lee aprobacion.json del caso y devuelve el texto de la evidencia y su hash.
// Nunca lanza: si el caso es inválido o falta la aprobación, devuelve un error.
export function construirEvidencia(caso: string, raizProyecto: string): Resultado<Evidencia> {
  if (!NOMBRE_CASO_VALIDO.test(caso)) {
    return { ok: false, error: `Nombre de caso inválido: "${caso}". Solo se permiten letras, números y guiones.` };
  }

  const carpeta = join(raizProyecto, RUTA_SOLICITUDES, caso);
  const aprobacion = leerJsonValidado(carpeta, "aprobacion.json", EsquemaAprobacionCompleta);
  if (!aprobacion.ok) return { ok: false, error: `No se puede generar la evidencia: ${aprobacion.error}` };

  const { de, para, fecha, asunto, cuerpo } = aprobacion.data;

  // Contenido que se firma con el hash: encabezados, una línea en blanco y el cuerpo.
  // Se normalizan los saltos de línea para que el hash no dependa del sistema operativo.
  const contenido = [`De: ${de}`, `Para: ${para}`, `Fecha: ${fecha}`, `Asunto: ${asunto}`, "", cuerpo]
    .join("\n")
    .replace(/\r\n/g, "\n");

  const sha256 = calcularSha256(contenido);
  return {
    ok: true,
    data: {
      texto: `${contenido}\n\n---\nsha256: ${sha256}\n`,
      sha256,
      encabezados: { de, para, fecha, asunto },
      cuerpo: cuerpo.replace(/\r\n/g, "\n"),
    },
  };
}
