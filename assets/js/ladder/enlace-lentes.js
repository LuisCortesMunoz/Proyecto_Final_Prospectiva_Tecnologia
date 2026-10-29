/**
 * enlace-lentes.js — "Simular en lentes": la PC espera la configuración que
 * se simuló en los lentes y la carga SOLA en el PLC que eligió el usuario.
 *
 *   PC  POST /enlace/abrir   {device, ip, port}   (Render, con el token)
 *   PC  GET  /enlace/esperar ?canal_id             long-poll ≤ 25 s, en bucle
 *       … llega un envío → onEnvio(envio) carga por el puente local
 *   PC  POST /enlace/resultado {ok, mensaje}       los lentes ven el resultado
 *   PC  POST /enlace/cerrar                        al dejar de esperar
 *
 * La espera no tiene límite: cada vuelta del long-poll dura como mucho 25 s y
 * se repite hasta que el usuario la detiene. Si Render se reinicia (canal
 * desconocido) se vuelve a abrir sola; si se cae la red, reintenta.
 *
 * Sin DOM: app.js pinta el estado con onEstado. Las dependencias (fetch,
 * espera) se inyectan para poder probarlo con node (tests/test_enlace_lentes.mjs).
 */

const ESPERA_S = 25;
// Margen sobre el long-poll: Render puede tardar en contestar al despertar.
const TIMEOUT_ESPERA_MS = 45000;
const TIMEOUT_MS = 20000;

export const nombreEquipo = (d) => (d === 'banda' ? 'la banda' : 'el maletín');

/** Error HTTP con su código, para distinguir "reintentar" de "no tiene arreglo". */
class ErrorHttp extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

/** 4xx que no se arreglan reintentando (401 lo resuelve auth.js pidiendo la contraseña). */
export const esDefinitivo = (e) => !!e?.status && e.status >= 400 && e.status < 500
  && ![401, 408, 429].includes(e.status);

/** Pausa entre reintentos: 2, 4, 6… s, hasta 15 s. */
export const pausaReintento = (fallos) => Math.min(2000 * Math.max(1, fallos), 15000);

/**
 * @param {object} deps
 * @param {string} deps.base      URL del backend en Render
 * @param {Function} deps.onEnvio async (envio, destino) => {ok, mensaje}
 * @param {Function} [deps.onEstado] (estado) => void
 * @param {Function} [deps.fetchFn]
 * @param {Function} [deps.dormir] ms => Promise
 */
