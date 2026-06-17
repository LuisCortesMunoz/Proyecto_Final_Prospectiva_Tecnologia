# Contrato — JSON lógico simple (arquitectura única)

> Fuente de verdad del frontend. Reemplaza cualquier arquitectura previa
> (no hay "Motor A/geometría" ni "Motor B/ecuaciones": **una sola**).

## Flujo

```
Texto del usuario
   → IA (/generar-logica)        ← la IA SOLO interpreta intención
   → JSON lógico simple          ← este contrato (fuente de verdad)
   → validateLogicJson           ← validación mínima del frontend
   → compileLogicToSchema        ← compilación a geometría (front, determinista)
   → normalizeAndValidate
   → program → render
        … (más tarde) → backend → registros PLC   (otro repo, fuera de alcance)
```

La IA **no** genera geometría (filas/columnas/ramas/spans/posiciones), **no**
genera tabla de verdad, **no** escribe registros PLC y **no** emite Python/Modbus.
Solo devuelve el JSON lógico simple. El front lo compila a una vista Ladder.

## Forma del JSON lógico

```json
{
  "name": "string",
  "logic_type": "combinational | stateful | timed | mixed",
  "device_profile": "maletin_basico",
  "inputs_used": ["I1", "I3", "I7"],
  "outputs": [
    { "coil": "Q10", "expr": "(I1 + I3) * !I7", "mode": "direct", "comment": "..." }
  ],
  "timers": [
    { "id": "T1", "type": "TON | TOF | OSCILLATOR", "enable": "I1", "preset_ms": 5000, "comment": "..." }
  ],
  "states": [
    { "id": "M1", "type": "latch", "set": "I1", "reset": "I2", "comment": "..." }
  ],
  "global_rules": { "global_stop": "I7", "stop_priority": true },
  "warnings": []
}
```

`outputs` es **obligatorio** (≥1 salida). `timers`, `states`, `global_rules`,
`inputs_used` y `warnings` son opcionales.

## Gramática de `expr`

| Símbolo            | Significado          | En Ladder                     |
|--------------------|----------------------|-------------------------------|
| `*` o `&`          | AND                  | contactos en serie            |
| `+` o `|`          | OR                   | ramas en paralelo (con `span`)|
| `!` (o `~`, `/`)   | NOT                  | contacto normalmente cerrado  |
| `( … )`            | agrupación           | —                             |

Operandos = **nombres lógicos**: `I1..I8` (entradas), `Q10..Q12` (salidas),
`M1…` (estados/memorias), `T1.DN` (bit "done" de un timer), `BLINK_1S`
(oscilador). La IA **no** usa direcciones físicas (`%R10`, `%M1`, `%Q10`) salvo
que el perfil del dispositivo lo exija; el mapeo físico→registros vive en el backend.

Si una salida aparece dentro de su propia `expr`, es **auto-retención** (sello).

### `mode` (tipo de bobina)

`direct` → bobina normal · `latched` → enclavada (sello) · `timer_on_delay` →
salida gobernada por un TON · `blinker` → salida intermitente (oscilador).

## Reglas de validación mínima (frontend, antes de compilar)

`validateLogicJson(logic, profile)` bloquea el render si:

1. `outputs` no existe o está vacío.
2. Una salida no tiene `coil`, o el `coil` no es una salida del perfil.
3. Una salida no tiene `expr`, o sus paréntesis no están balanceados.
4. Una variable de `expr` no existe (ni entrada/salida del perfil, ni estado, ni timer).
5. `expr` usa `T1.DN` pero `T1` no está en `timers`.
6. `expr` usa `M1` pero `M1` no está en `states`.
7. `global_stop`/`enable`/`set`/`reset` no existen en el perfil.

Las comprobaciones de existencia de variables solo se exigen cuando hay `profile`.
Si algo no pasa, se muestra el error al usuario y **no se renderiza lógica falsa**.

## Perfil de dispositivo activo (`maletin_basico`)

Entradas: `I1` (BTN_VERDE), `I2` (BTN_ROJO, NC), `I3` (SELECTOR), `I4`
(SELECTOR_2), `I8` (PARO_EMERG, NC). Analógicas `AI1`, `AI2`.
Salidas: `Q10` (LAMP_VERDE), `Q11` (LAMP_AMARILLA), `Q12` (LAMP_ROJA).
PLC Modbus en `192.168.1.100`.

> Los 7 ejemplos del PDF usan `I7` como paro general (dispositivo genérico de 8
> entradas). En el maletín el paro es `I8`. Por eso los fixtures se compilan a
> nivel de compilador (sin perfil); contra el perfil real usa los nombres del maletín.

## Los 7 casos de prueba

Ver `assets/js/ladder/fixtures/logic-examples.js`.

1. **directo** — "Con I1 prende Q10." → `expr: "I1"`
2. **OR** — "Q10 debe prender con I1 o con I3." → `expr: "I1 + I3"`
3. **AND** — "Q10 prende solo si I1 y el selector I4." → `expr: "I1 * I4"`
4. **NOT / paro general** — "Q10 prende con I1, pero se apaga con el paro." → `expr: "I1 * !I7"` + `global_rules.global_stop`
5. **enclavamiento** — "Con I1 arranca Q10 y se queda; con I2 se apaga." → `states: [{id:"M1", set:"I1", reset:"I2"}]`
6. **TON** — "Cuando presione I1, espera 5 s y prende Q10." → `timers: [{id:"T1", type:"TON", preset_ms:5000}]`, salida `expr: "T1.DN"`
7. **blinker** — "Mientras I1, Q12 parpadea cada segundo." → `timers: [{id:"BLINK_1S", type:"OSCILLATOR", preset_ms:1000}]`, salida `expr: "I1 * BLINK_1S"`

## Dependencia externa (backend, otro repo)

`BackEnd_Render_prospectiva_tecnologia` debe exponer:
- `POST /generar-logica` `{ texto, device_profile, contexto? }` → JSON lógico simple.
- `POST /transcribir` `{ audio }` (multipart) → `{ texto }` (solo STT para la voz).

Mientras tanto, el front funciona en **modo dev** pegando un JSON lógico simple
directamente en el chat. La futura ejecución (`logic_json → backend → registros PLC`)
queda fuera de alcance.
