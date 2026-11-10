// =====================================================================
// app.tsx — El chat: estado, comunicación con el servidor y pantalla.
//
// Lo que exige el PRD del front:
//   - historial de la conversación, campo de entrada e indicador de "pensando";
//   - mostrar CADA llamada a herramienta (nombre, argumentos y resultado resumido);
//   - RESALTAR cuando el agente pide confirmación.
// =====================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EntradaVisible } from "../src/agente/ciclo.ts";
import { enviarMensaje, ErrorApi, obtenerHistorial, obtenerSalud, type Salud } from "./api.ts";
import { AvisoConfirmacion, Bienvenida, BurbujaMensaje, CajaEntrada, PantallaClave, Pensando } from "./componentes.tsx";

// ---------------------------------------------------------------------
// BLOQUE 1 — Identificador de sesión y clave de acceso (guardados en el navegador)
// ---------------------------------------------------------------------

const CLAVE_SESION = "oc-sesion";
const CLAVE_ACCESO = "oc-acceso";
const PATRON_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Un identificador aleatorio. randomUUID solo existe en conexiones seguras, por eso hay un plan B.
function generarId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function leerAlmacen(almacen: Storage, nombre: string): string | null {
  try {
    return almacen.getItem(nombre);
  } catch {
    return null; // el navegador puede bloquear el almacenamiento
  }
}

function escribirAlmacen(almacen: Storage, nombre: string, valor: string | null): void {
  try {
    if (valor === null) almacen.removeItem(nombre);
    else almacen.setItem(nombre, valor);
  } catch {
    // Sin almacenamiento, la sesión simplemente no se recuerda al recargar
  }
}

function idDeSesionInicial(): string {
  const guardado = leerAlmacen(localStorage, CLAVE_SESION);
  if (guardado !== null && PATRON_ID.test(guardado)) return guardado;
  const nuevo = generarId();
  escribirAlmacen(localStorage, CLAVE_SESION, nuevo);
  return nuevo;
}

// ---------------------------------------------------------------------
// BLOQUE 2 — La aplicación
// ---------------------------------------------------------------------