export function crearEnlace({ base, onEnvio, onEstado = () => {}, fetchFn, dormir }) {
  const pedirRed = fetchFn || ((...a) => fetch(...a));
  const pausa = dormir || ((ms) => new Promise(r => setTimeout(r, ms)));
  const url = (ruta) => String(base).replace(/\/+$/, '') + ruta;

  let gen = 0;               // cada iniciar/detener invalida el bucle anterior
  let canal = null;
  let destino = null;
  let control = null;        // AbortController de la petición en curso
  let fase = 'detenido';
  let ultimo = null;         // último envío recibido y cómo terminó

  const estado = (extra = {}) => {
    onEstado({ fase, destino, canal, ultimo, ...extra });
  };

  async function pedir(ruta, { metodo = 'GET', cuerpo, timeout = TIMEOUT_MS, keepalive = false } = {}) {
    control = new AbortController();
    const t = setTimeout(() => control.abort(), timeout);
    try {
      const res = await pedirRed(url(ruta), {
        method: metodo,
        headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: control.signal,
        keepalive,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new ErrorHttp(res.status, d?.detail || `HTTP ${res.status}`);
      return d;
    } finally {
      clearTimeout(t);
    }
  }

  async function abrir() {
    const d = await pedir('/enlace/abrir', {
      metodo: 'POST',
      cuerpo: { device: destino.device, ip: destino.ip, port: destino.port, nombre_plc: destino.nombre || null },
    });
    return d.canal;
  }

  async function atender(envio, miGen) {
    fase = 'cargando';
    estado({ envio });
    let r;
    try {
      r = await onEnvio(envio, destino);
    } catch (e) {
      r = { ok: false, mensaje: e?.message || String(e) };
    }
    r = { ok: !!r?.ok, mensaje: String(r?.mensaje || (r?.ok ? 'Cargado.' : 'No se pudo cargar.')) };
    ultimo = { nombre: envio.nombre || 'Programa', ok: r.ok, mensaje: r.mensaje, hora: new Date() };
    try {
      await pedir('/enlace/resultado', {
        metodo: 'POST',
        cuerpo: { canal_id: envio.canal_id || canal?.canal_id, envio_id: envio.envio_id, ok: r.ok, mensaje: r.mensaje },
      });
    } catch { /* los lentes no verán el resultado, pero la carga ya ocurrió */ }
    if (miGen === gen) { fase = 'esperando'; estado(); }
  }

  async function bucle(miGen) {
    let fallos = 0;
    while (miGen === gen) {
      try {
        if (!canal) {
          canal = await abrir();
          if (miGen !== gen) return;
          fase = 'esperando';
          fallos = 0;
          estado();
        }
        const r = await pedir(`/enlace/esperar?canal_id=${encodeURIComponent(canal.canal_id)}&timeout_s=${ESPERA_S}`,
          { timeout: TIMEOUT_ESPERA_MS });
        if (miGen !== gen) return;
        if (fase !== 'esperando') { fase = 'esperando'; estado(); }
        fallos = 0;
        if (r?.status === 'envio') {
          await atender({ ...r.envio, canal_id: canal.canal_id }, miGen);
        } else if (r?.status === 'cerrado') {
          if (r.motivo === 'reemplazado') {
            gen++;
            canal = null;
            fase = 'detenido';
            estado({ aviso: `Otra pantalla empezó a esperar los lentes para ${nombreEquipo(destino.device)}: esta dejó de esperar.` });
            return;
          }
          canal = null;          // Render se reinició o expiró: se reabre en la siguiente vuelta
        }
      } catch (e) {
        if (miGen !== gen) return;
        if (esDefinitivo(e)) {
          gen++;
          canal = null;
          fase = 'detenido';
          estado({ error: e.message });
          return;
        }
        fallos++;
        fase = 'reconectando';
        estado({ error: e?.name === 'AbortError' ? 'El servidor no respondió a tiempo.' : (e?.message || String(e)) });
        await pausa(pausaReintento(fallos));
      }
    }
  }

  return {
    /** Empieza a esperar. destino = {device, ip, port, nombre?} elegido por el usuario. */
    iniciar(nuevo) {
      if (!nuevo || (nuevo.device !== 'banda' && nuevo.device !== 'maletin')) {
        throw new Error('Elige el equipo (maletín o banda) antes de esperar a los lentes.');
      }
      this.detener({ silencioso: true });
      destino = { device: nuevo.device, ip: String(nuevo.ip || '').trim(), port: Number(nuevo.port) || 502, nombre: nuevo.nombre || '' };
      ultimo = null;
      fase = 'conectando';
      estado();
      const miGen = ++gen;
      return bucle(miGen);
    },

    /** Deja de esperar y avisa al backend (los lentes dejan de ver esta PC). */
    detener({ silencioso = false } = {}) {
      const habia = canal;
      gen++;
      canal = null;
      try { control?.abort(); } catch { /* nada en curso */ }
      if (habia) {
        pedirRed(url('/enlace/cerrar'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canal_id: habia.canal_id }),
          keepalive: true,
        }).catch(() => { /* si no llega, el backend la da por perdida a los 75 s */ });
      }
      if (fase !== 'detenido') {
        fase = 'detenido';
        if (!silencioso) estado();
      }
    },

    activo: () => fase !== 'detenido',
    destino: () => destino,
  };
}
