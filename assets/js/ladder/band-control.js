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
 * Este módulo NO reproduce la lógica del PLC. Solo:
 *   1. recoge lo que pide el usuario,
 *   2. lo manda al backend (que valida y escribe los registros de interfaz),
 *   3. lee el feedback REAL del PLC y lo pinta.
 *
 * Nunca se pinta el estado a partir del último comando enviado: el operador
 * puede haber pulsado el paro físico I3 y la página tiene que enterarse.
 *
 * Registros que se leen (vía GET /banda/estado):
 *   R1 BandEnable · R3 BandStatus · R7 CfgReady · R8 velocidad real
 *   R25/R26/R27 S1 · R35/R36/R37 S2 · R40/R41 torreta · R62/R63 plumas
 * Registros que se escriben (vía POST, siempre desde el backend):
 *   R2 dirección · R4 frecuencia · R20-R24 S1 · R30-R34 S2 · R40/R41 torreta
 *   R60/R61 plumas · R5 NewCfgFlag (trigger) · R6 ResetCmd (trigger)
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

const POLL_MS = 1500;
// Segundos que puede estar CfgReady=0 con una configuración válida antes de
// avisar de un probable paro físico. La secuencia de reset del VFD dura ~2 s.
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

function direccionElegida() {
  const on = $('bcDir')?.querySelector('.bc-seg-btn.is-on');
  return Number(on?.dataset.dir) || 1;
}

function marcarDireccion(dir) {
  $('bcDir')?.querySelectorAll('.bc-seg-btn').forEach(b => {
    b.classList.toggle('is-on', Number(b.dataset.dir) === Number(dir));
  });
}

