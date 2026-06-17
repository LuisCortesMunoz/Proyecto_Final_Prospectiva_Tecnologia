/**
 * gen-bridge.js — Puente ESM para páginas con <script> clásico.
 *
 * index.html (copiloto) y asistente.html (voz) cargan scripts no-módulo y no
 * pueden importar generate.js directamente. Este módulo expone window.LadderGen
 * para que ambos usen el MISMO flujo único (texto → JSON lógico → programa),
 * con el perfil del dispositivo ya cargado.
 */
import { generateProgram } from './generate.js';
import { encode } from './codec.js';

const PROFILE_URL = 'assets/devices/maletin_basico.json';
const profilePromise = fetch(PROFILE_URL).then(r => (r.ok ? r.json() : null)).catch(() => null);

window.LadderGen = {
  /** @param {string} text @param {{context?:object, signal?:AbortSignal}} [opts] */
  async generate(text, opts = {}) {
    const profile = await profilePromise;
    return generateProgram(text, profile, opts);
  },
  // Codificación URL-safe centralizada en codec.js (antes duplicada en
  // main.js y copilot.js). Para construir ladder.html?l=…
  encodeProgramToURL: encode,
};
