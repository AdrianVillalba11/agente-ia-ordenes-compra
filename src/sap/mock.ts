// =====================================================================
// mock.ts — SAP simulado sobre archivos.
//
// Guarda cada orden como una línea de out/sap/ordenes.jsonl y asigna
// números consecutivos desde 4500000001. No hay base de datos: el archivo
// es la única fuente de verdad, así que la numeración y la idempotencia
// sobreviven a un reinicio de la aplicación.
//
// CASOS DELICADOS que este archivo cuida:
//   - IDEMPOTENCIA: una solicitud solo tiene una orden; pedirla otra vez
//     devuelve la existente.
//   - ATOMICIDAD: crearOrden comprueba y escribe SIN ningún "await" de por
//     medio; en JavaScript eso significa que dos llamadas simultáneas no
//     pueden crear dos órdenes. (Con varios procesos a la vez esto no bastaría:
//     un SAP real lo resuelve con una clave de referencia única.)
//   - NUMERACIÓN: el siguiente número sale del archivo. Si una línea está
//     dañada se rechaza todo, en vez de arriesgarse a repetir un número.
//   - FECHA: la fecha de la orden es el día en Colombia, no el día en UTC
//     (a las 8 p. m. en Bogotá ya es "mañana" en UTC).
// =====================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EsquemaOrdenCompra, EsquemaProveedor, type OrdenCompra } from "../esquemas.ts";
import { leerJsonValidado } from "../dominio/archivos.ts";
import { normalizarNit } from "../dominio/normalizar.ts";
import { ErrorSap, type OrdenCreada, type ProveedorSap, type SapAdapter } from "./adapter.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Constantes y formato de una línea del archivo
// ---------------------------------------------------------------------

// Primer número de orden que asigna el SAP simulado (lo fija el PRD)
export const PRIMER_NUMERO_OC = 4500000001;

// Cada línea de ordenes.jsonl: el número, la fecha y la orden completa
const EsquemaRegistro = z.object({
  numero_oc: z.string().regex(/^\d{10}$/),
  fecha: z.string(),
  orden: EsquemaOrdenCompra,
});
type Registro = z.infer<typeof EsquemaRegistro>;

// ---------------------------------------------------------------------
// BLOQUE 2 — Fecha en Colombia
// ---------------------------------------------------------------------

// Día "YYYY-MM-DD" en la zona horaria de Bogotá.
//   2026-11-10T02:30:00Z (UTC) -> "2026-11-09" (son las 9:30 p. m. del 9 en Colombia)
export function diaEnBogota(fecha: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(fecha);
}

// ---------------------------------------------------------------------
// BLOQUE 3 — El SAP simulado
// ---------------------------------------------------------------------

export class SapMock implements SapAdapter {
  private readonly raiz: string;
  private readonly ahora: () => Date;
  private readonly rutaOrdenes: string;

  // "ahora" permite fijar el reloj en las pruebas para que los resultados sean exactos
  constructor(raizProyecto: string, ahora: () => Date = () => new Date()) {
    this.raiz = raizProyecto;
    this.ahora = ahora;
    this.rutaOrdenes = join(raizProyecto, "out", "sap", "ordenes.jsonl");
  }

  // Lee todas las órdenes del archivo. Si alguna línea está dañada, se detiene:
  // seguir podría repetir un número de orden.
  private leerRegistros(): Registro[] {
    if (!existsSync(this.rutaOrdenes)) return [];

    const registros: Registro[] = [];
    readFileSync(this.rutaOrdenes, "utf-8")
      .split("\n")
      .forEach((linea, indice) => {
        if (linea.trim() === "") return;
        const danado = new ErrorSap(
          `El archivo de órdenes del SAP simulado está dañado en la línea ${indice + 1}; no se crean más órdenes para no arriesgar números repetidos.`,
        );
        let crudo: unknown;
        try {
          crudo = JSON.parse(linea);
        } catch {
          throw danado;
        }
        const registro = EsquemaRegistro.safeParse(crudo);
        if (!registro.success) throw danado;
        registros.push(registro.data);
      });
    return registros;
  }

  // ¿Ya existe una orden para esta solicitud?
  async buscarOrdenPorReferencia(solicitud_id: string): Promise<OrdenCreada | null> {
    const existente = this.leerRegistros().find((r) => r.orden.referencia.solicitud_id === solicitud_id);
    return existente === undefined ? null : { numero_oc: existente.numero_oc, fecha: existente.fecha };
  }

  // Crea la orden y devuelve su número. Todo el cuerpo es síncrono a propósito
  // (sin "await"): comprobar y escribir ocurren como un solo paso indivisible.
  async crearOrden(orden: OrdenCompra): Promise<OrdenCreada> {
    // SAP valida lo que recibe: una orden inválida no entra
    const validada = EsquemaOrdenCompra.safeParse(orden);
    if (!validada.success) throw new ErrorSap("SAP rechazó la orden: no cumple el esquema de órdenes de compra.");

    const registros = this.leerRegistros();

    // Idempotencia: si la solicitud ya tiene orden, se devuelve esa
    const existente = registros.find((r) => r.orden.referencia.solicitud_id === orden.referencia.solicitud_id);
    if (existente !== undefined) {
      return { numero_oc: existente.numero_oc, fecha: existente.fecha, ya_existia: true };
    }

    // Siguiente número: el mayor existente + 1 (o el primero si no hay ninguna)
    const mayor = registros.reduce((max, r) => Math.max(max, Number(r.numero_oc)), PRIMER_NUMERO_OC - 1);
    const numero_oc = String(mayor + 1);
    const fecha = diaEnBogota(this.ahora());

    mkdirSync(dirname(this.rutaOrdenes), { recursive: true });
    appendFileSync(this.rutaOrdenes, `${JSON.stringify({ numero_oc, fecha, orden: validada.data })}\n`, "utf-8");
    return { numero_oc, fecha };
  }

  // SAP conoce a los proveedores del maestro (en producción, su propio maestro)
  async consultarProveedor(nit: string): Promise<ProveedorSap | null> {
    const carpeta = join(this.raiz, "fixtures", "reto-03", "maestros");
    const proveedores = leerJsonValidado(carpeta, "proveedores.json", z.array(EsquemaProveedor));
    if (!proveedores.ok) throw new ErrorSap(`SAP no puede consultar proveedores: ${proveedores.error}`);

    const buscado = normalizarNit(nit);
    const encontrado = proveedores.data.find((p) => normalizarNit(p.nit) === buscado);
    return encontrado === undefined ? null : { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo };
  }
}
