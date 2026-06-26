(function () {
  'use strict';

  var LS_KEY = 'lv_tour_ladder_seen';

  var STEPS = [
    {
      element: '.sidebar',
      popover: {
        title: 'Paleta de componentes',
        description: 'Contiene todos los elementos Ladder: contactos (NO, NC, flancos), bobinas (Q, Set, Reset), timers (TON, TOF) y contadores (CTU, CTD). Arrastra cualquier elemento al área central.',
        side: 'right',
        align: 'start',
      },
    },
    {
      element: '#rungArea',
      popover: {
        title: 'Área de programación',
        description: 'Aquí construyes el programa Ladder rung a rung. Arrastra elementos desde la paleta, <b>doble clic</b> para editar propiedades, <b>clic derecho</b> para el menú contextual. Usa <b>Ctrl+Z</b> para deshacer.',
        side: 'left',
        align: 'center',
      },
    },
    {
      element: '#chatPanel',
      popover: {
        title: 'Asistente IA integrado',
        description: 'Describe en español el programa que necesitas y el asistente generará la lógica Ladder en segundos. También acepta entrada por voz. El resultado se carga directamente en el editor.',
        side: 'left',
        align: 'start',
      },
    },
    {
      element: '.tnav-btn.compile',
      popover: {
        title: 'Compilar',
        description: 'Valida la sintaxis y lógica del programa. El resultado aparece en la <b>Terminal</b> del panel inferior. Corrige todos los errores antes de intentar cargar al PLC.',
        side: 'bottom',
        align: 'start',
      },
    },
    {
      element: '.tnav-btn.upload',
      popover: {
        title: 'Cargar al PLC',
        description: 'Transfiere el programa compilado al PLC vía Modbus TCP. El indicador de estado (barra superior, izquierda) debe mostrar conexión activa. Haz clic en él para configurar la IP del PLC.',
        side: 'bottom',
        align: 'start',
      },
    },
    {
      element: '#bottombar',
      popover: {
        title: 'Panel de herramientas',
        description: 'Cuatro pestañas: <b>Terminal</b> (salida de compilación y errores), <b>Estado I/O</b> (valores de señales en tiempo real), <b>Watch Table</b> (monitoreo de variables) y <b>Referencias</b> (uso cruzado de etiquetas).',
        side: 'top',
        align: 'center',
      },
    },
    {
      element: '[data-menu="tnd-ia"]',
      popover: {
        title: 'Menú IA',
        description: 'Importa un programa generado por el Copiloto IA (archivo .js), o abre el asistente del panel lateral para diseñar lógica sin salir del editor.',
        side: 'bottom',
        align: 'start',
      },
    },
  ];

  function startTour() {
    var driverObj = window.driver.js.driver({
      animate: true,
      showProgress: true,
      progressText: 'Paso {{current}} de {{total}}',
      allowClose: true,
      overlayClickBehavior: 'close',
      nextBtnText: 'Siguiente →',
      prevBtnText: '← Anterior',
      doneBtnText: '¡Entendido!',
      popoverClass: 'lv-tour-popover',
      onDestroyed: function () {
        localStorage.setItem(LS_KEY, '1');
      },
      steps: STEPS,
    });
    driverObj.drive();
  }

  var tourBtn = document.getElementById('ladderTourBtn');
  if (tourBtn) {
    tourBtn.addEventListener('click', startTour);
  }

  // 600ms delay: app.js and chat.js are type="module" (deferred),
  // so rungArea and chatPanel may not be fully initialized yet when this runs.
  if (!localStorage.getItem(LS_KEY)) {
    setTimeout(startTour, 600);
  }

  window.LVTour = window.LVTour || {};
  window.LVTour.ladder = {
    start: startTour,
    reset: function () { localStorage.removeItem(LS_KEY); },
  };
})();
