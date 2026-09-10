// La Huerta 2 — la interfaz del celular.
//
// El motor es el mismo de siempre (js/core, probado con node --test). Lo que
// cambia acá es cómo se muestra, y cambia por una razón: esto se usa parado al
// lado del auto, con una mano ocupada y el sol de frente.
//
// Las tres reglas:
//  1. Una pantalla hace una sola cosa. Se elige abajo, con el pulgar.
//  2. Lo que se toca es grande: la fila entera tilda, no hay que apuntarle a
//     un cuadradito de 16px.
//  3. De a uno. Armar muestra UNA bolsa; cobrar muestra UNA cuenta. Las 31
//     están en el DOM igual, escondidas: así el papel sigue saliendo completo
//     y no hay que armar dos veces la misma cosa.
//
// Lo que se toca de vez en cuando (margen, recorrido, alias, respaldo) vive en
// la sábana de "Más", arriba a la derecha.

import { leerPDF } from '../core/pdf-grilla.js';
import { leerCSV } from '../core/csv.js';
import { armarLista } from '../core/tabla.js';
import { cosechaPorFamilia, textoDeCosecha } from '../core/cosecha.js';
import { informePedidos, recalcularPedido } from '../core/pedidos.js';
import { informeCobros, linkWhatsApp, productosSinAlias, balancePorPunto, PLANTILLAS } from '../core/cobros.js';
import { ordenarParaBolsa } from '../core/categorias.js';
import { calcularItem, totalPedido } from '../core/precios.js';
import { moneda, fecha } from '../core/formato.js';
import { cuentaAJPG, nombreArchivo } from '../img/cuenta-jpg.js';
import { armarZip } from '../img/zip.js';
import { quienMeDebe, resumenParaHistorial, ESTADOS } from '../core/cuentacorriente.js';
import { informesAXLSX } from '../datos/informes-xlsx.js';
import { guardarAvance, leerAvance, guardarConfig, leerConfig, claveItem,
         guardarListaEnHistorial, leerHistorial, guardarPago, leerPagos,
         exportarTodo, importarTodo } from '../datos/db.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const crear = (tag, props = {}) => {
  const { dataset, ...resto } = props;
  const el = Object.assign(document.createElement(tag), resto);
  if (dataset) for (const [k, v] of Object.entries(dataset)) el.dataset[k] = v;
  return el;
};
const plural = (n, uno, muchos) => `${n} ${n === 1 ? uno : muchos}`;
const recortar = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const diaDe = (iso) => fecha(iso + 'T12:00:00');
/** 3 -> "3", 0.5 -> "0,5". Como se escribe acá. */
const numero = (n) => String(Math.round((n + Number.EPSILON) * 100) / 100).replace('.', ',');

const estado = {
  lista: null, armado: null, cobros: null,
  tildados: new Set(),   // productos ya cosechados
  tildes: new Set(),     // ítems ya puestos en la bolsa
  pesos: new Map(),      // peso real por ítem
  enviadas: new Set(),   // cuentas ya mandadas
  ordenPuntos: [],
  alias: {},
  plantillas: { ...PLANTILLAS },
  historial: [],
  pagos: [],
  bolsas: [],            // las bolsas en orden de recorrido, para el pager
  iBolsa: 0,
  iCuenta: 0,
  vista: 'lista',
};

// ---------- navegación ----------
const TABS = ['lista', 'cosecha', 'armado', 'cobros', 'deudas'];

function irA(vista) {
  estado.vista = vista;
  $$('.pantalla').forEach((p) => { p.hidden = p.id !== 'p-' + vista; });
  // "revisar" no tiene pestaña propia: se entra desde Lista y desde Más.
  const activa = TABS.includes(vista) ? vista : 'lista';
  $$('.tab').forEach((t) => t.setAttribute('aria-current', String(t.dataset.vista === activa)));
  window.scrollTo({ top: 0, behavior: 'instant' });
}

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  if (t.disabled) return;
  const v = t.dataset.vista;
  // Cada pantalla se redibuja al entrar: así los pesos que acabás de cargar ya
  // están en los cobros, sin que tengas que acordarte de refrescar nada.
  if (v === 'cosecha') pintarCosecha();
  if (v === 'armado') pintarArmado();
  if (v === 'cobros') pintarCobros();
  if (v === 'deudas') refrescarDeudas();
  irA(v);
}));

function habilitar(vista, si) {
  const t = $$('.tab').find((x) => x.dataset.vista === vista);
  if (t) t.disabled = !si;
}

// ---------- la sábana de "Más" ----------
function abrirMas(foco) {
  $('#velo').hidden = false;
  $('#sabana').hidden = false;
  if (foco) setTimeout(() => { const e = $(foco); if (e) { e.focus(); e.scrollIntoView({ block: 'center' }); } }, 60);
}
function cerrarMas() {
  $('#velo').hidden = true;
  $('#sabana').hidden = true;
}
$('#btn-mas').addEventListener('click', () => abrirMas());
$('#btn-cerrar-mas').addEventListener('click', cerrarMas);
$('#velo').addEventListener('click', cerrarMas);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMas(); });

// ---------- 1. cargar la lista ----------
const zona = $('#zona');
$('#btn-elegir').addEventListener('click', () => $('#archivo').click());
$('#archivo').addEventListener('change', (e) => { if (e.target.files[0]) cargar(e.target.files[0]); });

['dragenter', 'dragover'].forEach((ev) =>
  zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('encima'); }));
['dragleave', 'drop'].forEach((ev) =>
  zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove('encima'); }));
zona.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) cargar(f); });

function decir(donde, texto, clase = 'ok') {
  const el = $(donde);
  el.innerHTML = '';
  if (texto) el.append(crear('div', { className: 'aviso ' + clase, textContent: texto }));
}

