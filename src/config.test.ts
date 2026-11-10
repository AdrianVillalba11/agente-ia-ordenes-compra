// =====================================================================
// config.test.ts — Pruebas de la configuración.
//
// Comprueban los valores por defecto, que un valor inválido no rompa
// nada y, sobre todo, que la clave del modelo nunca salga en lo que se
// puede mostrar en público.
// Se ejecutan con: bun test
// =====================================================================

import { describe, expect, test } from "bun:test";
import { descripcionPublica, leerConfiguracion, MODELO_POR_DEFECTO } from "./config.ts";

// Una clave inventada, que no se parece a ninguna real (para no confundir a los escáneres de secretos)
const CLAVE = "clave-falsa-solo-para-pruebas";

describe("leerConfiguracion", () => {
  test("sin variables usa los valores por defecto y no hay clave", () => {
    expect(leerConfiguracion({})).toEqual({
      proveedor: "gemini",
      modelo: "gemini-3.5-flash-lite",
      claveApi: null,
      maxIteracionesPorTurno: 25,
      maxTokensPorSesion: 300000,
      maxTokensSalida: 2048,
      tiempoLimiteLlmMs: 60000,
      puerto: 3000,
    });
    expect(MODELO_POR_DEFECTO).toBe("gemini-3.5-flash-lite");
  });

  test("lee los valores indicados", () => {
    const config = leerConfiguracion({
      LLM_PROVIDER: "Gemini",
      LLM_MODEL: " gemini-3.6-flash ",
      LLM_API_KEY: CLAVE,
      MAX_ITERACIONES_POR_TURNO: "10",
      MAX_TOKENS_POR_SESION: "50000",
      MAX_TOKENS_SALIDA: "1024",
      TIEMPO_LIMITE_LLM_MS: "5000",
      PORT: "8080",
    });
    expect(config).toEqual({
      proveedor: "gemini", // se normaliza a minúsculas
      modelo: "gemini-3.6-flash", // sin espacios sobrantes
      claveApi: CLAVE,
      maxIteracionesPorTurno: 10,
      maxTokensPorSesion: 50000,
      maxTokensSalida: 1024,
      tiempoLimiteLlmMs: 5000,
      puerto: 8080,
    });
  });

  test("un valor numérico inválido (texto, vacío, cero, negativo, decimal) usa el valor por defecto", () => {
    for (const invalido of ["abc", "", "   ", "0", "-5", "2.5"]) {
      const config = leerConfiguracion({ MAX_ITERACIONES_POR_TURNO: invalido, MAX_TOKENS_POR_SESION: invalido, PORT: invalido });
      expect(config.maxIteracionesPorTurno).toBe(25);
      expect(config.maxTokensPorSesion).toBe(300000);
      expect(config.puerto).toBe(3000);
    }
  });

  test("las variables vacías (como las deja .env.example) cuentan como no configuradas", () => {
    const config = leerConfiguracion({ LLM_PROVIDER: "", LLM_MODEL: "", LLM_API_KEY: "" });
    expect(config.proveedor).toBe("gemini");
    expect(config.modelo).toBe("gemini-3.5-flash-lite");
    expect(config.claveApi).toBeNull();
  });

  test("la clave puede venir de LLM_API_KEY o de GEMINI_API_KEY, y LLM_API_KEY tiene prioridad", () => {
    expect(leerConfiguracion({ GEMINI_API_KEY: "clave-google" }).claveApi).toBe("clave-google");
    expect(leerConfiguracion({ LLM_API_KEY: "clave-propia", GEMINI_API_KEY: "clave-google" }).claveApi).toBe("clave-propia");
    expect(leerConfiguracion({ LLM_API_KEY: "  ", GEMINI_API_KEY: "clave-google" }).claveApi).toBe("clave-google");
  });
});

describe("descripcionPublica", () => {
  test("indica si hay clave, pero la clave nunca aparece", () => {
    const publica = descripcionPublica(leerConfiguracion({ LLM_API_KEY: CLAVE }));
    expect(publica.claveConfigurada).toBe(true);
    expect(JSON.stringify(publica)).not.toContain(CLAVE);
    expect(Object.keys(publica)).not.toContain("claveApi");
  });

  test("sin clave lo dice", () => {
    expect(descripcionPublica(leerConfiguracion({})).claveConfigurada).toBe(false);
  });

  test("muestra el proveedor, el modelo y los topes", () => {
    expect(descripcionPublica(leerConfiguracion({}))).toEqual({
      proveedor: "gemini",
      modelo: "gemini-3.5-flash-lite",
      claveConfigurada: false,
      maxIteracionesPorTurno: 25,
      maxTokensPorSesion: 300000,
    });
  });
});
