# Conocimiento del proceso de órdenes de compra

## El proceso

Cada compra llega por correo con tres piezas: la solicitud de compra, la cotización del proveedor y el correo de aprobación del líder. Hoy la analista digita todo en SAP a mano. El agente automatiza ese trabajo: lee el paquete, lo valida contra los maestros (proveedores, centros de costo con sus aprobadores y topes, indicadores de IVA y condiciones de pago), arma la OC, guarda la evidencia de la aprobación y crea la OC en SAP (en este reto, un SAP simulado).

Lo que no cumple un control no se arregla a la fuerza: se bloquea o se pide la confirmación de una persona.

## Los controles

Bloqueos: impiden crear la OC. No hay forma de saltarlos.

- **RC1, proveedor.** Debe existir en el maestro (se busca por NIT; si la solicitud no trae NIT, por nombre) y estar activo. Acción: pedir el alta del proveedor o su reactivación.
- **RC2, aprobación.** Debe existir, decir "Aprobado" y venir de un aprobador del centro de costo de la solicitud. Un aprobador con tope alto en OTRO centro de costo no sirve para este. Acción: pedir la aprobación a un aprobador del centro; si el valor supera el tope de todos, escalar.
- **RC3, tope.** El valor total no puede superar el tope de quien aprobó en ese centro (un valor igual al tope sí se permite). Acción: pedir la aprobación a alguien con tope suficiente.
- **RC4, subárea.** Debe pertenecer al centro de costo de la solicitud.
- **RC10, aritmética.** Cantidad por valor unitario debe dar el valor total, con una tolerancia de 1 unidad monetaria.

Confirmaciones: la OC solo se crea si una persona las confirma.

- **RC5, cotización.** El total de la cotización no debe diferir del de la solicitud en más de 2 %. Si difiere más, se muestran ambos valores. Si no hay cotización (o no se pudo leer), también se pide confirmación.
- **RC6, IVA ausente.** La solicitud no trae indicador de IVA: se propone el del proveedor.
- **RC8, compra retroactiva.** Existe una factura con fecha anterior a la solicitud.
- **RC9, aprobación anterior a la solicitud.** La fecha de la aprobación es anterior a la de la solicitud.

Derivados: solo se informan.

- **RC7, condiciones de pago ausentes.** Se toman las del proveedor.

## Cómo leer los resultados de las herramientas

- `oc_validar`: `apta` (verdadero si no hay bloqueos), `bloqueos` y `confirmaciones` (cada una con su código de regla, el detalle y la acción sugerida), `derivados` (valores completados desde los maestros, con su fuente) y `retroactiva`.
- `oc_construir_payload`: la `orden` (lo que se enviaría a SAP, con proveedor, posiciones, aprobador y `excepciones`), las `advertencias` y la ruta de la trazabilidad, que dice de dónde sale cada valor.
- `oc_generar_evidencia`: las rutas del archivo de texto y del PDF de la aprobación, y su huella (hash).
- `oc_crear`: el `numero_oc` y si `idempotente` es verdadero (la solicitud ya tenía OC y se devuelve la existente). Si falta confirmación, el resultado trae `requiere_confirmacion` y la lista de lo que hay que confirmar.

## La compra retroactiva

Muchas OC se crean después de que llega la factura, saltándose la cotización. La dirección quiere medir cuántas son. El agente no las rechaza: pide confirmación y las deja marcadas como retroactivas en el registro de control (`out/control.csv`). Qué hacer con ellas (tolerarlas con marca o rechazarlas) es una decisión de la dirección, no del agente.

## Cosas que conviene avisar a la analista

- El precio unitario de la solicitud y de la cotización incluye IVA. La OC lleva el precio de la solicitud tal cual y, además, un indicador de IVA; en un SAP real habría que enviar el precio sin IVA o marcar el indicador como "IVA incluido".
- La unidad de medida (`UN`, `H` o `MES`) no viene en la solicitud: se infiere de la descripción.
- El texto breve de cada posición en SAP admite 40 caracteres, así que las descripciones largas se acortan. El texto original queda en la trazabilidad.
- El correo de aprobación se toma como evidencia suficiente; auditoría podría exigir firma digital.

## Qué pedirle al solicitante cuando algo falla

- Sin cotización: pedirla al solicitante.
- Proveedor inexistente: solicitar el alta del proveedor en el maestro de SAP.
- Aprobador sin autoridad en el centro: pedir la aprobación a un aprobador autorizado del centro.
- Valor por encima del tope: escalar a quien tenga tope suficiente.
- Solicitud con la cuenta mal hecha (RC10): pedir que corrijan cantidad, valor unitario o total.