async function cargar(archivo) {
  decir('#estado-carga', 'Leyendo ' + archivo.name + '…', 'revisar');
  try {
    const esCSV = /\.(csv|tsv|txt)$/i.test(archivo.name);
    const { tabla, renglones, meta } = esCSV
      ? leerCSV(await archivo.text())
      : await leerPDF(await archivo.arrayBuffer());

    estado.lista = armarLista(tabla, renglones, archivo.name);
    estado.lista.meta = meta;
    estado.tildes = new Set();
    estado.tildados = new Set();
    estado.pesos = new Map();
    estado.enviadas = new Set();
    estado.ordenPuntos = estado.lista.puntos.map((p) => p.codigo);
    estado.iBolsa = 0;
    estado.iCuenta = 0;

    await recuperarConfig();
    await recuperarAvance();

    decir('#estado-carga', '');
    $('#dato-lista').textContent = diaDe(estado.lista.fecha);
    $('#margen').value = String(await margenGuardado());

    pintarLista();
    pintarRevision();
    pintarCosecha();
    pintarArmado();
    pintarCobros();
    habilitar('cosecha', true);
    habilitar('armado', true);
    habilitar('cobros', true);

    // Si hay celdas que no se pudieron leer, lo primero es arreglarlas.
    irA(rojasDeLaLista() ? 'revisar' : 'lista');
  } catch (err) {
    decir('#estado-carga', 'No pude leer el archivo: ' + err.message, 'mal');
  }
}

function rojasDeLaLista() {
  if (!estado.lista) return 0;
  return estado.lista.pedidos.reduce(
    (a, p) => a + p.items.filter((i) => i.confianza === 'rojo').length, 0);
}

/** La pantalla Lista es el tablero: cuánto hay, qué falta revisar, y por dónde seguir. */
function pintarLista() {
  const L = estado.lista;
  const cont = $('#tarjeta-lista');
  cont.innerHTML = '';
  if (!L) return;

  const rojas = rojasDeLaLista();
  const cifras = crear('div', { className: 'cifras' });
  for (const [rot, val, clase] of [
    ['pedidos', L.resumen.pedidos, ''],
    ['productos', L.resumen.productosConPedido, ''],
    ['puntos de retiro', L.puntos.length, ''],
    ['para revisar', L.resumen.celdasParaRevisar, rojas ? 'mal' : (L.resumen.celdasParaRevisar ? 'alerta' : '')],
  ]) {
    const c = crear('div', { className: 'cifra ' + clase });
    c.append(crear('b', { textContent: String(val) }), crear('span', { textContent: rot }));
    cifras.append(c);
  }
  cont.append(cifras);

  if (L.resumen.celdasParaRevisar) {
    const b = crear('button', {
      className: 'aviso ' + (rojas ? 'mal' : 'revisar'),
      textContent: rojas
        ? `Hay ${plural(rojas, 'celda', 'celdas')} que no pude leer. Tocá para corregir el precio.`
        : `Hay ${plural(L.resumen.celdasParaRevisar, 'celda', 'celdas')} con algo raro. Tocá para mirarlas.`,
    });
    b.addEventListener('click', () => irA('revisar'));
    cont.append(b);
  } else {
    cont.append(crear('div', { className: 'aviso ok', textContent: 'Se leyó toda la lista sin dudas.' }));
  }

  const seguir = crear('button', { className: 'boton grande', textContent: 'Empezar a cosechar' });
  seguir.disabled = rojas > 0;
  seguir.addEventListener('click', () => { pintarCosecha(); irA('cosecha'); });
  cont.append(seguir);
}

// ---------- 2. revisar ----------
function pintarRevision() {
  const L = estado.lista;
  if (!L) return;
  const dudosas = L.pedidos.flatMap((p) =>
    p.items.filter((i) => i.confianza !== 'verde').map((i) => ({ pedido: p, item: i })));
  const rojas = dudosas.filter((d) => d.item.confianza === 'rojo').length;

  $('#resumen-revisar').textContent = dudosas.length
    ? `${plural(dudosas.length, 'celda', 'celdas')} para mirar`
    : 'no quedó nada raro';
  $('#pico-revisar').textContent = dudosas.length ? String(dudosas.length) : '';

  const av = $('#alerta-revision');
  av.innerHTML = '';
  av.append(crear('div', {
    className: 'aviso ' + (rojas ? 'mal' : dudosas.length ? 'revisar' : 'ok'),
    textContent: rojas
      ? `No pude leer ${plural(rojas, 'celda', 'celdas')}. Corregí el precio abajo antes de seguir.`
      : dudosas.length
        ? 'Leí toda la lista. Esto quedó con algo raro: miralo antes de seguir.'
        : 'Se leyó toda la lista sin ambigüedades.',
  }));

  $('#btn-a-cosecha').disabled = rojas > 0;
  pintarDudosas(dudosas);
  pintarPrecios();
}

function pintarDudosas(dudosas) {
  const cont = $('#lista-dudosas');
  cont.innerHTML = '';
  if (!dudosas.length) return;
  const caja = crear('div', { className: 'tarjeta' });
  for (const { pedido, item } of dudosas) {
    const fila = crear('div', { className: 'precio-fila' });
    const cuerpo = crear('div', { className: 'cuerpo' });
    const quien = crear('b');
    quien.append(crear('span', { className: 'punto ' + (item.confianza === 'rojo' ? 'rojo' : 'ambar') }),
                 crear('span', { textContent: pedido.nombre + ' · ' + item.nombreCorto }));
    cuerpo.append(quien);
    cuerpo.append(crear('span', { className: 'crudo', textContent: 'puso: ' + item.textoCrudo }));
    if (item.avisos.length) cuerpo.append(crear('span', { className: 'nota', textContent: item.avisos.join(' ') }));
    fila.append(cuerpo);
    caja.append(fila);
  }
  cont.append(caja);
}

function pintarPrecios() {
  const L = estado.lista;
  const pedidas = new Set(L.pedidos.flatMap((p) => p.items.map((i) => i.columnaIndice)));
  const cont = $('#lista-precios');
  cont.innerHTML = '';
  const caja = crear('div', { className: 'tarjeta' });

  for (const col of L.columnas) {
    if (!pedidas.has(col.indice)) continue;
    const fila = crear('div', { className: 'precio-fila' });
    const cuerpo = crear('div', { className: 'cuerpo' });
    cuerpo.append(crear('b', { textContent: col.nombreCorto }));
    const pie = [col.unidad || 'unidad'];
    if (col.productor) pie.push(recortar(col.productor, 30));
    if (col.precioPorKg) pie.push(moneda(col.precioPorKg) + '/kg');
    cuerpo.append(crear('span', { className: 'crudo', textContent: pie.join(' · ') }));
    if (col.precio === null) {
      cuerpo.append(crear('span', { className: 'nota', textContent: 'el precio lo trae la opción de cada cliente' }));
    }
    fila.append(cuerpo, campoPrecio(col));
    caja.append(fila);
  }
  cont.append(caja);
}

