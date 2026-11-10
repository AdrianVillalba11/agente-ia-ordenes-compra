// =====================================================================
// componentes.tsx — Las piezas visuales del chat.
//
// Todo el texto del agente se dibuja con elementos de React, que escapan
// cualquier contenido: nunca se usa HTML crudo (dangerouslySetInnerHTML).
// =====================================================================

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { EntradaVisible, LlamadaVisible } from "../src/agente/ciclo.ts";
import { parsearMarkdown, type Bloque, type Segmento } from "./markdown.ts";

// ---------------------------------------------------------------------
// BLOQUE 1 — Texto con formato (Markdown mínimo)
// ---------------------------------------------------------------------

function EnLinea({ segmentos }: { segmentos: Segmento[] }) {
  return (
    <>
      {segmentos.map((segmento, i) =>
        segmento.tipo === "negrita" ? (
          <strong key={i}>{segmento.texto}</strong>
        ) : segmento.tipo === "codigo" ? (
          <code key={i}>{segmento.texto}</code>
        ) : (
          <span key={i}>{segmento.texto}</span>
        ),
      )}
    </>
  );
}

function BloqueMarkdown({ bloque }: { bloque: Bloque }) {
  if (bloque.tipo === "titulo") {
    return (
      <p className="titulo">
        <EnLinea segmentos={bloque.segmentos} />
      </p>
    );
  }
  if (bloque.tipo === "lista") {
    const items = bloque.items.map((item, i) => (
      <li key={i}>
        <EnLinea segmentos={item} />
      </li>
    ));
    return bloque.ordenada ? <ol>{items}</ol> : <ul>{items}</ul>;
  }
  return (
    <p>
      {bloque.lineas.map((linea, i) => (
        <span key={i}>
          {i > 0 && <br />}
          <EnLinea segmentos={linea} />
        </span>
      ))}
    </p>
  );
}

