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
import { catalogo, textoDeCatalogo, renglonDeProducto } from '../core/catalogo.js';
import { leerPedidoDeTexto } from '../core/leer-pedido.js';
import { informePedidos, recalcularPedido } from '../core/pedidos.js';
import { informeCobros, linkWhatsApp, productosSinAlias, balancePorPunto, PLANTILLAS } from '../core/cobros.js';
import { ordenarParaBolsa } from '../core/categorias.js';
import { calcularItem, totalPedido } from '../core/precios.js';
import { moneda, fecha, sinAcentos, claveCliente, telE164 } from '../core/formato.js';
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

  // Lo que se toca a mano en el armado, cuando la realidad no coincide con
  // el form: el producto que no hubo, el que agregaste de más, la rebaja.
  quitados: new Map(),         // clave -> el item, guardado para poder devolverlo
  preciosManuales: new Map(),  // clave -> precio puesto a mano
  agregados: [],               // los que no vinieron por el form
  pedidosWhatsApp: [],         // pedidos enteros que no entraron por el form
  borrador: { items: [], pendientes: [] },  // el pedido que estas cargando ahora
  catalogo: null,              // el saludo y el cierre de la lista de productos
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

// ---------- las sábanas: "Más", un producto, agregar ----------
// Son tres hojas que suben desde abajo y comparten el velo. Siempre hay una
// sola abierta: abrir una cierra la anterior.
function abrirSabana(id, foco) {
  $$('.sabana').forEach((s) => { s.hidden = s.id !== id.replace('#', ''); });
  $('#velo').hidden = false;
  if (foco) setTimeout(() => { const e = $(foco); if (e) { e.focus(); e.scrollIntoView({ block: 'center' }); } }, 60);
}
function cerrarSabanas() {
  $('#velo').hidden = true;
  $$('.sabana').forEach((s) => { s.hidden = true; });
}
const abrirMas = (foco) => abrirSabana('#sabana', foco);
const cerrarMas = cerrarSabanas;

$('#btn-mas').addEventListener('click', () => abrirMas());
$('#btn-cerrar-mas').addEventListener('click', cerrarSabanas);
$$('[data-cerrar]').forEach((b) => b.addEventListener('click', cerrarSabanas));
$('#velo').addEventListener('click', cerrarSabanas);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarSabanas(); });

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
    estado.quitados = new Map();
    estado.preciosManuales = new Map();
    estado.agregados = [];
    estado.pedidosWhatsApp = [];
    estado.borrador = { items: [], pendientes: [] };

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

  // Las dos cosas que se hacen desde la lista y no son el circuito semanal.
  const productos = crear('button', { className: 'fila-boton', textContent: 'Lista de productos para mandar' });
  productos.addEventListener('click', () => { pintarProductos(); irA('productos'); });
  cont.append(productos);

  const nuevo = crear('button', { className: 'fila-boton', textContent: 'Agregar un pedido de WhatsApp' });
  nuevo.addEventListener('click', abrirNuevoPedido);
  cont.append(nuevo);

  const deWa = estado.pedidosWhatsApp.length;
  if (deWa) {
    cont.append(crear('p', {
      className: 'ayuda',
      textContent: `${plural(deWa, 'pedido', 'pedidos')} de WhatsApp cargados a mano, además de los del form.`,
    }));
  }
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

/** Copia un texto y avisa en el propio botón. Si el navegador no da permiso
 *  de portapapeles, al menos deja el texto seleccionado para copiarlo a mano. */
