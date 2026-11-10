// =====================================================================
// limites.test.ts — Pruebas de los límites que protegen la clave del modelo.
//
// Usan relojes controlados: no esperan nada de verdad.
// Se ejecutan con: bun test
// =====================================================================

import { describe, expect, test } from "bun:test";
import { LimitadorPorVentana, PresupuestoDiario } from "./limites.ts";

function relojControlado(inicio = 0): { reloj: () => number; avanzar: (ms: number) => void } {
  let ahora = inicio;
  return { reloj: () => ahora, avanzar: (ms) => (ahora += ms) };
}

describe("LimitadorPorVentana", () => {
  test("permite hasta el máximo y rechaza la siguiente, diciendo cuánto esperar", () => {
    const { reloj, avanzar } = relojControlado();
    const limitador = new LimitadorPorVentana(3, 60_000, reloj);

    for (let i = 0; i < 3; i++) {
      expect(limitador.permitir("1.2.3.4")).toEqual({ permitido: true, reintentarEnSegundos: 0 });
      avanzar(1000);
    }
    // Van 3 solicitudes (en 0 s, 1 s y 2 s); estamos en el segundo 3. La más antigua vence en el 60.
    expect(limitador.permitir("1.2.3.4")).toEqual({ permitido: false, reintentarEnSegundos: 57 });
  });

  test("al pasar la ventana se libera cupo, de forma deslizante (una a una)", () => {
    const { reloj, avanzar } = relojControlado();
    const limitador = new LimitadorPorVentana(2, 10_000, reloj);

    limitador.permitir("a"); // t = 0
    avanzar(5000);
    limitador.permitir("a"); // t = 5
    expect(limitador.permitir("a").permitido).toBe(false); // t = 5: lleno

    avanzar(5001); // t = 10,001: la primera ya venció, la segunda todavía no
    expect(limitador.permitir("a").permitido).toBe(true);
    expect(limitador.permitir("a").permitido).toBe(false);
  });

  test("cada visitante tiene su propio cupo", () => {
    const limitador = new LimitadorPorVentana(1, 60_000, relojControlado().reloj);
    expect(limitador.permitir("visitante-1").permitido).toBe(true);
    expect(limitador.permitir("visitante-1").permitido).toBe(false);
    expect(limitador.permitir("visitante-2").permitido).toBe(true);
  });

  test("un intento rechazado no cuenta ni alarga el bloqueo", () => {
    const { reloj, avanzar } = relojControlado();
    const limitador = new LimitadorPorVentana(1, 10_000, reloj);
    limitador.permitir("a"); // t = 0

    for (let i = 0; i < 5; i++) {
      avanzar(1000);
      expect(limitador.permitir("a").permitido).toBe(false); // se insiste mientras está bloqueado
    }
    avanzar(5001); // t = 10,001: el bloqueo termina a los 10 s del único intento aceptado
    expect(limitador.permitir("a").permitido).toBe(true);
  });

  test("la espera que se indica nunca es menor a 1 segundo", () => {
    const { reloj, avanzar } = relojControlado();
    const limitador = new LimitadorPorVentana(1, 10_000, reloj);
    limitador.permitir("a");
    avanzar(9_999); // falta 1 milisegundo
    expect(limitador.permitir("a")).toEqual({ permitido: false, reintentarEnSegundos: 1 });
  });

  test("consultar mira el estado sin gastar cupo", () => {
    const limitador = new LimitadorPorVentana(2, 60_000, relojControlado().reloj);
    for (let i = 0; i < 10; i++) expect(limitador.consultar("a").permitido).toBe(true); // consultar no cuenta
    expect(limitador.permitir("a").permitido).toBe(true);
    expect(limitador.permitir("a").permitido).toBe(true);
    expect(limitador.consultar("a")).toEqual({ permitido: false, reintentarEnSegundos: 60 });
  });

  test("purgar borra a los visitantes que ya no tienen nada vigente", () => {
    const { reloj, avanzar } = relojControlado();
    const limitador = new LimitadorPorVentana(5, 10_000, reloj);
    limitador.permitir("a");
    limitador.permitir("b");
    expect(limitador.claves).toBe(2);

    avanzar(10_001);
    limitador.permitir("c"); // c es reciente
    limitador.purgar();
    expect(limitador.claves).toBe(1);
  });
});

describe("PresupuestoDiario", () => {
  test("se agota al llegar al tope", () => {
    const presupuesto = new PresupuestoDiario(1000, () => new Date("2026-11-09T20:00:00Z"));
    expect(presupuesto.agotado()).toBe(false);

    presupuesto.registrar(600);
    expect(presupuesto.usado).toBe(600);
    expect(presupuesto.agotado()).toBe(false);

    presupuesto.registrar(400);
    expect(presupuesto.agotado()).toBe(true); // justo en el tope ya cuenta como agotado
    expect(presupuesto.limite).toBe(1000);
  });

  test("los tokens negativos no restan", () => {
    const presupuesto = new PresupuestoDiario(1000, () => new Date("2026-11-09T20:00:00Z"));
    presupuesto.registrar(500);
    presupuesto.registrar(-300);
    expect(presupuesto.usado).toBe(500);
  });

  test("el día cambia a la medianoche de COLOMBIA, no a la de UTC", () => {
    let ahora = new Date("2026-11-09T20:00:00Z"); // 3:00 p. m. del 9 en Bogotá
    const presupuesto = new PresupuestoDiario(1000, () => ahora);
    presupuesto.registrar(1000);
    expect(presupuesto.agotado()).toBe(true);

    ahora = new Date("2026-11-10T04:59:00Z"); // 11:59 p. m. del 9 en Bogotá (en UTC ya es el 10)
    expect(presupuesto.agotado()).toBe(true); // sigue siendo el mismo día de negocio

    ahora = new Date("2026-11-10T05:00:00Z"); // medianoche del 10 en Bogotá
    expect(presupuesto.agotado()).toBe(false);
    expect(presupuesto.usado).toBe(0);
  });

  test("un día nuevo empieza de cero y vuelve a contar", () => {
    let ahora = new Date("2026-11-09T20:00:00Z");
    const presupuesto = new PresupuestoDiario(500, () => ahora);
    presupuesto.registrar(500);

    ahora = new Date("2026-11-10T20:00:00Z");
    presupuesto.registrar(200);
    expect(presupuesto.usado).toBe(200);
    expect(presupuesto.agotado()).toBe(false);
  });
});
