/**
 * config.js — Configuración compartida por los motores de generación.
 * Se mantiene aparte para evitar dependencias circulares (engines/index.js
 * importa los motores, y los motores importan esta config).
 */
export const BACKEND_BASE_URL = 'https://backend-render-prospectiva-tecnologia.onrender.com';