function entero(id, porDefecto = 0) {
  const v = parseInt($(id)?.value, 10);
  return Number.isFinite(v) ? v : porDefecto;
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

// ── Bloque 'band' que entiende el backend ──────────────────────
// Es el MISMO contrato que genera la IA: así el panel y el asistente
// escriben exactamente los mismos registros.
function construirBand() {
  const band = {
    enable: true,
    direction: direccionElegida(),
    freq_hz: entero('bcFreq', 0),
    torreta_run:  leerMascara('bcTorRun'),
    torreta_idle: leerMascara('bcTorIdle'),
  };

  for (const n of [1, 2]) {
    const on = $(`bcS${n}En`)?.checked;
    if (!on) {
      // Sensor apagado: sin acción declarada, el backend lo deshabilita.
      band[`s${n}_action`] = null;
      band[`wait_s${n}_s`]  = null;
      band[`count_s${n}`]   = null;
      band[`torreta_s${n}`] = null;
      continue;
    }
    const accion = entero(`bcS${n}Action`, 0);
    band[`s${n}_action`] = accion;
    band[`wait_s${n}_s`]  = entero(`bcS${n}Timer`, 0);
    band[`count_s${n}`]   = entero(`bcS${n}Count`, 0);
    band[`torreta_s${n}`] = leerMascara(`bcS${n}Mask`);
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
const FASE = {
  paro:         { txt: 'Paro I3 activo',     clase: 'is-err',  icono: 'ti-hand-stop' },
  sin_marcha:   { txt: 'Sin marcha · luces con I1', clase: 'is-off', icono: 'ti-bulb' },
  configurando: { txt: 'Configurando VFD…',  clase: 'is-wait', icono: 'ti-loader' },
  lista:        { txt: 'Sistema listo',      clase: 'is-ok',   icono: 'ti-circle-check' },
  habilitada:   { txt: 'Banda habilitada',   clase: 'is-ok',   icono: 'ti-player-play' },
  corriendo:    { txt: 'Banda corriendo',    clase: 'is-run',  icono: 'ti-player-play-filled' },
};

const ESTADO_BANDA = {
  0: 'detenida', 1: 'corriendo dirección 1', 2: 'corriendo dirección 2',
};

function badge(id, texto, clase, icono) {
  const el = $(id);
  if (!el) return;
  el.className = 'bc-badge' + (clase ? ' ' + clase : '');
  el.innerHTML = `<i class="ti ${icono}"></i> ${texto}`;
}

function pintarEstado(est) {
  ultimoEstado = est;

  const fase = FASE[est.fase] || { txt: 'Banda detenida', clase: 'is-off', icono: 'ti-player-stop' };
  badge('bcFase', fase.txt, fase.clase, fase.icono);

  badge('bcBanda', 'Banda: ' + (ESTADO_BANDA[est.band_status] ?? est.estado),
        est.running ? 'is-run' : 'is-off', 'ti-topology-bus');

  badge('bcCfg', 'Config: ' + (est.cfg_ready ? 'lista' : 'no lista'),
        est.cfg_ready ? 'is-ok' : 'is-wait', 'ti-settings-check');

  badge('bcEnable', 'I1: ' + (est.band_enable ? 'habilitada' : 'sin habilitar'),
        est.band_enable ? 'is-ok' : 'is-off', 'ti-player-play');

  const i3 = est.i3_paro;
  badge('bcI3', 'I3: ' + (i3 === true ? 'paro presionado' : i3 === false ? 'suelto' : 'sin lectura'),
        i3 === true ? 'is-err' : i3 === false ? 'is-ok' : 'is-off', 'ti-hand-stop');

  badge('bcSpeed', `${est.vfd_speed_hz ?? '—'} Hz`, '', 'ti-wave-sine');

  // Sensores: conteo, temporizador y "conteo alcanzado" (R25-R27 / R35-R37).
  for (const n of [1, 2]) {
    const cnt = $(`bcS${n}Cnt`), tmr = $(`bcS${n}Tmr`), done = $(`bcS${n}Done`);
    if (cnt) cnt.textContent = `Conteo: ${est[`s${n}_count`] ?? '—'}`;
    if (tmr) tmr.textContent = `Temporizador: ${est[`s${n}_timer_s`] ?? '—'} s`;
    if (done) {
      const ok = !!est[`s${n}_count_done`];
      done.textContent = 'Conteo alcanzado: ' + (ok ? 'sí' : 'no');
      done.className = 'bc-chip' + (ok ? ' is-ok' : '');
    }
  }

  // Plumas: estado REAL (R62/R63), no el último botón pulsado.
  for (const n of [1, 2]) {
    const p = est[`pluma${n}`] || {};
    const chip = $(`bcP${n}`);
    if (chip) chip.textContent = 'Estado: ' + (p.estado || '—');
    document.querySelectorAll(`.bc-seg[data-pluma="${n}"] .bc-seg-btn`).forEach(b => {
      b.classList.toggle('is-on', Number(b.dataset.cmd) === Number(p.status));
    });
  }

  // Paro I3: se LEE de la entrada física (est.i3_paro). En el ST vigente I3
  // no baja CfgReady, así que no se puede deducir de los registros. null =
  // sin lectura fiable de %I (mapa Modbus sin confirmar): no se afirma nada.
  const paro = est.i3_paro === true;

  // Configuración válida cargada pero CfgReady en 0 más de lo que dura la
  // secuencia del VFD (~2 s): la secuencia no avanza (p. ej. con I3 activo).
  const cfgValida = [1, 2].includes(Number(est.dir_cmd))
                    && est.freq_request_hz >= 1 && est.freq_request_hz <= 327;
  if (!est.cfg_ready && cfgValida) {
    if (sinCfgDesde === null) sinCfgDesde = Date.now();
  } else {
    sinCfgDesde = null;
  }
  const atascada = sinCfgDesde !== null && Date.now() - sinCfgDesde > PARO_SOSPECHA_MS;

  if (paro) {
    alerta('Paro físico I3 activo: el PLC mantiene detenidos la banda, el VFD y las '
         + 'plumas. Suelta I3 y pulsa I1 para volver a arrancar.');
  } else if (atascada) {
    alerta('El PLC no confirma la configuración (CfgReady sigue en 0). La secuencia '
         + 'del VFD no avanza mientras el paro I3 está activo; si I3 está suelto, '
         + 'vuelve a enviar la configuración o haz un Reset del VFD.');
  } else if (est.fase === 'sin_marcha') {
    alerta('Programa sin marcha: I1 no arranca la banda. Las lámparas configuradas se '
         + 'encienden solo mientras I1 esté presionado.', 'info');
  } else if (!est.cfg_ready && !cfgValida) {
    alerta('El PLC no tiene una configuración válida cargada (dirección 1 o 2 y '
         + 'frecuencia entre 1 y 327 Hz). Envía la configuración para armar el VFD.',
           'info');
  } else if (est.cfg_ready && !est.band_enable) {
    alerta('Configuración lista. Pulsa el botón físico I1 para habilitar la banda.',
           'info');
  } else {
    alerta('');
  }
  paintBandLive($('bandPanel'), est, { paro });
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
    if (d?.estado) pintarEstado(d.estado);
    return d;
  } catch (e) {
    mensaje(e.message || 'Error', 'err');
    return null;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = antes; }
  }
}

async function enviarConfig() {
  const band = construirBand();
  const errores = revisar(band);
  if (errores.length) { mensaje(errores[0], 'err'); return; }

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

  $('bcSend')?.addEventListener('click', enviarConfig);

  // Torreta en vivo: solo %R40/%R41. El ST las lee en cada scan, así que no
  // hay trigger ni reinicio del VFD y la banda sigue como estaba.
  $('bcTorApply')?.addEventListener('click', () =>
    conBoton($('bcTorApply'), 'Aplicando torreta…', async () => {
      const d = await postear('/banda/torreta', {
        run: leerMascara('bcTorRun'), idle: leerMascara('bcTorIdle'),
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
      d.mensaje = 'Banda detenida. Vuelve a enviar la configuración para operar.';
      return d;
    }));

  // Plumas: comando inmediato. El enclavamiento entre subir y bajar lo hace
  // el PLC; aquí no se decide nada sobre las salidas físicas.
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
  const band = program?.metadata?.engine_config?.band;
  if (!band || !$('bandControl')) return;

  const dir = Number(band.direction) === 2
    || /izq|left|ccw|antihorario/i.test(String(band.direction)) ? 2 : 1;
  marcarDireccion(dir);
  if (band.freq_hz != null && $('bcFreq')) $('bcFreq').value = band.freq_hz;

  const ACCIONES = {
    nada: 0, paro_presencia: 1, paro_mientras_detecta: 1, paro_temporizado: 2,
    paro_presencia_torreta: 3, paro_mientras_detecta_torreta: 3,
    paro_temporizado_torreta: 4,
  };
  for (const n of [1, 2]) {
    const acc = band[`s${n}_action`];
    const codigo = typeof acc === 'number' ? acc : ACCIONES[String(acc).toLowerCase()];
    const usa = codigo != null || band[`wait_s${n}_s`] != null || band[`count_s${n}`] != null;
    const en = $(`bcS${n}En`);
    if (en) en.checked = !!usa;
    if (codigo != null && $(`bcS${n}Action`)) $(`bcS${n}Action`).value = String(codigo);
    if (band[`wait_s${n}_s`] != null && $(`bcS${n}Timer`)) $(`bcS${n}Timer`).value = band[`wait_s${n}_s`];
    if (band[`count_s${n}`] != null && $(`bcS${n}Count`)) $(`bcS${n}Count`).value = band[`count_s${n}`];
    pintarMascara(`bcS${n}Mask`, band[`torreta_s${n}`] || 0);
  }
  pintarMascara('bcTorRun',  band.torreta_run  || 0);
  pintarMascara('bcTorIdle', band.torreta_idle || 0);
}