/** Precio editable: al cambiarlo se recalcula toda la lista. */
function campoPrecio(col) {
  const input = crear('input', {
    type: 'number', inputMode: 'numeric', min: '0', step: '50', placeholder: '—',
    value: col.precio === null || col.precio === undefined ? '' : String(col.precio),
  });
  input.setAttribute('aria-label', 'Precio de ' + col.nombreCorto);
  input.addEventListener('change', () => {
    const v = input.value.trim();
    col.precio = v === '' ? null : Number(v);
    input.classList.add('editado');
    recalcular();
    pintarLista();
    pintarRevision();
    pintarCosecha();
    pintarArmado();
    pintarCobros();
  });
  return input;
}

function recalcular() {
  const L = estado.lista;
  const porIndice = new Map(L.columnas.map((c) => [c.indice, c]));
  for (const p of L.pedidos) {
    for (const item of p.items) {
      const calc = calcularItem(item, porIndice.get(item.columnaIndice), item.pesoReal);
      item.precioFinal = calc.precio;
      item.estimado = calc.estimado;
      item.basePrecio = calc.base;
    }
    p.total = totalPedido(p.items.map((i) => ({ precio: i.precioFinal })));
  }
}

$('#btn-a-cosecha').addEventListener('click', () => { pintarCosecha(); irA('cosecha'); });
$('#btn-revisar').addEventListener('click', () => {
  cerrarMas();
  if (estado.lista) irA('revisar');
});

// ---------- 3. cosechar ----------
$('#margen').addEventListener('change', () => {
  guardarConfig('margen', Number($('#margen').value) || 0).catch(() => {});
  pintarCosecha();
});
async function margenGuardado() {
  try {
    const m = await leerConfig('margen');
    return m === null || m === undefined ? 10 : m;
  } catch { return 10; }
}

function pintarCosecha() {
  if (!estado.lista) return;
  const margen = Math.max(0, Number($('#margen').value) || 0) / 100;
  const inf = cosechaPorFamilia(estado.lista, { margen });
  $('#texto-cosecha').textContent = textoDeCosecha(inf, estado.alias);

  const hoja = $('#hoja-cosecha');
  hoja.innerHTML = '';
  let total = 0;

  for (const familia of inf.familias) {
    hoja.append(crear('p', { className: 'rubro', textContent: familia.etiqueta }));
    for (const grupo of familia.grupos) {
      // El nombre del proveedor sólo hace falta si no es tuyo.
      hoja.append(crear('p', {
        className: 'subrubro',
        textContent: grupo.propia ? 'De tu chacra' : grupo.etiqueta,
      }));
      const caja = crear('div', { className: 'tarjeta' });
      for (const p of grupo.productos) {
        total++;
        caja.append(filaCosecha(p, grupo, margen));
      }
      hoja.append(caja);
    }
  }
  marcarCosecha(total);
}

function filaCosecha(p, grupo, margen) {
  const clave = 'cosecha:' + p.indice;
  const fila = crear('div', { className: 'item' + (estado.tildados.has(clave) ? ' listo' : '') });

  const zona = crear('button', { className: 'zona' });
  zona.setAttribute('aria-pressed', String(estado.tildados.has(clave)));
  zona.setAttribute('aria-label', 'Ya tengo ' + p.nombreCorto);
  zona.append(crear('span', { className: 'tilde' }));

  const cant = crear('span', { className: 'cantidad', textContent: numero(p.total) });
  cant.append(crear('i', { textContent: p.unidad }));
  zona.append(cant);

  const cuerpo = crear('span', { className: 'cuerpo' });
  cuerpo.append(crear('span', { className: 'nombre', textContent: p.nombreCorto }));
  // El margen de descarte sólo aplica a lo tuyo: a un tercero le pedís 13, no 14,3.
  if (grupo.propia && margen && p.conMargen !== p.total) {
    cuerpo.append(crear('span', { className: 'detalle', textContent: 'cosechá ' + numero(p.conMargen) }));
  }
  for (const nota of p.notas) cuerpo.append(crear('span', { className: 'nota', textContent: nota }));
  zona.append(cuerpo);

  zona.addEventListener('click', () => {
    const ahora = !estado.tildados.has(clave);
    if (ahora) estado.tildados.add(clave); else estado.tildados.delete(clave);
    fila.classList.toggle('listo', ahora);
    zona.setAttribute('aria-pressed', String(ahora));
    marcarCosecha();
    guardarLuego();
  });

  fila.append(zona);
  return fila;
}

function marcarCosecha(total) {
  const cuantos = total === undefined ? $$('#hoja-cosecha .item').length : total;
  const listos = $$('#hoja-cosecha .item.listo').length;
  $('#avance-cosecha').textContent = `${listos} de ${cuantos} listos`;
  $('#barra-cosecha').style.width = cuantos ? (listos / cuantos * 100) + '%' : '0';
}

// ---------- 4. armar: una bolsa por vez ----------
function pintarArmado() {
  if (!estado.lista) return;
  const inf = informePedidos(estado.lista, { ordenPuntos: estado.ordenPuntos });
  estado.armado = inf;
  estado.ordenPuntos = inf.puntos.map((p) => p.codigo);
  pintarRecorrido(inf);

  // Las bolsas, aplanadas en orden de entrega: así el pager avanza solo.
  estado.bolsas = inf.puntos.flatMap((punto) => punto.pedidos.map((pedido) => ({ punto, pedido })));
  if (estado.iBolsa >= estado.bolsas.length) estado.iBolsa = Math.max(0, estado.bolsas.length - 1);

  const porColumna = new Map(estado.lista.columnas.map((c) => [c.indice, c]));
  const hoja = $('#hoja-armado');
  hoja.innerHTML = '';
  estado.bolsas.forEach(({ punto, pedido }) => hoja.append(tarjetaDeBolsa(punto, pedido, porColumna)));
  mostrarBolsa(estado.iBolsa);
}

