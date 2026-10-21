/**
 * gen-bridge.js — Puente ESM para páginas con <script> clásico.
 *
 * index.html (copiloto) y asistente.html (voz) cargan scripts no-módulo y no
 * pueden importar generate.js directamente. Este módulo expone window.LadderGen
 * para que ambos usen el MISMO flujo único (texto → JSON lógico → programa),
 * con el perfil del dispositivo ya cargado.
 */
import {
  generateProgram, confirmarAlternativa, planearInstruccion, explicarLogica,
  claveAclaracion, preguntasPendientes, decidirRespuesta, registrarPreguntas,
} from './generate.js';
import { encode, fitsInURL } from './codec.js';

const PROFILE_URL = 'assets/devices/maletin_basico.json';
const profilePromise = fetch(PROFILE_URL).then(r => (r.ok ? r.json() : null)).catch(() => null);

window.LadderGen = {
  /** @param {string} text @param {{context?:object, signal?:AbortSignal}} [opts] */
  async generate(text, opts = {}) {
    const profile = await profilePromise;
    return generateProgram(text, profile, opts);
  },
  // Edición incremental sobre la lógica activa (ver lavo-sesion.js).
  planearInstruccion,
  explicarLogica,
  confirmarAlternativa,
  // Aclaraciones: la respuesta a una pregunta va aparte del texto.
  claveAclaracion,
  preguntasPendientes,
  decidirRespuesta,
  registrarPreguntas,
  // Codificación URL-safe centralizada en codec.js (antes duplicada en
  // main.js y copilot.js). Para construir ladder.html?l=…
  encodeProgramToURL: encode,
  // false si el programa no cabe en ?l= (414 URI Too Long): se abre con
  // ?handoff=1 y el editor lo toma de localStorage.
  programFitsURL: fitsInURL,
};
