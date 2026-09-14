/**
 * band-control.js — Control en vivo de la BANDA TRANSPORTADORA.
 *
 * SOLO la banda. No toca el maletín ni ninguna otra estación: sus endpoints,
 * su estado y sus componentes visuales quedan exactamente como estaban.
 *
 * Arquitectura (la misma que impone el programa maestro ST del PLC):
 *
 *   USUARIO → FRONTEND → BACKEND PYTHON → MODBUS TCP → REGISTROS DEL PLC
 *           → PROGRAMA MAESTRO ST → VFD / SENSORES / TORRETA / PLUMAS
 *
 * Este módulo NO reproduce la lógica del PLC ni sus prioridades. Solo:
 *   1. recoge lo que pide el usuario,
 *   2. lo manda al backend (que valida y escribe los registros de configuración),
 *   3. lee el feedback REAL del PLC y lo pinta.
 *
 * Nunca se pinta el estado a partir del último comando enviado: el operador
 * puede haber pulsado un paro físico y la página tiene que enterarse.
 *
 * Registros que se leen (vía GET /banda/estado, todos del ST):
 *   R1..R15 control, paros y paro automático · R20..R41 sensores y torreta
 *   R50 lámparas con I1 · R60..R63 plumas · R100..R127 monitores · R500..R506 VFD
 * Registros que se escriben (vía POST, siempre desde el backend):
 *   R2 dirección · R4 frecuencia · R9 StopMode · R10 SoftStopCmd · R11/R15 paro
 *   automático · R20-R24/R28/R29 S1 · R30-R34/R38/R39 S2 · R40/R41/R50 torreta
 *   R60/R61 plumas · R5 NewCfgFlag (trigger) · R6 ResetCmd (trigger)
 * Nunca R500/R504/R506 ni los monitores R100..R127.
 */

// Mismo puente que usa el resto del editor (app.js). Se lee igual para no
// tener dos configuraciones distintas de la misma dirección.
function bridgeUrl() {
  return (localStorage.getItem('lv_plc_bridge') || 'http://localhost:8000').replace(/\/+$/, '');
}

// IP del PLC que se opera desde el pop-up. La escribe el usuario en el campo de
// IP y se actualiza al cargar un programa de banda con "Cargar" (el PLC que el
// usuario eligió). Si está vacía, el backend usa la configurada con
// POST /plc/config?device=banda o BANDA_PLC_IP; nunca autodetecta.
function bandaTarget() {
  const ip = (localStorage.getItem('lv_banda_ip') || '').trim();
  const port = Number(localStorage.getItem('lv_banda_port')) || 0;
  const t = {};
  if (ip) t.ip = ip;
  if (port) t.port = port;
  return t;
}

// Esquema SVG de la banda: solo se le pasa la lectura para pintarla.
import { paintBandLive } from './renderer.js';
// Misma forma canónica del bloque "band" que usa el asistente.
import { canonicalBand } from './equipment.js';

const POLL_MS = 1500;
// Segundos que puede estar CfgReady=0 con una configuración válida antes de
// avisar de un probable paro. La secuencia de reset del VFD dura ~2 s.
const PARO_SOSPECHA_MS = 6000;

let timer = null;
let enVuelo = false;          // evita solapar peticiones si el PLC va lento
let sinCfgDesde = null;       // instante en que CfgReady pasó a 0
let ultimoEstado = null;

const $ = (id) => document.getElementById(id);

// ── Utilidades de formulario ───────────────────────────────────

/** Suma de las lámparas marcadas → máscara 0..7 (verde=1, amarilla=2, roja=4). */
function leerMascara(id) {
  const cont = $(id);
  if (!cont) return 0;
  let m = 0;
  cont.querySelectorAll('input[type="checkbox"]').forEach(c => {
    if (c.checked) m |= Number(c.value);
  });
  return m;
}

/** Máscara 0..7 → casillas marcadas. */
function pintarMascara(id, mask) {
  const cont = $(id);
  if (!cont) return;
  cont.querySelectorAll('input[type="checkbox"]').forEach(c => {
    c.checked = (Number(mask) & Number(c.value)) !== 0;
  });
}