function bolsaLista(pedido) {
  return pedido.items.length > 0 && pedido.items.every((i) => estado.tildes.has(claveItem(pedido, i)));
}

function tarjetaDeBolsa(punto, pedido, porColumna) {
  const art = crear('article', { className: 'pager-item', dataset: { quien: pedido.claveCliente } });

  const tope = crear('div', { className: 'bolsa-tope' });
  tope.append(crear('span', { className: 'quien', textContent: pedido.nombre }));
  const plata = crear('span', { className: 'total' });
  tope.append(plata);
  const donde = crear('span', { className: 'donde' });
  tope.append(donde);
  art.append(tope);

  const caja = crear('div', { className: 'tarjeta' });
  art.append(caja);

  const refrescar = () => {
    recalcularPedido(pedido);
    plata.textContent = moneda(pedido.total);
    const sinPesar = pedido.items.filter((i) => i.estimado).length;
    donde.textContent = [
      punto.etiqueta,
      'carga ' + punto.carga,
      punto.direccion ? recortar(punto.direccion, 34) : null,
      sinPesar ? plural(sinPesar, 'sin pesar', 'sin pesar') : null,
    ].filter(Boolean).join(' · ');
    art.classList.toggle('lista', bolsaLista(pedido));
    marcarArmado();
  };

  // De lo más pesado a lo más liviano: la papa al fondo, los huevos arriba.
  for (const item of ordenarParaBolsa(pedido.items, porColumna)) {
    caja.append(filaDeItem(pedido, item, refrescar));
  }

  // Lo que va a granel a este punto, para cargar el auto sin abrir las bolsas.
  if (punto.totales.length) {
    const pleg = crear('details', { className: 'plegable' });
    pleg.append(crear('summary', { textContent: 'Todo lo que va a ' + punto.etiqueta }));
    pleg.append(crear('pre', {
      textContent: punto.totales.map((t) => `${numero(t.cantidad)} ${t.unidad} ${t.nombreCorto}`).join('\n'),
    }));
    art.append(pleg);
  }

  refrescar();
  return art;
}

function filaDeItem(pedido, item, refrescar) {
  const clave = claveItem(pedido, item);
  // Lo que se pesa lleva un renglón más: el nombre no comparte línea con la balanza.
  const fila = crear('div', {
    className: 'item' + (item.sePesa ? ' pesa' : '') + (estado.tildes.has(clave) ? ' listo' : ''),
  });

  const zona = crear('button', { className: 'zona' });
  zona.setAttribute('aria-pressed', String(estado.tildes.has(clave)));
  zona.setAttribute('aria-label', `Ya puse ${item.nombreCorto} en la bolsa de ${pedido.nombre}`);
  zona.append(crear('span', { className: 'tilde' }));

  const cant = crear('span', { className: 'cantidad', textContent: numero(item.cantidad) });
  cant.append(crear('i', { textContent: item.unidad || item.unidadCol || '' }));
  zona.append(cant);

  const cuerpo = crear('span', { className: 'cuerpo' });
  cuerpo.append(crear('span', { className: 'nombre', textContent: item.nombreCorto }));
  if (item.nota) cuerpo.append(crear('span', { className: 'nota', textContent: item.nota }));
  zona.append(cuerpo);

  zona.addEventListener('click', () => {
    const ahora = !estado.tildes.has(clave);
    if (ahora) estado.tildes.add(clave); else estado.tildes.delete(clave);
    fila.classList.toggle('listo', ahora);
    zona.setAttribute('aria-pressed', String(ahora));
    refrescar();
    guardarLuego();
  });

  fila.append(zona);

  const precio = crear('span', { className: 'plata' + (item.estimado ? ' estimado' : '') });
  precio.textContent = moneda(item.precioFinal);
  item._pintarPrecio = () => {
    precio.textContent = moneda(item.precioFinal);
    precio.classList.toggle('estimado', Boolean(item.estimado));
  };

  if (item.sePesa) fila.append(balanzaDe(pedido, item, refrescar));
  fila.append(precio);
  return fila;
}

/** Peso real. Teclado numérico, y el precio se recalcula al toque. */
function balanzaDe(pedido, item, refrescar) {
  const clave = claveItem(pedido, item);
  const caja = crear('div', { className: 'balanza' });

  const campo = crear('input', {
    type: 'number', inputMode: 'decimal', step: '0.005', min: '0', placeholder: '—',
    value: item.pesoReal === null || item.pesoReal === undefined ? '' : String(item.pesoReal),
  });
  campo.classList.toggle('cargado', item.pesoReal > 0);
  campo.setAttribute('aria-label', `Cuánto pesó ${item.nombreCorto} de ${pedido.nombre}, en kilos`);

  const aplicar = () => {
    const v = campo.value.trim();
    item.pesoReal = v === '' ? null : Number(v.replace(',', '.'));
    if (item.pesoReal !== null) estado.pesos.set(clave, item.pesoReal);
    else estado.pesos.delete(clave);

    const col = estado.lista.columnas.find((c) => c.indice === item.columnaIndice);
    const calc = calcularItem(item, col, item.pesoReal);
    item.precioFinal = calc.precio;
    item.estimado = calc.estimado;
    campo.classList.toggle('cargado', item.pesoReal > 0);
    if (item._pintarPrecio) item._pintarPrecio();
    refrescar();
    guardarLuego();
  };
  campo.addEventListener('change', aplicar);
  campo.addEventListener('blur', aplicar);

  caja.append(campo, crear('i', { textContent: 'kg' }));
  return caja;
}

