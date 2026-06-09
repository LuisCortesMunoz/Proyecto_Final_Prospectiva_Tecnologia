/**
 * codec.js — Codifica/decodifica programas ladder desde/hacia URL
 * Usa Base64 UTF-8, parámetro ?l= en la URL (como capa8 usa ?g=)
 */

const PARAM = 'l';

/** Serializa el programa a Base64 URL-safe (sin +, / ni =).
 *  El Base64 estandar usa "+" y "/", y al ir en una URL el "+" se interpreta
 *  como espacio al leerlo con URLSearchParams, corrompiendo el dato. Por eso
 *  usamos el alfabeto URL-safe: + -> -, / -> _, y quitamos el padding "=". */
export function encode(program) {
  const json   = JSON.stringify(program);
  const bytes  = new TextEncoder().encode(json);
  let   binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Deserializa Base64 (URL-safe o estandar) → objeto programa, o null si falla */
export function decode(b64) {
  try {
    // Acepta el formato URL-safe nuevo y tambien links viejos donde el "+"
    // pudo haberse convertido en espacio.
    let s = String(b64).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';                 // restaurar padding
    const binary = atob(s);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Genera la URL completa con el programa codificado */
export function exportToURL(program) {
  const base = window.location.origin + window.location.pathname;
  return base + '?' + PARAM + '=' + encode(program);
}

/** Lee el programa desde el parámetro ?l= de la URL actual */
export function importFromURL() {
  const val = new URLSearchParams(window.location.search).get(PARAM);
  return val ? decode(val) : null;
}

/** Actualiza la URL del navegador sin recargar (para autosave silencioso) */
export function pushToURL(program) {
  const url = exportToURL(program);
  try {
    history.replaceState(null, '', url);
  } catch {
    // En file:// no funciona replaceState, ignorar
  }
}
