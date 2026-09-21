// Motor de precios. Un solo lugar decide cuanto sale cada item.
//
// Prioridad:
//  1. Si la celda trae un $, ese precio manda y NO se multiplica por cantidad.
//     "3 kg promo $5650" son $5650, no 3 x $2200.
//  2. Si el item se pesa y hay peso real cargado: peso x precio por kg,
//     redondeado al multiplo de $5 (regla sacada de las cuentas reales:
//     1,068 kg x 2200 = 2349,6 -> 2350; 1,075 x 2200 = 2365).
//  3. Si no: cantidad x precio de lista. Si el item se pesa, queda "estimado".

import { redondear5 } from './formato.js';

/** Precio por kilo a usar en la pesada. El queso trae los dos: venta y por kg. */
export function precioDePesada(col) {
  if (!col) return null;
  return col.precioPorKg !== null && col.precioPorKg !== undefined
    ? col.precioPorKg
    : col.precio;
}

/**
 * @param {object} item celda ya interpretada (leerCelda)
 * @param {object} col encabezado ya interpretado (leerEncabezado)
 * @param {number|null} pesoReal kg pesados en la balanza, o null
 */
export function calcularItem(item, col, pesoReal = null) {
  if (!item || item.vacia) return null;

  // Un precio puesto a mano en el armado gana sobre todo lo demas: es una
  // decision tuya (una rebaja, un arreglo) y no se tiene que mover cuando
  // despues cargas los kilos. Se compara contra null/undefined y no con un
  // "if" pelado porque 0 es un precio valido: algo que va de regalo.
  if (item.precioManual !== null && item.precioManual !== undefined) {
    return { precio: item.precioManual, estimado: false, base: 'manual' };
  }

  if (item.precioFijado !== null && item.precioFijado !== undefined) {
    return { precio: item.precioFijado, estimado: false, base: 'celda' };
  }

  const porKg = precioDePesada(col);
  if (col && col.sePesa && pesoReal !== null && pesoReal > 0 && porKg) {
    return { precio: redondear5(pesoReal * porKg), estimado: false, base: 'peso' };
  }

  if (!col || col.precio === null || col.precio === undefined) {
    return { precio: 0, estimado: true, base: 'sinPrecio' };
  }

  return {
    precio: redondear5(item.cantidad * col.precio),
    estimado: Boolean(col.sePesa),
    base: 'lista',
  };
}

/** Suma de un pedido. El total SIEMPRE sale de las lineas, nunca se tipea. */
export function totalPedido(lineas) {
  return (lineas || []).reduce((a, l) => a + (l && l.precio ? l.precio : 0), 0);
}
