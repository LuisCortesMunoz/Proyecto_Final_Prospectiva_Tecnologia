/**
 * lavo-sesion.js — Lógica activa de la sesión de trabajo (fuente única de verdad).
 *
 * El copiloto (index.html) y el editor (ladder.html) trabajan sobre UNA sola
 * lógica: el último programa válido (con su engine_config) más las
 * instrucciones que lo formaron. Cada instrucción nueva la edita; ninguna
 * pantalla guarda su propia copia.
 *
 *   - Navegar entre páginas la conserva (sessionStorage de la pestaña).
 *   - El editor abierto en otra pestaña desde el copiloto comparte la misma
 *     sesión (se le pasa al abrirlo y se sincroniza con BroadcastChannel).
 *   - Refresh (F5 / recargar) empieza una sesión nueva: la lógica temporal se
 *     borra al cargar. La memoria validada vive en el backend y no se toca.
 *
 * Script clásico (no módulo): expone window.LavoSesion para copilot.js
 * (clásico) y para los módulos del editor. Va justo después de auth.js.
 */
(function (global) {
  'use strict';

  var CLAVE = 'lavo_sesion_logica';
  var CLAVE_HANDOFF = 'lv_handoff_sesion';
  var CLAVE_SOLICITUD = 'lavo_sesion_solicitud';
  var HANDOFF_VIGENCIA_MS = 2 * 60 * 1000;
  var MAX_INSTRUCCIONES = 30;
  var MAX_HISTORIAL_BACKEND = 12;

  // ── ¿Esta carga es un Refresh? ──────────────────────────────
  function tipoNavegacion() {
    try {
      var n = global.performance.getEntriesByType('navigation')[0];
      if (n && n.type) return n.type;
    } catch (e) { /* navegador sin Navigation Timing 2 */ }
    try {
      if (global.performance.navigation && global.performance.navigation.type === 1) return 'reload';
    } catch (e) { /* sin API */ }
    return 'navigate';
  }
  var navegacion = tipoNavegacion();
  var esRecarga = navegacion === 'reload';

  // ── Almacenamiento de la pestaña ────────────────────────────
  // Si sessionStorage no está disponible, la sesión vive solo en memoria.
  var _memoria = null;
  function leer() {
    try {
      var raw = global.sessionStorage.getItem(CLAVE);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return _memoria; }
  }
  function escribir(st) {
    _memoria = st;
    try {
      if (st) global.sessionStorage.setItem(CLAVE, JSON.stringify(st));
      else global.sessionStorage.removeItem(CLAVE);
    } catch (e) { /* cuota llena o sin storage: queda en memoria */ }
  }
  function copia(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function nuevoId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function quitarHandoff() {
    try { global.localStorage.removeItem(CLAVE_HANDOFF); } catch (e) { /* sin storage */ }
  }

  // ── Solicitud en curso (instrucción original + respuestas de aclaración) ──
  // Vive aparte de la lógica: una instrucción que espera respuestas todavía no
  // cambió la lógica activa. Se guarda en la pestaña para que navegar no la
  // pierda; F5 la borra con lo demás.
  var _solMem = null;
  function leerSol() {
    try { var raw = global.sessionStorage.getItem(CLAVE_SOLICITUD); return raw ? JSON.parse(raw) : null; }
    catch (e) { return _solMem; }
  }
  function escribirSol(sol) {
    _solMem = sol;
    try {
      if (sol) global.sessionStorage.setItem(CLAVE_SOLICITUD, JSON.stringify(sol));
      else global.sessionStorage.removeItem(CLAVE_SOLICITUD);
    } catch (e) { /* queda en memoria */ }
  }

  if (esRecarga) { escribir(null); escribirSol(null); }   // F5 = sesión nueva
  var _estado = leer();

  // Editor abierto desde el copiloto en otra pestaña: adopta la sesión que le
  // dejó el copiloto (por si el navegador no copió el sessionStorage). Se
  // consume una sola vez y nunca después de un Refresh.
  (function adoptarHandoff() {
    var raw = null;
    try { raw = global.localStorage.getItem(CLAVE_HANDOFF); } catch (e) { return; }
    if (!raw) return;
    var params = new URLSearchParams(global.location ? global.location.search : '');
    var paraMi = params.get('from') === 'chat' || params.get('handoff') === '1';
    try {
      var h = JSON.parse(raw);
      var vigente = h && h.ts && (Date.now() - h.ts) < HANDOFF_VIGENCIA_MS && h.estado;
      if (paraMi && !esRecarga && vigente &&
          (!_estado || _estado.id !== h.estado.id || (h.estado.rev || 0) >= (_estado.rev || 0))) {
        _estado = h.estado;
        escribir(_estado);
      }
      if (paraMi || !vigente) quitarHandoff();
    } catch (e) { quitarHandoff(); }
  })();

  // ── Suscriptores y sincronización entre pestañas ────────────
  var _subs = [];
  function avisar(origen) {
    var st = copia(_estado);
    _subs.forEach(function (fn) { try { fn(st, origen); } catch (e) { console.error(e); } });
  }

  var canal = null;
  try { canal = new global.BroadcastChannel('lavo_sesion'); } catch (e) { canal = null; }
  if (canal) {
    canal.onmessage = function (ev) {
      var otro = ev && ev.data && ev.data.estado;
      if (!otro || !_estado || otro.id !== _estado.id) return;   // otra sesión: no es la mía
      if ((otro.rev || 0) <= (_estado.rev || 0)) return;
      _estado = otro;
      escribir(_estado);
      avisar('otra_pestana');
    };
  }
  function publicar() {
    if (canal && _estado) { try { canal.postMessage({ estado: _estado }); } catch (e) { /* sin canal */ } }
  }

  // Volver con "Atrás" puede restaurar la página congelada (bfcache): se relee
  // la sesión por si otra página la cambió mientras tanto.
  if (global.addEventListener) {
    global.addEventListener('pageshow', function (ev) {
      if (!ev.persisted) return;
      var st = leer();
      if (JSON.stringify(st) !== JSON.stringify(_estado)) { _estado = st; avisar('restaurada'); }
    });
  }

  // ── Utilidades de la lógica ─────────────────────────────────
  function cfgDe(program) {
    var c = program && program.metadata && program.metadata.engine_config;
    return c && typeof c === 'object' ? c : null;
  }
  function deviceDe(program, pedido) {
    if (pedido === 'banda' || pedido === 'maletin') return pedido;
    var c = cfgDe(program);
    if (!c) return null;
    var d = String(c.device || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (d === 'banda' || d === 'maletin') return d;
    return c.band && typeof c.band === 'object' ? 'banda' : 'maletin';
  }
  function limpiarPrograma(program) {
    var p = copia(program);
    if (p && p.execution_state) delete p.execution_state;   // estado de simulación: no es lógica
    return p;
  }

  /** "texto [freq_hz: 20 Hz; input: I1]" — solo para el modelo y la memoria. */
  function conAclaraciones(texto, acl) {
    var pares = Object.keys(acl || {}).map(function (k) {
      var v = acl[k];
      return k + ': ' + (v && typeof v === 'object' ? v.respuesta : v);
    });
    return pares.length ? texto + ' [' + pares.join('; ') + ']' : texto;
  }

  // ── Intención del mensaje ───────────────────────────────────
  function normTexto(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[¿?¡!.,;:"()]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  var RX_MODIFICA = /\b(agrega\w*|anade\w*|cambia\w*|corrige\w*|quita\w*|elimina\w*|borra\w*|pon|ponle|ponlo|ponla|haz|hazlo|hazla|modifica\w*|ajusta\w*|reemplaza\w*|sustituye\w*|aumenta\w*|reduce\w*|arregla\w*|repara\w*|incluye\w*|crea\w*|genera\w*|programa(?:me|lo|la))\b/;
  var RX_NUEVA = /\b(nueva logica|logica nueva|nuevo programa|programa nuevo|desde cero|(?:empieza|empecemos|empezar|comienza|comencemos|comenzar|inicia|iniciemos) de nuevo|olvida (?:lo anterior|todo|la logica)|borra todo|reinicia (?:la logica|todo)|otra logica|una logica (?:distinta|diferente)|logica (?:totalmente |completamente )?(?:distinta|diferente)|reemplaza(?:la)? (?:toda|por completo|completamente))\b/;
  var RX_MOSTRAR = /^(?:puedes |podrias )?(?:muestra(?:me|lo|la)?|mostrar|ensena(?:me|lo|la)?|ver|quiero ver|dame|pasame|imprime|despliega)\b.*\b(?:json|configuracion|config|(?:logica|programa) (?:actual|activa|activo|vigente|completa|completo)|(?:la logica|el programa)$)/;
  var RX_EXPLICAR = /^(?:puedes |podrias )?(?:explica(?:me|lo|la|mela|melo)?|por que|porque|que hace|como funciona|describe(?:me|lo|la)?|resume(?:me|lo|la)?|que entendiste|en que consiste|dime (?:que|por que|como))\b|\bpor que no (?:funciona|sirve|jala|arranca|se detiene|para|avanza)\b/;

  /** 'nueva' | 'mostrar' | 'explicar' | 'modificar' */
  function clasificar(texto) {
    var t = normTexto(texto);
    if (RX_NUEVA.test(t)) return 'nueva';
    var modifica = RX_MODIFICA.test(t);
    if (!modifica && RX_MOSTRAR.test(t)) return 'mostrar';
    if (!modifica && RX_EXPLICAR.test(t)) return 'explicar';
    return 'modificar';
  }

  // ── API ─────────────────────────────────────────────────────
  var LavoSesion = {
    esRecarga: esRecarga,
    navegacion: navegacion,          // 'navigate' | 'reload' | 'back_forward'

    /** Copia del estado completo, o null si aún no hay lógica activa. */
    activa: function () { return copia(_estado); },
    tieneLogica: function () { return !!(_estado && _estado.program); },
    programa: function () { return _estado ? copia(_estado.program) : null; },
    device: function () { return _estado ? _estado.device : null; },
    rev: function () { return _estado ? _estado.rev : 0; },
    nombre: function () {
      var p = _estado && _estado.program;
      return (p && p.metadata && p.metadata.name) || (cfgDe(p) || {}).name || 'programa';
    },
    /** Instrucciones (texto original del usuario) que formaron la lógica activa. */
    instrucciones: function () {
      return _estado ? _estado.instrucciones.filter(function (i) { return i.texto; })
        .map(function (i) { return i.texto; }) : [];
    },
    /** Las mismas, con sus aclaraciones como datos aparte: "texto [freq_hz: 20 Hz]". */
    instruccionesCompletas: function () {
      return _estado ? _estado.instrucciones.filter(function (i) { return i.texto; })
        .map(function (i) { return conAclaraciones(i.texto, i.aclaraciones); }) : [];
    },

    /**
     * Contexto para /generar-logica: el JSON vigente (lo único que usa el
     * backend del programa) y las instrucciones aplicadas. null sin lógica.
     */
    contexto: function () {
      if (!_estado || !_estado.program) return null;
      var meta = _estado.program.metadata || {};
      return {
        programa_anterior: { metadata: { name: meta.name || '', engine_config: copia(meta.engine_config) || null } },
        historial: this.instruccionesCompletas().slice(-MAX_HISTORIAL_BACKEND),
      };
    },

    /**
     * Fija una nueva versión VÁLIDA de la lógica activa (ya compilada y, si era
     * una alternativa, confirmada). tipo:
     *   'nueva'        → empieza la cadena de instrucciones con esta
     *   'modificacion' → se suma a la cadena
     *   'editor'       → cambio a mano en el editor (sin instrucción)
     *   'archivo'      → programa abierto o creado en el editor (cadena nueva)
     */
    aplicar: function (program, opts) {
      opts = opts || {};
      if (!program || typeof program !== 'object' || !Array.isArray(program.rungs)) {
        throw new Error('LavoSesion.aplicar: programa inválido; se conserva la lógica activa.');
      }
      var tipo = opts.tipo || 'modificacion';
      var reinicia = !_estado || tipo === 'nueva' || tipo === 'archivo';
      // Una lógica nueva sigue siendo la misma sesión de trabajo (mismo id): la
      // otra pestaña del editor también pasa a la nueva lógica.
      var st = reinicia
        ? { id: _estado ? _estado.id : nuevoId(), rev: _estado ? _estado.rev : 0, instrucciones: [] }
        : copia(_estado);
      st.program = limpiarPrograma(program);
      st.device = deviceDe(program, opts.device) || (st.device || null);
      st.rev = (st.rev || 0) + 1;
      st.actualizada = Date.now();
      // Cambiar una respuesta de aclaración rehace la MISMA instrucción: la
      // reemplaza en la cadena en vez de sumarla otra vez.
      if (opts.reemplazaUltima && !reinicia && st.instrucciones.length) st.instrucciones.pop();
      if (opts.instruccion || tipo === 'archivo') {
        var entrada = { texto: opts.instruccion || '', tipo: tipo, ts: Date.now() };
        if (opts.aclaraciones && Object.keys(opts.aclaraciones).length) entrada.aclaraciones = copia(opts.aclaraciones);
        st.instrucciones.push(entrada);
        if (st.instrucciones.length > MAX_INSTRUCCIONES) st.instrucciones.shift();
      }
      _estado = st;
      escribir(_estado);
      publicar();
      avisar(opts.origen || 'local');
      return copia(_estado);
    },

    /** Borra la lógica temporal (no toca la memoria validada del backend). */
    reiniciar: function () {
      _estado = null;
      escribir(null);
      escribirSol(null);
      avisar('reinicio');
    },

    // ── Solicitud en curso ────────────────────────────────────
    // { id, texto, tipo, base, aclaraciones: {clave: {pregunta, respuesta}},
    //   preguntas, estado: 'pendiente' | 'aplicada', revAplicada }
    // `base` es el contexto con el que se pidió (la lógica ANTES de esta
    // instrucción): rehacerla con otra respuesta parte del mismo punto.
    solicitud: function () { return copia(leerSol()); },
    /** Instrucción nueva escrita por el usuario: reemplaza la anterior (no se mezclan respuestas). */
    iniciarSolicitud: function (datos) {
      var sol = { id: 'q' + nuevoId(), texto: datos.texto, tipo: datos.tipo || 'nueva',
                  base: copia(datos.base || null), aclaraciones: {}, preguntas: [], estado: 'pendiente' };
      escribirSol(sol);
      return copia(sol);
    },
    /** Registra (o cambia) la respuesta a un parámetro. null si la solicitud ya no es la actual. */
    responder: function (id, clave, pregunta, respuesta) {
      var sol = leerSol();
      if (!sol || sol.id !== id || !clave) return null;
      sol.aclaraciones[clave] = { pregunta: String(pregunta || ''), respuesta: String(respuesta) };
      escribirSol(sol);
      return copia(sol);
    },
    actualizarSolicitud: function (id, cambios) {
      var sol = leerSol();
      if (!sol || sol.id !== id) return null;
      Object.keys(cambios || {}).forEach(function (k) { sol[k] = copia(cambios[k]); });
      escribirSol(sol);
      return copia(sol);
    },

    /** fn(estado|null, origen) en cada cambio: 'local', 'otra_pestana', 'restaurada', 'reinicio'. */
    suscribir: function (fn) { _subs.push(fn); },

    /** Deja la sesión para el editor que se abre en otra pestaña. */
    prepararHandoff: function () {
      if (!_estado) return;
      try {
        global.localStorage.setItem(CLAVE_HANDOFF, JSON.stringify({ ts: Date.now(), estado: _estado }));
      } catch (e) { /* cuota llena: el editor usará la URL o su sessionStorage copiado */ }
    },

    clasificar: clasificar,
    deviceDe: deviceDe,
    conAclaraciones: conAclaraciones,
  };

  global.LavoSesion = LavoSesion;
})(typeof window !== 'undefined' ? window : globalThis);