/** Valor del botón encendido de un grupo segmentado (data-<attr>). */
function segValor(id, attr) {
  const on = $(id)?.querySelector('.bc-seg-btn.is-on');
  return on ? Number(on.dataset[attr]) : null;
}

function marcarSeg(id, attr, valor) {
  $(id)?.querySelectorAll('.bc-seg-btn').forEach(b => {
    b.classList.toggle('is-on', Number(b.dataset[attr]) === Number(valor));
  });
}

const direccionElegida = () => segValor('bcDir', 'dir') || 1;
const marcarDireccion = (dir) => marcarSeg('bcDir', 'dir', dir);

function entero(id, porDefecto = 0) {
  const v = parseInt($(id)?.value, 10);
  return Number.isFinite(v) ? v : porDefecto;
}

function setValor(id, v) {
  const el = $(id);
  if (el && v != null) el.value = String(v);
}

function mensaje(texto, tipo = '') {
  const el = $('bcMsg');
  if (!el) return;
  el.textContent = texto || '';
  el.className = 'bc-msg' + (tipo ? ' is-' + tipo : '');
}

function alerta(texto, tipo = '') {
  const el = $('bcAlert');
  if (!el) return;
  el.hidden = !texto;
  el.textContent = texto || '';
  el.className = 'bc-alert' + (tipo ? ' is-' + tipo : '');
}

function chip(id, texto, clase = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = texto;
  el.className = 'bc-chip' + (clase ? ' ' + clase : '');
}

const siNo = (v) => (v ? 'sí' : 'no');

// ── Bloque 'band' que entiende el backend ──────────────────────
// Es el MISMO contrato que genera el asistente: así el panel y el chat
// escriben exactamente los mismos registros.
function construirBand() {
  const autoModo = entero('bcAutoMode', 0);
  const band = {
    enable: true,
    direction: direccionElegida(),
    freq_hz: entero('bcFreq', 0),
    stop_mode: segValor('bcStopMode', 'mode') ?? 0,
    auto_stop_mode: autoModo || null,
    auto_stop_s: autoModo ? entero('bcAutoS', 0) : null,
    torreta_run:  leerMascara('bcTorRun'),
    torreta_idle: leerMascara('bcTorIdle'),
    torreta_i1:   leerMascara('bcTorI1'),
  };

  for (const n of [1, 2]) {
    const on = $(`bcS${n}En`)?.checked;
    if (!on) {
      // Sensor apagado: sin acción declarada, el backend lo deshabilita.
      for (const k of [`s${n}_action`, `wait_s${n}_s`, `count_s${n}`, `torreta_s${n}`, `s${n}_pluma1`, `s${n}_pluma2`]) {
        band[k] = null;
      }
      continue;
    }
    const accion = entero(`bcS${n}Action`, 0);
    band[`s${n}_action`] = accion;
    band[`wait_s${n}_s`]  = entero(`bcS${n}Timer`, 0);
    band[`count_s${n}`]   = entero(`bcS${n}Count`, 0);
    band[`torreta_s${n}`] = leerMascara(`bcS${n}Mask`);
    band[`s${n}_pluma1`]  = entero(`bcS${n}P1`, 0);
    band[`s${n}_pluma2`]  = entero(`bcS${n}P2`, 0);
  }
  return band;
}

// Validación de cortesía en el navegador. La de verdad la hace el backend
// contra las reglas del ST (CfgValid): aquí solo se evita el viaje inútil.
function revisar(band) {
  const errores = [];
  if (![1, 2].includes(Number(band.direction)))
    errores.push('Elige una dirección (1 o 2).');
  if (!(band.freq_hz >= 1 && band.freq_hz <= 327))
    errores.push('La frecuencia debe estar entre 1 y 327 Hz.');
  if (Number(band.auto_stop_mode) > 0 && !(band.auto_stop_s > 0))
    errores.push('La secuencia automática necesita un tiempo objetivo mayor que 0 s.');
  for (const n of [1, 2]) {
    const a = band[`s${n}_action`];
    if (a === null || a === undefined) continue;
    if (![0, 1, 2, 3, 4].includes(Number(a)))
      errores.push(`La acción del sensor ${n} no es válida.`);
    if ([2, 4].includes(Number(a)) && !(band[`wait_s${n}_s`] > 0))
      errores.push(`El sensor ${n} detiene la banda por tiempo: pon más de 0 segundos.`);
    if (band[`count_s${n}`] < 0)
      errores.push(`El conteo del sensor ${n} no puede ser negativo.`);
  }
  return errores;
}

