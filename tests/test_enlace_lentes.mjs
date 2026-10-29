// Pruebas de "Simular en lentes" (sin navegador ni backend).
//   node tests/test_enlace_lentes.mjs
// El bucle de espera de la PC contra un backend simulado: abre el canal,
// repite el long-poll sin límite, carga lo que llega e informa el resultado,
// se reabre si Render se reinicia, reintenta sin red y se detiene cuando
// otra pantalla toma la espera o el error no tiene arreglo.
import assert from 'node:assert/strict';
import { crearEnlace, esDefinitivo, pausaReintento, nombreEquipo } from '../assets/js/ladder/enlace-lentes.js';

let ok = 0;
const check = (cond, msg) => { assert.ok(cond, msg); ok++; };
const resp = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const CANAL = { canal_id: 'c1', device: 'banda', plc: { ip: '192.168.3.12', port: 502 } };
const ENVIO = { envio_id: 'e1', device: 'banda', logic: { name: 'Llenado', band: {} }, nombre: 'Llenado', frases: ['Haz un llenado'] };

/**
 * Backend falso: cada petición toma la siguiente respuesta del guion. Con el
 * guion vacío la PC deja de esperar (fin de la prueba). /enlace/cerrar no
 * consume guion.
 */
function escenario(guion, { onEnvio } = {}) {
  const llamadas = [];
  const estados = [];
  const pausas = [];
  const envios = [];
  let enlace;
  const fetchFn = async (url, init = {}) => {
    const ruta = url.replace('https://render.test', '');
    const cuerpo = init.body ? JSON.parse(init.body) : null;
    llamadas.push({ ruta, metodo: init.method || 'GET', cuerpo, keepalive: !!init.keepalive });
    if (ruta === '/enlace/cerrar') return resp({ status: 'cerrado' });
    const paso = guion.shift();
    if (!paso) { enlace.detener(); return resp({ status: 'sin_envio' }); }
    if (paso.ruta) assert.ok(ruta.startsWith(paso.ruta), `se esperaba ${paso.ruta} y llegó ${ruta}`);
    if (paso.error) throw paso.error;
    return resp(paso.body, paso.status);
  };
  enlace = crearEnlace({
    base: 'https://render.test/',
    fetchFn,
    dormir: async (ms) => { pausas.push(ms); },
    onEstado: (st) => estados.push({ ...st }),
    onEnvio: onEnvio || (async (envio, destino) => { envios.push({ envio, destino }); return { ok: true, mensaje: 'Cargado en 192.168.3.12:502.' }; }),
  });
  return { enlace, llamadas, estados, pausas, envios };
}

const DESTINO = { device: 'banda', ip: '192.168.3.12', port: 502 };

// 1. Espera sin límite, recibe, carga e informa ------------------------------
{
  const e = escenario([
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: CANAL } },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio' } },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio' } },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio' } },
    { ruta: '/enlace/esperar', body: { status: 'envio', envio: ENVIO } },
    { ruta: '/enlace/resultado', body: { status: 'ok' } },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio' } },
  ]);
  await e.enlace.iniciar(DESTINO);
  const abrir = e.llamadas[0];
  check(abrir.metodo === 'POST' && abrir.cuerpo.device === 'banda' && abrir.cuerpo.ip === '192.168.3.12'
        && abrir.cuerpo.port === 502, 'abre el canal con el PLC elegido');
  const esperas = e.llamadas.filter(l => l.ruta.startsWith('/enlace/esperar'));
  check(esperas.length === 6, 'el long-poll se repite sin límite hasta que se detiene');
  check(esperas.every(l => l.ruta.includes('canal_id=c1') && l.ruta.includes('timeout_s=25')), 'cada vuelta dura ≤ 25 s');
  check(e.envios.length === 1 && e.envios[0].envio.envio_id === 'e1', 'lo que llega se carga una vez');
  check(e.envios[0].destino.ip === '192.168.3.12' && e.envios[0].destino.device === 'banda', 'en el PLC que eligió el usuario');
  const res = e.llamadas.find(l => l.ruta === '/enlace/resultado');
  check(res.cuerpo.ok === true && res.cuerpo.envio_id === 'e1' && res.cuerpo.canal_id === 'c1', 'informa el resultado a los lentes');
  check(e.estados.some(s => s.fase === 'cargando' && s.envio?.nombre === 'Llenado'), 'muestra "cargando"');
  const fin = e.estados.filter(s => s.fase === 'esperando').pop();
  check(fin.ultimo?.ok && fin.ultimo.nombre === 'Llenado', 'tras cargar vuelve a esperar con el último resultado');
  check(e.estados.at(-1).fase === 'detenido', 'detenido al final');
  const cerrar = e.llamadas.filter(l => l.ruta === '/enlace/cerrar');
  check(cerrar.length === 1 && cerrar[0].cuerpo.canal_id === 'c1' && cerrar[0].keepalive, 'al detener avisa al backend');
  check(!e.enlace.activo(), 'ya no está activo');
}

