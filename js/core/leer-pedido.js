// Lee un pedido escrito a mano, como llega por WhatsApp, y lo convierte en
// items de la lista.
//
//   Hola! Te encargo:
//   2 atados de acelga
//   1 kg de papa
//   medio kilo de nabo
//   lechuga 3
//
// La regla de la casa vale igual que en el resto: NO SE ADIVINA. Cada renglon
// vuelve con un estado —lo entendi, tengo dudas, no lo reconozco— y el que
// decide sos vos. Los nombres reales son de dos palabras ("Huevos chico",
// "Huevos grande"), asi que "huevos" es ambiguo de verdad: devolvemos los dos
// candidatos en vez de elegir uno y equivocarnos en silencio.

import { limpiar, sinAcentos } from './formato.js';
import { detectarUnidad } from './encabezado.js';

/** Numeros escritos con letras. "docena" NO va: es unidad, no cantidad. */
const EN_LETRAS = {
  medio: 0.5, media: 0.5, un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4,
  cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};

// Lo que la gente escribe alrededor del pedido y no es un producto. Va por
// palabra y no por frase entera: "hola!! gracias" y "buenas, mil gracias" son
// saludos igual, y no tienen por que aparecer como producto desconocido.
const CORTESIA = new Set([
  'hola', 'holis', 'buenas', 'buen', 'buenos', 'dia', 'dias', 'tarde', 'tardes',
  'noche', 'noches', 'gracias', 'mil', 'saludos', 'beso', 'besos', 'abrazo',
  'chau', 'listo', 'perfecto', 'dale', 'ok', 'oka', 'oki', 'si', 'no', 'todo',
  'bien', 'como', 'andas', 'estas', 'que', 'tal', 'por', 'favor', 'porfa',
  'xfa', 'genial', 'barbaro', 'buenisimo', 'nada', 'mas',
]);

/** Un renglón que es puro saludo: todas sus palabras son de cortesía. */
function esCortesia(renglon) {
  const palabras = sinAcentos(String(renglon)).toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
  return palabras.length > 0 && palabras.every((p) => CORTESIA.has(p));
}

// Arranques que se sacan antes de leer: "te encargo 2 acelgas" -> "2 acelgas".
const ARRANQUE = /^(?:hola[,!\s]+)?(?:te\s+)?(?:encargo|encargaria|quiero|queria|necesito|necesitaria|me\s+mandas|me\s+manda|mandame|dame|ponme|poneme|agregame|sumame|llevo|llevaria|pedido|anotame)\b[:,\s]*/i;

const NEXO = /^(?:de|del|la|el|los|las|y|con|en|a|por|para|favor|porfa|unos|unas|algunos|algunas)$/i;

/** Sin acentos, en minuscula y sin plural simple: para comparar nombres. */
export function raiz(palabra) {
  const p = sinAcentos(String(palabra || '')).toLowerCase().replace(/[^a-z0-9/]/g, '');
  if (p.length > 3 && p.endsWith('es')) return p.slice(0, -2);
  if (p.length > 3 && p.endsWith('s')) return p.slice(0, -1);
  return p;
}

/** Parte el mensaje en pedacitos: un renglon, una coma o un "y" es un item. */
export function partirEnRenglones(texto) {
  return String(texto || '')
    .split(/\r?\n/)
    .flatMap((l) => l.split(/[,;]| \+ /))
    .flatMap((l) => l.split(/\s+y\s+(?=\d|\bmedio\b|\bmedia\b|\bun\b|\buna\b|\bdos\b|\btres\b)/i))
    .map((l) => limpiar(l.replace(/^[\s\-*•·–—>]+/, '').replace(/^\d+[.)]\s+/, '')))
    .filter(Boolean);
}

/**
 * Cuanto pidio y en que unidad. Devuelve tambien el texto que sobra, que es
 * de donde sale el nombre del producto.
 */