// ── Llamadas al backend ────────────────────────────────────────
async function pedir(ruta, opciones = {}) {
  const res = await fetch(bridgeUrl() + ruta, {
    signal: AbortSignal.timeout(opciones.timeout || 20000),
    ...opciones.init,
  });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(d?.detail || `HTTP ${res.status}`);
  return d;
}

function postear(ruta, cuerpo, timeout) {
  return pedir(ruta, {
    timeout,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bandaTarget(), ...cuerpo }),
    },
  });
}

// ── Pintado del feedback ───────────────────────────────────────
// Fases que calcula el backend (plc_banda._fase_visual) SOLO con registros leídos.
const FASE = {
  paro_i3:          { txt: 'Paro I3 activo',          clase: 'is-err',  icono: 'ti-hand-stop' },
  paro_i2:          { txt: 'Paro I2 activo',          clase: 'is-err',  icono: 'ti-hand-stop' },
  paro_software:    { txt: 'Paro software activo',    clase: 'is-err',  icono: 'ti-lock' },
  esperando_config: { txt: 'Esperando configuración', clase: 'is-off',  icono: 'ti-settings' },
  sin_marcha:       { txt: 'Sin marcha · lámparas/plumas', clase: 'is-off', icono: 'ti-bulb' },
  configurando:     { txt: 'Configurando VFD…',       clase: 'is-wait', icono: 'ti-loader' },
  lista:            { txt: 'Lista · esperando I1',    clase: 'is-ok',   icono: 'ti-circle-check' },
  habilitada:       { txt: 'Banda habilitada',        clase: 'is-ok',   icono: 'ti-player-play' },
  pausa_sensor:     { txt: 'Pausada por sensor',      clase: 'is-wait', icono: 'ti-player-pause' },
  auto_completado:  { txt: 'Secuencia terminada',     clase: 'is-ok',   icono: 'ti-flag-check' },
  corriendo:        { txt: 'Banda corriendo',         clase: 'is-run',  icono: 'ti-player-play-filled' },
};

const ESTADO_BANDA = {
  0: 'detenida', 1: 'corriendo dirección 1', 2: 'corriendo dirección 2',
};

const STOP_MODE_TXT = ['I3', 'I2 + I3', 'Software + I3', 'I2 + Software + I3'];
const ACCESO_TXT = { cfg: 'config', trig: 'trigger', fb: 'feedback', mon: 'monitor', vfd: 'VFD' };

function badge(id, texto, clase, icono) {
  const el = $(id);
  if (!el) return;
  el.className = 'bc-badge' + (clase ? ' ' + clase : '');
  el.innerHTML = `<i class="ti ${icono}"></i> ${texto}`;
}

/** Secuencia de arranque: Esperando configuración → … → Banda corriendo. */
function pintarPasos(est) {
  const hecho = {
    config: est.cfg_valid || est.cfg_ready,
    vfd: est.cfg_ready,
    lista: est.cfg_ready,
    i1: est.band_enable || est.running,
    run: est.running,
  };
  const activo = {
    esperando_config: 'config', sin_marcha: 'config', configurando: 'vfd',
    lista: 'i1', habilitada: 'run', pausa_sensor: 'run', corriendo: 'run',
  }[est.fase] || null;
  const cont = $('bcSteps');
  cont?.querySelectorAll('.bc-step').forEach(el => {
    el.classList.toggle('is-done', !!hecho[el.dataset.step]);
    el.classList.toggle('is-on', el.dataset.step === activo);
  });
  cont?.classList.toggle('is-stop', !!est.gen_stop);
}

