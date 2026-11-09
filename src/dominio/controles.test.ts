// =====================================================================
// controles.test.ts — Pruebas de las reglas RC1 a RC10, de la carga de
// maestros y de la herramienta oc_validar.
//
// Los 6 casos reales solo activan RC1, RC2, RC5, RC6, RC7 y RC8. Las demás
// reglas (RC3, RC4, RC9, RC10) y los bordes se prueban aquí con casos
// propios, armados a partir de un caso real con un cambio puntual.
// Se ejecutan con: bun test
// =====================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hallazgo, Paquete, ResultadoValidacion } from "../esquemas.ts";
import { validar as herramientaValidar } from "../tools/oc.ts";
import { validarPaquete } from "./controles.ts";
import { cargarMaestros, type Maestros } from "./maestros.ts";
import { leerPaquete } from "./paquete.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Ayudantes de prueba
// ---------------------------------------------------------------------

const RAIZ = join(import.meta.dir, "..", "..");

// Devuelve el valor o falla la prueba con un mensaje claro si es null/undefined
function exigir<T>(valor: T | null | undefined, que: string): T {
  if (valor === null || valor === undefined) throw new Error(`Se esperaba ${que}`);
  return valor;
}

// Maestros reales, cargados una sola vez
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

function validarConMaestros(paquete: Paquete): ResultadoValidacion {
  return validarPaquete(paquete, maestros);
}

const codigos = (hallazgos: Hallazgo[]): string[] => hallazgos.map((h) => h.codigo);

