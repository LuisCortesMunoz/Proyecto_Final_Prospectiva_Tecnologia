# 🎙️ LAVO — Logic Automation, Validation & Operation

> **AI-Assisted System for Natural Language PLC Logic Generation, Validation and Deployment**

> **Proyecto Final** — Sistema que genera un agente capaz de, mediante comandos de voz, activar y desactivar diferentes elementos de automatización: encender una luz, mover una banda, controlar un robot UR3, y más.

---

## 📋 Descripción

Este repositorio documenta los pasos para el Proyecto Final, el cual trata de generar un **agente inteligente** que permita, mediante voz, controlar distintos elementos de automatización industrial en tiempo real.

### ¿Qué puede controlar?

| Dispositivo | Descripción |
|---|---|
| 💡 Luces / Actuadores | Encendido y apagado por voz |
| 🏭 Banda Transportadora | Control de velocidad y dirección |
| 🤖 Robot UR3 | Movimientos y rutinas predefinidas |
| ⚙️ PLC Industrial | Señales de E/S digitales |
| 🌀 Motores / Servos | Control de posición |
| 📡 Sensores IoT | Lectura y activación |

---

## 🗂️ Estructura del Repositorio

```
/
├── index.html          # Página principal del proyecto
├── assets/
│   ├── css/
│   │   └── style.css   # Estilos de la página
│   └── js/
│       └── main.js     # Lógica e interacciones
├── docs/               # Documentación técnica (agregar aquí)
├── src/                # Código fuente del agente (agregar aquí)
└── README.md
```

---

## 🚀 Pasos del Proyecto

1. **Definición del Proyecto** — Requerimientos, alcance y recursos
2. **Diseño de la Arquitectura** — Diagrama de sistema y elección de tecnologías
3. **Implementación del Motor de Voz** — ASR + NLP para extraer intenciones
4. **Desarrollo del Agente** — Interpretación y ruteo de comandos
5. **Integración con Dispositivos** — Conexión con UR3, PLC, bandas, etc.
6. **Pruebas y Resultados** — Evaluación de precisión y latencia

---

## 🥽 Simular en lentes

En el editor (`ladder.html`, servido en local como para "Cargar"), el botón
**Simular en lentes** pide el equipo (maletín o banda) y el PLC destino, y deja
la PC esperando sin límite de tiempo. Lo que se simule y envíe desde los
lentes se abre en el editor y **se carga automáticamente** en ese PLC, sin
preguntar. La tarjeta de abajo a la izquierda muestra el estado y el último
resultado, que también ven los lentes.

- Lógica de la espera: `assets/js/ladder/enlace-lentes.js` (long-poll a
  `/enlace/*` del backend en Render; se reabre si Render se reinicia).
- La carga usa el mismo `/aplicar-plc` del puente local que el botón Cargar.
- Pruebas: `node tests/test_enlace_lentes.mjs`.

---

## 🛠️ Tecnologías Utilizadas

- Python 3.x
- ASR (Automatic Speech Recognition)
- LLM / NLP para procesamiento de intenciones
- Protocolos industriales (Modbus, OPC-UA, etc.)
- Robot UR3 (Universal Robots)

---

## 📄 Licencia

Este proyecto es parte de un trabajo académico. Uso educativo.

---

> Página del proyecto: [Ver sitio](https://tu-usuario.github.io/tu-repositorio/)
