"""
============================================================================
 INTERFAZ DE CONFIGURACION DEL MOTOR LOGICO  (Horner XL4 - Modbus TCP)
 VERSION CON TIMERS, PULSO TEMPORIZADO, CONTADORES RETENTIVOS,
 RESET FISICO CONFIGURABLE Y CONTADOR MANTENIDO
============================================================================

Python NO reprograma el PLC.
Solo escribe registros %R.

MAPEO %Rn -> Modbus holding 0-based = n + 2999

SALIDAS:
  Q10 = verde
  Q11 = amarilla
  Q12 = roja

ENTRADAS:
  I1 = codigo 1
  I2 = codigo 2
  I3 = codigo 3
  I4 = codigo 4
  I7 = codigo 5

TIPO FISICO:
  I1, I3, I4 = NA
  I2, I7     = NC
============================================================================
"""

from pymodbus.client import ModbusTcpClient


PLC_IP = "192.168.3.12"
PLC_PORT = 502
UNIT_ID = 1


def R(n: int) -> int:
    return n + 2999


# ---------------------------------------------------------------------------
# REGISTROS GENERALES
# ---------------------------------------------------------------------------
ADDR_CMD = R(1)
ADDR_GENSTOP = R(2)
ADDR_INDEX = R(3)
ADDR_STATUS = R(4)


# ---------------------------------------------------------------------------
# BLOQUES POR SALIDA
# Q10 usa %R10..%R19
# Q11 usa %R20..%R29
# Q12 usa %R30..%R39
# ---------------------------------------------------------------------------
OUT_BASE = {
    "Q10": 10,
    "Q11": 20,
    "Q12": 30,
    "VERDE": 10,
    "AMARILLA": 20,
    "ROJA": 30,
}


# ---------------------------------------------------------------------------
# CODIGOS DE ENTRADA
# ---------------------------------------------------------------------------
SRC = {
    "NINGUNA": 0,
    "I1": 1,
    "I2": 2,
    "I3": 3,
    "I4": 4,
    "I7": 5,
}


INPUT_NC = {
    "I1": False,
    "I2": True,
    "I3": False,
    "I4": False,
    "I7": True,
}


# ---------------------------------------------------------------------------
# MODOS
# ---------------------------------------------------------------------------
MODE_OFF = 0
MODE_DIRECTO = 1
MODE_ENCLAVADO = 2

TIMER_OFF = 0
TIMER_RET_ON_DELAY = 1
TIMER_PULSO_TEMPORIZADO = 2

COUNTER_OFF = 0
COUNTER_UP_BASE = 1
COUNTER_UP_MANTENIDO = 2


# ---------------------------------------------------------------------------
# ACUMULADOS
# ---------------------------------------------------------------------------
ADDR_TACC = {
    "Q10": R(40),
    "Q11": R(41),
    "Q12": R(42),
    "VERDE": R(40),
    "AMARILLA": R(41),
    "ROJA": R(42),
}

ADDR_CACC = {
    "Q10": R(43),
    "Q11": R(44),
    "Q12": R(45),
    "VERDE": R(43),
    "AMARILLA": R(44),
    "ROJA": R(45),
}


# ---------------------------------------------------------------------------
# RESET POR SOFTWARE
# ---------------------------------------------------------------------------
ADDR_RESET_TIMER = {
    "Q10": R(46),
    "Q11": R(47),
    "Q12": R(48),
    "VERDE": R(46),
    "AMARILLA": R(47),
    "ROJA": R(48),
}

ADDR_RESET_COUNTER = {
    "Q10": R(49),
    "Q11": R(50),
    "Q12": R(51),
    "VERDE": R(49),
    "AMARILLA": R(50),
    "ROJA": R(51),
}


# ---------------------------------------------------------------------------
# RESET FISICO CONFIGURABLE PARA CONTADOR
# ---------------------------------------------------------------------------
ADDR_COUNTER_RESET_SRC = {
    "Q10": R(52),
    "Q11": R(53),
    "Q12": R(54),
    "VERDE": R(52),
    "AMARILLA": R(53),
    "ROJA": R(54),
}


