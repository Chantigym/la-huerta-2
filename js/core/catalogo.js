// La lista de productos: lo que ofreces esta semana, para mandarla.
//
// Ojo con la diferencia: la COSECHA es lo que la gente ya pidio, y sale de los
// pedidos. El CATALOGO es lo que esta en oferta, y sale de las columnas del
// form. Un producto que nadie pidio no aparece en la cosecha pero si aca, que
// es justamente el punto: todavia se puede pedir.

import { moneda } from './formato.js';
import { FAMILIAS, ETIQUETA_FAMILIA, familiaDe } from './categorias.js';

/**
 * Los productos agrupados por familia, en el mismo orden que la cosecha:
 * verdura, fruta, huevos y almacen.
 *
 * @param {object} lista salida de armarLista
 */
export function catalogo(lista) {
  const columnas = lista.columnas || [];

  const familias = FAMILIAS.map((familia) => ({
    familia,
    etiqueta: ETIQUETA_FAMILIA[familia],
    productos: columnas
      .filter((c) => familiaDe(c) === familia)
      .map((c) => ({
        indice: c.indice,
        nombreCorto: c.nombreCorto,
        unidad: c.unidad,
        precio: c.precio,
        precioPorKg: c.precioPorKg,
        productor: c.productor || '',
        origen: c.origen,
        sePesa: Boolean(c.sePesa),
      }))
      .sort((a, b) => a.nombreCorto.localeCompare(b.nombreCorto, 'es')),
  })).filter((f) => f.productos.length);

  return {
    fecha: lista.fecha,
    familias,
    total: familias.reduce((a, f) => a + f.productos.length, 0),
    sinPrecio: familias.reduce((a, f) => a + f.productos.filter((p) => p.precio === null).length, 0),
  };
}

/** "Acelga $3.300 atado". El precio con puntos de miles, como se escribe. */
export function renglonDeProducto(p) {
  const partes = [p.nombreCorto];
  if (p.precio !== null && p.precio !== undefined) partes.push(moneda(p.precio));
  else partes.push('a confirmar');
  if (p.unidad) partes.push(p.unidad === 'c/u' ? 'cada uno' : p.unidad);
  // El queso trae los dos precios: el de la horma y el del kilo.
  if (p.precioPorKg !== null && p.precioPorKg !== undefined && p.precioPorKg !== p.precio) {
    partes.push(`(${moneda(p.precioPorKg)} el kg)`);
  }
  return partes.join(' ');
}

/**
 * El catalogo como texto pelado, para pegar en WhatsApp:
 *
 *   VERDURA
 *   Acelga $3.300 atado
 *   Lechuga $2.000 unidad
 *
 *   FRUTA
 *   Mandarina $2.365 kg
 *
 * Sin negritas ni asteriscos: WhatsApp los interpreta distinto en cada
 * telefono y en la mitad quedan los asteriscos a la vista.
 */
export function textoDeCatalogo(inf, opciones = {}) {
  const bloques = [];
  if (opciones.encabezado) bloques.push(opciones.encabezado);

  for (const familia of inf.familias) {
    const renglones = [familia.etiqueta.toUpperCase()];
    for (const p of familia.productos) renglones.push(renglonDeProducto(p));
    bloques.push(renglones.join('\n'));
  }

  if (opciones.cierre) bloques.push(opciones.cierre);
  return bloques.join('\n\n');
}
