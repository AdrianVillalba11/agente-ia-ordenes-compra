// =====================================================================
// orden.test.ts — Pruebas de la evidencia, de la construcción de la OC
// y de la herramienta oc_construir_payload.
//
// Se prueba con los 6 casos reales y con casos propios armados a partir
// de un caso real con un cambio puntual. La herramienta escribe en out/,
// así que sus pruebas trabajan sobre una copia temporal de los fixtures.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EsquemaOrdenCompra, type OrdenCompra, type Paquete, type Resultado } from "../esquemas.ts";
import { construir_payload } from "../tools/oc.ts";
import { validarPaquete } from "./controles.ts";
import { calcularSha256, construirEvidencia } from "./evidencia.ts";
import { cargarMaestros, type Maestros } from "./maestros.ts";
import { acortarDescripcion, construirOrden, inferirUnidad, type ResultadoOrden } from "./orden.ts";
import { leerPaquete } from "./paquete.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");
const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];
const SHA_PRUEBA = "a".repeat(64);

// Hashes de referencia de la evidencia: fijan el formato del contenido.
// Si cambia el formato de aprobacion.txt, estas pruebas lo detectan.
const SHA_SOL_001 = "c2466ccea16832330e65da51f26e0ea7c55d8ec9ae10fc3497cb81cfcad4555e";
const SHA_SOL_004 = "f2dea3f7a7e98b50517753b2b2f166a520205e9ab17881ab7675749a51c6493f";

const maestros: Maestros = (() => {
  const resultado = cargarMaestros(RAIZ);
  if (!resultado.ok) throw new Error(resultado.error);
  return resultado.data;
})();

function paqueteDe(caso: string): Paquete {
  const resultado = leerPaquete(caso, RAIZ);
  if (!resultado.ok) throw new Error(resultado.error);
  return resultado.data;
}

// Copia de un caso real con un cambio puntual (no toca los fixtures)
function conCambios(caso: string, cambiar: (paquete: Paquete) => void): Paquete {
  const copia = structuredClone(paqueteDe(caso));
  cambiar(copia);
  return copia;
}

// Valida y construye la OC de un paquete, con un hash de evidencia de prueba
function construirDe(paquete: Paquete): Resultado<ResultadoOrden> {
  return construirOrden(paquete, validarPaquete(paquete, maestros), SHA_PRUEBA);
}

// Devuelve la OC o falla la prueba con el motivo
function ordenDe(paquete: Paquete): ResultadoOrden {
  const resultado = construirDe(paquete);
  if (!resultado.ok) throw new Error(`Se esperaba una OC, pero falló: ${resultado.error}`);
  return resultado.data;
}

// Devuelve el mensaje de error o falla la prueba si salió ok
function errorDe(resultado: Resultado<unknown>): string {
  if (resultado.ok) throw new Error("Se esperaba un error, pero salió ok");
  return resultado.error;
}

// Devuelve la primera posición de la OC (siempre hay una)
function posicionDe(orden: OrdenCompra): OrdenCompra["posiciones"][number] {
  const posicion = orden.posiciones[0];
  if (posicion === undefined) throw new Error("La OC no tiene posiciones");
  return posicion;
}

const raicesTemporales: string[] = [];

// Copia de los fixtures en una carpeta temporal, para pruebas que escriben en out/
function copiarFixtures(): string {
  const raiz = mkdtempSync(join(tmpdir(), "oc-orden-"));
  raicesTemporales.push(raiz);
  cpSync(join(RAIZ, "fixtures"), join(raiz, "fixtures"), { recursive: true });
  return raiz;
}