// 2. Render se reinició: el canal se reabre solo -----------------------------
{
  const e = escenario([
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: CANAL } },
    { ruta: '/enlace/esperar', body: { status: 'cerrado', motivo: 'no_existe' } },
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: { ...CANAL, canal_id: 'c2' } } },
    { ruta: '/enlace/esperar', body: { status: 'envio', envio: ENVIO } },
    { ruta: '/enlace/resultado', body: { status: 'ok' } },
  ]);
  await e.enlace.iniciar(DESTINO);
  check(e.llamadas.filter(l => l.ruta === '/enlace/abrir').length === 2, 'reabre el canal tras un reinicio');
  check(e.llamadas.find(l => l.ruta === '/enlace/resultado').cuerpo.canal_id === 'c2', 'y sigue con el canal nuevo');
  check(e.envios.length === 1, 'y carga lo que llega');
}

// 3. Otra pantalla tomó la espera: se detiene ------------------------------
{
  const e = escenario([
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: CANAL } },
    { ruta: '/enlace/esperar', body: { status: 'cerrado', motivo: 'reemplazado' } },
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: CANAL } },     // no debe usarse
  ]);
  await e.enlace.iniciar(DESTINO);
  const ult = e.estados.at(-1);
  check(ult.fase === 'detenido' && /Otra pantalla/.test(ult.aviso), 'avisa que otra pantalla tomó la espera');
  check(e.llamadas.filter(l => l.ruta === '/enlace/abrir').length === 1, 'no pelea por el canal');
}

// 4. Sin red: reintenta con pausa creciente y se recupera --------------------
{
  const e = escenario([
    { ruta: '/enlace/abrir', error: new TypeError('Failed to fetch') },
    { ruta: '/enlace/abrir', error: new TypeError('Failed to fetch') },
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: CANAL } },
    { ruta: '/enlace/esperar', error: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio' } },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio', status_http: 502 }, status: 502 },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio' } },
  ]);
  await e.enlace.iniciar(DESTINO);
  check(e.estados.some(s => s.fase === 'reconectando' && /Failed to fetch/.test(s.error)), 'muestra "reconectando"');
  check(e.estados.some(s => s.fase === 'reconectando' && /no respondió a tiempo/.test(s.error)), 'timeout explicado');
  check(e.pausas[0] === 2000 && e.pausas[1] === 4000, 'pausa creciente entre reintentos');
  check(e.pausas[2] === 2000, 'el contador de fallos se reinicia al recuperarse');
  check(e.pausas.length === 4, 'un 502 de Render también se reintenta');
  check(e.estados.filter(s => s.fase === 'esperando').length >= 2, 'vuelve a "esperando" tras recuperarse');
}

// 5. Error sin arreglo (IP inválida): se detiene con el mensaje --------------
{
  const e = escenario([
    { ruta: '/enlace/abrir', body: { detail: "IP del PLC no valida: '999.1.1.1'." }, status: 400 },
  ]);
  await e.enlace.iniciar({ ...DESTINO, ip: '999.1.1.1' });
  const ult = e.estados.at(-1);
  check(ult.fase === 'detenido' && /IP del PLC no valida/.test(ult.error), '400 detiene con el mensaje del backend');
  check(e.pausas.length === 0, 'sin reintentos inútiles');
  check(e.llamadas.filter(l => l.ruta === '/enlace/cerrar').length === 0, 'sin canal no hay nada que cerrar');
}