async function copiarDe(idBoton, texto, idFuente) {
  const boton = $(idBoton);
  const antes = boton.textContent;
  try {
    await navigator.clipboard.writeText(texto);
    boton.textContent = 'Copiado';
  } catch {
    const fuente = $(idFuente);
    if (fuente) {
      const r = document.createRange();
      r.selectNodeContents(fuente);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    boton.textContent = 'Copialo vos';
  }
  setTimeout(() => { boton.textContent = antes; }, 2000);
}

// ---------- la lista de productos: la que mandás para que pidan ----------
// No es la cosecha. La cosecha son los pedidos que ya entraron; esto es lo que
// hay en oferta, así que van TODOS los productos del form, también los que
// todavía nadie pidió: son justamente los que se pueden pedir.

const CATALOGO = {
  encabezado: 'Lista de La Huerta del {fecha}',
  cierre: 'Cualquier cosa me escribís.',
};

function textosDelCatalogo() {
  const c = { ...CATALOGO, ...(estado.catalogo || {}) };
  const dia = estado.lista ? diaDe(estado.lista.fecha) : '';
  return {
    encabezado: c.encabezado.replace(/\{fecha\}/g, dia).trim(),
    cierre: c.cierre.replace(/\{fecha\}/g, dia).trim(),
  };
}

function pintarProductos() {
  if (!estado.lista) return;
  const inf = catalogo(estado.lista);

  const resumen = [plural(inf.total, 'producto', 'productos')];
  if (inf.sinPrecio) resumen.push(plural(inf.sinPrecio, 'sin precio', 'sin precio'));
  $('#resumen-productos').textContent = resumen.join(' · ') + ' · lista del ' + diaDe(estado.lista.fecha);

  $('#texto-productos').textContent = textoDeCatalogo(inf, textosDelCatalogo());

  const hoja = $('#hoja-productos');
  hoja.innerHTML = '';

  // El encabezado va en la hoja: en papel la fecha tiene que estar.
  const enc = crear('div', { className: 'franja' });
  enc.append(crear('b', { textContent: textosDelCatalogo().encabezado }));
  hoja.append(enc);

  for (const familia of inf.familias) {
    hoja.append(crear('p', { className: 'rubro', textContent: familia.etiqueta }));
    const caja = crear('div', { className: 'tarjeta' });
    for (const p of familia.productos) {
      const fila = crear('div', { className: 'producto' + (p.precio === null ? ' sin-precio' : '') });
      fila.append(crear('span', { className: 'nombre', textContent: p.nombreCorto }));
      fila.append(crear('span', {
        className: 'uni',
        textContent: p.unidad ? (p.unidad === 'c/u' ? 'cada uno' : p.unidad) : '',
      }));
      fila.append(crear('span', {
        className: 'precio',
        textContent: p.precio === null ? 'a confirmar' : moneda(p.precio),
      }));
      caja.append(fila);
    }
    hoja.append(caja);
  }

  if (inf.sinPrecio) {
    hoja.append(crear('div', {
      className: 'aviso revisar no-imprime',
      textContent: `Hay ${plural(inf.sinPrecio, 'producto', 'productos')} sin precio. `
        + 'En la lista salen como "a confirmar": cargales el precio en Revisar si no querés que salgan así.',
    }));
  }
}

for (const [id, campo] of [['#cat-encabezado', 'encabezado'], ['#cat-cierre', 'cierre']]) {
  $(id).addEventListener('input', () => {
    estado.catalogo = { ...CATALOGO, ...(estado.catalogo || {}), [campo]: $(id).value };
    guardarConfig('catalogo', estado.catalogo).catch(() => {});
    pintarProductos();
  });
}

$('#btn-copiar-productos').addEventListener('click', () =>
  copiarDe('#btn-copiar-productos', $('#texto-productos').textContent, '#texto-productos'));

$('#btn-pdf-productos').addEventListener('click', () => window.print());

$('#btn-ver-productos').addEventListener('click', () => {
  cerrarSabanas();
  if (!estado.lista) return;
  pintarProductos();
  irA('productos');
});

// ---------- un pedido que llegó por WhatsApp ----------
// El form no es el único camino: siempre hay alguien que te escribe. Un pedido
// cargado acá es un pedido como cualquier otro —entra en la cosecha, en el
// armado y en los cobros— porque se mete en lista.pedidos con la misma forma
// que los que salen del archivo. No hay un segundo circuito que mantener.

/** Lo mínimo que hay que guardar de un ítem para poder rearmarlo mañana. */
function registroDeItem(item) {
  return {
    columnaIndice: item.columnaIndice,
    nombreCorto: item.nombreCorto,
    unidad: item.unidad,
    unidadCol: item.unidadCol,
    sePesa: Boolean(item.sePesa),
    cantidad: item.cantidad,
    precioFijado: item.precioFijado === undefined ? null : item.precioFijado,
  };
}

/** Rearma un pedido guardado y lo mete en la lista. */
function reponerPedido(reg) {
  const pedido = {
    claveCliente: reg.claveCliente,
    nombre: reg.nombre,
    telMostrado: reg.telMostrado || '',
    telE164: telE164(reg.telMostrado || ''),
    puntoCodigo: reg.puntoCodigo || null,
    marcaTemporal: '',
    deWhatsApp: true,
    items: (reg.items || []).map((a) => itemAgregado(a)),
    total: 0,
  };
  recalcularPedido(pedido);
  estado.lista.pedidos.push(pedido);
  if (!estado.lista.clientes.some((c) => c.clave === pedido.claveCliente)) {
    estado.lista.clientes.push({
      clave: pedido.claveCliente, nombre: pedido.nombre,
      telE164: pedido.telE164, telMostrado: pedido.telMostrado,
      puntoHabitual: pedido.puntoCodigo,
    });
  }
  return pedido;
}

/** Las cifras de la pantalla Lista salen de acá: hay que rehacerlas. */
function refrescarResumen() {
  const L = estado.lista;
  L.resumen.pedidos = L.pedidos.length;
  L.resumen.productosConPedido = L.columnas
    .filter((c) => L.pedidos.some((p) => p.items.some((i) => i.columnaIndice === c.indice))).length;
}

function abrirNuevoPedido() {
  cerrarSabanas();
  if (!estado.lista) return;
  estado.borrador = { items: [], pendientes: [] };

  $('#np-nombre').value = '';
  $('#np-tel').value = '';
  $('#np-buscar').value = '';
  $('#np-otro').open = false;
  for (const id of ['#np-otro-nombre', '#np-otro-unidad', '#np-otro-precio']) $(id).value = '';
  $('#np-otro-cantidad').value = '1';
  $('#np-aviso').innerHTML = '';
  $('#np-texto').value = '';
  $('#np-manual').open = false;

  const sel = $('#np-punto');
  sel.innerHTML = '';
  for (const punto of estado.lista.puntos) {
    sel.append(crear('option', { value: punto.codigo, textContent: punto.etiqueta }));
  }
  if (!estado.lista.puntos.length) sel.append(crear('option', { value: '', textContent: 'Sin punto de retiro' }));

  pintarPendientes();
  pintarBorrador();
  pintarCatalogoNuevo();
  irA('pedido-nuevo');
}

function pintarBorrador() {
  const cont = $('#np-borrador');
  cont.innerHTML = '';
  const items = estado.borrador.items;

  if (!items.length) {
    cont.append(crear('p', { className: 'ayuda', textContent: 'Todavía no le agregaste nada. Buscá abajo.' }));
    return;
  }

  const caja = crear('div', { className: 'tarjeta' });
  for (const item of items) {
    const fila = crear('div', { className: 'borrador-fila' });

    const cuerpo = crear('span', { className: 'cuerpo' });
    cuerpo.append(crear('b', { textContent: item.nombreCorto }));
    cuerpo.append(crear('span', { textContent: [item.unidad, moneda(item.precioFinal)].filter(Boolean).join(' · ') }));
    fila.append(cuerpo);

    // El paso: medio kilo para lo que va por peso, de uno para lo que se cuenta.
    const paso = item.unidad === 'kg' ? 0.5 : 1;
    const pasos = crear('span', { className: 'pasos-cant' });
    const menos = crear('button', { textContent: '−' });
    const valor = crear('span', { className: 'valor', textContent: numero(item.cantidad) });
    const mas = crear('button', { textContent: '+' });
    menos.setAttribute('aria-label', 'Menos ' + item.nombreCorto);
    mas.setAttribute('aria-label', 'Más ' + item.nombreCorto);

    const mover = (d) => {
      const n = Math.round((item.cantidad + d) * 100) / 100;
      if (n <= 0) return;
      item.cantidad = n;
      item.cantidadCosecha = n;
      recalcularItem(item);
      pintarBorrador();
    };
    menos.addEventListener('click', () => mover(-paso));
    mas.addEventListener('click', () => mover(paso));
    pasos.append(menos, valor, mas);
    fila.append(pasos);

    const saca = crear('button', { className: 'saca', textContent: '✕' });
    saca.setAttribute('aria-label', 'Sacar ' + item.nombreCorto + ' del pedido');
    saca.addEventListener('click', () => {
      estado.borrador.items = estado.borrador.items.filter((x) => x !== item);
      pintarBorrador();
      pintarCatalogoNuevo();
    });
    fila.append(saca);
    caja.append(fila);
  }

  const total = crear('div', { className: 'borrador-total' });
  total.append(crear('span', { textContent: plural(items.length, 'producto', 'productos') }));
  total.append(crear('span', {
    className: 'monto',
    textContent: moneda(items.reduce((a, i) => a + i.precioFinal, 0)),
  }));
  caja.append(total);
  cont.append(caja);
}

function pintarCatalogoNuevo() {
  const q = normal($('#np-buscar').value.trim());
  const yaTiene = new Set(estado.borrador.items.map((i) => i.columnaIndice));
  const cont = $('#np-catalogo');
  cont.innerHTML = '';

  const caja = crear('div', { className: 'tarjeta' });
  let cuantos = 0;
  for (const col of estado.lista.columnas) {
    if (yaTiene.has(col.indice)) continue;
    if (q && !normal(col.nombreCorto).includes(q)) continue;
    cuantos++;
    const b = crear('button', { className: 'fila-agregar' });
    const cuerpo = crear('span', { className: 'cuerpo' });
    cuerpo.append(crear('b', { textContent: col.nombreCorto }));
    cuerpo.append(crear('span', { textContent: renglonDeProducto(col).replace(col.nombreCorto + ' ', '') }));
    b.append(cuerpo, crear('span', { className: 'mas', textContent: '+' }));
    b.addEventListener('click', () => {
      estado.borrador.items.push(itemAgregado({
        columnaIndice: col.indice, nombreCorto: col.nombreCorto,
        unidad: col.unidad, unidadCol: col.unidad, sePesa: col.sePesa, cantidad: 1,
      }));
      pintarBorrador();
      pintarCatalogoNuevo();
    });
    caja.append(b);
  }

  if (!cuantos) {
    cont.append(crear('p', {
      className: 'ayuda',
      textContent: q ? 'Ningún producto de la lista se llama así.' : 'Ya le agregaste todos los productos.',
    }));
    return;
  }
  cont.append(caja);
}

$('#np-buscar').addEventListener('input', pintarCatalogoNuevo);

// ----- leer el pedido pegado -----
// Lo que se entiende entra directo al borrador. Lo que no, queda arriba en
// ámbar hasta que lo resolvés: ni se pierde ni se inventa.
$('#np-leer').addEventListener('click', () => {
  const texto = $('#np-texto').value;
  if (!texto.trim()) { decir('#np-aviso', 'Pegá el mensaje en la caja de arriba.', 'revisar'); return; }

  const inf = leerPedidoDeTexto(texto, estado.lista.columnas);
  if (!inf.renglones.length) {
    decir('#np-aviso', 'No encontré ningún producto en ese mensaje. Podés agregarlos a mano.', 'revisar');
    return;
  }

  const yaTiene = new Set(estado.borrador.items.map((i) => i.columnaIndice));
  let entraron = 0;
  let repetidos = 0;

  for (const r of inf.renglones) {
    if (r.estado !== 'ok') { estado.borrador.pendientes.push(r); continue; }
    if (yaTiene.has(r.columnaIndice)) { repetidos++; continue; }
    agregarAlBorrador(r.columnaIndice, r.cantidad);
    yaTiene.add(r.columnaIndice);
    entraron++;
  }

  const partes = [];
  if (entraron) partes.push(plural(entraron, 'producto entró', 'productos entraron'));
  if (repetidos) partes.push(plural(repetidos, 'ya estaba', 'ya estaban'));
  const pendientes = estado.borrador.pendientes.length;
  if (pendientes) partes.push(plural(pendientes, 'te lo pregunto abajo', 'te los pregunto abajo'));

  decir('#np-aviso', partes.join(' · ') || 'No entró nada.', pendientes ? 'revisar' : 'ok');
  $('#np-texto').value = '';
  pintarPendientes();
  pintarBorrador();
  pintarCatalogoNuevo();
});

/** Mete un producto de la lista en el borrador, con su cantidad. */
function agregarAlBorrador(columnaIndice, cantidad) {
  const col = estado.lista.columnas.find((c) => c.indice === columnaIndice);
  if (!col) return;
  estado.borrador.items.push(itemAgregado({
    columnaIndice: col.indice, nombreCorto: col.nombreCorto,
    unidad: col.unidad, unidadCol: col.unidad, sePesa: col.sePesa,
    cantidad: cantidad > 0 ? cantidad : 1,
  }));
}

/** Los renglones que el lector no pudo resolver solo. */
function pintarPendientes() {
  const cont = $('#np-pendientes');
  cont.innerHTML = '';
  const lista = estado.borrador.pendientes;
  if (!lista.length) return;

  cont.append(crear('div', {
    className: 'aviso revisar resumen-lectura',
    textContent: `${plural(lista.length, 'renglón', 'renglones')} que no puedo resolver solo. Decime cuál es cada uno.`,
  }));

  const sacar = (r) => {
    estado.borrador.pendientes = estado.borrador.pendientes.filter((x) => x !== r);
    pintarPendientes();
    pintarBorrador();
    pintarCatalogoNuevo();
  };

  for (const r of lista) {
    const caja = crear('div', { className: 'pendiente' });
    caja.append(crear('span', { className: 'crudo', textContent: r.crudo }));
    caja.append(crear('span', { className: 'porque', textContent: r.aviso }));

    const opciones = crear('div', { className: 'opciones' });
    const yaTiene = new Set(estado.borrador.items.map((i) => i.columnaIndice));

    // Si hay candidatos, se elige tocando: es lo más rápido en el celular.
    for (const c of r.candidatos) {
      if (yaTiene.has(c.indice)) continue;
      const b = crear('button', { textContent: `${numero(r.cantidad)} ${c.nombreCorto}` });
      b.addEventListener('click', () => { agregarAlBorrador(c.indice, r.cantidad); sacar(r); });
      opciones.append(b);
    }

    // Y si no lo reconoció, se lo busca a mano con el nombre ya puesto.
    if (!r.candidatos.length) {
      const buscar = crear('button', { textContent: 'Buscarlo en la lista' });
      buscar.addEventListener('click', () => {
        $('#np-manual').open = true;
        $('#np-buscar').value = r.consulta;
        pintarCatalogoNuevo();
        $('#np-buscar').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      opciones.append(buscar);
    }

    const fuera = crear('button', { className: 'descartar', textContent: 'No va' });
    fuera.setAttribute('aria-label', 'Descartar el renglón: ' + r.crudo);
    fuera.addEventListener('click', () => sacar(r));
    opciones.append(fuera);

    caja.append(opciones);
    cont.append(caja);
  }
}

$('#np-otro-agregar').addEventListener('click', () => {
  const nombre = $('#np-otro-nombre').value.trim();
  const cantidad = Number(String($('#np-otro-cantidad').value).replace(',', '.'));
  const precio = Number(String($('#np-otro-precio').value).replace(',', '.'));
  if (!nombre) { decir('#np-aviso', 'Al producto nuevo le falta el nombre.', 'revisar'); return; }
  if (!Number.isFinite(cantidad) || cantidad <= 0) { decir('#np-aviso', 'La cantidad tiene que ser mayor que cero.', 'revisar'); return; }
  if (!Number.isFinite(precio) || precio < 0) { decir('#np-aviso', 'Poné cuánto le vas a cobrar.', 'revisar'); return; }

  // Índices negativos, como los productos libres del armado: así no chocan
  // con ninguna columna del form.
  const usados = estado.borrador.items.map((i) => i.columnaIndice).filter((n) => n < 0);
  estado.borrador.items.push(itemAgregado({
    columnaIndice: usados.length ? Math.min(...usados) - 1 : -1,
    nombreCorto: nombre,
    unidad: $('#np-otro-unidad').value.trim() || null,
    unidadCol: $('#np-otro-unidad').value.trim() || null,
    sePesa: false, cantidad, precioFijado: precio,
  }));

  for (const id of ['#np-otro-nombre', '#np-otro-unidad', '#np-otro-precio']) $(id).value = '';
  $('#np-otro-cantidad').value = '1';
  decir('#np-aviso', '');
  pintarBorrador();
});

$('#btn-nuevo-pedido').addEventListener('click', abrirNuevoPedido);

$('#btn-guardar-pedido').addEventListener('click', () => {
  const nombre = $('#np-nombre').value.trim();
  const tel = $('#np-tel').value.trim();
  const punto = $('#np-punto').value || null;

  if (!nombre) { decir('#np-aviso', 'Falta el nombre de quien pidió.', 'revisar'); return; }
  if (!estado.borrador.items.length) { decir('#np-aviso', 'El pedido está vacío: agregale algo.', 'revisar'); return; }

  // Guardar con renglones sin resolver es perder parte del pedido en silencio.
  // Se puede hacer igual, pero hay que decirlo dos veces.
  const pend = estado.borrador.pendientes.length;
  if (pend && !$('#btn-guardar-pedido').dataset.insistiendo) {
    $('#btn-guardar-pedido').dataset.insistiendo = '1';
    decir('#np-aviso',
      `Te quedan ${plural(pend, 'renglón', 'renglones')} sin resolver arriba: si guardás así, no entran. Tocá Guardar otra vez para guardar igual.`,
      'revisar');
    return;
  }
  delete $('#btn-guardar-pedido').dataset.insistiendo;

  const clave = claveCliente(nombre, tel);
  if (estado.lista.pedidos.some((p) => p.claveCliente === clave)) {
    decir('#np-aviso', `${nombre} ya tiene un pedido en esta lista. Si es otra persona, agregale el teléfono para diferenciarla; si querés sumarle cosas, hacelo desde Armar.`, 'mal');
    return;
  }

  const reg = {
    claveCliente: clave, nombre, telMostrado: tel, puntoCodigo: punto,
    items: estado.borrador.items.map(registroDeItem),
  };
  estado.pedidosWhatsApp.push(reg);
  const pedido = reponerPedido(reg);
  refrescarResumen();
  guardarLuego();

  estado.borrador = { items: [], pendientes: [] };
  pintarLista();
  pintarProductos();
  pintarCosecha();
  pintarArmado();
  pintarCobros();

  irA('lista');
  decir('#estado-carga',
    `Cargado el pedido de ${nombre}: ${plural(pedido.items.length, 'producto', 'productos')}, ${moneda(pedido.total)}.`,
    'ok');
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

  // Quién pidió esto. El número de gente es el botón: en el campo sirve para
  // saber si ese atado de más es de alguien o es tu margen de descarte.
  const pedazo = document.createDocumentFragment();
  const detalle = p.detalle || [];
  if (detalle.length) {
    const panel = crear('div', { className: 'pidieron', hidden: true });
    panel.append(...filasDeQuienPidio(detalle));

    const boton = crear('button', { className: 'quienes' });
    boton.append(crear('span', { textContent: String(detalle.length) }),
                 crear('i', { textContent: detalle.length === 1 ? 'pidió' : 'piden' }));
    boton.setAttribute('aria-expanded', 'false');
    boton.setAttribute('aria-label', `Ver quién pidió ${p.nombreCorto}`);
    boton.addEventListener('click', () => {
      const abierto = panel.hidden;
      panel.hidden = !abierto;
      boton.setAttribute('aria-expanded', String(abierto));
    });

    fila.append(boton);
    pedazo.append(fila, panel);
  } else {
    pedazo.append(fila);
  }
  return pedazo;
}

/** Un renglón por persona: cuánto, quién, y dónde lo retira. */
function filasDeQuienPidio(detalle) {
  const etiquetas = new Map((estado.lista.puntos || []).map((x) => [x.codigo, x.etiqueta]));
  return detalle
    .slice()
    .sort((a, b) => String(a.cliente).localeCompare(String(b.cliente), 'es'))
    .map((d) => {
      const fila = crear('div', { className: 'pidio' });
      fila.append(crear('span', { className: 'cuanto', textContent: numero(d.cantidad) }));
      fila.append(crear('span', { className: 'quien', textContent: d.cliente }));
      const donde = etiquetas.get(d.punto) || d.punto;
      if (donde) fila.append(crear('span', { className: 'donde', textContent: donde }));
      if (d.nota) fila.append(crear('span', { className: 'nota', textContent: d.nota }));
      return fila;
    });
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
  // Una bolsa a la que le sacaste todo está lista: no queda nada que poner.
  if (!pedido.items.length) return true;
  return pedido.items.every((i) => estado.tildes.has(claveItem(pedido, i)));
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
  if (!pedido.items.length) {
    caja.append(crear('div', { className: 'vacio', innerHTML: '<b>Esta bolsa quedó vacía</b>' }));
  }

  // Lo que no vino por el form: se agrega acá, en la bolsa de esta persona.
  const agregar = crear('button', { className: 'fila-boton agregar no-imprime', textContent: '+  Agregar un producto' });
  agregar.addEventListener('click', () => abrirAgregar(pedido));
  art.append(agregar);

  // Lo que sacaste queda a la vista, tachado, para poder devolverlo.
  const sacados = [...estado.quitados.entries()]
    .filter(([clave]) => clave.startsWith(pedido.claveCliente + '#'));
  if (sacados.length) {
    const tira = crear('div', { className: 'quitados no-imprime' });
    tira.append(crear('b', { textContent: plural(sacados.length, 'producto sacado', 'productos sacados') }));
    for (const [clave, item] of sacados) {
      const fila = crear('div', { className: 'quitado' });
      fila.append(crear('span', {
        textContent: `${numero(item.cantidad)} ${item.unidad || item.unidadCol || ''} ${item.nombreCorto}`.replace(/\s+/g, ' '),
      }));
      const volver = crear('button', { textContent: 'Devolver' });
      volver.setAttribute('aria-label', 'Devolver ' + item.nombreCorto + ' a la bolsa de ' + pedido.nombre);
      volver.addEventListener('click', () => devolverItem(pedido, clave));
      fila.append(volver);
      tira.append(fila);
    }
    art.append(tira);
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

  // El precio se toca: ahí adentro está la rebaja y el "no hubo".
  const precio = crear('button', { className: 'plata' });
  precio.setAttribute('aria-label', `Precio de ${item.nombreCorto}. Tocá para rebajarlo o para sacarlo de la bolsa.`);
  precio.addEventListener('click', () => abrirItem(pedido, item, refrescar));
  item._pintarPrecio = () => pintarBotonPrecio(precio, item);
  item._pintarPrecio();

  if (item.sePesa) fila.append(balanzaDe(pedido, item, refrescar));
  fila.append(precio);
  return fila;
}

function pintarBotonPrecio(boton, item) {
  boton.innerHTML = '';
  boton.append(crear('span', { textContent: moneda(item.precioFinal) }));
  const aMano = item.precioManual !== null && item.precioManual !== undefined;
  if (aMano) boton.append(crear('i', { textContent: 'a mano' }));
  boton.classList.toggle('estimado', Boolean(item.estimado) && !aMano);
  boton.classList.toggle('a-mano', aMano);
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

// ---------- cuando la realidad no coincide con el form ----------
// Tres cosas que pasan siempre al armar: no hubo un producto, alguien pide
// algo que no pidió por el form, o le hacés una rebaja. Las tres viven acá,
// atrás del precio de cada renglón.

/** Lo que saldría este ítem si no hubiera un precio puesto a mano. */
function precioAutomatico(item) {
  const col = estado.lista.columnas.find((c) => c.indice === item.columnaIndice);
  const calc = calcularItem({ ...item, precioManual: null }, col, item.pesoReal);
  return calc ? calc.precio : 0;
}

/** Recalcula un ítem solo, respetando el precio a mano si lo tiene. */
function recalcularItem(item) {
  const col = estado.lista.columnas.find((c) => c.indice === item.columnaIndice);
  const calc = calcularItem(item, col, item.pesoReal);
  if (!calc) return;
  item.precioFinal = calc.precio;
  item.estimado = calc.estimado;
  item.basePrecio = calc.base;
}

function ponerPrecio(pedido, item, valor) {
  const clave = claveItem(pedido, item);
  if (valor === null) {
    item.precioManual = null;
    estado.preciosManuales.delete(clave);
  } else {
    item.precioManual = valor;
    estado.preciosManuales.set(clave, valor);
  }
  recalcularItem(item);
  // El total de la bolsa se rehace acá mismo: si lo dejáramos para el que
  // llama, alcanza con que uno se olvide para que la bolsa muestre un número
  // viejo. El total siempre sale de las líneas.
  recalcularPedido(pedido);
  guardarLuego();
}

/** El índice de la próxima columna inventada. Sale de lo que ya agregaste, no
 *  de un contador aparte: así no se puede desincronizar ni repetir una clave. */
function proximoIdLibre() {
  const usados = estado.agregados.map((a) => a.columnaIndice).filter((n) => n < 0);
  return usados.length ? Math.min(...usados) - 1 : -1;
}

let itemAbierto = null;

function abrirItem(pedido, item, refrescar) {
  itemAbierto = { pedido, item, refrescar };
  $('#item-titulo').textContent = item.nombreCorto;

  const cuerpo = $('#item-cuerpo');
  cuerpo.innerHTML = '';
  cuerpo.append(crear('p', {
    className: 'item-donde',
    textContent: `${numero(item.cantidad)} ${item.unidad || item.unidadCol || ''} · en la bolsa de ${pedido.nombre}`.replace(/\s+/g, ' '),
  }));

  // --- el precio ---
  const gPrecio = crear('section', { className: 'grupo' });
  gPrecio.append(crear('h3', { textContent: 'Precio' }));

  const campo = crear('input', {
    type: 'number', inputMode: 'numeric', min: '0', step: '50',
    value: String(item.precioFinal),
  });
  campo.setAttribute('aria-label', 'Cuánto le cobrás por ' + item.nombreCorto);
  const lab = crear('label', { className: 'fila-campo columna' });
  lab.append(crear('span', { textContent: 'Cuánto le cobrás' }), campo);
  gPrecio.append(lab);

  const nota = crear('p', { className: 'ayuda' });
  const volver = crear('button', { className: 'fila-boton', textContent: 'Volver al precio de lista' });

  const refrescarHoja = () => {
    const auto = precioAutomatico(item);
    const aMano = item.precioManual !== null && item.precioManual !== undefined;
    nota.textContent = aMano
      ? `Puesto a mano. Solo, saldría ${moneda(auto)}. No se mueve aunque cargues los kilos.`
      : (item.sePesa && item.pesoReal
        ? `Sale de la balanza: ${numero(item.pesoReal)} kg.`
        : 'Sale de la lista. Si lo cambiás acá, queda fijo.');
    volver.hidden = !aMano;
    campo.value = String(item.precioFinal);
    if (item._pintarPrecio) item._pintarPrecio();
    if (refrescar) refrescar();
  };

  const aplicar = () => {
    const v = campo.value.trim();
    if (v === '') return;
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return;
    // Si le ponés exactamente lo que ya salía, no hace falta fijarlo.
    ponerPrecio(pedido, item, n === precioAutomatico(item) ? null : n);
    refrescarHoja();
  };
  campo.addEventListener('change', aplicar);

  volver.addEventListener('click', () => { ponerPrecio(pedido, item, null); refrescarHoja(); });
  gPrecio.append(nota, volver);
  cuerpo.append(gPrecio);

  // --- cuánto, solo para lo que agregaste vos ---
  if (item.agregado) {
    const gCant = crear('section', { className: 'grupo' });
    gCant.append(crear('h3', { textContent: 'Cuánto' }));
    const cc = crear('input', {
      type: 'number', inputMode: 'decimal', min: '0', step: '0.5', value: String(item.cantidad),
    });
    cc.setAttribute('aria-label', 'Cuánto de ' + item.nombreCorto);
    const lc = crear('label', { className: 'fila-campo columna' });
    lc.append(crear('span', { textContent: 'Cantidad' }), cc);
    gCant.append(lc);
    cc.addEventListener('change', () => {
      const n = Number(cc.value.replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) return;
      item.cantidad = n;
      item.cantidadCosecha = n;
      const reg = estado.agregados.find((a) =>
        a.claveCliente === pedido.claveCliente && a.columnaIndice === item.columnaIndice);
      if (reg) reg.cantidad = n;
      recalcularItem(item);
      guardarLuego();
      cerrarSabanas();
      pintarArmado();
    });
    cuerpo.append(gCant);
  }

  // --- sacarlo ---
  const gQuitar = crear('section', { className: 'grupo' });
  gQuitar.append(crear('h3', { textContent: 'Si no hubo' }));
  const quitar = crear('button', { className: 'fila-boton peligro', textContent: 'Sacar de la bolsa' });
  quitar.addEventListener('click', () => quitarItem(pedido, item));
  gQuitar.append(quitar);
  gQuitar.append(crear('p', {
    className: 'ayuda',
    textContent: 'Deja de sumar al total y no aparece en el mensaje del cobro. Lo podés devolver.',
  }));
  cuerpo.append(gQuitar);

  refrescarHoja();
  abrirSabana('#hoja-item');
}

/** Lo sacamos de verdad del pedido y lo guardamos aparte. Así ningún total lo
 *  puede sumar por accidente: si no está en la lista, no está en la cuenta. */
function quitarItem(pedido, item) {
  const clave = claveItem(pedido, item);
  const i = pedido.items.indexOf(item);
  if (i >= 0) pedido.items.splice(i, 1);
  estado.quitados.set(clave, item);
  guardarLuego();
  cerrarSabanas();
  pintarArmado();
}

/** Saca un ítem buscándolo por su clave. Se usa al recuperar el avance, que
 *  guarda las claves y no los ítems. No parte la clave en dos: el nombre del
 *  cliente podría traer cualquier cosa, así que compara la clave entera. */
function quitarPorClave(clave) {
  for (const pedido of estado.lista.pedidos) {
    const i = pedido.items.findIndex((it) => claveItem(pedido, it) === clave);
    if (i >= 0) {
      estado.quitados.set(clave, pedido.items[i]);
      pedido.items.splice(i, 1);
      return true;
    }
  }
  return false;
}

function devolverItem(pedido, clave) {
  const item = estado.quitados.get(clave);
  if (!item) return;
  pedido.items.push(item);
  estado.quitados.delete(clave);
  guardarLuego();
  pintarArmado();
}

/** Un ítem hecho a mano, con la misma forma que los que salen de la lista. */
function itemAgregado(a) {
  const item = {
    columnaIndice: a.columnaIndice,
    nombreCorto: a.nombreCorto,
    unidadCol: a.unidadCol || null,
    sePesa: Boolean(a.sePesa),
    textoCrudo: 'agregado a mano',
    vacia: false,
    cantidad: a.cantidad,
    cantidadExplicita: true,
    cantidadCosecha: a.cantidad,
    unidad: a.unidad || null,
    precioFijado: a.precioFijado === undefined ? null : a.precioFijado,
    nota: '',
    confianza: 'verde',
    avisos: [],
    pesoReal: null,
    precioFinal: 0,
    estimado: false,
    basePrecio: 'lista',
    agregado: true,
  };
  recalcularItem(item);
  return item;
}

let pedidoParaAgregar = null;

function abrirAgregar(pedido) {
  pedidoParaAgregar = pedido;
  $('#agregar-titulo').textContent = 'Agregar a la bolsa de ' + pedido.nombre;
  $('#buscar-producto').value = '';
  $('#otro-producto').open = false;
  $('#nuevo-aviso').textContent = '';
  for (const id of ['#nuevo-nombre', '#nuevo-unidad', '#nuevo-precio']) $(id).value = '';
  $('#nuevo-cantidad').value = '1';
  pintarListaAgregar();
  abrirSabana('#hoja-agregar');
}

const normal = (s) => sinAcentos(String(s || '')).toLowerCase();

function pintarListaAgregar() {
  const pedido = pedidoParaAgregar;
  if (!pedido) return;
  const q = normal($('#buscar-producto').value.trim());
  const yaTiene = new Set(pedido.items.map((i) => i.columnaIndice));
  const cont = $('#lista-agregar');
  cont.innerHTML = '';

  const caja = crear('div', { className: 'tarjeta' });
  let cuantos = 0;
  for (const col of estado.lista.columnas) {
    if (yaTiene.has(col.indice)) continue;              // ya lo tiene: no se duplica
    if (q && !normal(col.nombreCorto).includes(q)) continue;
    cuantos++;
    const b = crear('button', { className: 'fila-agregar' });
    const cuerpo = crear('span', { className: 'cuerpo' });
    cuerpo.append(crear('b', { textContent: col.nombreCorto }));
    cuerpo.append(crear('span', {
      textContent: [col.precio === null ? 'sin precio' : moneda(col.precio), col.unidad || null]
        .filter(Boolean).join(' · '),
    }));
    b.append(cuerpo, crear('span', { className: 'mas', textContent: '+' }));
    b.addEventListener('click', () => agregarItem(pedido, {
      claveCliente: pedido.claveCliente,
      columnaIndice: col.indice,
      nombreCorto: col.nombreCorto,
      unidad: col.unidad, unidadCol: col.unidad, sePesa: col.sePesa,
      cantidad: 1,
    }));
    caja.append(b);
  }

  if (!cuantos) {
    cont.append(crear('p', {
      className: 'ayuda',
      textContent: q ? 'No hay ningún producto de la lista con ese nombre.'
                     : 'Esta bolsa ya tiene todos los productos de la lista.',
    }));
    return;
  }
  cont.append(caja);
}

$('#buscar-producto').addEventListener('input', pintarListaAgregar);

$('#btn-nuevo').addEventListener('click', () => {
  const pedido = pedidoParaAgregar;
  if (!pedido) return;
  const nombre = $('#nuevo-nombre').value.trim();
  const cantidad = Number($('#nuevo-cantidad').value.replace(',', '.'));
  const precio = Number($('#nuevo-precio').value.replace(',', '.'));
  const aviso = $('#nuevo-aviso');

  if (!nombre) { aviso.textContent = 'Ponele un nombre.'; return; }
  if (!Number.isFinite(cantidad) || cantidad <= 0) { aviso.textContent = 'La cantidad tiene que ser mayor que cero.'; return; }
  if (!Number.isFinite(precio) || precio < 0) { aviso.textContent = 'Poné cuánto le vas a cobrar.'; return; }

  agregarItem(pedido, {
    claveCliente: pedido.claveCliente,
    columnaIndice: proximoIdLibre(),     // negativo: no choca con ninguna columna
    nombreCorto: nombre,
    unidad: $('#nuevo-unidad').value.trim() || null,
    unidadCol: $('#nuevo-unidad').value.trim() || null,
    sePesa: false,
    cantidad,
    precioFijado: precio,                // es el total, no se multiplica
  });
});

function agregarItem(pedido, a) {
  estado.agregados.push(a);
  pedido.items.push(itemAgregado(a));
  guardarLuego();
  cerrarSabanas();
  pintarArmado();
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
      quitados: [...estado.quitados.keys()],
      manuales: Object.fromEntries(estado.preciosManuales),
      agregados: estado.agregados,
      pedidosWhatsApp: estado.pedidosWhatsApp,
    }).catch(() => {});
  }, 350);
}

async function recuperarConfig() {
  try {
    estado.alias = (await leerConfig('aliasProductos')) || {};
    estado.plantillas = { ...PLANTILLAS, ...((await leerConfig('plantillas')) || {}) };
    estado.catalogo = { ...CATALOGO, ...((await leerConfig('catalogo')) || {}) };
  } catch {
    estado.alias = {};
    estado.plantillas = { ...PLANTILLAS };
    estado.catalogo = { ...CATALOGO };
  }
  $('#pl-saludo').value = estado.plantillas.saludo;
  $('#pl-cierre').value = estado.plantillas.cierre;
  $('#pl-alias').value = estado.plantillas.aliasTransferencia;

  estado.catalogo = { ...CATALOGO, ...(estado.catalogo || {}) };
  $('#cat-encabezado').value = estado.catalogo.encabezado;
  $('#cat-cierre').value = estado.catalogo.cierre;
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

    // El orden importa: primero los pedidos enteros que no vinieron por el
    // form, después los ítems agregados a bolsas que ya existían (uno de ellos
    // puede estar quitado), después los precios a mano, y recién al final se
    // sacan los quitados. Si no, buscaríamos ítems que todavía no existen.
    estado.pedidosWhatsApp = g.pedidosWhatsApp || [];
    for (const reg of estado.pedidosWhatsApp) {
      if (!estado.lista.pedidos.some((p) => p.claveCliente === reg.claveCliente)) reponerPedido(reg);
    }
    if (estado.pedidosWhatsApp.length) refrescarResumen();

    estado.agregados = g.agregados || [];
    for (const a of estado.agregados) {
      const p = estado.lista.pedidos.find((x) => x.claveCliente === a.claveCliente);
      if (p && !p.items.some((i) => i.columnaIndice === a.columnaIndice)) p.items.push(itemAgregado(a));
    }

    estado.preciosManuales = new Map(Object.entries(g.manuales || {}).map(([k, v]) => [k, Number(v)]));

    for (const p of estado.lista.pedidos) {
      for (const item of p.items) {
        const clave = claveItem(p, item);
        const peso = estado.pesos.get(clave);
        if (peso !== undefined && peso !== null && peso !== '') item.pesoReal = Number(peso);
        if (estado.preciosManuales.has(clave)) item.precioManual = estado.preciosManuales.get(clave);
      }
    }

    estado.quitados = new Map();
    for (const clave of g.quitados || []) quitarPorClave(clave);

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

$('#btn-copiar-cosecha').addEventListener('click', () =>
  copiarDe('#btn-copiar-cosecha', $('#texto-cosecha').textContent, '#texto-cosecha'));

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
  quitarItem, devolverItem, agregarItem, ponerPrecio, recalcularItem, proximoIdLibre,
  pintarPendientes, agregarAlBorrador,
  precioAutomatico, abrirItem, abrirAgregar,
  pintarProductos, pintarLista, abrirNuevoPedido, reponerPedido, refrescarResumen,
  registroDeItem, itemAgregado, textosDelCatalogo,
};