// Reescribe el aprobacion.json de sol-001 en una copia temporal
function conAprobacion(cuerpo: string): string {
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
// BLOQUE 2 — Descripción acortada (caso delicado: límite de 40 de SAP)
// ---------------------------------------------------------------------

describe("acortarDescripcion", () => {
  test("un texto de hasta 40 caracteres queda igual", () => {
    expect(acortarDescripcion("Papelería y tóner para el trimestre")).toBe("Papelería y tóner para el trimestre");
    expect(acortarDescripcion("a".repeat(40))).toBe("a".repeat(40));
  });

  test("corta en la última palabra completa, sin partir palabras", () => {
    const esperado: Record<string, string> = {
      "sol-001": "Renovación licencias antivirus",
      "sol-002": "Licencia anual herramienta de pruebas",
      "sol-003": "Mobiliario para nueva sede: 40 puestos",
      "sol-004": "Bolsa de 100 horas de arquitectura de",
      "sol-006": "Diademas con micrófono para la mesa de",
    };
    for (const [caso, corto] of Object.entries(esperado)) {
      expect(acortarDescripcion(paqueteDe(caso).solicitud.descripcion)).toBe(corto);
    }
  });

  test("las 6 descripciones reales caben en 40 caracteres", () => {
    for (const caso of CASOS) {
      expect(acortarDescripcion(paqueteDe(caso).solicitud.descripcion).length).toBeLessThanOrEqual(40);
    }
  });

  test("si la palabra termina justo en el límite, se conserva entera", () => {
    const texto = `${"a".repeat(35)} bbbb cc`; // el carácter 41 es un espacio
    const corto = acortarDescripcion(texto);
    expect(corto).toBe(`${"a".repeat(35)} bbbb`);
    expect(corto.length).toBe(40);
  });

  test("una palabra larguísima sin espacios se corta seco en 40", () => {
    expect(acortarDescripcion("x".repeat(60))).toBe("x".repeat(40));
  });

  test("si el único espacio queda muy al principio, corta seco en 40", () => {
    expect(acortarDescripcion(`ab ${"x".repeat(60)}`).length).toBe(40);
  });

  test("quita la puntuación que quede al final del corte", () => {
    expect(acortarDescripcion("Alquiler de equipos de oficina, mantenimiento mensual completo")).toBe(
      "Alquiler de equipos de oficina",
    );
  });

  test("colapsa espacios repetidos", () => {
    expect(acortarDescripcion("  Compra   de   papel ")).toBe("Compra de papel");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — Unidad de medida (caso delicado: no viene en los datos)
// ---------------------------------------------------------------------

describe("inferirUnidad", () => {
  test("'horas' da H", () => {
    expect(inferirUnidad("Bolsa de 100 horas de arquitectura de nube para migración")).toBe("H");
    expect(inferirUnidad("Horas de consultoría")).toBe("H");
  });

  test("'vigencia 12 meses' NO da MES: son 120 licencias (trampa de sol-001)", () => {
    expect(inferirUnidad(paqueteDe("sol-001").solicitud.descripcion)).toBe("UN");
  });

  test("precio mensual da MES", () => {
    expect(inferirUnidad("Alquiler por mes de la oficina")).toBe("MES");
    expect(inferirUnidad("Servicio mensual de hosting")).toBe("MES");
  });

  test("lo demás da UN, y 'horario' no se confunde con 'horas'", () => {
    expect(inferirUnidad("Silla ergonómica")).toBe("UN");
    expect(inferirUnidad("Horario extendido de soporte")).toBe("UN");
  });

  test("los 6 casos reales dan la unidad esperada", () => {
    const esperadas: Record<string, "UN" | "H" | "MES"> = {
      "sol-001": "UN", "sol-002": "UN", "sol-003": "UN", "sol-004": "H", "sol-005": "UN", "sol-006": "UN",
    };
    for (const [caso, unidad] of Object.entries(esperadas)) {
      expect(inferirUnidad(paqueteDe(caso).solicitud.descripcion)).toBe(unidad);
    }
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — Evidencia de aprobación y su hash
// ---------------------------------------------------------------------

describe("construirEvidencia", () => {
  test("el algoritmo es SHA-256: coincide con el vector estándar de 'abc'", () => {
    expect(calcularSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("sol-001: texto con encabezados y cuerpo, y hash de referencia fijo", () => {
    const resultado = construirEvidencia("sol-001", RAIZ);
    if (!resultado.ok) throw new Error(resultado.error);
    const { texto, sha256 } = resultado.data;

    expect(texto).toContain("De: mlopez@periferia-ficticia.com");
    expect(texto).toContain("Para: juan.camargo@periferia-ficticia.com");
    expect(texto).toContain("Fecha: 2026-08-21T10:02:00-05:00");
    expect(texto).toContain("Asunto: RE: Solicitud de orden de compra SOL-001");
    expect(texto).toContain("Aprobado, proceder con la orden de compra.");
    expect(sha256).toBe(SHA_SOL_001);
  });

  test("el hash cubre solo el contenido, no su propia línea", () => {
    const resultado = construirEvidencia("sol-001", RAIZ);
    if (!resultado.ok) throw new Error(resultado.error);
    const { texto, sha256 } = resultado.data;

    const [contenido] = texto.split("\n\n---\nsha256: ");
    expect(calcularSha256(contenido ?? "")).toBe(sha256);
    expect(texto.endsWith(`sha256: ${sha256}\n`)).toBe(true);
  });

  test("es determinista: dos llamadas dan exactamente lo mismo", () => {
    expect(construirEvidencia("sol-004", RAIZ)).toEqual(construirEvidencia("sol-004", RAIZ));
  });

  test("cambiar una sola letra del cuerpo cambia el hash", () => {
    const original = construirEvidencia("sol-001", RAIZ);
    const alterado = construirEvidencia("sol-001", conAprobacion("Aprobado, proceder con la orden de compra!"));
    if (!original.ok || !alterado.ok) throw new Error("Se esperaban evidencias");
    expect(alterado.data.sha256).not.toBe(original.data.sha256);
  });

  test("el hash es el mismo con saltos de línea de Windows o de Linux", () => {
    const conWindows = construirEvidencia("sol-001", conAprobacion("Aprobado\r\nGracias"));
    const conLinux = construirEvidencia("sol-001", conAprobacion("Aprobado\nGracias"));
    if (!conWindows.ok || !conLinux.ok) throw new Error("Se esperaban evidencias");
    expect(conWindows.data.sha256).toBe(conLinux.data.sha256);
  });

  test("un caso peligroso o sin aprobación da un error claro", () => {
    expect(errorDe(construirEvidencia("../../.env", RAIZ))).toContain("inválido");
    const raiz = copiarFixtures();
    rmSync(join(raiz, "fixtures", "reto-03", "solicitudes", "sol-001", "aprobacion.json"));
    expect(errorDe(construirEvidencia("sol-001", raiz))).toContain("aprobacion.json");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — La OC de cada caso real
// ---------------------------------------------------------------------

describe("construirOrden con los casos reales", () => {
  test("sol-001: OC completa, sin excepciones y con la descripción acortada", () => {
    const { orden, advertencias } = ordenDe(paqueteDe("sol-001"));
    const posicion = posicionDe(orden);

    expect(EsquemaOrdenCompra.safeParse(orden).success).toBe(true);
    expect(orden.referencia).toEqual({ solicitud_id: "SOL-2026-001", correo_id: "sol-001-correo", cotizacion_ref: "COT-TS-2026-0451" });
    expect(orden.proveedor).toEqual({ codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." });
    expect(orden.sociedad).toBe("1000");
    expect(orden.organizacion_compras).toBe("1000");
    expect(orden.moneda).toBe("COP");
    expect(orden.condiciones_pago).toBe("Z030");
    expect(orden.aprobador).toEqual({
      email: "mlopez@periferia-ficticia.com",
      fecha_aprobacion: "2026-08-21T10:02:00-05:00",
      evidencia_sha256: SHA_PRUEBA,
    });
    expect(posicion).toEqual({
      numero: 10,
      descripcion: "Renovación licencias antivirus",
      cantidad: 120,
      unidad: "UN",
      precio_unitario: 95000,
      centro_costo: "CC-1010",
      subarea: "Infraestructura",
      indicador_iva: "C1",
    });
    expect(orden.excepciones).toEqual([]);
    expect(advertencias.some((a) => a.includes("se acortó") && a.includes("Renovación licencias antivirus corporativo"))).toBe(true);
    expect(advertencias.some((a) => a.includes("Unidad de medida inferida: UN"))).toBe(true);
  });

  test("sol-004: unidad H, condiciones Z000 y la excepción RC5 sin confirmar", () => {
    const { orden } = ordenDe(paqueteDe("sol-004"));
    expect(posicionDe(orden).unidad).toBe("H");
    expect(posicionDe(orden).cantidad).toBe(100);
    expect(posicionDe(orden).precio_unitario).toBe(250000);
    expect(orden.condiciones_pago).toBe("Z000");
    expect(orden.excepciones.map((e) => e.codigo)).toEqual(["RC5"]);
    expect(orden.excepciones.every((e) => e.confirmado_por === null)).toBe(true);
  });

  test("sol-005: la excepción RC8 (retroactiva) queda registrada", () => {
    const { orden, advertencias } = ordenDe(paqueteDe("sol-005"));
    expect(orden.excepciones.map((e) => e.codigo)).toEqual(["RC8"]);
    expect(orden.excepciones[0]?.detalle).toContain("FC-88231");
    expect(orden.condiciones_pago).toBe("Z015");
    expect(posicionDe(orden).descripcion).toBe("Papelería y tóner para el trimestre");
    // La descripción cabe en 40: no hay aviso de acortado, solo el de la unidad
    expect(advertencias.some((a) => a.includes("se acortó"))).toBe(false);
  });

  test("sol-006: proveedor por nombre, IVA y condiciones derivados del proveedor", () => {
    const { orden } = ordenDe(paqueteDe("sol-006"));
    expect(orden.proveedor.codigo_sap).toBe("100234");
    expect(orden.condiciones_pago).toBe("Z030");
    expect(posicionDe(orden).indicador_iva).toBe("C1");
    expect(orden.excepciones.map((e) => e.codigo)).toEqual(["RC6"]);
  });

  test("sol-002 y sol-003 tienen bloqueos: no hay OC y el error cita la regla", () => {
    expect(errorDe(construirDe(paqueteDe("sol-002")))).toContain("RC1");
    expect(errorDe(construirDe(paqueteDe("sol-003")))).toContain("RC2");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — Trazabilidad: cada valor tiene su fuente
// ---------------------------------------------------------------------

describe("trazabilidad", () => {
  const CAMPOS_REQUERIDOS = [
    "referencia.solicitud_id", "referencia.correo_id", "referencia.cotizacion_ref",
    "sociedad", "organizacion_compras",
    "proveedor.codigo_sap", "proveedor.nit", "proveedor.nombre",
    "moneda", "condiciones_pago",
    "aprobador.email", "aprobador.fecha_aprobacion", "aprobador.evidencia_sha256",
    "posiciones[0].numero", "posiciones[0].descripcion", "posiciones[0].cantidad", "posiciones[0].unidad",
    "posiciones[0].precio_unitario", "posiciones[0].centro_costo", "posiciones[0].subarea", "posiciones[0].indicador_iva",
    "excepciones",
  ];

  for (const caso of ["sol-001", "sol-004", "sol-005", "sol-006"]) {
    test(`${caso}: todos los campos de la OC tienen fuente`, () => {
      const { trazabilidad } = ordenDe(paqueteDe(caso));
      const campos = trazabilidad.map((t) => t.campo);
      for (const campo of CAMPOS_REQUERIDOS) expect(campos).toContain(campo);
      expect(new Set(campos).size).toBe(campos.length); // sin repetidos
      expect(trazabilidad.every((t) => t.fuente !== "")).toBe(true);
    });
  }

  test("sol-006: IVA y condiciones se marcan como derivados y dicen de qué maestro", () => {
    const { trazabilidad } = ordenDe(paqueteDe("sol-006"));
    const iva = trazabilidad.find((t) => t.campo === "posiciones[0].indicador_iva");
    const pago = trazabilidad.find((t) => t.campo === "condiciones_pago");
    expect(iva?.fuente).toBe("derivado");
    expect(iva?.nota).toContain("maestro.proveedores.indicador_iva_default");
    expect(pago?.fuente).toBe("derivado");
    expect(pago?.nota).toContain("maestro.proveedores.condiciones_pago_default");
  });

  test("sol-001: los valores de la solicitud lo indican y la descripción guarda el original", () => {
    const { trazabilidad } = ordenDe(paqueteDe("sol-001"));
    const buscar = (campo: string) => trazabilidad.find((t) => t.campo === campo);
    expect(buscar("posiciones[0].indicador_iva")?.fuente).toBe("solicitud");
    expect(buscar("condiciones_pago")?.fuente).toBe("solicitud");
    expect(buscar("posiciones[0].descripcion")?.nota).toContain("Renovación licencias antivirus corporativo 120 puestos");
    expect(buscar("posiciones[0].unidad")?.fuente).toBe("derivado");
  });

  test("el precio deja constancia de que incluye IVA (riesgo documentado)", () => {
    const { trazabilidad } = ordenDe(paqueteDe("sol-001"));
    expect(trazabilidad.find((t) => t.campo === "posiciones[0].precio_unitario")?.nota).toContain("incluye IVA");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 7 — Red de seguridad del esquema (lo que dejamos fuera de RC1-RC10)
// ---------------------------------------------------------------------

describe("el esquema de la OC atrapa datos inválidos", () => {
  test("una moneda que no es COP ni USD se rechaza y se nombra el campo", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.moneda = "EUR";
    });
    expect(errorDe(construirDe(paquete))).toContain("moneda");
  });

  test("una cantidad en cero se rechaza y se nombra el campo", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.cantidad = 0;
      p.solicitud.valor_total = 0; // RC10 la deja pasar (0 × precio = 0)
    });
    expect(errorDe(construirDe(paquete))).toContain("cantidad");
  });

  test("una OC con confirmaciones se construye, pero ninguna queda confirmada", () => {
    const { orden } = ordenDe(paqueteDe("sol-006"));
    expect(orden.excepciones.length).toBeGreaterThan(0);
    expect(orden.excepciones.every((e) => e.confirmado_por === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 8 — La herramienta oc_construir_payload
// ---------------------------------------------------------------------

describe("herramienta construir_payload", () => {
  type Respuesta = {
    ok: boolean;
    data?: { orden: OrdenCompra; trazabilidad_ruta: string; advertencias: string[] };
    error?: string;
  };

  async function ejecutar(
    raiz: string,
    args: Parameters<typeof construir_payload.execute>[0],
  ): Promise<Respuesta> {
    return JSON.parse(await construir_payload.execute(args, { directory: raiz, sessionId: "prueba" })) as Respuesta;
  }

  test("sol-004: devuelve la OC, escribe la trazabilidad y usa el hash de la evidencia", async () => {
    const raiz = copiarFixtures();
    const respuesta = await ejecutar(raiz, { caso: "sol-004" });

    expect(respuesta.ok).toBe(true);
    expect(respuesta.data?.trazabilidad_ruta).toBe("out/sol-004/trazabilidad.json");
    expect(respuesta.data?.orden.aprobador.evidencia_sha256).toBe(SHA_SOL_004);
    expect(respuesta.data?.orden.excepciones.map((e) => e.codigo)).toEqual(["RC5"]);

    const archivo = JSON.parse(readFileSync(join(raiz, "out", "sol-004", "trazabilidad.json"), "utf-8")) as {
      caso: string;
      campos: { campo: string; fuente: string }[];
    };
    expect(archivo.caso).toBe("sol-004");
    expect(archivo.campos.length).toBeGreaterThan(15);
  });

  test("es determinista: dos ejecuciones dejan el mismo archivo", async () => {
    const raiz = copiarFixtures();
    await ejecutar(raiz, { caso: "sol-001" });
    const primero = readFileSync(join(raiz, "out", "sol-001", "trazabilidad.json"), "utf-8");
    await ejecutar(raiz, { caso: "sol-001" });
    expect(readFileSync(join(raiz, "out", "sol-001", "trazabilidad.json"), "utf-8")).toBe(primero);
  });

  test("un caso con bloqueos da error y no escribe nada", async () => {
    const raiz = copiarFixtures();
    const respuesta = await ejecutar(raiz, { caso: "sol-002" });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("RC1");
    expect(existsSync(join(raiz, "out", "sol-002"))).toBe(false);
  });

  test("acepta paquete y derivados idénticos a los del disco", async () => {
    const raiz = copiarFixtures();
    const paquete = paqueteDe("sol-006");
    const derivados = validarPaquete(paquete, maestros).derivados;
    expect((await ejecutar(raiz, { caso: "sol-006", paquete, derivados })).ok).toBe(true);
  });

  test("rechaza derivados alterados: el modelo no puede cambiar el proveedor", async () => {
    const raiz = copiarFixtures();
    const respuesta = await ejecutar(raiz, {
      caso: "sol-006",
      derivados: { proveedor: { codigo_sap: "999999", nit: "900555111", nombre: "Otro" } },
    });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("no coinciden");
  });

  test("rechaza un paquete alterado", async () => {
    const raiz = copiarFixtures();
    const manipulado = conCambios("sol-004", (p) => {
      p.solicitud.valor_total = 26_500_000; // para que cuadre con la cotización
    });
    const respuesta = await ejecutar(raiz, { caso: "sol-004", paquete: manipulado });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("no coincide");
  });

  test("con un caso peligroso devuelve error sin lanzar", async () => {
    const respuesta = await ejecutar(copiarFixtures(), { caso: "../../.env" });
    expect(respuesta.ok).toBe(false);
  });
});
