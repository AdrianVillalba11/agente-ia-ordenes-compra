// =====================================================================
// evidencia-pdf.ts — La evidencia de aprobación en formato PDF.
//
// Hoy la analista imprime el correo de aprobación a PDF y lo adjunta a la
// OC. Aquí se genera ese PDF con el mismo contenido que aprobacion.txt:
// encabezados (de, para, fecha, asunto), cuerpo y el hash sha256.
//
// Se usa pdf-lib con las fuentes estándar de PDF (Helvetica y Courier),
// sin descargar ni incrustar fuentes externas.
//
// CASOS DELICADOS que este archivo cuida:
//   - DETERMINISMO: por defecto pdf-lib escribe la fecha y hora actuales
//     dentro del archivo, así que dos ejecuciones darían bytes distintos.
//     Se desactiva y se usa la fecha del correo de aprobación (que además
//     es la fecha que le importa a auditoría).
//   - Las fuentes estándar solo admiten el juego de caracteres WinAnsi
//     (tildes y ñ sí; emojis o flechas no). Un carácter no admitido se
//     reemplaza por "?" y se avisa; nunca se rompe la generación. El .txt
//     conserva siempre el texto completo.
//   - Las líneas largas se parten por palabras y, si una palabra sola no
//     cabe, por caracteres; el texto largo continúa en otra página.
// =====================================================================

import { PDFDocument, rgb, StandardFonts, type PDFFont } from "pdf-lib";
import type { Evidencia } from "./evidencia.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Medidas de la página (A4, en puntos)
// ---------------------------------------------------------------------

const ANCHO_PAGINA = 595.28;
const ALTO_PAGINA = 841.89;
const MARGEN = 56;
const TAMANO_TEXTO = 10.5;
const INTERLINEADO = 15;
const COLUMNA_VALOR = MARGEN + 52; // donde empiezan los valores de los encabezados
const GRIS = rgb(0.45, 0.45, 0.45);

export type PdfEvidencia = {
  bytes: Uint8Array;
  caracteresReemplazados: string[]; // caracteres que la fuente no admite (vacío si no hubo)
};

// ---------------------------------------------------------------------
// BLOQUE 2 — Generación
// ---------------------------------------------------------------------

