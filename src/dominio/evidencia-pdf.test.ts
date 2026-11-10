// =====================================================================
// evidencia-pdf.test.ts — Pruebas del PDF de evidencia y de la
// herramienta oc_generar_evidencia.
//
// El texto de un PDF se lee desde la prueba: pdf-lib guarda cada línea
// como una cadena hexadecimal dentro de un flujo comprimido, y se
// recupera descomprimiendo (ver textoDelPdf).
// Las pruebas de la herramienta trabajan sobre una copia temporal de los
// fixtures, porque escriben en out/.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { construir_payload, generar_evidencia } from "../tools/oc.ts";
import { calcularSha256, construirEvidencia, type Evidencia } from "./evidencia.ts";
import { generarPdfEvidencia } from "./evidencia-pdf.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");
const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];
const SHA_SOL_001 = "c2466ccea16832330e65da51f26e0ea7c55d8ec9ae10fc3497cb81cfcad4555e";
const SEPARADOR_HASH = "\n\n---\nsha256: ";

function evidenciaDe(caso: string): Evidencia {
  const resultado = construirEvidencia(caso, RAIZ);
  if (!resultado.ok) throw new Error(resultado.error);
  return resultado.data;
}

// Recupera el texto de un PDF: descomprime sus flujos y lee las cadenas hexadecimales
// de las instrucciones "Tj" (cada una es una línea dibujada). Las fuentes estándar
// usan la codificación WinAnsi, que para tildes y ñ coincide con latin1.
function textoDelPdf(bytes: Uint8Array): string {
  const crudo = Buffer.from(bytes).toString("latin1");
  const lineas: string[] = [];
  for (const flujo of crudo.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let contenido: string;
    try {
      contenido = inflateSync(Buffer.from(flujo[1] ?? "", "latin1")).toString("latin1");
    } catch {
      continue; // no todos los flujos son de contenido de página
    }
    for (const cadena of contenido.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      lineas.push(Buffer.from(cadena[1] ?? "", "hex").toString("latin1"));
    }
  }
  return lineas.join("\n");
}

const raicesTemporales: string[] = [];

// Copia de los fixtures en una carpeta temporal, para pruebas que escriben en out/
function copiarFixtures(): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-evidencia-"));
  raicesTemporales.push(raiz);
  cpSync(join(RAIZ, "fixtures"), join(raiz, "fixtures"), { recursive: true });
  return raiz;
}

// Copia temporal donde el cuerpo de la aprobación de sol-001 es el indicado
function conCuerpoDeAprobacion(cuerpo: string): string {
  const raiz = copiarFixtures();
  const ruta = join(raiz, "fixtures", "reto-03", "solicitudes", "sol-001", "aprobacion.json");
  const original = JSON.parse(readFileSync(ruta, "utf-8")) as Record<string, unknown>;
  writeFileSync(ruta, JSON.stringify({ ...original, cuerpo }));
  return raiz;
}

afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — El PDF de la evidencia
// ---------------------------------------------------------------------