function pintarDiagnostico(est) {
  const box = $('bcDiagBox'), cont = $('bcDiag');
  if (!box?.open || !cont) return;
  const filas = (est.registros || []).map(r => `
    <tr><td>%R${r.r}</td><td>${r.simbolo}</td>
    <td class="${r.acceso === 'cfg' || r.acceso === 'trig' ? 'is-rw' : ''}">${ACCESO_TXT[r.acceso] || r.acceso}</td>
    <td>${r.valor}</td></tr>`).join('');
  cont.innerHTML = `<table><thead><tr><th>Registro</th><th>Símbolo</th><th>Acceso</th><th>Valor</th></tr></thead>
    <tbody>${filas}</tbody></table>`;
}

function pintarEstado(est) {
  ultimoEstado = est;

  const fase = FASE[est.fase] || { txt: 'Banda detenida', clase: 'is-off', icono: 'ti-player-stop' };
  badge('bcFase', fase.txt, fase.clase, fase.icono);
  pintarPasos(est);

  badge('bcBanda', 'Banda: ' + (ESTADO_BANDA[est.band_status] ?? est.estado),
        est.running ? 'is-run' : 'is-off', 'ti-topology-bus');
  badge('bcCfg', 'Config: ' + (est.cfg_ready ? 'lista' : est.cfg_valid ? 'preparando' : 'no lista'),
        est.cfg_ready ? 'is-ok' : 'is-wait', 'ti-settings-check');
  badge('bcEnable', 'Habilitación: ' + (est.band_enable ? 'activa' : 'sin I1'),
        est.band_enable ? 'is-ok' : 'is-off', 'ti-player-play');
  const razon = Number(est.stop_reason) || 0;
  badge('bcReason', 'Causa de paro: ' + (razon ? est.stop_reason_texto : 'ninguna'),
        razon >= 1 && razon <= 3 ? 'is-err' : razon ? 'is-wait' : 'is-off', 'ti-info-circle');
  badge('bcSpeed', `${est.vfd_speed_hz ?? '—'} Hz`, '', 'ti-wave-sine');

  // Paros: entradas físicas (monitores R105..R107) y paro software (R10/R124).
  const modo = Number(est.stop_mode) || 0;
  const usaI2 = modo === 1 || modo === 3, usaSw = modo === 2 || modo === 3;
  chip('bcStopPlc', `Modo en el PLC: ${STOP_MODE_TXT[modo] ?? modo}`);
  chip('bcIn1', `I1 arranque: ${est.i1_pulsado ? 'presionado' : 'suelto'}`, est.i1_pulsado ? 'is-ok' : '');
  chip('bcIn2', `I2 paro aux: ${est.i2_activo ? 'activo' : 'suelto'}${usaI2 ? '' : ' (no usado)'}`,
       est.aux_stop ? 'is-err' : '');
  chip('bcIn3', `I3 paro: ${est.i3_paro ? 'presionado' : 'suelto'}`, est.i3_paro ? 'is-err' : '');
  const softCmd = Number(est.soft_stop_cmd) === 1;
  chip('bcSoftState', `Paro software: ${softCmd ? 'enclavado' : 'liberado'}${softCmd && !usaSw ? ' (el modo no lo incluye)' : ''}`,
       est.soft_stop ? 'is-err' : softCmd ? 'is-wait' : '');
  const btnSoft = $('bcSoftStop');
  if (btnSoft && !btnSoft.disabled) {
    btnSoft.className = 'bc-btn ' + (softCmd ? 'bc-btn-primary' : 'bc-btn-danger');
    btnSoft.innerHTML = softCmd
      ? '<i class="ti ti-lock-open"></i> Liberar paro software'
      : '<i class="ti ti-lock"></i> Activar paro software';
  }

  // Secuencia automática: R11 objetivo · R12 transcurrido · R13 terminada · R15 modo.
  const preset = Number(est.auto_stop_preset) || 0, acc = Number(est.auto_stop_accum) || 0;
  const autoOn = Number(est.auto_stop_mode) > 0;
  chip('bcAutoObj', `Tiempo objetivo: ${autoOn ? `${preset} s` : '—'}`);
  chip('bcAutoAcc', `Transcurrido: ${autoOn ? `${acc} s` : '—'}`);
  chip('bcAutoState', 'Estado: ' + (!autoOn ? 'deshabilitada'
    : est.auto_stop_done ? 'terminada'
    : est.running ? 'contando'
    : est.band_enable ? (Number(est.auto_stop_mode) === 1 ? 'en pausa (no cuenta)' : 'contando')
    : 'esperando I1'), autoOn && !est.auto_stop_done && est.band_enable ? 'is-wait' : '');
  chip('bcAutoDone', `Secuencia terminada: ${siNo(est.auto_stop_done)}`, est.auto_stop_done ? 'is-ok' : '');
  const barra = $('bcAutoBar');
  if (barra) barra.style.width = autoOn && preset > 0 ? `${Math.min(100, (acc / preset) * 100)}%` : '0';

  // Sensores: detección real, conteo actual/objetivo y temporizador.
  for (const n of [1, 2]) {
    const s = est.sensores?.[`s${n}`] || {};
    const enPausa = Number(est.stop_reason) === (n === 1 ? 5 : 6);
    chip(`bcS${n}Det`, `Detectando: ${siNo(s.detecta)}${enPausa ? ' · pausa activa' : ''}`,
         enPausa ? 'is-wait' : s.detecta ? 'is-ok' : '');
    chip(`bcS${n}Cnt`, `Conteo: ${s.count ?? '—'} / ${s.count_preset ? s.count_preset : 'cada detección'}`);
    const temporizado = s.action === 2 || s.action === 4;
    chip(`bcS${n}Tmr`, `Temporizador: ${temporizado ? `${s.timer_s ?? 0} / ${s.timer_preset ?? 0} s` : '—'}`);
    chip(`bcS${n}Done`, `Objetivo alcanzado: ${siNo(s.count_done)}`, s.count_done ? 'is-ok' : '');
  }

  // Torreta: salidas físicas reales (monitores R110..R112).
  const L = est.lamparas || {};
  chip('bcQ3', `Verde Q3: ${L.verde ? 'encendida' : 'apagada'}`, L.verde ? 'is-ok' : '');
  chip('bcQ4', `Amarilla Q4: ${L.amarilla ? 'encendida' : 'apagada'}`, L.amarilla ? 'is-wait' : '');
  chip('bcQ5', `Roja Q5: ${L.roja ? 'encendida' : 'apagada'}`, L.roja ? 'is-err' : '');

  // Plumas: estado REAL (R62/R63), no el último botón pulsado.
  for (const n of [1, 2]) {
    const p = est[`pluma${n}`] || {};
    const salida = Number(p.status) === 1 ? p.salidas?.subir : Number(p.status) === 2 ? p.salidas?.bajar : '';
    chip(`bcP${n}`, 'Estado: ' + (p.estado || '—') + (salida ? ` (${salida})` : ''));
    document.querySelectorAll(`.bc-seg[data-pluma="${n}"] .bc-seg-btn`).forEach(b => {
      b.classList.toggle('is-on', Number(b.dataset.cmd) === Number(p.status));
    });
  }

  // Configuración válida cargada pero CfgReady en 0 más de lo que dura la
  // secuencia del VFD (~2 s): la secuencia no avanza (p. ej. con un paro activo).
  if (!est.cfg_ready && est.cfg_valid) {
    if (sinCfgDesde === null) sinCfgDesde = Date.now();
  } else {
    sinCfgDesde = null;
  }
  const atascada = sinCfgDesde !== null && Date.now() - sinCfgDesde > PARO_SOSPECHA_MS;

  if (est.hard_stop) {
    alerta('Paro I3 activo: el PLC mantiene detenidos la banda, el VFD y las plumas. '
         + 'Suelta I3 y pulsa I1 para volver a arrancar.');
  } else if (est.aux_stop) {
    alerta('Paro I2 activo (el modo de paro incluye I2). Suelta I2 y pulsa I1 para volver a arrancar.');
  } else if (est.soft_stop) {
    alerta('Paro software activo. Libéralo con el botón "Liberar paro software"; '
         + 'la banda NO rearranca sola: después pulsa I1.');
  } else if (atascada) {
    alerta('El PLC no confirma la configuración (CfgReady sigue en 0). La secuencia del VFD '
         + 'no avanza con un paro activo; si no hay paro, vuelve a enviar la configuración '
         + 'o haz un Reset del VFD.');
  } else if (est.fase === 'pausa_sensor') {
    alerta(`${est.stop_reason_texto}: es una pausa temporal. La banda sigue habilitada y `
         + 'continúa sola al terminar la condición del sensor.', 'info');
  } else if (est.fase === 'auto_completado') {
    alerta(`Secuencia terminada: paro automático a los ${preset} s. Pulsa I1 para repetirla.`, 'info');
  } else if (est.fase === 'sin_marcha') {
    alerta('Programa sin marcha: I1 no arranca la banda. Las lámparas y plumas configuradas '
         + 'funcionan igual.', 'info');
  } else if (est.fase === 'esperando_config') {
    alerta('El PLC no tiene una configuración válida cargada (dirección 1 o 2 y frecuencia '
         + 'entre 1 y 327 Hz). Envía la configuración para armar el VFD.', 'info');
  } else if (est.fase === 'lista') {
    alerta('Configuración lista. Pulsa el botón físico I1 para habilitar la banda.', 'info');
  } else {
    alerta('');
  }
  pintarDiagnostico(est);
  paintBandLive($('bandPanel'), est, { paro: !!est.gen_stop });
}