export function leerCantidad(renglon) {
  const palabras = String(renglon).split(/\s+/).filter(Boolean);
  let cantidad = null;
  let usadas = new Set();

  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i];
    const limpio = p.replace(/[^\d/.,a-zA-ZáéíóúñÁÉÍÓÚÑ]/g, '');

    // "1/2", "3/4"
    const frac = limpio.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (frac) { cantidad = parseInt(frac[1], 10) / parseInt(frac[2], 10); usadas.add(i); break; }

    // "2", "1,5", "0.5" — y tambien "2kg" pegado
    const num = limpio.match(/^(\d+(?:[.,]\d+)?)/);
    if (num) { cantidad = parseFloat(num[1].replace(',', '.')); usadas.add(i); break; }

    const enLetras = EN_LETRAS[sinAcentos(limpio).toLowerCase()];
    if (enLetras !== undefined) { cantidad = enLetras; usadas.add(i); break; }
  }

  const u = detectarUnidad(renglon);
  const resto = palabras
    .filter((_, i) => !usadas.has(i))
    .map((p) => p.replace(/^\d+(?:[.,]\d+)?/, ''))     // "2kg" -> "kg"
    .filter((p) => {
      const r = raiz(p);
      if (!r) return false;
      if (NEXO.test(r)) return false;
      if (u && raiz(u.clave) === r) return false;       // la unidad no es el nombre
      if (detectarUnidad(p)) return false;              // otra unidad suelta
      return true;
    })
    .join(' ');

  return {
    cantidad: cantidad === null ? 1 : cantidad,
    cantidadExplicita: cantidad !== null,
    unidad: u ? u.clave : null,
    consulta: limpiar(resto),
  };
}

/** Cuanto se parece lo que escribieron al nombre de una columna. */
export function puntaje(consulta, nombreCorto) {
  const q = String(consulta).split(/\s+/).map(raiz).filter(Boolean);
  const n = String(nombreCorto).split(/\s+/).map(raiz).filter(Boolean);
  if (!q.length || !n.length) return 0;

  if (q.join(' ') === n.join(' ')) return 100;

  const pega = (a, b) => a.startsWith(b) || b.startsWith(a);
  // La primera palabra del producto tiene que estar: si no, "fina" pegaria
  // con "Sal fina" y con "Harina integral fina" por igual.
  if (!q.some((w) => pega(w, n[0]))) return 0;

  const cubiertas = q.filter((w) => n.some((x) => pega(w, x))).length;
  return cubiertas * 10 - (n.length - cubiertas);
}

/**
 * Lee el mensaje entero contra las columnas de la lista.
 *
 * @param {string} texto el mensaje, tal cual lo pegaste
 * @param {Array} columnas lista.columnas
 */
export function leerPedidoDeTexto(texto, columnas = []) {
  const renglones = [];

  for (const crudo of partirEnRenglones(texto)) {
    const sinArranque = limpiar(crudo.replace(ARRANQUE, ''));
    if (!sinArranque || esCortesia(sinArranque)) continue;     // saludos: afuera

    const { cantidad, cantidadExplicita, unidad, consulta } = leerCantidad(sinArranque);

    if (!consulta) {
      // Habia un numero pero ningun nombre: no es un item.
      if (!cantidadExplicita) continue;
      renglones.push({
        crudo, cantidad, unidad, consulta: '', columnaIndice: null, nombreCorto: '',
        estado: 'desconocido', candidatos: [],
        aviso: 'No dice de qué producto.',
      });
      continue;
    }

    const conPuntaje = columnas
      .map((c) => ({ col: c, p: puntaje(consulta, c.nombreCorto) }))
      .filter((x) => x.p > 0)
      .sort((a, b) => b.p - a.p);

    if (!conPuntaje.length) {
      renglones.push({
        crudo, cantidad, unidad, consulta, columnaIndice: null, nombreCorto: '',
        estado: 'desconocido', candidatos: [],
        aviso: 'No hay ningún producto de la lista con ese nombre.',
      });
      continue;
    }

    const mejor = conPuntaje[0].p;
    const empatados = conPuntaje.filter((x) => x.p === mejor);

    if (empatados.length > 1) {
      renglones.push({
        crudo, cantidad, unidad, consulta, columnaIndice: null, nombreCorto: '',
        estado: 'dudoso',
        candidatos: empatados.map((x) => ({ indice: x.col.indice, nombreCorto: x.col.nombreCorto })),
        aviso: 'Puede ser ' + empatados.map((x) => x.col.nombreCorto).join(' o ') + '.',
      });
      continue;
    }

    const col = empatados[0].col;
    // Pidio en una unidad distinta de la que vendes: se avisa, no se corrige.
    const chocaUnidad = unidad && col.unidad && unidad !== col.unidad;
    renglones.push({
      crudo, cantidad, unidad, consulta,
      columnaIndice: col.indice, nombreCorto: col.nombreCorto,
      estado: chocaUnidad ? 'dudoso' : 'ok',
      candidatos: [{ indice: col.indice, nombreCorto: col.nombreCorto }],
      aviso: chocaUnidad ? `Lo pidió por ${unidad} y vos lo vendés por ${col.unidad}.` : '',
    });
  }

  return {
    renglones,
    ok: renglones.filter((r) => r.estado === 'ok').length,
    dudosos: renglones.filter((r) => r.estado === 'dudoso').length,
    desconocidos: renglones.filter((r) => r.estado === 'desconocido').length,
  };
}
