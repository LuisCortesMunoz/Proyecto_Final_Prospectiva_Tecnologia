/**
 * auth.js — Puerta de acceso de la herramienta (contraseña única).
 *
 * Se carga como script CLÁSICO en el <head> de todas las páginas, antes que
 * cualquier módulo, por dos razones: puede tapar la página antes de que se
 * pinte y deja instalada la envoltura de fetch antes de la primera petición.
 *
 * Cómo funciona
 *   1. Al abrir, consulta /health del backend. Si `password_requerida` es
 *      false (no hay APP_PASSWORD, p. ej. el puente local del PLC) no molesta
 *      a nadie y desbloquea.
 *   2. Si hace falta, tapa la página y pide la contraseña. La contraseña NO
 *      vive en el sitio estático: se manda a /login y el backend responde con
 *      un token firmado.
 *   3. El token se guarda en localStorage y esta envoltura de fetch lo añade
 *      en Authorization a todas las llamadas al backend. Si alguna responde
 *      401 (token caducado o contraseña cambiada), vuelve a pedirla.
 *
 * IMPORTANTE — hasta dónde protege
 *   Tapar la página con JavaScript es solo comodidad: el sitio es estático y
 *   su HTML se puede leer igual desde el repositorio. La protección REAL es la
 *   del backend, que rechaza con 401 cualquier petición sin token. Es decir:
 *   nadie puede generar programas, hablar con la IA ni cargar al PLC sin la
 *   contraseña, aunque se salte esta pantalla.
 */