// ── Polling ────────────────────────────────────────────────────
async function sondear() {
  if (enVuelo) return;
  enVuelo = true;
  const conn = $('bcConn');
  try {
    const t = bandaTarget();
    const q = new URLSearchParams();
    if (t.ip) q.set('ip', t.ip);
    if (t.port) q.set('port', t.port);
    const d = await pedir('/banda/estado' + (q.toString() ? '?' + q : ''), { timeout: 8000 });
    if (conn) { conn.textContent = d.plc || 'conectado'; conn.className = 'bc-conn is-ok'; }
    pintarEstado(d.estado || {});
  } catch (e) {
    ultimoEstado = null;
    paintBandLive($('bandPanel'), null);   // sin lectura: vuelve a la vista de configuracion
    if (conn) {
      const m = e.message || '';
      conn.textContent = /Failed to fetch|NetworkError|timeout|aborted/i.test(m)
        ? 'sin conexión con el puente'
        : /No hay IP/i.test(m) ? 'falta la IP de la banda' : 'sin lectura del PLC';
      conn.title = m;
      conn.className = 'bc-conn is-err';
    }
  } finally {
    enVuelo = false;
  }
}

export function startBandPolling() {
  if (timer) return;
  sondear();
  timer = setInterval(sondear, POLL_MS);
}

