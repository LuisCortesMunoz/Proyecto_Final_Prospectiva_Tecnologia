(function () {
  'use strict';

  var LS_KEY = 'lv_tour_index_seen';
  var activeDriver = null;

  var STEPS = [
    {
      element: '#cpInput',
      popover: {
        title: 'Escribe tu consulta aquí',
        description: 'Este es el campo principal del copiloto. Pregunta conceptos de Ladder, PLCs, o pide que genere código. El asistente responderá con explicaciones detalladas.',
        side: 'top',
        align: 'center',
      },
    },
    {
      element: '#cpModeBtn',
      popover: {
        title: 'Modo de operación',
        description: '<b>Aprendizaje</b> explica conceptos paso a paso. <b>Práctico</b> revisa tu lógica y sugiere mejoras. <b>Diseñador</b> genera programas Ladder completos que puedes abrir directamente en el editor.',
        side: 'top',
        align: 'start',
      },
    },
    {
      element: '#cpEffortBtn',
      popover: {
        title: 'Nivel de esfuerzo',
        description: 'Define la profundidad del razonamiento. <b>Instantánea</b> = respuestas rápidas. <b>Media</b> = equilibrio ideal para la mayoría de casos. <b>Alta</b> = análisis detallado para lógica compleja.',
        side: 'top',
        align: 'start',
      },
    },
    {
      element: '#cpChips',
      popover: {
        title: 'Acciones rápidas',
        description: 'Pulsa uno de estos botones para comenzar una conversación predefinida: genera lógica Ladder, explica un concepto, depura código existente o solicita documentación técnica.',
        side: 'top',
        align: 'center',
      },
    },
    {
      element: '#cpMicBtn',
      popover: {
        title: 'Entrada por voz',
        description: 'Habla en lugar de escribir. El copiloto transcribirá tu pregunta automáticamente. El navegador pedirá permiso de micrófono la primera vez.',
        side: 'top',
        align: 'end',
      },
    },
    {
      element: '#cpSendBtn',
      popover: {
        title: 'Enviar mensaje',
        description: 'Haz clic aquí o pulsa <b>Enter</b> para enviar tu consulta. El botón se activa en cuanto hay texto en el campo.',
        side: 'top',
        align: 'end',
      },
    },
    {
      element: '#backendPill',
      popover: {
        title: 'Estado del servidor',
        description: 'Muestra si el backend con Ollama está disponible. <b>Verde</b> = conectado. <b>Rojo</b> = sin conexión (verifica que el servidor esté activo).',
        side: 'bottom',
        align: 'end',
      },
    },
    {
      element: '#onav-logo-btn',
      popover: {
        title: 'Navegar entre páginas',
        description: 'Haz clic en el logo para cambiar de página: Chat IA, Editor Ladder, Documentación del proyecto o el repositorio en GitHub.',
        side: 'bottom',
        align: 'start',
      },
    },
  ];

  function startTour() {
    if (activeDriver) {
      activeDriver.destroy();
      activeDriver = null;
    }

    activeDriver = window.driver.js.driver({
      animate: true,
      showProgress: true,
      progressText: 'Paso {{current}} de {{total}}',
      allowClose: true,
      nextBtnText: 'Siguiente →',
      prevBtnText: '← Anterior',
      doneBtnText: '¡Entendido!',
      popoverClass: 'lv-tour-popover',
      onDestroyed: function () {
        localStorage.setItem(LS_KEY, '1');
        activeDriver = null;
      },
      steps: STEPS,
    });

    activeDriver.drive();
  }

  var tourBtn = document.getElementById('cpTourBtn');
  if (tourBtn) {
    tourBtn.addEventListener('click', startTour);
  }

  if (!localStorage.getItem(LS_KEY)) {
    setTimeout(startTour, 600);
  }

  window.LVTour = window.LVTour || {};
  window.LVTour.index = {
    start: startTour,
    reset: function () { localStorage.removeItem(LS_KEY); },
  };
})();