const raicesTemporales: string[] = [];
afterAll(() => {
  for (const raiz of raicesTemporales) rmSync(raiz, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// BLOQUE 2 — Los 6 casos reales: resultado esperado de cada uno
// ---------------------------------------------------------------------

type Esperado = { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean };

const ESPERADOS: Record<string, Esperado> = {
  "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
  "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
  "sol-003": { apta: false, bloqueos: ["RC2"], confirmaciones: [], retroactiva: false },
  "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
  "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
  "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
};

describe("los 6 casos reales", () => {
  for (const [caso, esperado] of Object.entries(ESPERADOS)) {
    test(`${caso}: resultado esperado`, () => {
      const resultado = validarConMaestros(paqueteDe(caso));
      expect(resultado.apta).toBe(esperado.apta);
      expect(codigos(resultado.bloqueos)).toEqual(esperado.bloqueos);
      expect(codigos(resultado.confirmaciones)).toEqual(esperado.confirmaciones);
      expect(resultado.retroactiva).toBe(esperado.retroactiva);
    });
  }

  test("sol-001: el proveedor sale del maestro y no hay nada derivado", () => {
    const { derivados } = validarConMaestros(paqueteDe("sol-001"));
    expect(derivados.proveedor?.codigo_sap).toBe("100234");
    expect(derivados.indicador_iva).toBeUndefined();
    expect(derivados.condiciones_pago).toBeUndefined();
  });

  test("sol-002: el NIT no existe en el maestro y el mensaje dice qué hacer", () => {
    const [bloqueo] = validarConMaestros(paqueteDe("sol-002")).bloqueos;
    expect(bloqueo?.detalle).toContain("901999000");
    expect(bloqueo?.accion_sugerida).toContain("alta del proveedor");
  });

  test("sol-003: bloquea por RC2 (otro centro), no por RC3, y avisa que hay que escalar", () => {
    const resultado = validarConMaestros(paqueteDe("sol-003"));
    expect(codigos(resultado.bloqueos)).toEqual(["RC2"]); // RC3 no se activa
    const [bloqueo] = resultado.bloqueos;
    expect(bloqueo?.detalle).toContain("fvargas@periferia-ficticia.com no figura como aprobador del centro CC-2020");
    expect(bloqueo?.detalle).toContain("supera el tope máximo del centro (30.000.000)");
    expect(bloqueo?.accion_sugerida).toContain("Escalar");
  });

  test("sol-004: la confirmación muestra ambos valores y el porcentaje", () => {
    const [confirmacion] = validarConMaestros(paqueteDe("sol-004")).confirmaciones;
    expect(confirmacion?.detalle).toContain("COP 26.500.000");
    expect(confirmacion?.detalle).toContain("COP 25.000.000");
    expect(confirmacion?.detalle).toContain("6,0 %");
  });

  test("sol-005: marca la compra como retroactiva y cita la factura", () => {
    const resultado = validarConMaestros(paqueteDe("sol-005"));
    expect(resultado.retroactiva).toBe(true);
    expect(resultado.confirmaciones[0]?.detalle).toContain("FC-88231");
  });

  test("sol-006: busca el proveedor por nombre y deriva IVA y condiciones de pago", () => {
    const { derivados, confirmaciones } = validarConMaestros(paqueteDe("sol-006"));
    expect(derivados.proveedor?.codigo_sap).toBe("100234");
    expect(derivados.indicador_iva).toEqual({ valor: "C1", fuente: "maestro.proveedores.indicador_iva_default" });
    expect(derivados.condiciones_pago).toEqual({ valor: "Z030", fuente: "maestro.proveedores.condiciones_pago_default" });
    // RC7 solo informa: no pide confirmación
    expect(codigos(confirmaciones)).toEqual(["RC6"]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 3 — RC1: proveedor existente y activo
// ---------------------------------------------------------------------

describe("RC1 proveedor", () => {
  test("un proveedor inactivo bloquea (ningún fixture lo prueba)", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.proveedor_nit = "901777888"; // Consultores Ágiles, activo = false
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.bloqueos)).toEqual(["RC1"]);
    expect(resultado.bloqueos[0]?.detalle).toContain("inactivo");
  });

  test("el NIT con puntos y dígito de verificación se reconoce", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.proveedor_nit = "900.555.111-2";
    });
    expect(validarConMaestros(paquete).apta).toBe(true);
  });

  test("sin NIT, el nombre se reconoce sin importar mayúsculas ni puntuación", () => {
    const paquete = conCambios("sol-006", (p) => {
      p.solicitud.proveedor_nombre = "TECNOSUMINISTROS S.A.S";
    });
    expect(validarConMaestros(paquete).derivados.proveedor?.codigo_sap).toBe("100234");
  });

  test("sin NIT y con un nombre desconocido bloquea y lo dice", () => {
    const paquete = conCambios("sol-006", (p) => {
      p.solicitud.proveedor_nombre = "Proveedor Fantasma S.A.S.";
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.bloqueos)).toEqual(["RC1"]);
    expect(resultado.bloqueos[0]?.detalle).toContain("no trae NIT");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 4 — RC2: aprobación válida de un aprobador del centro
// ---------------------------------------------------------------------

describe("RC2 aprobación", () => {
  test("sin correo de aprobación bloquea", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.aprobacion = null;
      p.faltantes.push("aprobacion.json");
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.bloqueos)).toEqual(["RC2"]);
    expect(resultado.bloqueos[0]?.detalle).toContain("No hay un correo de aprobación");
  });

  test("un correo que no aprueba de forma explícita bloquea", () => {
    const paquete = conCambios("sol-001", (p) => {
      exigir(p.aprobacion, "aprobación").aprobado = false;
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.bloqueos)).toEqual(["RC2"]);
    expect(resultado.bloqueos[0]?.detalle).toContain("no contiene una aprobación explícita");
  });

  test("el correo del aprobador se compara sin mayúsculas ni tildes", () => {
    const paquete = conCambios("sol-001", (p) => {
      exigir(p.aprobacion, "aprobación").de = "MLÓPEZ@Periferia-Ficticia.com";
    });
    expect(validarConMaestros(paquete).bloqueos).toEqual([]);
  });

  test("un aprobador con tope alto es válido en SU centro (CC-3030)", () => {
    const paquete = conCambios("sol-003", (p) => {
      p.solicitud.centro_costo = "CC-3030";
      p.solicitud.subarea = "Preventa";
    });
    const resultado = validarConMaestros(paquete); // 74 M ≤ 80 M de fvargas
    expect(resultado.bloqueos).toEqual([]);
    expect(resultado.apta).toBe(true);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 5 — RC3: el valor no supera el tope del aprobador
// ---------------------------------------------------------------------

// Deja un caso con un único valor coherente (cantidad 1) en solicitud y cotización,
// para que RC5 y RC10 no se activen y solo se pruebe RC3
function conValor(caso: string, valor: number): Paquete {
  return conCambios(caso, (p) => {
    p.solicitud.cantidad = 1;
    p.solicitud.valor_unitario = valor;
    p.solicitud.valor_total = valor;
    exigir(p.cotizacion, "cotización").total = valor;
  });
}

describe("RC3 tope del aprobador", () => {
  test("un valor exactamente igual al tope se permite", () => {
    const resultado = validarConMaestros(conValor("sol-001", 50_000_000)); // tope de mlopez
    expect(resultado.bloqueos).toEqual([]);
    expect(resultado.apta).toBe(true);
  });

  test("un peso por encima del tope bloquea y sugiere quién puede aprobar", () => {
    const resultado = validarConMaestros(conValor("sol-001", 50_000_001));
    expect(codigos(resultado.bloqueos)).toEqual(["RC3"]);
    expect(resultado.bloqueos[0]?.accion_sugerida).toContain("dgarcia@periferia-ficticia.com");
  });

  test("si nadie en el centro alcanza el valor, pide escalar", () => {
    const paquete = conCambios("sol-003", (p) => {
      p.solicitud.centro_costo = "CC-3030";
      p.solicitud.subarea = "Preventa";
      p.solicitud.cantidad = 1;
      p.solicitud.valor_unitario = 80_000_001;
      p.solicitud.valor_total = 80_000_001;
      exigir(p.cotizacion, "cotización").total = 80_000_001;
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.bloqueos)).toEqual(["RC3"]);
    expect(resultado.bloqueos[0]?.accion_sugerida).toContain("Ningún aprobador");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 6 — RC4: subárea y centro de costo
// ---------------------------------------------------------------------

describe("RC4 subárea", () => {
  test("una subárea de otro centro bloquea y lista las válidas", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.subarea = "Compras"; // pertenece a CC-2020, no a CC-1010
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.bloqueos)).toEqual(["RC4"]);
    expect(resultado.bloqueos[0]?.detalle).toContain("Infraestructura");
  });

  test("un centro de costo inexistente bloquea sin romper nada", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.centro_costo = "CC-9999";
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.bloqueos)).toEqual(["RC2", "RC4"]);
    expect(resultado.bloqueos[0]?.detalle).toContain("no existe en el maestro");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 7 — RC5: cotización vs solicitud (borde del 2 %)
// ---------------------------------------------------------------------

describe("RC5 cotización", () => {
  // sol-004 tiene valor_total = 25.000.000; el 2 % son 500.000
  function conCotizacion(total: number): Paquete {
    return conCambios("sol-004", (p) => {
      exigir(p.cotizacion, "cotización").total = total;
    });
  }

  test("exactamente 2 % arriba o abajo pasa", () => {
    expect(validarConMaestros(conCotizacion(25_500_000)).confirmaciones).toEqual([]);
    expect(validarConMaestros(conCotizacion(24_500_000)).confirmaciones).toEqual([]);
  });

  test("un peso más allá del 2 % pide confirmación", () => {
    expect(codigos(validarConMaestros(conCotizacion(25_500_001)).confirmaciones)).toEqual(["RC5"]);
    expect(codigos(validarConMaestros(conCotizacion(24_499_999)).confirmaciones)).toEqual(["RC5"]);
  });

  test("sin cotización pide confirmación y cita el motivo", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.cotizacion = null;
      p.faltantes.push("cotizacion.txt: no se pudo leer el total");
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.confirmaciones)).toEqual(["RC5"]);
    expect(resultado.confirmaciones[0]?.detalle).toContain("no se pudo leer el total");
    expect(resultado.apta).toBe(true); // es una confirmación, no un bloqueo
  });
});

// ---------------------------------------------------------------------
// BLOQUE 8 — RC6 y RC7: valores derivados del proveedor
// ---------------------------------------------------------------------

describe("RC6 y RC7 derivados", () => {
  test("un indicador de IVA vacío se trata como faltante", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.indicador_iva = "";
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.confirmaciones)).toEqual(["RC6"]);
    expect(resultado.derivados.indicador_iva?.valor).toBe("C1");
  });

  test("las condiciones de pago faltantes solo se informan, sin confirmación", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.solicitud.condiciones_pago = undefined;
    });
    const resultado = validarConMaestros(paquete);
    expect(resultado.confirmaciones).toEqual([]);
    expect(resultado.derivados.condiciones_pago).toEqual({ valor: "Z030", fuente: "maestro.proveedores.condiciones_pago_default" });
  });

  test("si el proveedor no existe no se deriva nada (no se inventa)", () => {
    const paquete = conCambios("sol-002", (p) => {
      p.solicitud.indicador_iva = undefined;
      p.solicitud.condiciones_pago = undefined;
    });
    const resultado = validarConMaestros(paquete);
    expect(resultado.derivados.indicador_iva).toBeUndefined();
    expect(resultado.derivados.condiciones_pago).toBeUndefined();
    expect(codigos(resultado.bloqueos)).toEqual(["RC1"]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 9 — RC8: compra retroactiva
// ---------------------------------------------------------------------

describe("RC8 retroactiva", () => {
  // sol-001 tiene fecha_solicitud 2026-08-20
  function conFactura(fecha: string): Paquete {
    return conCambios("sol-001", (p) => {
      p.factura = { numero: "F-1", fecha, total: 11_400_000 };
    });
  }

  test("una factura del mismo día o posterior no es retroactiva", () => {
    for (const fecha of ["2026-08-20", "2026-08-21"]) {
      const resultado = validarConMaestros(conFactura(fecha));
      expect(resultado.retroactiva).toBe(false);
      expect(resultado.confirmaciones).toEqual([]);
    }
  });

  test("una factura de un día antes sí lo es", () => {
    const resultado = validarConMaestros(conFactura("2026-08-19"));
    expect(resultado.retroactiva).toBe(true);
    expect(codigos(resultado.confirmaciones)).toEqual(["RC8"]);
  });

  test("una factura ilegible pide confirmación: podría ser retroactiva", () => {
    const paquete = conCambios("sol-001", (p) => {
      p.faltantes.push("factura.txt: no se pudo leer el total");
    });
    const resultado = validarConMaestros(paquete);
    expect(codigos(resultado.confirmaciones)).toEqual(["RC8"]);
    expect(resultado.retroactiva).toBe(false);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 10 — RC9: la aprobación no es anterior a la solicitud
// ---------------------------------------------------------------------

describe("RC9 fecha de aprobación", () => {
  // sol-001 tiene fecha_solicitud 2026-08-20
  function conFechaAprobacion(fecha: string): Paquete {
    return conCambios("sol-001", (p) => {
      exigir(p.aprobacion, "aprobación").fecha = fecha;
    });
  }

  test("una aprobación de un día antes pide confirmación", () => {
    expect(codigos(validarConMaestros(conFechaAprobacion("2026-08-19T23:59:00-05:00")).confirmaciones)).toEqual(["RC9"]);
  });

  test("una aprobación el mismo día, a cualquier hora, pasa", () => {
    expect(validarConMaestros(conFechaAprobacion("2026-08-20T23:59:00-05:00")).confirmaciones).toEqual([]);
  });

  test("una fecha ilegible pide confirmación en vez de asumirse buena", () => {
    expect(codigos(validarConMaestros(conFechaAprobacion("ayer")).confirmaciones)).toEqual(["RC9"]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 11 — RC10: cantidad × valor unitario = valor total (±1)
// ---------------------------------------------------------------------

describe("RC10 aritmética", () => {
  // sol-001: 120 × 95.000 = 11.400.000
  function conTotal(total: number): Paquete {
    return conCambios("sol-001", (p) => {
      p.solicitud.valor_total = total;
      exigir(p.cotizacion, "cotización").total = total;
    });
  }

  test("una diferencia de 1 se tolera", () => {
    expect(validarConMaestros(conTotal(11_400_001)).bloqueos).toEqual([]);
  });

  test("una diferencia de 2 bloquea y muestra los números", () => {
    const resultado = validarConMaestros(conTotal(11_400_002));
    expect(codigos(resultado.bloqueos)).toEqual(["RC10"]);
    expect(resultado.bloqueos[0]?.detalle).toContain("COP 11.400.000");
    expect(resultado.bloqueos[0]?.detalle).toContain("COP 11.400.002");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 12 — Se evalúan todas las reglas, siempre en el mismo orden
// ---------------------------------------------------------------------

describe("acumulación de hallazgos", () => {
  test("varios problemas a la vez salen todos, en orden de regla", () => {
    const paquete = conCambios("sol-002", (p) => {
      p.solicitud.subarea = "Compras"; // RC4
      p.solicitud.cantidad = 1; // RC10 (1 × 1.700.000 ≠ 8.500.000)
    });
    expect(codigos(validarConMaestros(paquete).bloqueos)).toEqual(["RC1", "RC4", "RC10"]);
  });
});

// ---------------------------------------------------------------------
// BLOQUE 13 — Carga de maestros
// ---------------------------------------------------------------------

describe("cargarMaestros", () => {
  test("carga los 4 maestros reales", () => {
    expect(maestros.proveedores).toHaveLength(5);
    expect(maestros.centrosCosto).toHaveLength(3);
    expect(maestros.indicadoresIva).toHaveLength(3);
    expect(maestros.condicionesPago).toHaveLength(4);
  });

  test("sin carpeta de maestros da un error claro", () => {
    const raiz = mkdtempSync(join(tmpdir(), "oc-maestros-"));
    raicesTemporales.push(raiz);
    const resultado = cargarMaestros(raiz);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error).toContain("Maestro no disponible");
  });

  test("un maestro corrupto indica cuál es", () => {
    const raiz = mkdtempSync(join(tmpdir(), "oc-maestros-"));
    raicesTemporales.push(raiz);
    const destino = join(raiz, "fixtures", "reto-03", "maestros");
    mkdirSync(destino, { recursive: true });
    cpSync(join(RAIZ, "fixtures", "reto-03", "maestros"), destino, { recursive: true });
    writeFileSync(join(destino, "proveedores.json"), '[{"nit": 1}]');

    const resultado = cargarMaestros(raiz);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error).toContain("proveedores.json");
  });
});

// ---------------------------------------------------------------------
// BLOQUE 14 — La herramienta oc_validar
// ---------------------------------------------------------------------

describe("herramienta validar", () => {
  const contexto = { directory: RAIZ, sessionId: "prueba" };
  type Respuesta = { ok: boolean; data?: ResultadoValidacion; error?: string };

  async function ejecutar(args: { caso: string; paquete?: Paquete }): Promise<Respuesta> {
    return JSON.parse(await herramientaValidar.execute(args, contexto)) as Respuesta;
  }

  test("valida un caso usando solo su nombre", async () => {
    const respuesta = await ejecutar({ caso: "sol-004" });
    expect(respuesta.ok).toBe(true);
    expect(respuesta.data?.apta).toBe(true);
    expect(codigos(respuesta.data?.confirmaciones ?? [])).toEqual(["RC5"]);
  });

  test("acepta el paquete cuando es idéntico al del caso, aunque las llaves vengan en otro orden", async () => {
    const original = paqueteDe("sol-004");
    const barajado = Object.fromEntries(Object.entries(original).reverse()) as Paquete;
    expect((await ejecutar({ caso: "sol-004", paquete: original })).ok).toBe(true);
    expect((await ejecutar({ caso: "sol-004", paquete: barajado })).ok).toBe(true);
  });

  test("rechaza un paquete alterado: el modelo no puede 'arreglar' un monto", async () => {
    const manipulado = conCambios("sol-004", (p) => {
      exigir(p.cotizacion, "cotización").total = 25_000_000; // para que cuadre con la solicitud
    });
    const respuesta = await ejecutar({ caso: "sol-004", paquete: manipulado });
    expect(respuesta.ok).toBe(false);
    expect(respuesta.error).toContain("no coincide");
  });

  test("con un caso peligroso o inexistente devuelve error sin lanzar", async () => {
    expect((await ejecutar({ caso: "../../.env" })).ok).toBe(false);
    expect((await ejecutar({ caso: "sol-999" })).ok).toBe(false);
  });
});
