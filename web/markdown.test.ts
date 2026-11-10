// =====================================================================
// markdown.test.ts — Pruebas del convertidor de Markdown del chat.
//
// Se prueba con respuestas como las que da el agente, y sobre todo que
// nada se interprete como HTML.
// Se ejecutan con: bun test
// =====================================================================

import { describe, expect, test } from "bun:test";
import { parsearEnLinea, parsearMarkdown } from "./markdown.ts";

describe("parsearEnLinea", () => {
  test("texto sin formato", () => {
    expect(parsearEnLinea("Hola mundo")).toEqual([{ tipo: "texto", texto: "Hola mundo" }]);
  });

  test("negrita y código en medio de una frase", () => {
    expect(parsearEnLinea("La **OC 4500000002** quedó en `out/sap` hoy")).toEqual([
      { tipo: "texto", texto: "La " },
      { tipo: "negrita", texto: "OC 4500000002" },
      { tipo: "texto", texto: " quedó en " },
      { tipo: "codigo", texto: "out/sap" },
      { tipo: "texto", texto: " hoy" },
    ]);
  });

  test("varias negritas seguidas", () => {
    expect(parsearEnLinea("**RC1** y **RC2**")).toEqual([
      { tipo: "negrita", texto: "RC1" },
      { tipo: "texto", texto: " y " },
      { tipo: "negrita", texto: "RC2" },
    ]);
  });

  test("los asteriscos o comillas invertidas sueltos se muestran tal cual", () => {
    expect(parsearEnLinea("2 * 3 = 6 y **sin cerrar")).toEqual([{ tipo: "texto", texto: "2 * 3 = 6 y **sin cerrar" }]);
    expect(parsearEnLinea("una ` suelta")).toEqual([{ tipo: "texto", texto: "una ` suelta" }]);
    expect(parsearEnLinea("****")).toEqual([{ tipo: "texto", texto: "****" }]);
  });

  test("una línea vacía no da segmentos", () => {
    expect(parsearEnLinea("")).toEqual([]);
  });
});

describe("parsearMarkdown", () => {
  test("una respuesta típica del agente: resultado, lista de controles y un aviso", () => {
    const respuesta = [
      "**Resultado**: OC 4500000002 creada.",
      "",
      "**Controles**:",
      "- **RC1**: el proveedor existe y está activo.",
      "- **RC5**: la cotización difiere en 6,0 %.",
      "",
      "Recuerda que el precio incluye IVA.",
    ].join("\n");

    expect(parsearMarkdown(respuesta)).toEqual([
      {
        tipo: "parrafo",
        lineas: [
          [
            { tipo: "negrita", texto: "Resultado" },
            { tipo: "texto", texto: ": OC 4500000002 creada." },
          ],
        ],
      },
      { tipo: "parrafo", lineas: [[{ tipo: "negrita", texto: "Controles" }, { tipo: "texto", texto: ":" }]] },
      {
        tipo: "lista",
        ordenada: false,
        items: [
          [{ tipo: "negrita", texto: "RC1" }, { tipo: "texto", texto: ": el proveedor existe y está activo." }],
          [{ tipo: "negrita", texto: "RC5" }, { tipo: "texto", texto: ": la cotización difiere en 6,0 %." }],
        ],
      },
      { tipo: "parrafo", lineas: [[{ tipo: "texto", texto: "Recuerda que el precio incluye IVA." }]] },
    ]);
  });

  test("listas con guion, con asterisco y con viñeta", () => {
    for (const marca of ["-", "*", "•"]) {
      const [bloque] = parsearMarkdown(`${marca} uno\n${marca} dos`);
      expect(bloque).toEqual({ tipo: "lista", ordenada: false, items: [[{ tipo: "texto", texto: "uno" }], [{ tipo: "texto", texto: "dos" }]] });
    }
  });

  test("lista numerada", () => {
    expect(parsearMarkdown("1. primero\n2. segundo\n3) tercero")).toEqual([
      {
        tipo: "lista",
        ordenada: true,
        items: [[{ tipo: "texto", texto: "primero" }], [{ tipo: "texto", texto: "segundo" }], [{ tipo: "texto", texto: "tercero" }]],
      },
    ]);
  });

  test("cambiar de viñetas a números empieza otra lista", () => {
    const bloques = parsearMarkdown("- a\n- b\n1. c");
    expect(bloques.map((b) => (b.tipo === "lista" ? b.ordenada : b.tipo))).toEqual([false, true]);
  });

  test("una línea con sangría continúa el elemento de la lista", () => {
    expect(parsearMarkdown("- Acción sugerida:\n  pedir el alta del proveedor")).toEqual([
      { tipo: "lista", ordenada: false, items: [[{ tipo: "texto", texto: "Acción sugerida: pedir el alta del proveedor" }]] },
    ]);
  });

  test("los títulos se reconocen con cualquier cantidad de #", () => {
    expect(parsearMarkdown("## Controles")[0]).toEqual({ tipo: "titulo", segmentos: [{ tipo: "texto", texto: "Controles" }] });
    expect(parsearMarkdown("# **Uno**")[0]).toEqual({ tipo: "titulo", segmentos: [{ tipo: "negrita", texto: "Uno" }] });
  });

  test("un párrafo de varias líneas conserva sus saltos; la línea en blanco separa párrafos", () => {
    const bloques = parsearMarkdown("línea uno\nlínea dos\n\notro párrafo");
    expect(bloques).toHaveLength(2);
    expect(bloques[0]).toMatchObject({ tipo: "parrafo", lineas: [[{ texto: "línea uno" }], [{ texto: "línea dos" }]] });
  });

  test("un texto vacío o de solo espacios no da bloques", () => {
    expect(parsearMarkdown("")).toEqual([]);
    expect(parsearMarkdown("  \n \n")).toEqual([]);
  });

  test("los saltos de línea de Windows no se notan", () => {
    expect(parsearMarkdown("- a\r\n- b")).toEqual(parsearMarkdown("- a\n- b"));
  });

  test("NADA se interpreta como HTML: las etiquetas quedan como texto plano", () => {
    const malicioso = '<script>alert("x")</script> y <img src=x onerror=alert(1)> y [enlace](javascript:alert(1))';
    const [bloque] = parsearMarkdown(malicioso);
    expect(bloque).toEqual({ tipo: "parrafo", lineas: [[{ tipo: "texto", texto: malicioso }]] });

    // Y dentro de una negrita o de código también es texto
    expect(parsearEnLinea("**<b>hola</b>**")).toEqual([{ tipo: "negrita", texto: "<b>hola</b>" }]);
    expect(parsearEnLinea("`<script>`")).toEqual([{ tipo: "codigo", texto: "<script>" }]);
  });
});