function mostrarBolsa(i) {
  const tarjetas = $$('#hoja-armado .pager-item');
  if (!tarjetas.length) { $('#franja-armado').textContent = ''; $('#pager-armado').innerHTML = ''; return; }
  estado.iBolsa = Math.min(Math.max(0, i), tarjetas.length - 1);
  tarjetas.forEach((t, n) => t.classList.toggle('actual', n === estado.iBolsa));
  marcarArmado();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function marcarArmado() {
  const total = estado.bolsas.length;
  if (!total) return;
  const listas = estado.bolsas.filter((b) => bolsaLista(b.pedido)).length;
  const actual = estado.bolsas[estado.iBolsa];

  const franja = $('#franja-armado');
  franja.innerHTML = '';
  franja.append(crear('b', { textContent: actual ? actual.punto.etiqueta : 'Armar' }));
  if (actual) franja.append(crear('span', { textContent: 'entrega ' + actual.punto.entrega + ' · carga ' + actual.punto.carga }));
  franja.append(crear('span', { className: 'der', textContent: `${listas}/${total} bolsas` }));
  const barra = crear('div', { className: 'progreso' });
  barra.append(crear('i', { style: `width:${listas / total * 100}%` }));
  franja.append(barra);

  pintarPager($('#pager-armado'), {
    i: estado.iBolsa,
    total,
    nombre: actual ? actual.pedido.nombre : '',
    hecho: actual ? bolsaLista(actual.pedido) : false,
    pendiente: estado.bolsas.findIndex((b) => !bolsaLista(b.pedido)),
    ir: mostrarBolsa,
    queFalta: 'bolsa sin terminar',
  });
}

/** El pager: anterior, dónde estás, siguiente. Y el medio te lleva a la que falta. */
function pintarPager(cont, o) {
  cont.innerHTML = '';

  const antes = crear('button', { className: 'mover', textContent: '‹', disabled: o.i <= 0 });
  antes.setAttribute('aria-label', 'Anterior');
  antes.addEventListener('click', () => o.ir(o.i - 1));

  const medio = crear('button', { className: 'medio' });
  medio.append(crear('b', { textContent: `${o.i + 1} / ${o.total}` }));
  const hayPendiente = o.pendiente >= 0 && o.pendiente !== o.i;
  medio.append(crear('span', {
    textContent: hayPendiente ? 'ir a la ' + o.queFalta : (o.nombre || ''),
  }));
  medio.disabled = !hayPendiente;
  if (hayPendiente) {
    medio.setAttribute('aria-label', 'Ir a la primera ' + o.queFalta);
    medio.addEventListener('click', () => o.ir(o.pendiente));
  }

  const despues = crear('button', {
    className: 'mover' + (o.hecho ? ' hecho' : ''),
    textContent: '›',
    disabled: o.i >= o.total - 1,
  });
  despues.setAttribute('aria-label', 'Siguiente');
  despues.addEventListener('click', () => o.ir(o.i + 1));

  cont.append(antes, medio, despues);
}

/** Orden del recorrido: con flechas, que es lo único que funciona con una mano. */
function pintarRecorrido(inf) {
  const ol = $('#recorrido');
  ol.innerHTML = '';
  inf.puntos.forEach((punto, i) => {
    const li = crear('li');
    li.append(crear('span', { className: 'nombre-punto', textContent: punto.entrega + '. ' + punto.etiqueta }));
    li.append(crear('span', { className: 'cuenta', textContent: 'carga ' + punto.carga }));
    for (const [texto, destino, apagado] of [['↑', i - 1, i === 0], ['↓', i + 1, i === inf.puntos.length - 1]]) {
      const b = crear('button', { className: 'mover', textContent: texto, disabled: apagado });
      b.setAttribute('aria-label', (texto === '↑' ? 'Entregar antes: ' : 'Entregar después: ') + punto.etiqueta);
      b.addEventListener('click', () => mover(i, destino));
      li.append(b);
    }
    ol.append(li);
  });
}

function mover(desde, hasta) {
  const orden = estado.ordenPuntos.slice();
  const [x] = orden.splice(desde, 1);
  orden.splice(hasta, 0, x);
  estado.ordenPuntos = orden;
  pintarArmado();
  pintarCobros();
  guardarLuego();
}

// ---------- 5. cobrar: una cuenta por vez ----------
for (const [id, campo] of [['#pl-saludo', 'saludo'], ['#pl-cierre', 'cierre'], ['#pl-alias', 'aliasTransferencia']]) {
  $(id).addEventListener('input', () => {
    estado.plantillas[campo] = $(id).value;
    guardarConfig('plantillas', estado.plantillas).catch(() => {});
    pintarCobros();
  });
}

function pintarCobros() {
  if (!estado.lista) return;
  const inf = informeCobros(estado.lista, {
    alias: estado.alias, plantillas: estado.plantillas, ordenPuntos: estado.ordenPuntos,
  });
  estado.cobros = inf;

  // Sin alias de transferencia el mensaje sale sin la línea para pagar.
  const avisoAlias = $('#aviso-alias');
  avisoAlias.innerHTML = '';
  if (!estado.plantillas.aliasTransferencia) {
    const a = crear('button', {
      className: 'aviso revisar',
      textContent: 'Falta tu alias para transferir. Tocá acá para cargarlo.',
    });
    a.addEventListener('click', () => abrirMas('#pl-alias'));
    avisoAlias.append(a);
  }

  const hoja = $('#hoja-cobros');
  hoja.innerHTML = '';
  inf.cuentas.forEach((cuenta) => hoja.append(tarjetaDeCuenta(cuenta)));
  if (estado.iCuenta >= inf.cuentas.length) estado.iCuenta = Math.max(0, inf.cuentas.length - 1);
  mostrarCuenta(estado.iCuenta);
  pintarAlias();
}

function tarjetaDeCuenta(cuenta) {
  const art = crear('article', { className: 'pager-item', dataset: { quien: cuenta.claveCliente } });
  if (estado.enviadas.has(cuenta.claveCliente)) art.classList.add('enviada');

  const tope = crear('div', { className: 'cuenta-tope' });
  tope.append(crear('span', { className: 'quien', textContent: cuenta.nombre }));
  tope.append(crear('span', { className: 'total', textContent: moneda(cuenta.total) }));
  const pie = [cuenta.telMostrado, cuenta.estimados ? plural(cuenta.estimados, 'sin pesar', 'sin pesar') : null]
    .filter(Boolean).join(' · ');
  if (pie) tope.append(crear('span', { className: 'tel', textContent: pie }));
  art.append(tope);

  art.append(crear('pre', { className: 'mensaje', textContent: cuenta.texto }));

  const marcar = () => {
    estado.enviadas.add(cuenta.claveCliente);
    art.classList.add('enviada');
    marcarCobros();
    guardarLuego();
  };

  const acciones = crear('div', { className: 'acciones no-imprime' });

  const link = linkWhatsApp(cuenta);
  if (link) {
    const wa = crear('a', {
      className: 'boton ancho', href: link, target: '_blank', rel: 'noopener',
      textContent: 'Mandar por WhatsApp',
    });
    wa.addEventListener('click', marcar);
    acciones.append(wa);
  }

  const copiar = crear('button', { className: 'boton fantasma' + (link ? '' : ' ancho'), textContent: 'Copiar' });
  copiar.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cuenta.texto);
      copiar.textContent = 'Copiado';
    } catch {
      // Sin permiso de portapapeles: al menos queda seleccionado.
      const r = document.createRange();
      r.selectNodeContents(art.querySelector('.mensaje'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      copiar.textContent = 'Copialo vos';
    }
    marcar();
    setTimeout(() => { copiar.textContent = 'Copiar'; }, 2000);
  });
  acciones.append(copiar);

  const imagen = crear('button', { className: 'boton fantasma', textContent: 'Imagen' });
  imagen.addEventListener('click', () => mandarImagen(cuenta, imagen, marcar));
  acciones.append(imagen);

  art.append(acciones);
  return art;
}