function App() {
  const [sessionId, setSessionId] = useState<string>(idDeSesionInicial);
  const [clave, setClave] = useState<string | null>(() => leerAlmacen(sessionStorage, CLAVE_ACCESO));
  const [salud, setSalud] = useState<Salud | null>(null);
  const [mensajes, setMensajes] = useState<EntradaVisible[]>([]);
  const [pendientes, setPendientes] = useState<string[]>([]);
  const [tokens, setTokens] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [necesitaClave, setNecesitaClave] = useState(false);
  const [errorClave, setErrorClave] = useState<string | null>(null);
  const [comprobando, setComprobando] = useState(false);
  const [avisoGlobal, setAvisoGlobal] = useState<string | null>(null);
  const finDeLaConversacion = useRef<HTMLDivElement>(null);

  // --- Cargar el historial de la sesión (si el servidor la recuerda) ---

  const cargarHistorial = useCallback(async (id: string, claveAcceso: string | null): Promise<void> => {
    try {
      const historial = await obtenerHistorial(id, claveAcceso);
      setMensajes(historial.mensajes);
      setPendientes(historial.pendientes);
      setTokens(historial.tokensUsados);
    } catch (error) {
      if (error instanceof ErrorApi && error.requiereClave) setNecesitaClave(true);
      // Un 404 significa que la sesión es nueva o caducó: se empieza en blanco
    }
  }, []);

  // Al abrir la página: se pregunta al servidor cómo está y, si hace falta, se pide la clave
  useEffect(() => {
    let cancelado = false;
    void (async () => {
      try {
        const estado = await obtenerSalud();
        if (cancelado) return;
        setSalud(estado);
        if (estado.requiereClaveDeAcceso && clave === null) {
          setNecesitaClave(true);
          return;
        }
        await cargarHistorial(sessionId, clave);
      } catch (error) {
        if (!cancelado) setAvisoGlobal(error instanceof ErrorApi ? error.message : "No se pudo contactar con el servidor.");
      }
    })();
    return () => {
      cancelado = true;
    };
    // Solo al abrir la página
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El contador de segundos mientras el agente trabaja
  useEffect(() => {
    if (!enviando) return;
    setSegundos(0);
    const intervalo = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(intervalo);
  }, [enviando]);

  // Siempre se ve lo último
  useEffect(() => {
    finDeLaConversacion.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [mensajes, enviando, pendientes]);

  // --- Acciones ---

  const enviar = useCallback(
    async (texto: string): Promise<void> => {
      if (enviando) return;
      setAvisoGlobal(null);
      setMensajes((anteriores) => [...anteriores, { rol: "usuario", texto, llamadas: [] }]);
      setEnviando(true);
      try {
        const respuesta = await enviarMensaje(sessionId, texto, clave);
        setMensajes((anteriores) => [
          ...anteriores,
          {
            rol: "asistente",
            texto: respuesta.reply,
            llamadas: respuesta.toolCalls,
            necesitaConfirmacion: respuesta.needsConfirmation,
            esError: respuesta.error !== null,
          },
        ]);
        setPendientes(respuesta.pendientes);
        setTokens(respuesta.tokensSesion);
      } catch (error) {
        const mensaje = error instanceof ErrorApi ? error.message : "Ocurrió un error inesperado. Inténtalo de nuevo.";
        if (error instanceof ErrorApi && error.estado === 401) {
          escribirAlmacen(sessionStorage, CLAVE_ACCESO, null);
          setClave(null);
          setNecesitaClave(true);
        }
        setMensajes((anteriores) => [...anteriores, { rol: "asistente", texto: mensaje, llamadas: [], esError: true }]);
      } finally {
        setEnviando(false);
      }
    },
    [enviando, sessionId, clave],
  );

  const nuevaSesion = (): void => {
    if (enviando) return;
    const nuevo = generarId();
    escribirAlmacen(localStorage, CLAVE_SESION, nuevo);
    setSessionId(nuevo);
    setMensajes([]);
    setPendientes([]);
    setTokens(0);
    setAvisoGlobal(null);
  };

  // Se comprueba la clave pidiendo el historial: un 404 significa "clave aceptada, la sesión es nueva"
  const entrarConClave = async (candidata: string): Promise<void> => {
    setComprobando(true);
    setErrorClave(null);
    try {
      await obtenerHistorial(sessionId, candidata).then((historial) => {
        setMensajes(historial.mensajes);
        setPendientes(historial.pendientes);
        setTokens(historial.tokensUsados);
      });
      aceptarClave(candidata);
    } catch (error) {
      if (error instanceof ErrorApi && error.estado === 404) aceptarClave(candidata);
      else if (error instanceof ErrorApi && error.estado === 401) setErrorClave("La clave no es correcta.");
      else setErrorClave(error instanceof ErrorApi ? error.message : "No se pudo comprobar la clave.");
    } finally {
      setComprobando(false);
    }
  };

  const aceptarClave = (candidata: string): void => {
    escribirAlmacen(sessionStorage, CLAVE_ACCESO, candidata);
    setClave(candidata);
    setNecesitaClave(false);
  };

  // --- Pantalla ---

  if (necesitaClave) return <PantallaClave onEntrar={(c) => void entrarConClave(c)} error={errorClave} comprobando={comprobando} />;

  const sinClaveDelModelo = salud !== null && !salud.claveConfigurada;
  return (
    <div className="app">
      <header className="cabecera">
        <div className="cabecera__titulo">
          <h1>Agente de órdenes de compra</h1>
          <p>SAP simulado · datos ficticios</p>
        </div>
        <div className="cabecera__estado">
          {salud !== null && (
            <span className={`insignia ${sinClaveDelModelo ? "insignia--alerta" : "insignia--ok"}`} title="Modelo de lenguaje en uso">
              <span className="insignia__punto" aria-hidden="true" />
              {sinClaveDelModelo ? "Sin clave del modelo" : salud.modelo}
            </span>
          )}
          <span className="insignia insignia--neutra" title="Tokens usados en esta sesión">
            {new Intl.NumberFormat("es-CO").format(tokens)} tokens
          </span>
          <button type="button" className="boton" onClick={nuevaSesion} disabled={enviando}>
            Nueva sesión
          </button>
        </div>
      </header>

      <main className="conversacion" role="log" aria-live="polite" aria-label="Conversación con el agente">
        {sinClaveDelModelo && (
          <div className="aviso aviso--alerta" role="alert">
            El servidor no tiene configurada la clave del modelo de lenguaje, así que el agente no podrá responder todavía.
          </div>
        )}
        {avisoGlobal !== null && (
          <div className="aviso aviso--error" role="alert">
            {avisoGlobal}
          </div>
        )}
        {mensajes.length === 0 && !enviando && <Bienvenida onEjemplo={(m) => void enviar(m)} deshabilitado={enviando} />}
        {mensajes.map((mensaje, i) => (
          <BurbujaMensaje key={i} mensaje={mensaje} />
        ))}
        {enviando && <Pensando segundos={segundos} />}
        <div ref={finDeLaConversacion} />
      </main>

      <footer className="pie">
        <AvisoConfirmacion pendientes={pendientes} deshabilitado={enviando} onEnviar={(m) => void enviar(m)} />
        <CajaEntrada onEnviar={(m) => void enviar(m)} deshabilitado={enviando} />
        <p className="pie__nota">Cada sesión tiene su propio SAP simulado. Las confirmaciones las decides tú: el agente no puede darlas por ti.</p>
      </footer>
    </div>
  );
}

const contenedor = document.getElementById("raiz");
if (contenedor !== null) createRoot(contenedor).render(<App />);
