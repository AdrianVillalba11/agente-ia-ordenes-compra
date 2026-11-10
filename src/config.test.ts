// =====================================================================
// config.test.ts — Pruebas de la configuración.
//
// Comprueban los valores por defecto, que un valor inválido no rompa
// nada y, sobre todo, que ninguna clave salga en lo que se puede
// mostrar en público.
// Se ejecutan con: bun test
// =====================================================================

import { describe, expect, test } from "bun:test";
import { descripcionPublica, leerConfiguracion, MODELO_POR_DEFECTO } from "./config.ts";

// Claves inventadas, que no se parecen a ninguna real (para no confundir a los escáneres de secretos)
const CLAVE = "clave-falsa-solo-para-pruebas";
const CLAVE_ACCESO = "acceso-falso-para-pruebas";

describe("leerConfiguracion", () => {
  test("sin variables usa los valores por defecto y no hay claves", () => {
    expect(leerConfiguracion({})).toEqual({
      proveedor: "gemini",
      modelo: "gemini-3.5-flash-lite",
      claveApi: null,
      maxIteracionesPorTurno: 25,
      maxTokensPorSesion: 300000,
      maxTokensSalida: 2048,
      tiempoLimiteLlmMs: 60000,
      puerto: 3000,
      claveDeAcceso: null,
      maxMensajesPorIp: 30,
      ventanaIpSegundos: 600,
      maxTokensGlobalDiario: 1500000,
      maxSesiones: 100,
      ttlSesionMinutos: 120,
      confiarEnProxy: false,
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
      CLAVE_DE_ACCESO: ` ${CLAVE_ACCESO} `,
      MAX_MENSAJES_POR_IP: "5",
      VENTANA_IP_SEGUNDOS: "60",
      MAX_TOKENS_GLOBAL_DIARIO: "9000",
      MAX_SESIONES: "7",
      TTL_SESION_MINUTOS: "15",
      CONFIAR_EN_PROXY: "true",
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
      claveDeAcceso: CLAVE_ACCESO,
      maxMensajesPorIp: 5,
      ventanaIpSegundos: 60,
      maxTokensGlobalDiario: 9000,
      maxSesiones: 7,
      ttlSesionMinutos: 15,
      confiarEnProxy: true,
    });
  });

  test("un valor numérico inválido (texto, vacío, cero, negativo, decimal) usa el valor por defecto", () => {
    for (const invalido of ["abc", "", "   ", "0", "-5", "2.5"]) {
      const config = leerConfiguracion({
        MAX_ITERACIONES_POR_TURNO: invalido,
        MAX_TOKENS_POR_SESION: invalido,
        PORT: invalido,
        MAX_MENSAJES_POR_IP: invalido,
        MAX_SESIONES: invalido,
      });
      expect(config.maxIteracionesPorTurno).toBe(25);
      expect(config.maxTokensPorSesion).toBe(300000);
      expect(config.puerto).toBe(3000);
      expect(config.maxMensajesPorIp).toBe(30);
      expect(config.maxSesiones).toBe(100);
    }
  });

  test("las variables vacías (como las deja .env.example) cuentan como no configuradas", () => {
    const config = leerConfiguracion({ LLM_PROVIDER: "", LLM_MODEL: "", LLM_API_KEY: "", CLAVE_DE_ACCESO: "  " });
    expect(config.proveedor).toBe("gemini");
    expect(config.modelo).toBe("gemini-3.5-flash-lite");
    expect(config.claveApi).toBeNull();
    expect(config.claveDeAcceso).toBeNull();
  });

  test("la clave puede venir de LLM_API_KEY o de GEMINI_API_KEY, y LLM_API_KEY tiene prioridad", () => {
    expect(leerConfiguracion({ GEMINI_API_KEY: "clave-google" }).claveApi).toBe("clave-google");
    expect(leerConfiguracion({ LLM_API_KEY: "clave-propia", GEMINI_API_KEY: "clave-google" }).claveApi).toBe("clave-propia");
    expect(leerConfiguracion({ LLM_API_KEY: "  ", GEMINI_API_KEY: "clave-google" }).claveApi).toBe("clave-google");
  });

  test("confiar en el proxy solo se activa con un valor afirmativo explícito", () => {
    for (const valor of ["true", "TRUE", "1", "si", "sí"]) expect(leerConfiguracion({ CONFIAR_EN_PROXY: valor }).confiarEnProxy).toBe(true);
    for (const valor of ["false", "0", "no", "", "quizás", "yes"]) expect(leerConfiguracion({ CONFIAR_EN_PROXY: valor }).confiarEnProxy).toBe(false);
  });
});

describe("descripcionPublica", () => {
  test("indica si hay claves, pero ninguna clave aparece", () => {
    const publica = descripcionPublica(leerConfiguracion({ LLM_API_KEY: CLAVE, CLAVE_DE_ACCESO: CLAVE_ACCESO }));
    expect(publica.claveConfigurada).toBe(true);
    expect(publica.requiereClaveDeAcceso).toBe(true);
    const texto = JSON.stringify(publica);
    expect(texto).not.toContain(CLAVE);
    expect(texto).not.toContain(CLAVE_ACCESO);
    expect(Object.keys(publica)).not.toContain("claveApi");
    expect(Object.keys(publica)).not.toContain("claveDeAcceso");
  });

  test("sin claves lo dice", () => {
    const publica = descripcionPublica(leerConfiguracion({}));
    expect(publica.claveConfigurada).toBe(false);
    expect(publica.requiereClaveDeAcceso).toBe(false);
  });

  test("muestra el proveedor, el modelo y los topes", () => {
    expect(descripcionPublica(leerConfiguracion({}))).toEqual({
      proveedor: "gemini",
      modelo: "gemini-3.5-flash-lite",
      claveConfigurada: false,
      requiereClaveDeAcceso: false,
      maxIteracionesPorTurno: 25,
      maxTokensPorSesion: 300000,
    });
  });
});