export async function generarPdfEvidencia(evidencia: Evidencia): Promise<PdfEvidencia> {
  // updateMetadata: false evita que pdf-lib estampe la hora actual (rompería el determinismo)
  const documento = await PDFDocument.create({ updateMetadata: false });
  const normal = await documento.embedFont(StandardFonts.Helvetica);
  const negrita = await documento.embedFont(StandardFonts.HelveticaBold);
  const monoespaciada = await documento.embedFont(StandardFonts.Courier);

  // --- Texto: limpiar caracteres no admitidos y partir en líneas ---

  const admitidos = new Set(normal.getCharacterSet());
  const reemplazados = new Set<string>();

  // Reemplaza por "?" lo que la fuente no puede dibujar, anotándolo
  const limpiar = (texto: string): string =>
    Array.from(texto.replace(/\t/g, " "))
      .map((caracter) => {
        if (admitidos.has(caracter.codePointAt(0) ?? 0)) return caracter;
        reemplazados.add(caracter);
        return "?";
      })
      .join("");

  // Parte un texto en líneas que quepan en "ancho"; si una palabra sola no cabe, la parte por caracteres
  const dividir = (texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] => {
    const lineas: string[] = [];
    let actual = "";
    for (const palabra of texto.split(" ")) {
      const candidata = actual === "" ? palabra : `${actual} ${palabra}`;
      if (fuente.widthOfTextAtSize(candidata, tamano) <= ancho) {
        actual = candidata;
        continue;
      }
      if (actual !== "") {
        lineas.push(actual);
        actual = "";
      }
      let resto = palabra;
      while (fuente.widthOfTextAtSize(resto, tamano) > ancho) {
        let corte = resto.length;
        while (corte > 1 && fuente.widthOfTextAtSize(resto.slice(0, corte), tamano) > ancho) corte--;
        lineas.push(resto.slice(0, corte));
        resto = resto.slice(corte);
      }
      actual = resto;
    }
    lineas.push(actual);
    return lineas;
  };

  // --- Cursor: página actual y posición vertical ---

  let pagina = documento.addPage([ANCHO_PAGINA, ALTO_PAGINA]);
  let y = ALTO_PAGINA - MARGEN;

  // Baja el cursor "altura" puntos; si no hay espacio, empieza una página nueva
  const avanzar = (altura: number): void => {
    if (y - altura < MARGEN) {
      pagina = documento.addPage([ANCHO_PAGINA, ALTO_PAGINA]);
      y = ALTO_PAGINA - MARGEN;
    }
    y -= altura;
  };

  const trazarLinea = (): void => {
    pagina.drawLine({
      start: { x: MARGEN, y: y - 6 },
      end: { x: ANCHO_PAGINA - MARGEN, y: y - 6 },
      thickness: 0.5,
      color: GRIS,
    });
    avanzar(14);
  };

  // --- Contenido ---

  // Título
  avanzar(20);
  pagina.drawText("Evidencia de aprobación", { x: MARGEN, y, size: 15, font: negrita });
  avanzar(15);
  pagina.drawText("Correo de aprobación del líder adjunto a la orden de compra", {
    x: MARGEN,
    y,
    size: 9,
    font: normal,
    color: GRIS,
  });
  trazarLinea();

  // Encabezados: etiqueta en negrita y valor al lado, con sangría si se parte en varias líneas
  const { de, para, fecha, asunto } = evidencia.encabezados;
  const campos: [string, string][] = [["De:", de], ["Para:", para], ["Fecha:", fecha], ["Asunto:", asunto]];
  for (const [etiqueta, valor] of campos) {
    const lineas = dividir(limpiar(valor), normal, TAMANO_TEXTO, ANCHO_PAGINA - MARGEN - COLUMNA_VALOR);
    lineas.forEach((linea, indice) => {
      avanzar(INTERLINEADO);
      if (indice === 0) pagina.drawText(etiqueta, { x: MARGEN, y, size: TAMANO_TEXTO, font: negrita });
      pagina.drawText(linea, { x: COLUMNA_VALOR, y, size: TAMANO_TEXTO, font: normal });
    });
  }
  trazarLinea();

  // Cuerpo: cada línea del correo es un párrafo; las vacías dejan un espacio
  for (const parrafo of evidencia.cuerpo.split("\n")) {
    if (parrafo.trim() === "") {
      avanzar(INTERLINEADO);
      continue;
    }
    for (const linea of dividir(limpiar(parrafo), normal, TAMANO_TEXTO, ANCHO_PAGINA - 2 * MARGEN)) {
      avanzar(INTERLINEADO);
      pagina.drawText(linea, { x: MARGEN, y, size: TAMANO_TEXTO, font: normal });
    }
  }
  trazarLinea();

  // Huella sha256 del contenido (la misma que lleva la OC)
  avanzar(INTERLINEADO);
  pagina.drawText("Huella sha256 del contenido (la misma de aprobacion.txt):", {
    x: MARGEN,
    y,
    size: 9,
    font: negrita,
  });
  avanzar(13);
  pagina.drawText(evidencia.sha256, { x: MARGEN, y, size: 8.5, font: monoespaciada });

  // Numeración de páginas
  const paginas = documento.getPages();
  paginas.forEach((p, indice) => {
    p.drawText(`Página ${indice + 1} de ${paginas.length}`, {
      x: ANCHO_PAGINA / 2 - 35,
      y: 28,
      size: 8,
      font: normal,
      color: GRIS,
    });
  });

  // --- Metadatos: fijos, para que dos ejecuciones den exactamente el mismo archivo ---

  documento.setTitle("Evidencia de aprobación");
  documento.setAuthor(de);
  documento.setSubject(asunto);
  documento.setProducer("agente-ia-ordenes-compra");
  documento.setCreator("agente-ia-ordenes-compra");
  const fechaAprobacion = new Date(fecha);
  if (!Number.isNaN(fechaAprobacion.getTime())) {
    documento.setCreationDate(fechaAprobacion);
    documento.setModificationDate(fechaAprobacion);
  }

  return { bytes: await documento.save(), caracteresReemplazados: [...reemplazados] };
}
