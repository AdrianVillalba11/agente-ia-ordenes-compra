// =====================================================================
// modulo/tools/oc.ts — Las herramientas de órdenes de compra, importables sin el servidor.
//
// No es una copia: reexporta el MISMO módulo que usa la aplicación
// (src/tools/oc.ts). Cada export es una herramienta { description, args, execute }
// y su nombre público es oc_<export> (oc_leer_paquete, oc_validar,
// oc_construir_payload, oc_generar_evidencia, oc_crear).
//
// No depende de server.ts, del ciclo del agente ni del modelo: solo del dominio
// y del adaptador de SAP. Para ejecutarlas con validación de argumentos y registro,
// ver ejecutarHerramienta en src/tools/registro.ts.
// =====================================================================

export * from "../../src/tools/oc.ts";