describe("generarPdfEvidencia", () => {
  test("sol-001: un PDF válido de una página con todos los datos", async () => {
    const { bytes, caracteresReemplazados } = await generarPdfEvidencia(evidenciaDe("sol-001"));

    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(caracteresReemplazados).toEqual([]);

    const documento = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(documento.getPageCount()).toBe(1);

    const texto = textoDelPdf(bytes);
    expect(texto).toContain("Evidencia de aprobación");
    expect(texto).toContain("mlopez@periferia-ficticia.com");
    expect(texto).toContain("juan.camargo@periferia-ficticia.com");
    expect(texto).toContain("2026-08-21T10:02:00-05:00");
    expect(texto).toContain("RE: Solicitud de orden de compra SOL-001");
    expect(texto).toContain("Aprobado, proceder con la orden de compra.");
    expect(texto).toContain("Mariana López"); // la tilde se conserva
    expect(texto).toContain(SHA_SOL_001);
    expect(texto).toContain("Página 1 de 1");
  });

  test("los 6 casos reales generan un PDF con su remitente, su cuerpo y su hash", async () => {
    for (const caso of CASOS) {
      const evidencia = evidenciaDe(caso);
      const texto = textoDelPdf((await generarPdfEvidencia(evidencia)).bytes);
      expect(texto).toContain(evidencia.encabezados.de);
      // El comienzo de la primera línea del cuerpo (cada línea del correo es una línea del PDF)
      const primeraLinea = evidencia.cuerpo.split("\n")[0] ?? "";
      expect(primeraLinea.length).toBeGreaterThan(0);
      expect(texto).toContain(primeraLinea.slice(0, 20));
      expect(texto).toContain(evidencia.sha256);
    }
  });

  test("es determinista: dos generaciones dan exactamente los mismos bytes", async () => {
    const evidencia = evidenciaDe("sol-004");
    const primero = await generarPdfEvidencia(evidencia);
    const segundo = await generarPdfEvidencia(evidencia);
    expect(Buffer.from(primero.bytes).equals(Buffer.from(segundo.bytes))).toBe(true);
  });

  test("la fecha del documento es la del correo de aprobación, no la actual", async () => {
    const { bytes } = await generarPdfEvidencia(evidenciaDe("sol-001"));
    const documento = await PDFDocument.load(bytes, { updateMetadata: false });
    const esperada = Date.parse("2026-08-21T10:02:00-05:00");

    expect(documento.getCreationDate()?.getTime()).toBe(esperada);
    expect(documento.getModificationDate()?.getTime()).toBe(esperada);
    expect(documento.getTitle()).toBe("Evidencia de aprobación");
    expect(documento.getAuthor()).toBe("mlopez@periferia-ficticia.com");
    expect(documento.getProducer()).toBe("agente-ia-ordenes-compra");
  });

  test("los caracteres que la fuente no admite se reemplazan por '?' y se avisan; las tildes y la ñ se conservan", async () => {
    const evidencia = { ...evidenciaDe("sol-001"), cuerpo: "Aprobado ✓ → ñandú, año, ¿qué tal? 日本語" };
    const { bytes, caracteresReemplazados } = await generarPdfEvidencia(evidencia);

    expect(caracteresReemplazados).toEqual(expect.arrayContaining(["✓", "→", "日", "本", "語"]));
    expect(caracteresReemplazados).not.toContain("ñ");
    const texto = textoDelPdf(bytes);
    expect(texto).toContain("Aprobado ? ? ñandú, año, ¿qué tal? ???");
  });

  test("un texto largo continúa en más páginas y todas quedan numeradas", async () => {
    const parrafo = "Apruebo la compra descrita en la solicitud, siempre que se respeten las condiciones pactadas. ";
    const evidencia = {
      ...evidenciaDe("sol-001"),
      cuerpo: Array.from({ length: 80 }, (_, i) => `${i + 1}. ${parrafo}`).join("\n"),
    };
    const { bytes } = await generarPdfEvidencia(evidencia);

    const documento = await PDFDocument.load(bytes, { updateMetadata: false });
    const paginas = documento.getPageCount();
    expect(paginas).toBeGreaterThan(1);

    const texto = textoDelPdf(bytes);
    expect(texto).toContain(`Página 1 de ${paginas}`);
    expect(texto).toContain(`Página ${paginas} de ${paginas}`);
    expect(texto).toContain("80. Apruebo la compra"); // nada se pierde al cambiar de página
    expect(texto).toContain(evidencia.sha256); // la huella llega al final
  });

  test("una palabra larguísima sin espacios se parte por caracteres sin perder ninguno", async () => {
    const evidencia = { ...evidenciaDe("sol-001"), cuerpo: "x".repeat(500) };
    const { bytes } = await generarPdfEvidencia(evidencia);

    const soloX = textoDelPdf(bytes)
      .split("\n")
      .filter((linea) => /^x+$/.test(linea));
    expect(soloX.length).toBeGreaterThan(1); // se partió en varias líneas
    expect(soloX.join("").length).toBe(500); // y no se perdió ninguna x
  });

  test("un asunto largo se parte en varias líneas, con sangría", async () => {
    const evidencia = {
      ...evidenciaDe("sol-001"),
      encabezados: { ...evidenciaDe("sol-001").encabezados, asunto: "palabra ".repeat(40).trim() },
    };
    const lineas = textoDelPdf((await generarPdfEvidencia(evidencia)).bytes)
      .split("\n")
      .filter((linea) => linea.startsWith("palabra"));
    expect(lineas.length).toBeGreaterThan(1);
  });

  test("un cuerpo vacío no rompe la generación", async () => {
    const { bytes } = await generarPdfEvidencia({ ...evidenciaDe("sol-001"), cuerpo: "" });
    expect((await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — La herramienta oc_generar_evidencia
// ---------------------------------------------------------------------

describe("herramienta generar_evidencia", () => {
  type Respuesta = {
    ok: boolean;
    data?: { ruta: string; ruta_pdf: string | null; sha256: string; advertencias: string[] };
    error?: string;
  };

  async function ejecutar(raiz: string, caso: string): Promise<Respuesta> {
    return JSON.parse(await generar_evidencia.execute({ caso }, { directory: raiz, sessionId: "prueba" })) as Respuesta;
  }

  test("sol-001: escribe el .txt y el PDF y devuelve las rutas y el hash", async () => {
    const raiz = copiarFixtures();
    const respuesta = await ejecutar(raiz, "sol-001");

    expect(respuesta.ok).toBe(true);
    expect(respuesta.data?.ruta).toBe("out/sol-001/aprobacion.txt");
    expect(respuesta.data?.ruta_pdf).toBe("out/sol-001/aprobacion.pdf");
    expect(respuesta.data?.sha256).toBe(SHA_SOL_001);
    expect(respuesta.data?.advertencias).toEqual([]);

    // El .txt escrito es exactamente el texto de la evidencia
    const txt = readFileSync(join(raiz, "out", "sol-001", "aprobacion.txt"), "utf-8");
    expect(txt).toBe(evidenciaDe("sol-001").texto);

    // Y el PDF escrito es un PDF válido que lleva la misma huella
    const pdf = readFileSync(join(raiz, "out", "sol-001", "aprobacion.pdf"));
    expect((await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount()).toBe(1);
    expect(textoDelPdf(pdf)).toContain(SHA_SOL_001);
  });

  test("el hash del archivo escrito se puede recalcular leyéndolo y coincide con el devuelto", async () => {
    const raiz = copiarFixtures();
    const respuesta = await ejecutar(raiz, "sol-004");
    const txt = readFileSync(join(raiz, "out", "sol-004", "aprobacion.txt"), "utf-8");

    // Si la respuesta no trajera hash quedaría "" y la comparación fallaría (no se oculta nada)
    const hashDevuelto = respuesta.data?.sha256 ?? "";
    const [contenido, ultimaLinea] = txt.split(SEPARADOR_HASH);
    expect(calcularSha256(contenido ?? "")).toBe(hashDevuelto);
    expect(ultimaLinea?.trim()).toBe(hashDevuelto);
  });

  test("el hash de la evidencia es el mismo que lleva la OC de oc_construir_payload", async () => {
    const raiz = copiarFixtures();
    const evidencia = await ejecutar(raiz, "sol-004");
    const payload = JSON.parse(
      await construir_payload.execute({ caso: "sol-004" }, { directory: raiz, sessionId: "prueba" }),
    ) as { ok: boolean; data?: { orden: { aprobador: { evidencia_sha256: string } } } };

    expect(payload.ok).toBe(true);
    expect(payload.data?.orden.aprobador.evidencia_sha256).toBe(evidencia.data?.sha256);
  });

  test("es idempotente: ejecutarla dos veces deja los mismos archivos, byte a byte", async () => {
    const raiz = copiarFixtures();
    await ejecutar(raiz, "sol-005");
    const txt1 = readFileSync(join(raiz, "out", "sol-005", "aprobacion.txt"));
    const pdf1 = readFileSync(join(raiz, "out", "sol-005", "aprobacion.pdf"));

    await ejecutar(raiz, "sol-005");
    expect(readFileSync(join(raiz, "out", "sol-005", "aprobacion.txt")).equals(txt1)).toBe(true);
    expect(readFileSync(join(raiz, "out", "sol-005", "aprobacion.pdf")).equals(pdf1)).toBe(true);
  });

  test("los 6 casos generan su evidencia, incluso los que tienen bloqueos (es independiente de la validación)", async () => {
    const raiz = copiarFixtures();
    for (const caso of CASOS) {
      const respuesta = await ejecutar(raiz, caso);
      expect(respuesta.ok).toBe(true);
      expect(existsSync(join(raiz, "out", caso, "aprobacion.txt"))).toBe(true);
      expect(existsSync(join(raiz, "out", caso, "aprobacion.pdf"))).toBe(true);
    }
  });

  test("sin correo de aprobación da un error claro y no deja nada escrito", async () => {
    const raiz = copiarFixtures();
    rmSync(join(raiz, "fixtures", "reto-03", "solicitudes", "sol-001", "aprobacion.json"));
    const respuesta = await ejecutar(raiz, "sol-001");

    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("aprobacion.json");
    expect(existsSync(join(raiz, "out", "sol-001"))).toBe(false);
  });

  test("un caso peligroso devuelve error sin escribir fuera de out/", async () => {
    const raiz = copiarFixtures();
    const respuesta = await ejecutar(raiz, "../../.env");
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("inválido");
  });

  test("caracteres que el PDF no admite se avisan, y el .txt conserva el texto completo", async () => {
    const raiz = conCuerpoDeAprobacion("Aprobado ✓ gracias");
    const respuesta = await ejecutar(raiz, "sol-001");

    expect(respuesta.ok).toBe(true);
    expect(respuesta.data?.advertencias.join(" ")).toContain("reemplazaron");
    expect(readFileSync(join(raiz, "out", "sol-001", "aprobacion.txt"), "utf-8")).toContain("Aprobado ✓ gracias");
  });

  test("si el PDF no se puede escribir, el .txt queda escrito y solo se avisa", async () => {
    const raiz = copiarFixtures();
    // Una carpeta con el nombre del PDF hace fallar su escritura (simula un error de disco)
    mkdirSync(join(raiz, "out", "sol-001", "aprobacion.pdf"), { recursive: true });
    const respuesta = await ejecutar(raiz, "sol-001");

    expect(respuesta.ok).toBe(true);
    expect(respuesta.data?.ruta_pdf).toBeNull();
    expect(respuesta.data?.advertencias.join(" ")).toContain("No se pudo generar el PDF");
    expect(existsSync(join(raiz, "out", "sol-001", "aprobacion.txt"))).toBe(true);
  });

  test("si el .txt no se puede escribir devuelve un error legible, sin lanzar", async () => {
    const raiz = copiarFixtures();
    mkdirSync(join(raiz, "out", "sol-001", "aprobacion.txt"), { recursive: true });
    const respuesta = await ejecutar(raiz, "sol-001");

    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("Error inesperado");
  });
});
