/**
 * schema.js — Modelo de datos para programas ladder PLC
 */

export const ELEMENT_TYPES = {
  contact_no:       { label: 'Contacto NO',  category: 'contact' },
  contact_nc:       { label: 'Contacto NC',  category: 'contact' },
  contact_pos_edge: { label: 'Flanco +',     category: 'contact' },
  contact_neg_edge: { label: 'Flanco −',     category: 'contact' },
  coil:             { label: 'Bobina Q',     category: 'coil'    },
  coil_s:           { label: 'Bobina S',     category: 'coil'    },
  coil_r:           { label: 'Bobina R',     category: 'coil'    },
  block_ton:        { label: 'Timer TON',    category: 'block'   },
  block_tof:        { label: 'Timer TOF',    category: 'block'   },
  block_ctu:        { label: 'Contador CTU', category: 'block'   },
  block_ctd:        { label: 'Contador CTD', category: 'block'   },
  block_cmp:        { label: 'Comparador',   category: 'block'   },
  block_mov:        { label: 'MOV',          category: 'block'   },
  block_add:        { label: 'Aritmético',   category: 'block'   },
};

// Tipos que solo van en la zona derecha (salida del rung)
export const OUTPUT_TYPES = new Set([
  'coil', 'coil_s', 'coil_r',
  'block_ton', 'block_tof', 'block_ctu', 'block_ctd',
]);

export function isOutputType(t) { return OUTPUT_TYPES.has(t); }

export function defaultProgram() {
  return {
    metadata: {
      project_id: 'proj_001',
      name: 'Control Motor',
      version: '1.0.0',
      plc_target: { ip: '192.168.1.10', port: 502, unit_id: 1 },
      scan_time_ms: 100,
    },
    symbol_table: {
      'I0.0': { symbol: 'PARO_EM',   type: 'BOOL',  modbus: { fn: 'read_coil',   address: 0     }, comment: 'Paro de emergencia'  },
      'I0.1': { symbol: 'SENSOR_T',  type: 'BOOL',  modbus: { fn: 'read_coil',   address: 1     }, comment: 'Sensor temperatura'  },
      'I0.2': { symbol: 'INICIO',    type: 'BOOL',  modbus: { fn: 'read_coil',   address: 2     }, comment: 'Botón de inicio'     },
      'Q0.0': { symbol: 'MOTOR_1',   type: 'BOOL',  modbus: { fn: 'write_coil',  address: 16    }, comment: 'Motor principal'     },
      'Q0.1': { symbol: 'VALVULA_A', type: 'BOOL',  modbus: { fn: 'write_coil',  address: 17    }, comment: 'Válvula A'           },
      'Q0.2': { symbol: 'ALARMA',    type: 'BOOL',  modbus: { fn: 'write_coil',  address: 18    }, comment: 'Alarma'              },
      'T0':   { symbol: 'T0',        type: 'TIMER', modbus: { fn: 'internal',    address: null  }, comment: 'Timer arranque'      },
      'M0.0': { symbol: 'FLAG_RUN',  type: 'BOOL',  modbus: { fn: 'internal',    address: null  }, comment: 'Marca interna'       },
      'MW10': { symbol: 'TEMP_ACT',  type: 'INT',   modbus: { fn: 'holding_reg', address: 40010 }, comment: 'Temperatura actual'  },
    },
    rungs: [
      {
        id: 1, enabled: true,
        comment: 'Control motor — paro de emergencia',
        network: [{ row: 0, elements: [
          { id: 'r1e1', type: 'contact_no', address: 'I0.0', pos: { col: 0 } },
          { id: 'r1e2', type: 'contact_nc', address: 'I0.1', pos: { col: 1 } },
          { id: 'r1e3', type: 'coil',       address: 'Q0.0', pos: { col: 2 }, coil_type: 'output' },
        ]}],
      },
      {
        id: 2, enabled: true,
        comment: 'Paralelo — I0.2 en paralelo con I0.1',
        network: [
          { row: 0, elements: [
            { id: 'r2e1', type: 'contact_no', address: 'I0.0', pos: { col: 0 } },
            { id: 'r2e2', type: 'contact_no', address: 'I0.1', pos: { col: 1 } },
            { id: 'r2e3', type: 'coil',       address: 'Q0.1', pos: { col: 2 }, coil_type: 'output' },
          ]},
          { row: 1, span: { from: 1, to: 1 }, elements: [
            { id: 'r2e4', type: 'contact_nc', address: 'I0.2', pos: { col: 1 } },
          ]},
        ],
      },
      {
        id: 3, enabled: true,
        comment: 'Timer on-delay',
        network: [{ row: 0, elements: [
          { id: 'r3e1', type: 'contact_no', address: 'I0.2', pos: { col: 0 } },
          { id: 'r3e2', type: 'block_ton',  address: 'T0',   pos: { col: 1 }, params: { preset_ms: 5000 } },
        ]}],
      },
    ],
    execution_state: {
      mode: 'run',
      rung_states: { '1': true, '2': false, '3': false },
      forced_outputs: {},
    },
  };
}

export function newRung(existingRungs) {
  const maxId = existingRungs.reduce((m, r) => Math.max(m, r.id), 0);
  return {
    id: maxId + 1,
    enabled: true,
    comment: '',
    network: [{ row: 0, elements: [] }],
  };
}

export function newElement(type, col) {
  const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const el = { id, type, address: '', pos: { col } };
  if (type === 'coil')   el.coil_type = 'output';
  if (type === 'coil_s') el.coil_type = 'set';
  if (type === 'coil_r') el.coil_type = 'reset';
  if (type === 'block_ton' || type === 'block_tof') el.params = { preset_ms: 1000 };
  if (type === 'block_ctu' || type === 'block_ctd') el.params = { preset: 10 };
  if (type === 'block_cmp') el.params = { op: 'EQ', value: 0 };
  return el;
}

export function validateProgram(prog) {
  const errors = [];
  const st = prog.symbol_table || {};
  for (const rung of prog.rungs) {
    const allEls = (rung.network ?? []).flatMap(row => row.elements ?? []);
    const seen = new Set();
    for (const el of allEls) {
      if (seen.has(el.id)) errors.push(`Rung ${rung.id}: ID duplicado "${el.id}"`);
      seen.add(el.id);
      if (el.address && !st[el.address]) {
        errors.push(`Rung ${rung.id}: dirección "${el.address}" no está en symbol_table`);
      }
    }
    const mainEls = rung.network?.[0]?.elements ?? [];
    const coils = mainEls.filter(e => e.type.startsWith('coil'));
    for (const coil of coils) {
      const entry = st[coil.address];
      if (entry && entry.modbus.fn === 'read_coil') {
        errors.push(`Rung ${rung.id}: "${coil.address}" es read-only, no puede ser bobina`);
      }
    }
  }
  return errors;
}