// 6. La carga falla: los lentes reciben el error ----------------------------
{
  const e = escenario([
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: CANAL } },
    { ruta: '/enlace/esperar', body: { status: 'envio', envio: ENVIO } },
    { ruta: '/enlace/resultado', body: { status: 'ok' } },
  ], { onEnvio: async () => { throw new Error('No se pudo conectar al PLC de la banda'); } });
  await e.enlace.iniciar(DESTINO);
  const res = e.llamadas.find(l => l.ruta === '/enlace/resultado');
  check(res.cuerpo.ok === false && /No se pudo conectar/.test(res.cuerpo.mensaje), 'una excepción llega como error a los lentes');
  check(e.estados.some(s => s.ultimo && !s.ultimo.ok), 'y se ve en la tarjeta');
}

// 7. El resultado no llega al backend: la espera sigue -----------------------
{
  const e = escenario([
    { ruta: '/enlace/abrir', body: { status: 'ok', canal: CANAL } },
    { ruta: '/enlace/esperar', body: { status: 'envio', envio: ENVIO } },
    { ruta: '/enlace/resultado', error: new TypeError('Failed to fetch') },
    { ruta: '/enlace/esperar', body: { status: 'sin_envio' } },
  ]);
  await e.enlace.iniciar(DESTINO);
  check(e.llamadas.filter(l => l.ruta.startsWith('/enlace/esperar')).length === 3, 'sigue esperando aunque falle el aviso');
}

// 8. Cambiar de PLC reemplaza la espera anterior ----------------------------
{
  // La primera espera queda colgada en el long-poll hasta que se reinicia.
  let soltar;
  const llamadas = [];
  let n = 0;
  const enl = crearEnlace({
    base: 'https://render.test',
    dormir: async () => {},
    onEnvio: async () => ({ ok: true }),
    fetchFn: async (url, init = {}) => {
      const ruta = url.replace('https://render.test', '');
      llamadas.push({ ruta, cuerpo: init.body ? JSON.parse(init.body) : null });
      if (ruta === '/enlace/cerrar') return resp({ status: 'cerrado' });
      if (ruta === '/enlace/abrir') return resp({ status: 'ok', canal: { canal_id: 'k' + (++n) } });
      if (n === 1) {
        return new Promise((_, rej) => {
          init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          soltar = true;
        });
      }
      enl.detener();
      return resp({ status: 'sin_envio' });
    },
  });
  const primera = enl.iniciar(DESTINO);
  await new Promise(r => setTimeout(r, 10));
  check(soltar, 'la primera espera está en el long-poll');
  const segunda = enl.iniciar({ device: 'maletin', ip: '192.168.3.30', port: 502 });
  await Promise.all([primera, segunda]);
  const cerrar = llamadas.filter(l => l.ruta === '/enlace/cerrar');
  check(cerrar[0].cuerpo.canal_id === 'k1', 'cierra el canal anterior');
  const abrir = llamadas.filter(l => l.ruta === '/enlace/abrir');
  check(abrir.length === 2 && abrir[1].cuerpo.device === 'maletin' && abrir[1].cuerpo.ip === '192.168.3.30',
        'y abre otro con el PLC nuevo');
  check(enl.destino().device === 'maletin', 'destino actualizado');
}

// 9. Utilidades -------------------------------------------------------------
check(esDefinitivo({ status: 400 }) && esDefinitivo({ status: 422 }), '4xx sin arreglo');
check(!esDefinitivo({ status: 401 }) && !esDefinitivo({ status: 429 }) && !esDefinitivo({ status: 502 })
      && !esDefinitivo(new TypeError('Failed to fetch')), '401/429/5xx/red se reintentan');
check(pausaReintento(1) === 2000 && pausaReintento(3) === 6000 && pausaReintento(50) === 15000, 'pausa acotada');
check(nombreEquipo('banda') === 'la banda' && nombreEquipo('maletin') === 'el maletín', 'nombres');
assert.throws(() => crearEnlace({ base: 'x', onEnvio: async () => ({}) }).iniciar({ device: 'tostadora' }),
              /Elige el equipo/);
ok++;

console.log(`\nTODAS LAS PRUEBAS DE SIMULAR EN LENTES PASARON (${ok} comprobaciones).`);
