// =====================================================================
// limites.ts — Límites para proteger la clave del modelo en una URL pública.
//
// El tope de tokens por sesión no basta: alguien podría abrir muchas
// sesiones. Por eso hay dos límites más, que viven en memoria:
//   - LimitadorPorVentana: cuántos mensajes puede enviar un mismo visitante
//     (por dirección IP) en una ventana de tiempo.
//   - PresupuestoDiario: cuántos tokens puede gastar TODO el servidor en un día.
//
// Ambos reciben el reloj como parámetro para poder probarlos sin esperar.
// =====================================================================

import { diaEnBogota } from "../sap/mock.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Límite por visitante
// ---------------------------------------------------------------------

export type ResultadoLimite = { permitido: boolean; reintentarEnSegundos: number };

// Ventana deslizante: se permiten "maximo" solicitudes en cualquier intervalo de "ventanaMs"
export class LimitadorPorVentana {
  private readonly registros = new Map<string, number[]>();
  private readonly maximo: number;
  private readonly ventanaMs: number;
  private readonly ahora: () => number;

  constructor(maximo: number, ventanaMs: number, ahora: () => number = Date.now) {
    this.maximo = maximo;
    this.ventanaMs = ventanaMs;
    this.ahora = ahora;
  }

  // Los instantes de esta clave que todavía cuentan (los más viejos que la ventana se descartan)
  private vigentes(clave: string, ahora: number): number[] {
    const instantes = (this.registros.get(clave) ?? []).filter((instante) => instante > ahora - this.ventanaMs);
    if (instantes.length === 0) this.registros.delete(clave);
    else this.registros.set(clave, instantes);
    return instantes;
  }

  // ¿Puede esta clave hacer una solicitud ahora? Solo mira: NO la cuenta.
  // (Sirve para bloquear a quien ya agotó sus intentos aunque después acierte.)
  consultar(clave: string): ResultadoLimite {
    const ahora = this.ahora();
    const instantes = this.vigentes(clave, ahora);

    if (instantes.length >= this.maximo) {
      const masAntiguo = instantes[0] ?? ahora;
      return { permitido: false, reintentarEnSegundos: Math.max(1, Math.ceil((masAntiguo + this.ventanaMs - ahora) / 1000)) };
    }
    return { permitido: true, reintentarEnSegundos: 0 };
  }

  // ¿Puede esta clave hacer una solicitud ahora? Si puede, la cuenta.
  permitir(clave: string): ResultadoLimite {
    const estado = this.consultar(clave);
    if (estado.permitido) this.registros.set(clave, [...(this.registros.get(clave) ?? []), this.ahora()]);
    return estado;
  }

  // Borra las claves que ya no tienen nada vigente (para que la memoria no crezca sin fin)
  purgar(): void {
    const ahora = this.ahora();
    for (const clave of [...this.registros.keys()]) this.vigentes(clave, ahora);
  }

  get claves(): number {
    return this.registros.size;
  }
}

// ---------------------------------------------------------------------
// BLOQUE 2 — Presupuesto diario de tokens
// ---------------------------------------------------------------------

// Cuenta los tokens que gasta todo el servidor en un día (en hora de Colombia) y avisa cuando se agota.
// Al empezar un día nuevo, la cuenta vuelve a cero.
export class PresupuestoDiario {
  private readonly tope: number;
  private readonly ahora: () => Date;
  private dia: string;
  private gastado = 0;

  constructor(tope: number, ahora: () => Date = () => new Date()) {
    this.tope = tope;
    this.ahora = ahora;
    this.dia = diaEnBogota(ahora());
  }

  private alDia(): void {
    const hoy = diaEnBogota(this.ahora());
    if (hoy !== this.dia) {
      this.dia = hoy;
      this.gastado = 0;
    }
  }

  registrar(tokens: number): void {
    this.alDia();
    this.gastado += Math.max(0, tokens);
  }

  agotado(): boolean {
    this.alDia();
    return this.gastado >= this.tope;
  }

  get usado(): number {
    this.alDia();
    return this.gastado;
  }

  get limite(): number {
    return this.tope;
  }
}