(function () {
  'use strict';

  // Backend de Render. Fuente de la verdad: assets/js/ladder/config.js
  // (aquí se repite porque este archivo no es un módulo ESM).
  var BACKEND = 'https://backend-render-prospectiva-tecnologia-8y7u.onrender.com';
  var CLAVE   = 'lv_auth_token';

  // ── Token ───────────────────────────────────────────────────
  // Formato del backend: "expiracion.firma". La expiración se puede leer aquí
  // para no mandar un token ya vencido; la firma solo la valida el servidor.
  function leerToken() {
    try {
      var t = localStorage.getItem(CLAVE);
      if (!t) return '';
      var exp = parseInt(String(t).split('.')[0], 10);
      if (!exp || exp * 1000 < Date.now()) { localStorage.removeItem(CLAVE); return ''; }
      return t;
    } catch (e) { return ''; }
  }
  function guardarToken(t) { try { localStorage.setItem(CLAVE, t); } catch (e) {} }
  function borrarToken()   { try { localStorage.removeItem(CLAVE); } catch (e) {} }

  // ── ¿Esta petición va al backend? ───────────────────────────
  // Solo a esas se les añade la cabecera: al CDN de iconos o a las fuentes no.
  //
  // No basta con comparar contra BACKEND: el copiloto deja cambiar su URL de
  // API desde la interfaz y el editor deja cambiar la del puente del PLC. Por
  // eso se acepta cualquier host de Render y cualquier dirección local, que es
  // donde puede estar este backend. El token solo se manda a esos destinos.
  function esBackend(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin === new URL(BACKEND).origin) return true;
      var h = u.hostname;
      return h === 'localhost' || h === '127.0.0.1' || /\.onrender\.com$/.test(h);
    } catch (e) { return false; }
  }

  // ── Envoltura de fetch ──────────────────────────────────────
  var fetchOriginal = window.fetch.bind(window);
  window.fetch = function (entrada, init) {
    var url = (typeof entrada === 'string') ? entrada : (entrada && entrada.url) || '';
    if (!esBackend(url)) return fetchOriginal(entrada, init);

    var token = leerToken();
    var opts = Object.assign({}, init || {});
    if (token) {
      var base = (init && init.headers) ||
                 (typeof entrada === 'object' && entrada && entrada.headers) || {};
      var h = new Headers(base);
      h.set('Authorization', 'Bearer ' + token);
      opts.headers = h;
    }
    return fetchOriginal(entrada, opts).then(function (res) {
      // Token caducado o contraseña cambiada: volver a pedirla.
      if (res.status === 401) {
        borrarToken();
        mostrarPuerta('La sesión caducó. Escribe la contraseña otra vez.');
      }
      return res;
    });
  };

  // ── Tapar la página mientras está bloqueada ─────────────────
  var estilo = document.createElement('style');
  estilo.textContent = [
    'html.lv-bloqueado body > *:not(#lvAuth) { visibility: hidden !important; }',
    '#lvAuth{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;',
    'justify-content:center;padding:24px;background:#12121a;color:#e6e6f0;',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
    '#lvAuth .lv-caja{width:min(380px,100%);border:1px solid #2e2e3f;border-radius:12px;',
    'background:#1a1a26;padding:26px 24px;box-shadow:0 18px 50px rgba(0,0,0,.55);text-align:center;}',
    '#lvAuth img{height:38px;margin-bottom:14px;}',
    '#lvAuth h1{font-size:16px;margin:0 0 6px;font-weight:600;}',
    '#lvAuth p{font-size:12.5px;line-height:1.5;color:#9a9ab0;margin:0 0 18px;}',
    '#lvAuth input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;',
    'border:1px solid #3a3a4a;background:#12121a;color:#e6e6f0;font-size:14px;}',
    '#lvAuth input:focus{outline:none;border-color:#3b82f6;}',
    '#lvAuth button{width:100%;margin-top:12px;padding:10px 12px;border:0;border-radius:8px;',
    'background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}',
    '#lvAuth button:disabled{background:#33334a;color:#8a8aa0;cursor:progress;}',
    '#lvAuth .lv-error{margin-top:12px;font-size:12.5px;color:#f87171;min-height:17px;}',
  ].join('');
  (document.head || document.documentElement).appendChild(estilo);
  document.documentElement.classList.add('lv-bloqueado');

  function desbloquear() {
    document.documentElement.classList.remove('lv-bloqueado');
    var n = document.getElementById('lvAuth');
    if (n) n.remove();
  }

  // ── Pantalla de contraseña ──────────────────────────────────
  function mostrarPuerta(aviso) {
    document.documentElement.classList.add('lv-bloqueado');
    if (document.getElementById('lvAuth')) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { mostrarPuerta(aviso); });
      return;
    }

    var caja = document.createElement('div');
    caja.id = 'lvAuth';

    var interior = document.createElement('div');
    interior.className = 'lv-caja';

    var logo = document.createElement('img');
    logo.src = 'assets/img/logo.png';
    logo.alt = 'LAVO';
    logo.addEventListener('error', function () { logo.style.display = 'none'; });

    var titulo = document.createElement('h1');
    titulo.textContent = 'Acceso restringido';

    var texto = document.createElement('p');
    texto.textContent = 'Escribe la contraseña para usar la herramienta.';

    var input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = 'Contraseña';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Entrar';

    var err = document.createElement('div');
    err.className = 'lv-error';
    if (aviso) err.textContent = aviso;

    interior.append(logo, titulo, texto, input, btn, err);
    caja.appendChild(interior);
    document.body.appendChild(caja);
    input.focus();

    function entrar() {
      var pass = input.value;
      if (!pass) { err.textContent = 'Escribe la contraseña.'; return; }
      btn.disabled = true;
      btn.textContent = 'Comprobando…';
      err.textContent = '';
      // fetchOriginal a propósito: /login es lo único que va sin token.
      fetchOriginal(BACKEND + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass }),
      }).then(function (res) {
        return res.json().catch(function () { return null; })
          .then(function (d) { return { res: res, d: d }; });
      }).then(function (r) {
        if (!r.res.ok) throw new Error((r.d && r.d.detail) || ('HTTP ' + r.res.status));
        if (r.d && r.d.token) guardarToken(r.d.token);
        desbloquear();
      }).catch(function (e) {
        var m = e.message || 'No se pudo comprobar la contraseña.';
        if (/Failed to fetch|NetworkError/i.test(m)) {
          m = 'No se pudo contactar el servidor. El plan gratuito de Render tarda ' +
              '~1 min en despertar; intenta otra vez.';
        }
        err.textContent = m;
        input.select();
      }).then(function () {
        btn.disabled = false;
        btn.textContent = 'Entrar';
      });
    }

    btn.addEventListener('click', entrar);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') entrar(); });
  }

  // ── Arranque ────────────────────────────────────────────────
  // Si ya hay token válido se desbloquea de inmediato; el primer 401 real
  // volverá a pedir la contraseña.
  if (leerToken()) {
    desbloquear();
  } else {
    // ¿Este backend tiene contraseña configurada? Si no, no se molesta al usuario.
    fetchOriginal(BACKEND + '/health', { signal: AbortSignal.timeout(90000) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.password_requerida === false) desbloquear();
        else mostrarPuerta('');
      })
      .catch(function () {
        // Sin respuesta del backend se pide la contraseña igualmente: es la
        // opción prudente, y el propio intento de entrar reintenta la conexión.
        mostrarPuerta('');
      });
  }

  window.LVAuth = {
    token: leerToken,
    salir: function () { borrarToken(); mostrarPuerta('Sesión cerrada.'); },
  };
})();