export function Markdown({ texto }: { texto: string }) {
  return (
    <div className="markdown">
      {parsearMarkdown(texto).map((bloque, i) => (
        <BloqueMarkdown key={i} bloque={bloque} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// BLOQUE 2 — Las llamadas a herramientas
// ---------------------------------------------------------------------

const NOMBRES_AMIGABLES: Record<string, string> = {
  oc_leer_paquete: "Leer el paquete",
  oc_validar: "Validar los controles",
  oc_construir_payload: "Armar la OC",
  oc_generar_evidencia: "Generar la evidencia",
  oc_crear: "Crear la OC",
};

type EstadoLlamada = "ok" | "error" | "pendiente" | "confirmada";

const ETIQUETAS: Record<EstadoLlamada, string> = {
  ok: "Correcta",
  error: "Error",
  pendiente: "Requiere confirmación",
  confirmada: "Confirmada por el usuario",
};

function estadoDe(llamada: LlamadaVisible): EstadoLlamada {
  if (llamada.requiereConfirmacion) return "pendiente";
  if (!llamada.ok) return "error";
  return llamada.confirmadoPorUsuario ? "confirmada" : "ok";
}

// Los argumentos en una línea: caso: sol-004
function argumentosEnTexto(argumentos: Record<string, unknown>): string {
  return Object.entries(argumentos)
    .map(([nombre, valor]) => `${nombre}: ${typeof valor === "string" ? valor : JSON.stringify(valor)}`)
    .join(", ");
}

export function TarjetaHerramienta({ llamada }: { llamada: LlamadaVisible }) {
  const estado = estadoDe(llamada);
  return (
    <li className={`herramienta herramienta--${estado}`}>
      <span className="herramienta__punto" aria-hidden="true" />
      <div className="herramienta__cuerpo">
        <div className="herramienta__titulo">
          <strong>{NOMBRES_AMIGABLES[llamada.herramienta] ?? llamada.herramienta}</strong>
          <code>{llamada.herramienta}</code>
          <span className={`etiqueta etiqueta--${estado}`}>{ETIQUETAS[estado]}</span>
        </div>
        <div className="herramienta__argumentos">{argumentosEnTexto(llamada.argumentos)}</div>
        <div className="herramienta__resumen">{llamada.resumen}</div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Mensajes de la conversación
// ---------------------------------------------------------------------

export function BurbujaMensaje({ mensaje }: { mensaje: EntradaVisible }) {
  if (mensaje.rol === "usuario") {
    return (
      <div className="mensaje mensaje--usuario">
        <div className="burbuja">{mensaje.texto}</div>
      </div>
    );
  }

  return (
    <div className="mensaje mensaje--asistente">
      <div className="avatar" aria-hidden="true">
        A
      </div>
      <div className="mensaje__contenido">
        {mensaje.llamadas.length > 0 && (
          <details className="pasos" open>
            <summary>Pasos del agente ({mensaje.llamadas.length})</summary>
            <ul>
              {mensaje.llamadas.map((llamada, i) => (
                <TarjetaHerramienta key={i} llamada={llamada} />
              ))}
            </ul>
          </details>
        )}
        <div className={`burbuja${mensaje.esError === true ? " burbuja--error" : ""}`}>
          <Markdown texto={mensaje.texto} />
        </div>
      </div>
    </div>
  );
}

export function Pensando({ segundos }: { segundos: number }) {
  return (
    <div className="mensaje mensaje--asistente">
      <div className="avatar" aria-hidden="true">
        A
      </div>
      <div className="burbuja pensando" role="status">
        <span className="puntos" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        El agente está trabajando… {segundos} s
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// BLOQUE 4 — Bienvenida y ejemplos
// ---------------------------------------------------------------------

const EJEMPLOS: { etiqueta: string; mensaje: string }[] = [
  { etiqueta: "Un caso limpio (sol-001)", mensaje: "Procesa la solicitud sol-001" },
  {
    etiqueta: "Con una excepción (sol-004)",
    mensaje:
      "Procesa la solicitud sol-004. Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.",
  },
  { etiqueta: "Un caso bloqueado (sol-002)", mensaje: "Procesa la solicitud sol-002" },
  { etiqueta: "Compra retroactiva (sol-005)", mensaje: "Procesa la solicitud sol-005" },
  { etiqueta: "Preguntar por una regla", mensaje: "¿Qué significa la regla RC5?" },
];

export function Bienvenida({ onEjemplo, deshabilitado }: { onEjemplo: (mensaje: string) => void; deshabilitado: boolean }) {
  return (
    <div className="bienvenida">
      <h2>¿Qué solicitud procesamos?</h2>
      <p>
        Soy el asistente de órdenes de compra. Leo la solicitud, la cotización y la aprobación, valido los controles contra los
        maestros y creo la OC en un SAP simulado. Lo que genere dudas te lo pregunto antes de crear nada.
      </p>
      <p className="bienvenida__ayuda">Prueba con uno de estos ejemplos o escribe tu propia petición:</p>
      <div className="ejemplos">
        {EJEMPLOS.map((ejemplo) => (
          <button key={ejemplo.etiqueta} type="button" className="chip" disabled={deshabilitado} onClick={() => onEjemplo(ejemplo.mensaje)}>
            {ejemplo.etiqueta}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// BLOQUE 5 — Confirmación pendiente
// ---------------------------------------------------------------------

// Los botones envían EXACTAMENTE lo que el usuario podría escribir: el servidor decide si es una
// confirmación válida con las mismas reglas de siempre, no por venir de un botón.
export function AvisoConfirmacion({
  pendientes,
  deshabilitado,
  onEnviar,
}: {
  pendientes: string[];
  deshabilitado: boolean;
  onEnviar: (mensaje: string) => void;
}) {
  if (pendientes.length === 0) return null;
  return (
    <section className="aviso-confirmacion" aria-live="polite">
      <div className="aviso-confirmacion__texto">
        <strong>Esperando tu confirmación</strong>
        <span>
          {pendientes.length === 1 ? "Hay una excepción pendiente en " : "Hay excepciones pendientes en "}
          {pendientes.map((caso) => (
            <code key={caso}>{caso}</code>
          ))}
          . La OC no se crea hasta que la confirmes.
        </span>
      </div>
      <div className="aviso-confirmacion__acciones">
        {pendientes.map((caso) => (
          <button key={caso} type="button" className="boton boton--principal" disabled={deshabilitado} onClick={() => onEnviar(`Confirmo ${caso}`)}>
            Confirmo {caso}
          </button>
        ))}
        <button type="button" className="boton" disabled={deshabilitado} onClick={() => onEnviar("No, espera")}>
          No, espera
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// BLOQUE 6 — Caja de entrada
// ---------------------------------------------------------------------

const MAX_CARACTERES = 4000;

export function CajaEntrada({ onEnviar, deshabilitado }: { onEnviar: (mensaje: string) => void; deshabilitado: boolean }) {
  const [texto, setTexto] = useState("");
  const caja = useRef<HTMLTextAreaElement>(null);

  // La caja crece con lo que se escribe (hasta un máximo). Vacía, usa su altura natural de una línea:
  // medirla vacía daba un valor inflado cuando aún no tenía su ancho final.
  useEffect(() => {
    const elemento = caja.current;
    if (elemento === null) return;
    if (texto === "") {
      elemento.style.height = "";
      return;
    }
    elemento.style.height = "auto";
    elemento.style.height = `${Math.min(elemento.scrollHeight, 160)}px`;
  }, [texto]);

  const enviar = (): void => {
    const limpio = texto.trim();
    if (limpio === "" || deshabilitado) return;
    onEnviar(limpio);
    setTexto("");
  };

  const alEnviar = (evento: FormEvent): void => {
    evento.preventDefault();
    enviar();
  };

  // Enter envía; Mayús + Enter hace un salto de línea (y no se interfiere con la escritura por IME)
  const alTeclear = (evento: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (evento.key === "Enter" && !evento.shiftKey && !evento.nativeEvent.isComposing) {
      evento.preventDefault();
      enviar();
    }
  };

  const cerca = texto.length > MAX_CARACTERES * 0.9;
  return (
    <form className="entrada" onSubmit={alEnviar}>
      <label htmlFor="mensaje" className="solo-lectores">
        Escribe tu mensaje
      </label>
      <textarea
        id="mensaje"
        ref={caja}
        value={texto}
        rows={1}
        maxLength={MAX_CARACTERES}
        placeholder="Escribe tu mensaje…"
        title="Enter envía · Mayús + Enter salta de línea"
        onChange={(evento) => setTexto(evento.target.value)}
        onKeyDown={alTeclear}
        disabled={deshabilitado}
      />
      <button type="submit" className="boton boton--principal" disabled={deshabilitado || texto.trim() === ""}>
        Enviar
      </button>
      {cerca && <span className="contador">{texto.length}/{MAX_CARACTERES}</span>}
    </form>
  );
}

// ---------------------------------------------------------------------
// BLOQUE 7 — Pantalla de la clave de acceso
// ---------------------------------------------------------------------

export function PantallaClave({ onEntrar, error, comprobando }: { onEntrar: (clave: string) => void; error: string | null; comprobando: boolean }) {
  const [clave, setClave] = useState("");
  return (
    <main className="pantalla-clave">
      <form
        className="tarjeta-clave"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (clave.trim() !== "") onEntrar(clave.trim());
        }}
      >
        <h1>Agente de órdenes de compra</h1>
        <p>Esta demo está protegida. Escribe la clave de acceso que te dieron para continuar.</p>
        <label htmlFor="clave">Clave de acceso</label>
        <input id="clave" type="password" autoComplete="off" value={clave} onChange={(evento) => setClave(evento.target.value)} autoFocus />
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="boton boton--principal" disabled={comprobando || clave.trim() === ""}>
          {comprobando ? "Comprobando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
