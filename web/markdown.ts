// =====================================================================
// markdown.ts — Un convertidor de Markdown mínimo para las respuestas del agente.
//
// El agente responde con negritas, listas y código en línea. Este archivo
// las convierte en una estructura de datos (no en HTML): la pantalla la
// dibuja con elementos de React, que escapan cualquier texto. Así, aunque
// el modelo (o un correo malicioso) escriba "<script>", se ve como texto y
// nunca se ejecuta.
//
// Soporta: títulos (#), listas con viñetas (-, *) y numeradas (1.), párrafos,
// **negrita** y `código`. Todo lo demás se muestra tal cual.
// =====================================================================

export type Segmento = { tipo: "texto" | "negrita" | "codigo"; texto: string };

export type Bloque =
  | { tipo: "titulo"; segmentos: Segmento[] }
  | { tipo: "parrafo"; lineas: Segmento[][] }
  | { tipo: "lista"; ordenada: boolean; items: Segmento[][] };

// ---------------------------------------------------------------------
// BLOQUE 1 — Dentro de una línea: **negrita** y `código`
// ---------------------------------------------------------------------

export function parsearEnLinea(texto: string): Segmento[] {
  const segmentos: Segmento[] = [];
  // Al dividir con un grupo de captura, los trozos con formato quedan en las posiciones impares
  for (const trozo of texto.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (trozo === "") continue;
    if (trozo.startsWith("**") && trozo.endsWith("**") && trozo.length > 4) {
      segmentos.push({ tipo: "negrita", texto: trozo.slice(2, -2) });
    } else if (trozo.startsWith("`") && trozo.endsWith("`") && trozo.length > 2) {
      segmentos.push({ tipo: "codigo", texto: trozo.slice(1, -1) });
    } else {
      segmentos.push({ tipo: "texto", texto: trozo });
    }
  }
  return segmentos;
}

// ---------------------------------------------------------------------
// BLOQUE 2 — Bloques: títulos, listas y párrafos
// ---------------------------------------------------------------------

const TITULO = /^#{1,6}\s+(.*)$/;
const VINETA = /^\s*[-*•]\s+(.*)$/;
const NUMERADA = /^\s*\d+[.)]\s+(.*)$/;
const CONTINUACION = /^\s{2,}\S/; // una línea con sangría, que sigue al elemento de lista anterior

export function parsearMarkdown(texto: string): Bloque[] {
  const bloques: Bloque[] = [];
  let parrafo: string[] = [];
  let lista: { ordenada: boolean; items: string[] } | null = null;

  const cerrarParrafo = (): void => {
    if (parrafo.length > 0) bloques.push({ tipo: "parrafo", lineas: parrafo.map(parsearEnLinea) });
    parrafo = [];
  };
  const cerrarLista = (): void => {
    if (lista !== null) bloques.push({ tipo: "lista", ordenada: lista.ordenada, items: lista.items.map(parsearEnLinea) });
    lista = null;
  };

  for (const linea of texto.replace(/\r\n/g, "\n").split("\n")) {
    // Una línea en blanco separa bloques
    if (linea.trim() === "") {
      cerrarParrafo();
      cerrarLista();
      continue;
    }

    const titulo = TITULO.exec(linea);
    if (titulo !== null) {
      cerrarParrafo();
      cerrarLista();
      bloques.push({ tipo: "titulo", segmentos: parsearEnLinea(titulo[1] ?? "") });
      continue;
    }

    const vineta = VINETA.exec(linea);
    const numerada = NUMERADA.exec(linea);
    const elemento = vineta ?? numerada;
    if (elemento !== null) {
      const ordenada = vineta === null;
      cerrarParrafo();
      // Si cambia el tipo de lista, empieza otra
      if (lista !== null && lista.ordenada !== ordenada) cerrarLista();
      lista ??= { ordenada, items: [] };
      lista.items.push(elemento[1] ?? "");
      continue;
    }

    // Una línea con sangría continúa el elemento de lista anterior
    if (lista !== null && CONTINUACION.test(linea) && lista.items.length > 0) {
      lista.items[lista.items.length - 1] += ` ${linea.trim()}`;
      continue;
    }

    cerrarLista();
    parrafo.push(linea.trim());
  }
  cerrarParrafo();
  cerrarLista();
  return bloques;
}