class XL4:
    def __init__(self, ip=PLC_IP, port=PLC_PORT, unit=UNIT_ID):
        self.ip = ip
        self.port = port
        self.unit = unit
        self.client = ModbusTcpClient(ip, port=port)

    # -----------------------------------------------------------------------
    # CONEXION
    # -----------------------------------------------------------------------
    def connect(self):
        if not self.client.connect():
            raise ConnectionError(f"No conecta a {self.ip}:{self.port}")
        print("Conectado al XL4.")

    def close(self):
        self.client.close()

    # -----------------------------------------------------------------------
    # MODBUS
    # -----------------------------------------------------------------------
    def _w(self, addr, value):
        value = int(value) & 0xFFFF

        try:
            rr = self.client.write_register(addr, value, device_id=self.unit)
        except TypeError:
            rr = self.client.write_register(addr, value, slave=self.unit)

        if rr is not None and hasattr(rr, "isError") and rr.isError():
            raise RuntimeError(f"Error escribiendo registro Modbus {addr}: {rr}")

    def _r(self, addr):
        try:
            rr = self.client.read_holding_registers(addr, count=1, device_id=self.unit)
        except TypeError:
            rr = self.client.read_holding_registers(addr, count=1, slave=self.unit)

        if rr is None:
            raise RuntimeError(f"Sin respuesta leyendo registro Modbus {addr}")

        if hasattr(rr, "isError") and rr.isError():
            raise RuntimeError(f"Error leyendo registro Modbus {addr}: {rr}")

        return rr.registers[0]

    # -----------------------------------------------------------------------
    # VALIDACIONES
    # -----------------------------------------------------------------------
    def _src(self, nombre):
        if nombre is None:
            return 0

        n = str(nombre).upper()

        if n not in SRC:
            raise ValueError(f"Entrada no valida: {nombre}. Usa: {list(SRC.keys())}")

        return SRC[n]

    def _out(self, salida):
        s = str(salida).upper()

        if s not in OUT_BASE:
            raise ValueError(f"Salida no valida: {salida}. Usa: {list(OUT_BASE.keys())}")

        return s

    def _es_nc(self, nombre):
        if nombre is None:
            return False
        return INPUT_NC.get(str(nombre).upper(), False)

    # -----------------------------------------------------------------------
    # ESCRITURA DE CONFIGURACION BASE
    # -----------------------------------------------------------------------
    def _escribir_salida(self, salida, mode, srcA, srcB, stop, enable, flags=0):
        s = self._out(salida)
        base = OUT_BASE[s]

        self._w(R(base + 0), mode)
        self._w(R(base + 1), srcA)
        self._w(R(base + 2), srcB)
        self._w(R(base + 3), stop)
        self._w(R(base + 4), enable)
        self._w(R(base + 5), flags)

    # -----------------------------------------------------------------------
    # COMANDOS GENERALES
    # -----------------------------------------------------------------------
    def habilitar(self, on=True):
        self._w(ADDR_CMD, 1 if on else 0)
        print(f"Sistema {'HABILITADO' if on else 'DESHABILITADO'}")

    def paro_general(self, entrada):
        self._w(ADDR_GENSTOP, self._src(entrada))
        print(f"Paro general -> {entrada}")

    def quitar_paro_general(self):
        self._w(ADDR_GENSTOP, 0)
        print("Paro general desactivado")

    def apagar(self, salida):
        self._escribir_salida(salida, MODE_OFF, 0, 0, 0, 0, 0)
        print(f"{salida}: desactivada")

    # -----------------------------------------------------------------------
    # LOGICAS BASE
    # -----------------------------------------------------------------------
    def directo(self, salida, entrada, habilitacion=None):
        self._escribir_salida(
            salida=salida,
            mode=MODE_DIRECTO,
            srcA=self._src(entrada),
            srcB=0,
            stop=0,
            enable=self._src(habilitacion),
            flags=0,
        )

        print(
            f"{salida}: DIRECTO con {entrada}"
            + (f", habilita {habilitacion}" if habilitacion else "")
        )

    def enclavar(self, salida, arranque, paro=None, habilitacion=None):
        self._escribir_salida(
            salida=salida,
            mode=MODE_ENCLAVADO,
            srcA=self._src(arranque),
            srcB=0,
            stop=self._src(paro),
            enable=self._src(habilitacion),
            flags=0,
        )

        print(
            f"{salida}: ENCLAVADO arranque={arranque}"
            + (f" paro={paro}" if paro else "")
            + (f" habilita={habilitacion}" if habilitacion else "")
        )

    def combinacional(self, salida, a, b, op="OR", enclavado=False, paro=None):
        mode = MODE_ENCLAVADO if enclavado else MODE_DIRECTO
        op = op.upper()

        if op == "OR":
            srcA = self._src(a)
            srcB = self._src(b)
            srcEn = 0

        elif op == "AND":
            srcA = self._src(a)
            srcB = 0
            srcEn = self._src(b)

        else:
            raise ValueError("op debe ser 'AND' u 'OR'.")

        self._escribir_salida(
            salida=salida,
            mode=mode,
            srcA=srcA,
            srcB=srcB,
            stop=self._src(paro),
            enable=srcEn,
            flags=0,
        )

        print(
            f"{salida}: {op}({a},{b})"
            + (" enclavado" if enclavado else "")
            + (f" paro={paro}" if paro else "")
        )

    # -----------------------------------------------------------------------
    # TIMER
    # -----------------------------------------------------------------------
    def configurar_timer(self, salida, segundos):
        s = self._out(salida)
        base = OUT_BASE[s]
        segundos = int(segundos)

        if segundos < 0 or segundos > 32767:
            raise ValueError("El preset del timer debe estar entre 0 y 32767 segundos.")

        self._w(R(base + 6), TIMER_RET_ON_DELAY)
        self._w(R(base + 7), segundos)

        print(f"{salida}: TIMER retentivo configurado a {segundos} s")

    def configurar_pulso_salida(self, salida, segundos):
        """
        Aplica TimerMode = 2 a una salida que ya tenga logica base configurada.
        """
        s = self._out(salida)
        base = OUT_BASE[s]
        segundos = int(segundos)

        if segundos < 1 or segundos > 32767:
            raise ValueError("El tiempo debe estar entre 1 y 32767 segundos.")

        self._w(R(base + 6), TIMER_PULSO_TEMPORIZADO)
        self._w(R(base + 7), segundos)

        print(f"{salida}: pulso temporizado configurado a {segundos} s")

    def pulso_temporizado(self, salida, entrada, segundos):
        """
        Configura una salida directa con una entrada y pulso temporizado.
        """
        self.directo(salida, entrada)
        self.configurar_pulso_salida(salida, segundos)

        print(f"{salida}: prende con {entrada} durante {segundos} segundos y luego se apaga")

    def quitar_timer(self, salida):
        s = self._out(salida)
        base = OUT_BASE[s]

        self._w(R(base + 6), TIMER_OFF)
        self._w(R(base + 7), 0)

        print(f"{salida}: TIMER desactivado")

    def reset_timer(self, salida):
        s = self._out(salida)
        self._w(ADDR_RESET_TIMER[s], 1)

        print(f"{salida}: reset de TIMER enviado")

    # -----------------------------------------------------------------------
    # CONTADOR
    # -----------------------------------------------------------------------
    def configurar_contador(self, salida, conteos):
        """
        CounterMode = 1.
        La salida solo prende si la entrada base está activa y el contador llegó al preset.
        """
        s = self._out(salida)
        base = OUT_BASE[s]
        conteos = int(conteos)

        if conteos < 0 or conteos > 32767:
            raise ValueError("El preset del contador debe estar entre 0 y 32767.")

        self._w(R(base + 8), COUNTER_UP_BASE)
        self._w(R(base + 9), conteos)

        print(f"{salida}: CONTADOR retentivo configurado a {conteos} conteos")

    def configurar_contador_mantenido(self, salida, conteos):
        """
        CounterMode = 2.

        La salida se mantiene encendida cuando CounterAcc >= CounterPreset,
        aunque la entrada de conteo ya no esté presionada.

        Se apaga únicamente al resetear el contador.
        """
        s = self._out(salida)
        base = OUT_BASE[s]
        conteos = int(conteos)

        if conteos < 1 or conteos > 32767:
            raise ValueError("El preset del contador debe estar entre 1 y 32767.")

        self._w(R(base + 8), COUNTER_UP_MANTENIDO)
        self._w(R(base + 9), conteos)

        print(f"{salida}: CONTADOR mantenido configurado a {conteos} conteos")

    def quitar_contador(self, salida):
        s = self._out(salida)
        base = OUT_BASE[s]

        self._w(R(base + 8), COUNTER_OFF)
        self._w(R(base + 9), 0)

        print(f"{salida}: CONTADOR desactivado")

    def reset_contador(self, salida):
        s = self._out(salida)
        self._w(ADDR_RESET_COUNTER[s], 1)

        print(f"{salida}: reset de CONTADOR enviado")

    def configurar_reset_contador(self, salida, entrada):
        """
        Define qué entrada física resetea el contador de una salida.

        entrada:
          None o "NINGUNA" = sin reset físico
          "I1", "I2", "I3", "I4", "I7"
        """
        s = self._out(salida)
        self._w(ADDR_COUNTER_RESET_SRC[s], self._src(entrada))

        if entrada is None or str(entrada).upper() == "NINGUNA":
            print(f"{salida}: reset físico de contador desactivado")
        else:
            print(f"{salida}: contador se resetea con {entrada}")

    def quitar_reset_contador(self, salida):
        s = self._out(salida)
        self._w(ADDR_COUNTER_RESET_SRC[s], 0)

        print(f"{salida}: reset físico de contador desactivado")

    # -----------------------------------------------------------------------
    # RESET GENERAL
    # -----------------------------------------------------------------------
    def reset_todo(self, borrar_acumulados=True):
        self._w(ADDR_CMD, 0)

        for s in ("Q10", "Q11", "Q12"):
            self.apagar(s)
            self.quitar_timer(s)
            self.quitar_contador(s)
            self.quitar_reset_contador(s)

            if borrar_acumulados:
                self.reset_timer(s)
                self.reset_contador(s)

        self._w(ADDR_GENSTOP, 0)

        print("Configuracion reiniciada.")

    # -----------------------------------------------------------------------
    # LECTURAS
    # -----------------------------------------------------------------------
    def leer_estado(self):
        idx = self._r(ADDR_INDEX)
        status = self._r(ADDR_STATUS)

        I1 = idx & 1
        I2 = (idx >> 1) & 1
        I3 = (idx >> 2) & 1
        I4 = (idx >> 3) & 1
        I7 = (idx >> 4) & 1

        Q10 = status & 1
        Q11 = (status >> 1) & 1
        Q12 = (status >> 2) & 1

        print(
            f"Entradas electricas: "
            f"I1={I1} I2={I2} I3={I3} I4={I4} I7={I7}  |  "
            f"Salidas: Q10={Q10} Q11={Q11} Q12={Q12}"
        )

        return idx, status

    def leer_acumulados(self):
        datos = {}

        for s in ("Q10", "Q11", "Q12"):
            timer_s = self._r(ADDR_TACC[s])
            contador = self._r(ADDR_CACC[s])

            datos[s] = {
                "timer_s": timer_s,
                "contador": contador,
            }

        print(
            "Acumulados | "
            f"Q10: T={datos['Q10']['timer_s']}s C={datos['Q10']['contador']} | "
            f"Q11: T={datos['Q11']['timer_s']}s C={datos['Q11']['contador']} | "
            f"Q12: T={datos['Q12']['timer_s']}s C={datos['Q12']['contador']}"
        )

        return datos


# ---------------------------------------------------------------------------
# EJEMPLO DE USO
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    plc = XL4()
    plc.connect()

    try:
        plc.reset_todo(borrar_acumulados=True)

        # ------------------------------------------------------------
        # Q11: I1 o I3 encienden la lampara amarilla durante 5 segundos
        # ------------------------------------------------------------
        plc.combinacional("Q11", "I1", "I3", op="OR")
        plc.configurar_pulso_salida("Q11", 5)

        # ------------------------------------------------------------
        # Q10: I4 cuenta pulsos.
        # Cuando llegue a 3, Q10 se queda encendida.
        # I7 resetea el contador de Q10 y apaga Q10.
        # ------------------------------------------------------------
        plc.directo("Q10", "I4")
        plc.configurar_contador_mantenido("Q10", 3)
        plc.configurar_reset_contador("Q10", "I7")

        # ------------------------------------------------------------
        # Habilitar sistema
        # ------------------------------------------------------------
        plc.habilitar(True)

        plc.leer_estado()
        plc.leer_acumulados()

    finally:
        plc.close()