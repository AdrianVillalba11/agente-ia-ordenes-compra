// =====================================================================
// sesiones.ts — Almacén de sesiones en memoria, con carpeta propia.
//
// Cada sesión tiene su PROPIA copia de los fixtures y, por tanto, su propio
// SAP simulado, su registro de control y sus confirmaciones. Así, cuando
// varias personas prueban la misma URL no se pisan: cada una puede procesar
// sol-001 y obtener la OC 4500000001, en vez de que la segunda reciba "ya
// existía". Las carpetas se borran cuando la sesión caduca o se expulsa.
//
// CASOS DELICADOS que este archivo cuida:
//   - El identificador de sesión lo escribe el visitante: se valida con un
//     patrón estricto antes de usarlo como nombre de carpeta (nada de "../").
//   - Hay un máximo de sesiones: al llenarse se expulsa la menos usada, pero
//     nunca una que esté en medio de un turno.
//   - Una sesión sin uso caduca; sus carpetas no se acumulan sin límite.
// =====================================================================

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Resultado } from "../esquemas.ts";
import { crearSesion, type Sesion } from "./ciclo.ts";

// Solo letras, números, guion y guion bajo, entre 8 y 64 caracteres (un UUID cumple)
export const PATRON_ID_SESION = /^[A-Za-z0-9_-]{8,64}$/;

export type OpcionesAlmacen = {
  raizProyecto: string; // de aquí se copian los fixtures
  directorioBase?: string; // dónde se crean las carpetas de las sesiones (por defecto, una carpeta temporal nueva)
  maxSesiones: number;
  ttlMs: number; // una sesión sin uso caduca después de esto
  ahora?: () => number; // reloj en milisegundos; se puede fijar en las pruebas
};

type Entrada = { sesion: Sesion; ultimoUso: number };

export class AlmacenSesiones {
  private readonly entradas = new Map<string, Entrada>();
  private readonly raizProyecto: string;
  private readonly base: string;
  private readonly maxSesiones: number;
  private readonly ttlMs: number;
  private readonly ahora: () => number;

  constructor(opciones: OpcionesAlmacen) {
    this.raizProyecto = opciones.raizProyecto;
    this.maxSesiones = opciones.maxSesiones;
    this.ttlMs = opciones.ttlMs;
    this.ahora = opciones.ahora ?? Date.now;

    if (opciones.directorioBase === undefined) {
      this.base = mkdtempSync(join(tmpdir(), "oc-sesiones-"));
    } else {
      this.base = opciones.directorioBase;
      mkdirSync(this.base, { recursive: true });
    }
  }

  get cantidad(): number {
    return this.entradas.size;
  }

  // ¿Ya pasó el tiempo de vida de esta entrada sin que se usara?
  private caducada(entrada: Entrada): boolean {
    return this.ahora() - entrada.ultimoUso > this.ttlMs;
  }

  // La sesión existente, o null si no existe o caducó. Consultarla cuenta como "usarla".
  obtener(id: string): Sesion | null {
    const entrada = this.entradas.get(id);
    if (entrada === undefined) return null;
    if (this.caducada(entrada) && !entrada.sesion.ocupada) {
      this.eliminar(id);
      return null;
    }
    entrada.ultimoUso = this.ahora();
    return entrada.sesion;
  }

  // La sesión existente o una nueva, con su carpeta propia
  obtenerOCrear(id: string): Resultado<Sesion> {
    if (!PATRON_ID_SESION.test(id)) {
      return { ok: false, error: "Identificador de sesión inválido: usa entre 8 y 64 letras, números, guiones o guiones bajos." };
    }

    const existente = this.obtener(id);
    if (existente !== null) return { ok: true, data: existente };

    // Si el almacén está lleno, se expulsa la sesión menos usada que no esté en medio de un turno
    if (this.entradas.size >= this.maxSesiones && !this.expulsarMenosUsada()) {
      return { ok: false, error: "El servidor está al límite de sesiones activas. Inténtalo de nuevo en unos minutos." };
    }

    // Su carpeta propia, con una copia de los fixtures
    const carpeta = join(this.base, id);
    try {
      rmSync(carpeta, { recursive: true, force: true }); // por si quedó algo de una sesión anterior con el mismo id
      mkdirSync(carpeta, { recursive: true });
      cpSync(join(this.raizProyecto, "fixtures"), join(carpeta, "fixtures"), { recursive: true });
    } catch {
      rmSync(carpeta, { recursive: true, force: true });
      return { ok: false, error: "No se pudo preparar el espacio de trabajo de la sesión." };
    }

    const sesion = crearSesion(id, carpeta);
    this.entradas.set(id, { sesion, ultimoUso: this.ahora() });
    return { ok: true, data: sesion };
  }

  // Quita una sesión y borra su carpeta
  eliminar(id: string): void {
    if (!this.entradas.delete(id)) return;
    rmSync(join(this.base, id), { recursive: true, force: true });
  }

  // Quita las sesiones que caducaron (salvo las que están en medio de un turno). Devuelve cuántas.
  limpiarCaducadas(): number {
    let quitadas = 0;
    for (const [id, entrada] of [...this.entradas]) {
      if (this.caducada(entrada) && !entrada.sesion.ocupada) {
        this.eliminar(id);
        quitadas++;
      }
    }
    return quitadas;
  }

  // Quita la sesión menos usada de las que no están ocupadas. false si todas están ocupadas.
  private expulsarMenosUsada(): boolean {
    let candidata: string | null = null;
    let usoMasAntiguo = Infinity;
    for (const [id, entrada] of this.entradas) {
      if (!entrada.sesion.ocupada && entrada.ultimoUso < usoMasAntiguo) {
        candidata = id;
        usoMasAntiguo = entrada.ultimoUso;
      }
    }
    if (candidata === null) return false;
    this.eliminar(candidata);
    return true;
  }

  // Al apagar el servidor: se borra todo
  cerrar(): void {
    this.entradas.clear();
    rmSync(this.base, { recursive: true, force: true });
  }
}