export function stopBandPolling() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// ── Acciones del usuario ───────────────────────────────────────
async function conBoton(btn, texto, fn) {
  const antes = btn?.innerHTML;
  if (btn) { btn.disabled = true; }
  mensaje(texto);
  try {
    const d = await fn();
    mensaje(d?.mensaje || 'Listo.', 'ok');
    (d?.avisos || []).forEach(a => console.info('[banda] ' + a));
    if (btn) { btn.disabled = false; btn.innerHTML = antes; }
    if (d?.estado) pintarEstado(d.estado);
    return d;
  } catch (e) {
    mensaje(e.message || 'Error', 'err');
    return null;
  } finally {
    if (btn && btn.disabled) { btn.disabled = false; btn.innerHTML = antes; }
  }
}

async function enviarConfig() {
  const crudo = construirBand();
  const errores = revisar(crudo);
  if (errores.length) { mensaje(errores[0], 'err'); return; }
  const band = canonicalBand(crudo);

  // Cambio de frecuencia = caso especial. El backend siempre para la banda,
  // reescribe los parámetros, dispara NewCfgFlag y espera CfgReady, así que
  // aquí solo se avisa de lo que va a pasar.
  const freqAnterior = ultimoEstado?.freq_request_hz;
  const cambiaFreq = freqAnterior != null && Number(freqAnterior) !== Number(band.freq_hz);

  await conBoton($('bcSend'),
    cambiaFreq ? 'Cambiando frecuencia: reconfigurando el VFD…' : 'Enviando configuración…',
    async () => {
      const d = await postear('/banda/config', { band }, 25000);
      d.mensaje = d.estado?.cfg_ready
        ? 'Configuración lista. Pulsa I1 para habilitar la banda.'
        : 'Configuración enviada. Esperando que el PLC prepare el VFD…';
      return d;
    });
}

