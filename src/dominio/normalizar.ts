// =====================================================================
// normalizar.ts — Limpieza de datos antes de compararlos.
//
// Un mismo dato llega escrito distinto según su origen (la cotización
// dice "900.555.111-2" y el maestro "900555111"). Estas funciones lo
// dejan en una forma estándar para poder comparar.
//
// Son funciones PURAS: reciben un valor y devuelven otro, sin leer
// archivos ni depender de nada externo. Por eso son fáciles de probar.
//
// CASOS DELICADOS que este archivo debe cuidar siempre:
//   1. El NIT trae dígito de verificación (-2) que NO es parte del número.
//   2. El punto es separador de miles en Colombia: "11.400.000" = 11400000.
//   3. Las fechas con hora y zona no se convierten: se compara el día escrito.
//   4. Tildes y mayúsculas no deben cambiar el resultado de una comparación.
//   5. Un dato inválido devuelve null; nunca se inventa un valor.
// =====================================================================

// ---------------------------------------------------------------------
// BLOQUE 1 — NIT
// ---------------------------------------------------------------------

// Deja solo los dígitos del NIT, sin puntos ni dígito de verificación.
//   "900.555.111-2" -> "900555111"
//   "900555111"     -> "900555111"   (ya limpio: aplicarla dos veces da igual)
// Limitación conocida: si el dígito de verificación llegara pegado sin guion
// ("9005551112") no hay forma de distinguirlo; no se intenta adivinar.
export function normalizarNit(texto: string): string {
  // Lo que va después del guion es el dígito de verificación: se descarta
  const antesDelGuion = texto.split("-")[0] ?? "";
  // Se eliminan puntos, espacios y letras (por ejemplo el prefijo "NIT")
  return antesDelGuion.replace(/\D/g, "");
}

// ---------------------------------------------------------------------
// BLOQUE 2 — Montos
// ---------------------------------------------------------------------

// Convierte un texto con un monto en un número, o null si no se puede.
//   "COP 11.400.000" -> 11400000   (punto de miles, estilo colombiano)
//   "1.234,56"       -> 1234.56    (coma decimal)
//   "1,234.56"       -> 1234.56    (punto decimal, estilo anglosajón)
//   "abc"            -> null       (nunca se inventa un valor)
// Por qué no usamos parseFloat: parseFloat("11.400.000") devuelve 11.4,
// y un monto equivocado en una orden de compra es un error grave.
// No soporta negativos: los montos de una compra siempre son positivos.
export function parsearMonto(texto: string): number | null {
  // Se toma el primer grupo de dígitos con sus separadores, ignorando "COP", "$", etc.
  const encontrado = texto.match(/\d[\d.,]*/);
  if (!encontrado) return null;

  // Se quita puntuación sobrante al final (por ejemplo "3.200.")
  const numero = encontrado[0].replace(/[.,]+$/, "");
  const tienePunto = numero.includes(".");
  const tieneComa = numero.includes(",");
  let normalizado: string;

  if (tienePunto && tieneComa) {
    // Con ambos separadores, el que aparece último es el decimal
    const decimal = numero.lastIndexOf(",") > numero.lastIndexOf(".") ? "," : ".";
    const miles = decimal === "," ? "." : ",";
    normalizado = numero.split(miles).join("").replace(decimal, ".");
  } else if (tienePunto || tieneComa) {
    // Con un solo tipo de separador hay que decidir si es de miles o decimal
    const separador = tienePunto ? "." : ",";
    const partes = numero.split(separador);
    const ultimaParte = partes[partes.length - 1] ?? "";
    // Es de miles si se repite ("11.400.000") o si deja exactamente 3 dígitos ("1.500")
    const esMiles = partes.length > 2 || ultimaParte.length === 3;
    normalizado = esMiles ? partes.join("") : partes.join(".");
  } else {
    // Sin separadores: ya es un número limpio
    normalizado = numero;
  }

  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

// ---------------------------------------------------------------------
// BLOQUE 3 — Texto (nombres y correos)
// ---------------------------------------------------------------------

// Quita tildes, pasa a minúsculas y colapsa espacios, para comparar sin
// que importe cómo se escribió. Conserva puntos y símbolos, así que sirve
// para correos:
//   "Sofía.Herrera@Periferia-Ficticia.com" -> "sofia.herrera@periferia-ficticia.com"
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD") // separa la letra de su tilde ("í" -> "i" + tilde)
    .replace(/\p{Diacritic}/gu, "") // elimina las tildes sueltas
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Igual que normalizarTexto pero además elimina la puntuación, para comparar
// nombres de empresas cuando no hay NIT (caso sol-006):
//   "Papelería Central Ltda." -> "papeleria central ltda"
export function normalizarNombre(texto: string): string {
  return normalizarTexto(texto).replace(/[^a-z0-9]+/g, " ").trim();
}

// ---------------------------------------------------------------------
// BLOQUE 4 — Fechas
// ---------------------------------------------------------------------

// Devuelve solo el día ("YYYY-MM-DD") de una fecha, o null si es inválida.
//   "2026-08-26T18:45:00-05:00" -> "2026-08-26"
// NO se convierte la zona horaria: se toma el día tal como está escrito.
// Si se convirtiera a UTC, una aprobación a las 22:30 en Colombia caería
// al día siguiente y la comparación con la fecha de solicitud saldría mal.
export function soloDia(fecha: string): string | null {
  const encontrado = fecha.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!encontrado) return null;

  const anio = Number(encontrado[1]);
  const mes = Number(encontrado[2]);
  const dia = Number(encontrado[3]);

  // Se comprueba que el día exista de verdad ("2026-02-30" no existe)
  const prueba = new Date(Date.UTC(anio, mes - 1, dia));
  const existe =
    prueba.getUTCFullYear() === anio &&
    prueba.getUTCMonth() === mes - 1 &&
    prueba.getUTCDate() === dia;

  return existe ? encontrado[0] : null;
}

// ¿La fecha "a" cae en un día anterior a la fecha "b"? Compara solo el día.
// Devuelve null si alguna de las dos es inválida, para que quien la use
// tenga que decidir qué hacer (no se asume ni "sí" ni "no").
// Para RC9 ("aprobación posterior o igual a la solicitud") se usa la negación:
//   esFechaAnterior(aprobacion, solicitud) === false
export function esFechaAnterior(a: string, b: string): boolean | null {
  const diaA = soloDia(a);
  const diaB = soloDia(b);
  if (diaA === null || diaB === null) return null;
  // El formato YYYY-MM-DD se ordena igual como texto que como fecha
  return diaA < diaB;
}