/** La cuenta como JPG: en el celular va al menú de compartir, en la compu se baja. */
async function mandarImagen(cuenta, boton, marcar) {
  const antes = boton.textContent;
  boton.textContent = 'Armando…';
  try {
    const blob = await cuentaAJPG(cuenta, {
      fechaLista: estado.lista.fecha,
      aliasTransferencia: estado.plantillas.aliasTransferencia,
    });
    const nombre = nombreArchivo(cuenta, estado.lista.fecha);
    const archivo = new File([blob], nombre, { type: 'image/jpeg' });

    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      await navigator.share({ files: [archivo], title: cuenta.nombre });
      marcar();
    } else {
      descargar(blob, nombre);
      marcar();
    }
    boton.textContent = antes;
  } catch {
    // Si cancelás el menú de compartir no es un error: no avisamos nada raro.
    boton.textContent = antes;
  }
}

function mostrarCuenta(i) {
  const tarjetas = $$('#hoja-cobros .pager-item');
  if (!tarjetas.length) { $('#franja-cobros').textContent = ''; $('#pager-cobros').innerHTML = ''; return; }
  estado.iCuenta = Math.min(Math.max(0, i), tarjetas.length - 1);
  tarjetas.forEach((t, n) => t.classList.toggle('actual', n === estado.iCuenta));
  marcarCobros();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function marcarCobros() {
  const inf = estado.cobros;
  if (!inf || !inf.cuentas.length) return;
  const total = inf.cuentas.length;
  const mandadas = inf.cuentas.filter((c) => estado.enviadas.has(c.claveCliente)).length;

  const franja = $('#franja-cobros');
  franja.innerHTML = '';
  franja.append(crear('b', { textContent: 'Cobrar' }));
  franja.append(crear('span', { textContent: `${mandadas} de ${total} mandadas` }));
  franja.append(crear('span', { className: 'der', textContent: moneda(inf.total) }));
  const barra = crear('div', { className: 'progreso' });
  barra.append(crear('i', { style: `width:${mandadas / total * 100}%` }));
  franja.append(barra);

  pintarPager($('#pager-cobros'), {
    i: estado.iCuenta,
    total,
    nombre: inf.cuentas[estado.iCuenta] ? inf.cuentas[estado.iCuenta].nombre : '',
    hecho: inf.cuentas[estado.iCuenta] && estado.enviadas.has(inf.cuentas[estado.iCuenta].claveCliente),
    pendiente: inf.cuentas.findIndex((c) => !estado.enviadas.has(c.claveCliente)),
    ir: mostrarCuenta,
    queFalta: 'cuenta sin mandar',
  });
}

/** Los nombres cortos que van en el mensaje. */
function pintarAlias() {
  const productos = productosSinAlias(estado.lista, {});
  const cont = $('#lista-alias');
  cont.innerHTML = '';
  if (!productos.length) return;

  const usados = new Map();
  for (const p of productos) {
    const v = (estado.alias[p.clave] || p.sugerido).toLowerCase();
    usados.set(v, (usados.get(v) || 0) + 1);
  }

  for (const p of productos) {
    const valor = estado.alias[p.clave] || p.sugerido;
    const chocan = usados.get(valor.toLowerCase()) > 1;

    const fila = crear('div', { className: 'alias-fila' });
    const de = crear('div', { className: 'de' });
    de.append(crear('span', { textContent: p.nombreCorto }));
    if (chocan) de.append(crear('small', { textContent: 'otro producto se llama igual' }));

    const campo = crear('input', { type: 'text', value: valor, placeholder: p.sugerido });
    campo.setAttribute('aria-label', 'Cómo llamás a ' + p.nombreCorto);
    if (estado.alias[p.clave]) campo.classList.add('guardado');
    if (chocan) campo.classList.add('choca');
    campo.addEventListener('change', () => {
      const v = campo.value.trim();
      if (!v || v === valor) return;
      estado.alias[p.clave] = v;
      guardarConfig('aliasProductos', estado.alias).catch(() => {});
      pintarCobros();
      pintarCosecha();
    });

    fila.append(de, campo);
    cont.append(fila);
  }
}

// ---------- 6. quién me debe ----------
async function refrescarDeudas() {
  try {
    estado.historial = await leerHistorial();
    estado.pagos = await leerPagos();
  } catch { estado.historial = []; estado.pagos = []; }
  pintarDeudas();
}

function pintarDeudas() {
  const inf = quienMeDebe(estado.historial, estado.pagos);
  const partes = [plural(estado.historial.length, 'lista guardada', 'listas guardadas')];
  if (inf.total) partes.push('deben ' + moneda(inf.total));
  if (inf.aFavor) partes.push(moneda(inf.aFavor) + ' a favor');
  $('#resumen-deudas').textContent = partes.join(' · ');

  const aviso = $('#aviso-historial');
  aviso.innerHTML = '';
  if (estado.lista && !estado.historial.some((l) => l.listaId === estado.lista.fecha)) {
    const b = crear('button', {
      className: 'aviso revisar',
      textContent: `La lista del ${diaDe(estado.lista.fecha)} no está guardada. Tocá para guardarla.`,
    });
    b.addEventListener('click', guardarHistorial);
    aviso.append(b);
  } else if (estado.lista) {
    aviso.append(crear('div', {
      className: 'aviso ok',
      textContent: `La lista del ${diaDe(estado.lista.fecha)} está guardada.`,
    }));
  }

  const cont = $('#listado-deudas');
  cont.innerHTML = '';
  if (!inf.deudores.length) {
    const vacio = crear('div', { className: 'vacio' });
    vacio.append(crear('b', { textContent: estado.historial.length ? 'No te debe nadie' : 'Todavía no hay historial' }));
    vacio.append(crear('span', {
      textContent: estado.historial.length
        ? 'Todas las cuentas guardadas están pagadas.'
        : 'Guardá una lista después de cobrar y acá vas a ver quién quedó debiendo.',
    }));
    cont.append(vacio);
    return;
  }
  for (const d of inf.deudores) cont.append(fichaDeudor(d));
}

function fichaDeudor(d) {
  const caja = crear('article', { className: 'deudor' });
  const tope = crear('div', { className: 'deudor-tope' });
  tope.append(crear('span', { className: 'quien', textContent: d.nombre }));
  if (d.telMostrado) tope.append(crear('span', { className: 'tel', textContent: d.telMostrado }));
  const monto = crear('span', { className: d.debe < 0 ? 'debe afavor' : 'debe' });
  monto.textContent = d.debe < 0 ? moneda(-d.debe) + ' a favor' : moneda(d.debe);
  tope.append(monto);
  caja.append(tope);

  for (const l of d.listas) {
    const fila = crear('div', { className: 'deudor-lista' });
    fila.append(crear('span', { className: 'cuando', textContent: diaDe(l.fecha) }));
    fila.append(crear('span', { className: 'monto', textContent: moneda(l.debe) }));

    const grupo = crear('div', { className: 'estados' });
    for (const est of ESTADOS) {
      const b = crear('button', { type: 'button', textContent: est, dataset: { estado: est } });
      b.setAttribute('aria-pressed', String(l.estado === est));
      b.setAttribute('aria-label', `${d.nombre}, ${diaDe(l.fecha)}: marcar ${est}`);
      b.addEventListener('click', async () => {
        await guardarPago({
          listaId: l.listaId, claveCliente: d.claveCliente, estado: est,
          monto: est === 'pagada' ? l.total : 0, fecha: new Date().toISOString().slice(0, 10),
        });
        await refrescarDeudas();
      });
      grupo.append(b);
    }
    fila.append(grupo);
    caja.append(fila);
  }
  return caja;
}

async function guardarHistorial() {
  const boton = $('#btn-guardar-historial');
  if (!estado.lista) { decir('#estado-respaldo', 'Cargá una lista primero.', 'revisar'); return; }
  if (!estado.cobros) pintarCobros();
  boton.textContent = 'Guardando…';
  try {
    await guardarListaEnHistorial(estado.lista.fecha, resumenParaHistorial(estado.lista, estado.cobros));
    await refrescarDeudas();
    boton.textContent = 'Guardada';
  } catch { boton.textContent = 'No pude guardar'; }
  setTimeout(() => { boton.textContent = 'Guardar la lista en el historial'; }, 2500);
}
$('#btn-guardar-historial').addEventListener('click', guardarHistorial);

// ---------- lo que se guarda solo ----------
// El avance se guarda apenas cambia: el celular se apaga cuando quiere.
let guardadoPendiente = null;
function guardarLuego() {
  clearTimeout(guardadoPendiente);
  guardadoPendiente = setTimeout(() => {
    if (!estado.lista) return;
    guardarAvance(estado.lista.fecha, {
      tildes: [...estado.tildes],
      pesos: Object.fromEntries(estado.pesos),
      ordenPuntos: estado.ordenPuntos,
      cosechados: [...estado.tildados],
      enviadas: [...estado.enviadas],
    }).catch(() => {});
  }, 350);
}

async function recuperarConfig() {
  try {
    estado.alias = (await leerConfig('aliasProductos')) || {};
    estado.plantillas = { ...PLANTILLAS, ...((await leerConfig('plantillas')) || {}) };
  } catch {
    estado.alias = {};
    estado.plantillas = { ...PLANTILLAS };
  }
  $('#pl-saludo').value = estado.plantillas.saludo;
  $('#pl-cierre').value = estado.plantillas.cierre;
  $('#pl-alias').value = estado.plantillas.aliasTransferencia;
}

async function recuperarAvance() {
  try {
    const g = await leerAvance(estado.lista.fecha);
    if (!g) return;
    estado.tildes = new Set(g.tildes || []);
    estado.tildados = new Set(g.cosechados || []);
    estado.enviadas = new Set(g.enviadas || []);
    estado.pesos = new Map(Object.entries(g.pesos || {}));
    if (g.ordenPuntos && g.ordenPuntos.length) estado.ordenPuntos = g.ordenPuntos;
    for (const p of estado.lista.pedidos) {
      for (const item of p.items) {
        const peso = estado.pesos.get(claveItem(p, item));
        if (peso !== undefined && peso !== null && peso !== '') item.pesoReal = Number(peso);
      }
    }
    recalcular();
  } catch { /* si no hay base, se arranca de cero */ }
}

// ---------- papeles y respaldo ----------
function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = crear('a', { href: url, download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

$('#btn-imprimir').addEventListener('click', () => {
  cerrarMas();
  setTimeout(() => window.print(), 150);
});

$('#btn-exportar').addEventListener('click', async () => {
  try {
    const todo = await exportarTodo();
    descargar(new Blob([JSON.stringify(todo, null, 2)], { type: 'application/json' }),
      `lahuerta-respaldo-${new Date().toISOString().slice(0, 10)}.json`);
    decir('#estado-respaldo', `Bajado: ${todo.listas.length} listas, ${todo.pagos.length} pagos y tus alias.`);
  } catch (e) { decir('#estado-respaldo', 'No pude armar el respaldo: ' + e.message, 'mal'); }
});

$('#btn-importar').addEventListener('click', () => $('#archivo-respaldo').click());

$('#archivo-respaldo').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  if (!archivo) return;
  try {
    const datos = JSON.parse(await archivo.text());
    if (!datos || typeof datos !== 'object' || !('listas' in datos)) {
      throw new Error('Ese archivo no parece un respaldo de La Huerta.');
    }
    const cuenta = await importarTodo(datos);
    await recuperarConfig();
    await refrescarDeudas();
    if (estado.lista) pintarCobros();
    decir('#estado-respaldo', `Cargado: ${cuenta.listas} listas, ${cuenta.pagos} pagos, ${cuenta.config} preferencias.`);
  } catch (err) { decir('#estado-respaldo', 'No pude cargar el respaldo: ' + err.message, 'mal'); }
  e.target.value = '';
});

$('#btn-xlsx').addEventListener('click', () => {
  if (!estado.lista) { decir('#estado-respaldo', 'Cargá una lista para exportar los informes.', 'revisar'); return; }
  try {
    descargar(informesAXLSX(estado.lista, {
      margen: Math.max(0, Number($('#margen').value) || 0) / 100,
      ordenPuntos: estado.ordenPuntos, alias: estado.alias, plantillas: estado.plantillas,
    }), `lahuerta-informes-${estado.lista.fecha}.xlsx`);
    decir('#estado-respaldo', 'Bajado el Excel con las tres hojas: Cosecha, Pedidos y Cobros.');
  } catch (e) { decir('#estado-respaldo', 'No pude armar el Excel: ' + e.message, 'mal'); }
});

/** Todas las cuentas como imagen, en un zip. */
$('#btn-zip').addEventListener('click', async () => {
  const boton = $('#btn-zip');
  if (!estado.cobros) { decir('#estado-respaldo', 'Cargá una lista primero.', 'revisar'); return; }
  const cuentas = estado.cobros.cuentas;
  const opciones = { fechaLista: estado.lista.fecha, aliasTransferencia: estado.plantillas.aliasTransferencia };
  const archivos = [];
  try {
    for (let i = 0; i < cuentas.length; i++) {
      boton.textContent = `Armando ${i + 1} de ${cuentas.length}…`;
      const blob = await cuentaAJPG(cuentas[i], opciones);
      archivos.push({
        nombre: nombreArchivo(cuentas[i], estado.lista.fecha),
        datos: new Uint8Array(await blob.arrayBuffer()),
      });
      await new Promise((r) => setTimeout(r, 0));
    }
    descargar(armarZip(archivos), `cuentas_${estado.lista.fecha}.zip`);
    decir('#estado-respaldo', `${archivos.length} imágenes descargadas.`);
  } catch {
    decir('#estado-respaldo', 'No pude armar las imágenes.', 'mal');
  }
  boton.textContent = 'Bajar todas las cuentas como imagen';
});

/** Balance: los totales solos, sin los mensajes. Se arma al pedir el PDF. */
function pintarBalance() {
  if (!estado.cobros) return;
  const hoja = $('#hoja-balance');
  hoja.innerHTML = '';

  hoja.append(crear('h3', { textContent: 'Balance del ' + diaDe(estado.lista.fecha) }));
  const balance = balancePorPunto(estado.cobros, estado.lista.puntos);

  for (const grupo of balance.grupos) {
    hoja.append(crear('p', { className: 'balance-punto', textContent: grupo.etiqueta }));
    for (const cuenta of grupo.cuentas) {
      const fila = crear('div', { className: 'balance-fila' });
      fila.append(crear('span', { className: 'quien', textContent: cuenta.nombre }));
      if (cuenta.telMostrado) fila.append(crear('span', { className: 'tel', textContent: cuenta.telMostrado }));
      fila.append(crear('span', { className: 'monto', textContent: moneda(cuenta.total) }));
      hoja.append(fila);
    }
    const sub = crear('div', { className: 'balance-fila subtotal' });
    sub.append(crear('span', { className: 'quien', textContent: plural(grupo.cuentas.length, 'pedido', 'pedidos') }));
    sub.append(crear('span', { className: 'monto', textContent: moneda(grupo.total) }));
    hoja.append(sub);
  }

  const total = crear('div', { className: 'balance-total' });
  total.append(crear('b', { textContent: 'Total de la semana' }));
  total.append(crear('span', { className: 'monto', textContent: moneda(balance.total) }));
  hoja.append(total);
}

$('#btn-balance').addEventListener('click', () => {
  if (!estado.lista) { decir('#estado-respaldo', 'Cargá una lista primero.', 'revisar'); return; }
  if (!estado.cobros) pintarCobros();
  pintarBalance();
  cerrarMas();
  irA('cobros');
  document.body.classList.add('imprimir-balance');
  setTimeout(() => window.print(), 150);
  setTimeout(() => document.body.classList.remove('imprimir-balance'), 800);
});

$('#btn-copiar-cosecha').addEventListener('click', async () => {
  const boton = $('#btn-copiar-cosecha');
  const texto = $('#texto-cosecha').textContent;
  try {
    await navigator.clipboard.writeText(texto);
    boton.textContent = 'Copiado';
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('#texto-cosecha'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    boton.textContent = 'Copialo vos';
  }
  setTimeout(() => { boton.textContent = 'Copiar para WhatsApp'; }, 2000);
});

// Al abrir: el margen guardado y el historial, para que "Deben" ya tenga datos.
(async () => {
  $('#margen').value = String(await margenGuardado());
  await recuperarConfig();
  await refrescarDeudas();
})();

// Punto de entrada para las páginas de prueba de test/.
window.laHuerta = {
  cargar, estado, irA, pintarCosecha, pintarArmado, pintarCobros, pintarBalance,
  refrescarDeudas, mostrarBolsa, mostrarCuenta, abrirMas, cerrarMas,
};