function instalar() {
  // Dirección: si el PLC ya tiene la configuración armada, el cambio de
  // sentido se aplica en el acto (el ST lee DirCmd en vivo y no necesita
  // reset). Si todavía no lo está, solo queda seleccionado para el envío.
  $('bcDir')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.bc-seg-btn');
    if (!btn) return;
    const dir = Number(btn.dataset.dir);
    marcarDireccion(dir);
    if (ultimoEstado?.cfg_ready) {
      await conBoton(null, 'Cambiando dirección…', async () => {
        const d = await postear('/banda/direccion', { direccion: dir });
        d.mensaje = `Dirección ${dir} aplicada.`;
        return d;
      });
    }
  });

  // Modo de paro: el ST lee StopMode en cada scan, así que con el PLC
  // conectado se aplica al instante; si no, queda elegido para el envío.
  $('bcStopMode')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.bc-seg-btn');
    if (!btn) return;
    const modo = Number(btn.dataset.mode);
    marcarSeg('bcStopMode', 'mode', modo);
    if (!ultimoEstado) return;
    await conBoton(null, 'Aplicando modo de paro…', async () => {
      const d = await postear('/banda/paros', { stop_mode: modo });
      d.mensaje = `Modo de paro: ${STOP_MODE_TXT[modo]}.`;
      return d;
    });
  });

  // Paro software (R10): enclavar / liberar. Liberar NO rearranca: el PLC
  // exige un nuevo flanco de I1.
  $('bcSoftStop')?.addEventListener('click', () => {
    const activar = Number(ultimoEstado?.soft_stop_cmd) !== 1;
    conBoton($('bcSoftStop'), activar ? 'Activando paro software…' : 'Liberando paro software…', async () => {
      const d = await postear('/banda/paros', { soft_stop: activar });
      d.mensaje = d.avisos?.[0]
        || (activar ? 'Paro software activado.' : 'Paro software liberado. Pulsa I1 para arrancar.');
      return d;
    });
  });

  $('bcSend')?.addEventListener('click', enviarConfig);

  // Torreta en vivo: solo %R40/%R41/%R50. El ST las lee en cada scan, así que
  // no hay trigger ni reinicio del VFD y la banda sigue como estaba.
  $('bcTorApply')?.addEventListener('click', () =>
    conBoton($('bcTorApply'), 'Aplicando torreta…', async () => {
      const d = await postear('/banda/torreta', {
        run: leerMascara('bcTorRun'), idle: leerMascara('bcTorIdle'), i1: leerMascara('bcTorI1'),
      });
      d.mensaje = 'Torreta actualizada sin detener la banda.';
      return d;
    }));

  $('bcReset')?.addEventListener('click', () =>
    conBoton($('bcReset'), 'Reiniciando el VFD…', async () => {
      const d = await postear('/banda/reset', {}, 25000);
      d.mensaje = d.cfg_ready
        ? 'VFD reiniciado. Pulsa I1 para habilitar la banda.'
        : 'Reset enviado. El PLC aún no confirma la configuración.';
      return d;
    }));

  $('bcStop')?.addEventListener('click', () =>
    conBoton($('bcStop'), 'Deteniendo…', async () => {
      const d = await postear('/banda/paro', {});
      d.mensaje = 'Banda detenida y desarmada. Vuelve a enviar la configuración para operar.';
      return d;
    }));

  // Plumas: comando manual inmediato. El enclavamiento entre subir y bajar y
  // las prioridades las resuelve el PLC; aquí no se decide ninguna salida.
  document.querySelectorAll('.bc-seg[data-pluma]').forEach(seg => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.bc-seg-btn');
      if (!btn) return;
      const pluma = Number(seg.dataset.pluma);
      const cmd = Number(btn.dataset.cmd);
      conBoton(null, 'Enviando comando a la pluma…', async () => {
        const d = await postear('/banda/pluma', { pluma, comando: cmd });
        d.mensaje = `Pluma ${pluma}: ${['stop', 'subir', 'bajar'][cmd]}.`;
        return d;
      });
    });
  });

  // Reinicio de contadores de sensor.
  document.querySelectorAll('[data-reset-count]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sensor = Number(btn.dataset.resetCount);
      conBoton(btn, 'Reiniciando conteo…', async () => {
        const d = await postear('/banda/sensor/reset-contador', { sensor });
        // El ST no rearma la acción por conteo al poner el acumulado en 0.
        d.mensaje = d.avisos?.[0] || `Conteo del sensor ${sensor} en 0.`;
        return d;
      });
    });
  });

  // El diagnóstico solo se dibuja abierto: se pinta en cuanto se abre.
  $('bcDiagBox')?.addEventListener('toggle', () => { if (ultimoEstado) pintarDiagnostico(ultimoEstado); });
}

/**
 * Deja el panel listo. Se llama una vez al arrancar el editor; el polling
 * solo corre mientras el pop-up de la banda está abierto.
 */
export function initBandControl() {
  if (!$('bandControl')) return;
  instalar();
  marcarDireccion(1);

  // IP propia de la banda (lv_banda_ip). Sin ella, el sondeo depende de que el
  // puente tenga BANDA_PLC_IP configurada.
  const ip = $('bcIp');
  if (ip) {
    try { ip.value = localStorage.getItem('lv_banda_ip') || ''; } catch { /* sin storage */ }
    ip.addEventListener('change', () => {
      try { localStorage.setItem('lv_banda_ip', ip.value.trim()); } catch { /* sin storage */ }
      ultimoEstado = null;
      sinCfgDesde = null;
      if (timer) sondear();
    });
  }
}

/**
 * Precarga el formulario con el programa que generó el asistente, para que
 * el panel muestre lo mismo que el esquema. No escribe nada en el PLC.
 */
export function cargarBandDesdePrograma(program) {
  // La IP pudo elegirse desde el selector de "Cargar" (misma clave lv_banda_ip).
  const ipIn = $('bcIp');
  if (ipIn && document.activeElement !== ipIn) {
    try { ipIn.value = localStorage.getItem('lv_banda_ip') || ''; } catch { /* sin storage */ }
  }
  const crudo = program?.metadata?.engine_config?.band;
  if (!crudo || !$('bandControl')) return;
  const band = canonicalBand(crudo);

  marcarDireccion(band.direction === 'izquierda' ? 2 : 1);
  setValor('bcFreq', band.freq_hz);
  marcarSeg('bcStopMode', 'mode', band.stop_mode || 0);
  setValor('bcAutoMode', band.auto_stop_mode || 0);
  setValor('bcAutoS', band.auto_stop_s);

  for (const n of [1, 2]) {
    const codigo = band[`s${n}_action`];
    const en = $(`bcS${n}En`);
    if (en) en.checked = codigo != null;
    setValor(`bcS${n}Action`, codigo);
    setValor(`bcS${n}Timer`, band[`wait_s${n}_s`]);
    setValor(`bcS${n}Count`, band[`count_s${n}`] ?? 0);
    pintarMascara(`bcS${n}Mask`, band[`torreta_s${n}`] || 0);
    setValor(`bcS${n}P1`, band[`s${n}_pluma1`] || 0);
    setValor(`bcS${n}P2`, band[`s${n}_pluma2`] || 0);
  }
  pintarMascara('bcTorRun',  band.torreta_run  || 0);
  pintarMascara('bcTorIdle', band.torreta_idle || 0);
  pintarMascara('bcTorI1',   band.torreta_i1   || 0);
}
