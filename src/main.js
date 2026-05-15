const STORAGE_KEY = 'virtualDeskState';
const inputSelector = 'textarea, input, button, select, [contenteditable="true"], [data-no-drag]';
const NOTEBOOK_OPEN_CLICK_MAX_MS = 180;
const NOTEBOOK_DRAG_MOVE_THRESHOLD = 6;

const NOTEBOOK_ROTATION_LIMIT = 45;
const NOTEBOOK_MIN_SCALE = 0.65;
const NOTEBOOK_DEFAULT_DIMENSIONS = {
  closed: { width: 210, height: 270 },
  open: { width: 460, height: 430 }
};

const POMODORO_MODES = {
  work: { label: 'Work', minutes: 25, seconds: 25 * 60 },
  shortBreak: { label: 'Short Break', minutes: 5, seconds: 5 * 60 },
  longBreak: { label: 'Long Break', minutes: 15, seconds: 15 * 60 }
};

const makeId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const root = document.getElementById('root');
let saveTimer = null;
let toastTimer = null;
let clockTimer = null;
let pomodoroTimer = null;
let pomodoroAudioContext = null;
let trashDialogOpen = false;

const defaultState = {
  background: { mode: 'color', value: '#5e789a' },
  objects: [
    {
      id: 'welcome-notebook',
      type: 'notebook',
      status: 'active',
      x: 170,
      y: 92,
      open: false,
      activePage: 0,
      pages: [
        'Bienvenido a VirtualDesk. Haz clic en la libreta para abrirla y escribe tus ideas.',
        'Usa las flechas para cambiar de página. Todo se guarda automáticamente.'
      ],
      flipDirection: 'next',
      rotation: 0,
      notebookScale: 1
    }
  ]
};

let state = loadState();

function normalizeObject(object) {
  const baseObject = { status: 'active', ...object };
  if (baseObject?.type === 'pomodoro') return normalizePomodoro(baseObject);
  if (baseObject?.type !== 'notebook') return baseObject;
  return {
    rotation: 0,
    notebookScale: 1,
    ...baseObject,
    rotation: clampNotebookRotation(baseObject.rotation),
    notebookScale: Math.max(NOTEBOOK_MIN_SCALE, Number(baseObject.notebookScale) || 1)
  };
}

function normalizeState(value) {
  return {
    ...defaultState,
    ...value,
    background: { ...defaultState.background, ...(value?.background || {}) },
    objects: (Array.isArray(value?.objects) ? value.objects : defaultState.objects).map(normalizeObject)
  };
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeState(JSON.parse(saved)) : structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, 60);
}

function setState(updater, shouldRender = true) {
  state = typeof updater === 'function' ? updater(state) : updater;
  persist();
  if (shouldRender) render();
}

function updateObject(id, patch, shouldRender = true) {
  setState((current) => ({
    ...current,
    objects: current.objects.map((object) => {
      if (object.id !== id) return object;
      const nextPatch = typeof patch === 'function' ? patch(object) : patch;
      return { ...object, ...nextPatch };
    })
  }), shouldRender);
}

function addObject(object) {
  setState((current) => ({ ...current, objects: [...current.objects, object] }));
}

function bringToFront(id, shouldRender = true) {
  const target = state.objects.find((object) => object.id === id);
  if (!target || state.objects[state.objects.length - 1]?.id === id) return;
  setState((current) => ({
    ...current,
    objects: [...current.objects.filter((object) => object.id !== id), target]
  }), shouldRender);
}

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : value);
  });
  return node;
}

function placeObject(offset = 0) {
  return { x: Math.min(window.innerWidth - 280, 132 + offset), y: 96 + offset };
}

function showToast(message) {
  const toast = document.querySelector('.toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2200);
}

function applyBackground(main) {
  if (state.background.mode === 'image') {
    main.style.backgroundImage = `linear-gradient(rgba(26, 36, 56, .2), rgba(26, 36, 56, .42)), url(${state.background.value})`;
    main.style.backgroundColor = '';
  } else {
    main.style.backgroundImage = '';
    main.style.backgroundColor = state.background.value;
  }
}

function createDock() {
  const dock = el('nav', 'dock', { 'aria-label': 'Herramientas del escritorio' });
  const buttons = [
    ['notebook-icon', '📓', 'Crear libreta', () => addObject({ id: makeId('notebook'), type: 'notebook', status: 'active', ...placeObject(18), open: false, activePage: 0, pages: [''], flipDirection: 'next', rotation: 0, notebookScale: 1 })],
    ['sticky-icon', '🗒️', 'Crear nota adhesiva', () => addObject({ id: makeId('note'), type: 'sticky', status: 'active', ...placeObject(42), content: '' })],
    ['todo-icon', '☑️', 'Crear lista de tareas', () => addObject({ id: makeId('todo'), type: 'todo', status: 'active', ...placeObject(76), tasks: [] })],
    ['pomodoro-icon', '⏱️', 'Crear timer Pomodoro', () => addObject(createPomodoroObject(placeObject(108)))],
    ['settings-icon', '⚙️', 'Configuración', () => showToast('Configuración: Coming Soon')]
  ];

  buttons.forEach(([className, icon, label, handler]) => {
    const button = el('button', `dock-button ${className}`, { title: label, 'aria-label': label, onclick: handler });
    button.append(el('span', '', { text: icon }));
    dock.append(button);
  });
  return dock;
}

function createBackgroundPanel() {
  const panel = el('section', 'background-panel', { 'aria-label': 'Configurar fondo' });
  const copy = el('div');
  copy.append(el('strong', '', { text: 'Fondo' }));
  copy.append(el('span', '', { text: state.background.mode === 'image' ? 'Imagen personalizada' : 'Color de escritorio' }));

  const colorLabel = el('label', 'color-control');
  const color = el('input', '', { type: 'color', value: state.background.mode === 'color' ? state.background.value : '#5e789a', 'aria-label': 'Elegir color de fondo' });
  color.addEventListener('input', (event) => setState((current) => ({ ...current, background: { mode: 'color', value: event.target.value } })));
  colorLabel.append(color);

  const form = el('form');
  const url = el('input', '', { type: 'url', value: state.background.mode === 'image' ? state.background.value : '', placeholder: 'URL de imagen', 'aria-label': 'URL de imagen para el fondo' });
  const submit = el('button', '', { text: 'Usar' });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (url.value.trim()) setState((current) => ({ ...current, background: { mode: 'image', value: url.value.trim() } }));
  });
  form.append(url, submit);
  panel.append(copy, colorLabel, form);
  return panel;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampNotebookRotation(value = 0) {
  return clamp(Number(value) || 0, -NOTEBOOK_ROTATION_LIMIT, NOTEBOOK_ROTATION_LIMIT);
}

function createPomodoroObject(position = placeObject(108)) {
  return {
    id: makeId('pomodoro'),
    type: 'pomodoro',
    status: 'active',
    ...position,
    mode: 'work',
    remainingSeconds: POMODORO_MODES.work.seconds,
    completedCycles: 0,
    isRunning: false,
    lastTickAt: Date.now()
  };
}

function normalizePomodoro(object) {
  const mode = POMODORO_MODES[object.mode] ? object.mode : 'work';
  let remainingSeconds = Number.isFinite(Number(object.remainingSeconds))
    ? Math.max(0, Math.floor(Number(object.remainingSeconds)))
    : POMODORO_MODES[mode].seconds;
  const completedCycles = clamp(Math.floor(Number(object.completedCycles) || 0), 0, 4);
  const lastTickAt = Number(object.lastTickAt) || Date.now();
  if (object.isRunning) {
    const elapsed = Math.max(0, Math.floor((Date.now() - lastTickAt) / 1000));
    remainingSeconds = Math.max(0, remainingSeconds - elapsed);
  }
  return {
    ...object,
    mode,
    remainingSeconds,
    completedCycles,
    isRunning: Boolean(object.isRunning),
    lastTickAt: Date.now()
  };
}

function getPomodoroModeSeconds(mode) {
  return POMODORO_MODES[mode]?.seconds || POMODORO_MODES.work.seconds;
}

function formatTimer(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function getNotebookMode(object) {
  return object.open ? 'open' : 'closed';
}

function getNotebookDimensions(object) {
  const mode = getNotebookMode(object);
  const base = NOTEBOOK_DEFAULT_DIMENSIONS[mode];
  const scale = Number(object.notebookScale) || 1;
  return { width: base.width * scale, height: base.height * scale, base };
}

function getFrameRotation(frame, fallback = 0) {
  return Number(frame.dataset.displayRotation ?? frame.dataset.rotation ?? fallback) || 0;
}

function setFrameTransform(frame, x, y, rotation = getFrameRotation(frame)) {
  frame.dataset.displayRotation = String(rotation);
  frame.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rotation}deg)`;
}

function getEventPoint(event) {
  const touch = event.touches?.[0] || event.changedTouches?.[0];
  return touch || event;
}

function getObjectById(id, fallback) {
  return state.objects.find((item) => item.id === id) || fallback;
}

function getActiveObjects() {
  return state.objects.filter((object) => object.status !== 'trashed');
}

function getTrashedObjects() {
  return state.objects.filter((object) => object.status === 'trashed');
}

function getTrashButton() {
  return document.querySelector('.trash-can');
}

function isPointInsideRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isPointOverTrash(x, y) {
  const trash = getTrashButton();
  return trash ? isPointInsideRect(x, y, trash.getBoundingClientRect()) : false;
}

function setTrashDropFeedback(active) {
  const trash = getTrashButton();
  if (trash) trash.classList.toggle('is-drop-target', active);
}

function shakeTrashCan() {
  const trash = getTrashButton();
  if (!trash) return;
  trash.classList.remove('just-ate');
  void trash.offsetWidth;
  trash.classList.add('just-ate');
}

function trashObjectWithAnimation(frame, object, point) {
  setTrashDropFeedback(false);
  const trash = getTrashButton();
  const frameRect = frame.getBoundingClientRect();
  const trashRect = trash?.getBoundingClientRect();
  const targetX = trashRect ? trashRect.left + (trashRect.width - frameRect.width) / 2 : point.clientX - frameRect.width / 2;
  const targetY = trashRect ? trashRect.top + (trashRect.height - frameRect.height) / 2 : point.clientY - frameRect.height / 2;

  frame.classList.add('is-being-trashed');
  frame.style.transform = `translate3d(${targetX}px, ${targetY}px, 0) scale(0) rotate(720deg)`;
  frame.style.opacity = '0';

  window.setTimeout(() => {
    updateObject(object.id, { status: 'trashed', trashedAt: Date.now(), open: object.type === 'notebook' ? false : object.open }, true);
    shakeTrashCan();
    showToast('Objeto enviado a la Papelera');
  }, 420);
}

function makeDraggable(frame, object, options = {}) {
  let drag = null;
  let holdTimer = null;
  const moveThreshold = options.moveThreshold ?? 0;
  const dragDelay = options.dragDelay ?? 0;

  const clearHoldTimer = () => {
    window.clearTimeout(holdTimer);
    holdTimer = null;
  };

  const startDrag = (event) => {
    if (!drag || drag.isDragging) return;
    clearHoldTimer();
    drag.isDragging = true;
    frame.classList.add('is-dragging');
    if (event?.cancelable) event.preventDefault();
  };

  frame.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (options.canStart && !options.canStart(event)) return;
    if (!options.canStart && event.target.closest(inputSelector)) return;

    bringToFront(object.id, false);
    frame.style.zIndex = 1000;
    frame.setPointerCapture?.(event.pointerId);
    const current = getObjectById(object.id, object);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
      startedAt: performance.now(),
      isDragging: false
    };

    if (dragDelay > 0) {
      holdTimer = window.setTimeout(() => startDrag(), dragDelay);
    } else {
      startDrag(event);
    }
  });

  frame.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const distance = Math.hypot(deltaX, deltaY);

    if (!drag.isDragging && distance >= moveThreshold) startDrag(event);
    if (!drag.isDragging) return;

    const x = Math.max(8, drag.originX + deltaX);
    const y = Math.max(8, drag.originY + deltaY);
    setFrameTransform(frame, x, y);
    updateObject(object.id, { x, y }, false);
    setTrashDropFeedback(object.status !== 'trashed' && isPointOverTrash(event.clientX, event.clientY));
  });

  const stop = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearHoldTimer();
    frame.releasePointerCapture?.(event.pointerId);
    const wasDragging = drag.isDragging;
    const elapsed = performance.now() - drag.startedAt;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    const droppedOnTrash = wasDragging && object.status !== 'trashed' && isPointOverTrash(event.clientX, event.clientY);
    drag = null;
    frame.classList.remove('is-dragging');
    frame.style.zIndex = '';

    if (droppedOnTrash) {
      trashObjectWithAnimation(frame, object, event);
      return;
    }

    setTrashDropFeedback(false);

    if (wasDragging) {
      persist();
      return;
    }

    if (options.onQuickClick && elapsed <= (options.quickClickMaxMs ?? NOTEBOOK_OPEN_CLICK_MAX_MS) && distance < moveThreshold) {
      options.onQuickClick(event);
    }
  };

  frame.addEventListener('pointerup', stop);
  frame.addEventListener('pointercancel', (event) => {
    clearHoldTimer();
    if (drag?.pointerId === event.pointerId) {
      frame.releasePointerCapture?.(event.pointerId);
      drag = null;
      frame.classList.remove('is-dragging');
      frame.style.zIndex = '';
      setTrashDropFeedback(false);
    }
  });
}

function isOpenNotebookDragZone(event) {
  if (event.target.closest(inputSelector)) return false;
  if (event.target.closest('.notebook-drag-zone')) return true;

  const notebook = event.currentTarget;
  const rect = notebook.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const edgeSize = Math.max(18, Math.min(rect.width, rect.height) * 0.06);
  const bindingWidth = Math.max(34, rect.width * 0.08);
  const topMargin = Math.max(38, rect.height * 0.1);

  return (
    x <= edgeSize ||
    y <= edgeSize ||
    x >= rect.width - edgeSize ||
    y >= rect.height - edgeSize ||
    x <= bindingWidth ||
    y <= topMargin
  );
}


function createFrame(object, className, dragOptions) {
  const frame = el('article', `desk-object ${className}`);
  const rotation = object.type === 'notebook' ? clampNotebookRotation(object.rotation) : 0;
  frame.dataset.rotation = String(rotation);
  setFrameTransform(frame, object.x, object.y, rotation);
  makeDraggable(frame, object, dragOptions);
  return frame;
}

function applyNotebookFrameSize(frame, object, scale = Number(object.notebookScale) || 1) {
  const base = NOTEBOOK_DEFAULT_DIMENSIONS[getNotebookMode(object)];
  const width = base.width * scale;
  const height = base.height * scale;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.setProperty('--notebook-width', `${width}px`);
  frame.style.setProperty('--notebook-height', `${height}px`);
  frame.style.setProperty('--notebook-scale', scale);
}

function fitNotebookScaleToViewport(object, requestedScale) {
  const current = getObjectById(object.id, object);
  const base = NOTEBOOK_DEFAULT_DIMENSIONS[getNotebookMode(current)];
  const radians = Math.abs(clampNotebookRotation(current.rotation)) * Math.PI / 180;
  const rotatedWidth = base.width * Math.cos(radians) + base.height * Math.sin(radians);
  const rotatedHeight = base.width * Math.sin(radians) + base.height * Math.cos(radians);
  const rightLimit = (window.innerWidth - current.x - 8) * 2 / (base.width + rotatedWidth);
  const bottomLimit = (window.innerHeight - current.y - 8) * 2 / (base.height + rotatedHeight);
  const leftLimit = rotatedWidth > base.width ? Math.max(0, (current.x - 8) * 2 / (rotatedWidth - base.width)) : Infinity;
  const topLimit = rotatedHeight > base.height ? Math.max(0, (current.y - 8) * 2 / (rotatedHeight - base.height)) : Infinity;
  const maxScale = Math.max(NOTEBOOK_MIN_SCALE, Math.min(rightLimit, bottomLimit, leftLimit, topLimit));
  return clamp(requestedScale, NOTEBOOK_MIN_SCALE, maxScale);
}

function addNotebookResize(frame, object) {
  const handle = el('span', 'notebook-resize-control', { role: 'button', 'aria-label': 'Redimensionar libreta', 'data-no-drag': true });
  let resize = null;

  const move = (event) => {
    if (!resize) return;
    event.preventDefault();
    const point = getEventPoint(event);
    const dx = point.clientX - resize.startX;
    const dy = point.clientY - resize.startY;
    const aspectDelta = Math.max(dx, dy * resize.aspect);
    const requestedScale = (resize.startWidth + aspectDelta) / resize.base.width;
    const current = getObjectById(object.id, object);
    const notebookScale = fitNotebookScaleToViewport(current, requestedScale);
    applyNotebookFrameSize(frame, current, notebookScale);
    updateObject(object.id, { notebookScale }, false);
  };

  const stop = () => {
    if (!resize) return;
    resize = null;
    frame.classList.remove('is-resizing');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', stop);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', stop);
    document.removeEventListener('touchcancel', stop);
    persist();
  };

  const start = (event) => {
    event.preventDefault();
    event.stopPropagation();
    bringToFront(object.id, false);
    const point = getEventPoint(event);
    const current = getObjectById(object.id, object);
    const { width, height, base } = getNotebookDimensions(current);
    resize = { startX: point.clientX, startY: point.clientY, startWidth: width, aspect: width / height, base };
    frame.classList.add('is-resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', stop);
    document.addEventListener('touchcancel', stop);
  };

  handle.addEventListener('mousedown', start);
  handle.addEventListener('touchstart', start, { passive: false });
  frame.append(handle);
}

function addNotebookRotation(frame, object) {
  const handle = el('span', 'notebook-rotate-control', { role: 'button', 'aria-label': 'Rotar libreta', 'data-no-drag': true, text: '↻' });
  let rotate = null;

  const pointerAngle = (event) => {
    const point = getEventPoint(event);
    const rect = frame.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return Math.atan2(point.clientY - centerY, point.clientX - centerX) * 180 / Math.PI;
  };

  const move = (event) => {
    if (!rotate) return;
    event.preventDefault();
    const delta = pointerAngle(event) - rotate.startAngle;
    const rotation = clampNotebookRotation(rotate.startRotation + delta);
    frame.dataset.rotation = String(rotation);
    const current = getObjectById(object.id, object);
    setFrameTransform(frame, current.x, current.y, frame.classList.contains('is-writing') ? 0 : rotation);
    updateObject(object.id, { rotation }, false);
  };

  const stop = () => {
    if (!rotate) return;
    rotate = null;
    frame.classList.remove('is-rotating');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', stop);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', stop);
    document.removeEventListener('touchcancel', stop);
    persist();
  };

  const start = (event) => {
    event.preventDefault();
    event.stopPropagation();
    bringToFront(object.id, false);
    const current = getObjectById(object.id, object);
    rotate = { startAngle: pointerAngle(event), startRotation: clampNotebookRotation(current.rotation) };
    frame.classList.add('is-rotating');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', stop);
    document.addEventListener('touchcancel', stop);
  };

  handle.addEventListener('mousedown', start);
  handle.addEventListener('touchstart', start, { passive: false });
  frame.append(handle);
}

function addNotebookFocusRotation(frame, object, textarea) {
  textarea.addEventListener('focus', () => {
    frame.classList.add('is-writing');
    const current = getObjectById(object.id, object);
    setFrameTransform(frame, current.x, current.y, 0);
  });
  textarea.addEventListener('blur', () => {
    frame.classList.remove('is-writing');
    const current = getObjectById(object.id, object);
    const rotation = clampNotebookRotation(current.rotation);
    frame.dataset.rotation = String(rotation);
    setFrameTransform(frame, current.x, current.y, rotation);
  });
}

function createStickyNote(object) {
  const frame = createFrame(object, 'sticky-note');
  const textarea = el('textarea', '', { placeholder: 'Escribe una nota...', 'aria-label': 'Contenido de nota adhesiva' });
  textarea.value = object.content || '';
  textarea.addEventListener('input', (event) => updateObject(object.id, { content: event.target.value }, false));
  frame.append(el('div', 'paper-tape'), textarea);
  return frame;
}

function createNotebook(object) {
  const dragOptions = object.open
    ? { canStart: isOpenNotebookDragZone, moveThreshold: NOTEBOOK_DRAG_MOVE_THRESHOLD }
    : {
        canStart: (event) => !event.target.closest('[data-no-drag]'),
        dragDelay: NOTEBOOK_OPEN_CLICK_MAX_MS,
        moveThreshold: NOTEBOOK_DRAG_MOVE_THRESHOLD,
        onQuickClick: () => updateObject(object.id, { open: true })
      };
  const frame = createFrame(object, `notebook ${object.open ? 'open' : 'closed'}`, dragOptions);
  applyNotebookFrameSize(frame, object, fitNotebookScaleToViewport(object, Number(object.notebookScale) || 1));
  addNotebookRotation(frame, object);
  addNotebookResize(frame, object);
  if (!object.open) {
    const cover = el('div', 'notebook-cover', { role: 'button', tabindex: '0', 'aria-label': 'Abrir libreta' });
    cover.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      updateObject(object.id, { open: true });
    });
    cover.append(el('span', 'spiral'), el('span', 'cover-title', { text: 'Notebook' }), el('span', 'cover-subtitle', { text: 'click to open' }));
    frame.append(cover);
    return frame;
  }

  const wrap = el('div', 'notebook-open');
  const toolbar = el('header', 'notebook-toolbar notebook-drag-zone', { title: 'Arrastra desde este margen superior para mover la libreta' });
  const close = el('button', '', { text: 'Cerrar', onclick: () => updateObject(object.id, { open: false }) });
  toolbar.append(close, el('span', '', { text: `Página ${(object.activePage || 0) + 1} / ${(object.pages || ['']).length}` }));

  const page = el('div', `notebook-page ${object.flipDirection === 'prev' ? 'flip-back' : 'flip-next'}`);
  const textarea = el('textarea', '', { placeholder: 'Nueva página...', 'aria-label': 'Página editable de libreta' });
  textarea.value = (object.pages || [''])[object.activePage || 0] || '';
  textarea.addEventListener('input', (event) => updateObject(object.id, (current) => {
    const pages = [...(current.pages || [''])];
    pages[current.activePage || 0] = event.target.value;
    return { pages };
  }, false));
  addNotebookFocusRotation(frame, object, textarea);
  page.append(textarea);

  const footer = el('footer', 'page-controls');
  const prev = el('button', '', { text: '← Anterior' });
  prev.disabled = (object.activePage || 0) === 0;
  prev.addEventListener('click', () => turnNotebookPage(object.id, 'prev'));
  const next = el('button', '', { text: 'Siguiente →', onclick: () => turnNotebookPage(object.id, 'next') });
  footer.append(prev, next);
  wrap.append(toolbar, page, footer);
  frame.append(wrap);
  return frame;
}

function turnNotebookPage(id, direction) {
  updateObject(id, (current) => {
    const pages = [...(current.pages || [''])];
    const currentPage = current.activePage || 0;
    let nextPage = currentPage + (direction === 'next' ? 1 : -1);
    if (direction === 'next' && nextPage >= pages.length) pages.push('');
    nextPage = Math.max(0, Math.min(nextPage, pages.length - 1));
    return { pages, activePage: nextPage, flipDirection: direction, flippingAt: Date.now() };
  });
}

function createTodoList(object) {
  const frame = createFrame(object, 'todo-pad');
  const tasks = object.tasks || [];
  const header = el('header');
  header.append(el('span', '', { text: 'Today' }), el('small', '', { text: `${tasks.filter((task) => task.done).length}/${tasks.length}` }));

  const form = el('form', 'todo-add');
  const draft = el('input', '', { placeholder: 'Añadir tarea', 'aria-label': 'Nueva tarea' });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!draft.value.trim()) return;
    updateObject(object.id, { tasks: [...tasks, { id: makeId('task'), text: draft.value.trim(), done: false }] });
  });
  form.append(draft, el('button', '', { text: '+' }));

  const list = el('div', 'todo-items');
  tasks.forEach((task) => {
    const label = el('label', `todo-item ${task.done ? 'done' : ''}`);
    const checkbox = el('input', '', { type: 'checkbox', 'aria-label': `Completar ${task.text}` });
    checkbox.checked = task.done;
    checkbox.addEventListener('change', (event) => updateObject(object.id, { tasks: tasks.map((item) => item.id === task.id ? { ...item, done: event.target.checked } : item) }));
    const text = el('input', '', { 'aria-label': 'Editar tarea' });
    text.value = task.text;
    text.addEventListener('input', (event) => updateObject(object.id, { tasks: tasks.map((item) => item.id === task.id ? { ...item, text: event.target.value } : item) }, false));
    label.append(checkbox, text);
    list.append(label);
  });

  frame.append(header, form, list);
  return frame;
}


function isPomodoroDragZone(event) {
  if (event.target.closest(inputSelector)) return false;
  if (event.target.closest('.pomodoro-grip')) return true;

  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const edgeSize = 16;
  return x <= edgeSize || y <= edgeSize || x >= rect.width - edgeSize || y >= rect.height - edgeSize;
}

function primePomodoroAudio() {
  try {
    pomodoroAudioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    if (pomodoroAudioContext.state === 'suspended') pomodoroAudioContext.resume();
  } catch {
    // Audio is best-effort and can be unavailable in restricted browsers.
  }
}

function playPomodoroDing() {
  try {
    primePomodoroAudio();
    const context = pomodoroAudioContext;
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    master.connect(context.destination);

    [660, 990].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const toneGain = context.createGain();
      oscillator.type = index ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.08);
      toneGain.gain.setValueAtTime(index ? 0.32 : 0.7, now);
      toneGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.05);
      oscillator.connect(toneGain);
      toneGain.connect(master);
      oscillator.start(now + index * 0.08);
      oscillator.stop(now + 1.12);
    });
  } catch {
    // Browsers can block audio until the user interacts; the visual transition still runs.
  }
}

function completePomodoroPhase(object) {
  playPomodoroDing();
  let mode = 'work';
  let completedCycles = object.completedCycles || 0;
  let message = 'Pomodoro listo para volver al trabajo';

  if (object.mode === 'work') {
    completedCycles = clamp(completedCycles + 1, 0, 4);
    mode = completedCycles >= 4 ? 'longBreak' : 'shortBreak';
    message = mode === 'longBreak' ? '¡Cuatro Pomodoros! Toma un descanso largo.' : 'Trabajo completado. Descanso corto iniciado.';
  } else if (object.mode === 'longBreak') {
    completedCycles = 0;
    message = 'Descanso largo terminado. Ciclos reiniciados.';
  } else {
    message = 'Descanso corto terminado. Vuelve a Focus Mode.';
  }

  updateObject(object.id, {
    mode,
    completedCycles,
    remainingSeconds: getPomodoroModeSeconds(mode),
    isRunning: false,
    lastTickAt: Date.now()
  });
  showToast(message);
}

function updatePomodoroDisplays() {
  let hasRunningPomodoros = false;
  let completedObject = null;
  const now = Date.now();

  state.objects.forEach((object) => {
    if (object.type !== 'pomodoro' || object.status === 'trashed' || !object.isRunning) return;
    hasRunningPomodoros = true;
    const elapsed = Math.floor((now - (Number(object.lastTickAt) || now)) / 1000);
    if (elapsed < 1 && Number(object.remainingSeconds) > 0) return;
    const remainingSeconds = Math.max(0, (Number(object.remainingSeconds) || 0) - Math.max(0, elapsed));
    object.remainingSeconds = remainingSeconds;
    object.lastTickAt = now;
    const display = document.querySelector(`[data-pomodoro-id="${object.id}"] .pomodoro-display`);
    if (display) display.textContent = formatTimer(remainingSeconds);
    if (remainingSeconds <= 0) completedObject = { ...object };
  });

  if (hasRunningPomodoros) persist();
  if (completedObject) completePomodoroPhase(completedObject);
}

function ensurePomodoroTicker() {
  window.clearInterval(pomodoroTimer);
  updatePomodoroDisplays();
  pomodoroTimer = window.setInterval(updatePomodoroDisplays, 1000);
}

function setPomodoroMode(id, mode) {
  updateObject(id, {
    mode,
    remainingSeconds: getPomodoroModeSeconds(mode),
    isRunning: false,
    lastTickAt: Date.now()
  });
}

function createPomodoroWidget(object) {
  const frame = createFrame(object, 'pomodoro-widget', { canStart: isPomodoroDragZone });
  frame.dataset.pomodoroId = object.id;

  const shell = el('div', 'pomodoro-shell');
  const header = el('header', 'pomodoro-grip', { title: 'Arrastra desde la barra o los bordes' });
  header.append(el('span', 'pomodoro-status-light'), el('strong', '', { text: 'Focus Mode' }), el('span', '', { text: object.isRunning ? 'RUN' : 'READY' }));

  const display = el('div', 'pomodoro-display', { text: formatTimer(object.remainingSeconds), 'aria-live': 'polite' });

  const cycles = el('div', 'pomodoro-cycles', { 'aria-label': `${object.completedCycles || 0} de 4 ciclos de trabajo completados` });
  Array.from({ length: 4 }).forEach((_, index) => {
    cycles.append(el('span', index < (object.completedCycles || 0) ? 'is-lit' : '', { 'aria-hidden': 'true' }));
  });

  const modes = el('div', 'pomodoro-modes', { 'aria-label': 'Seleccionar modo Pomodoro' });
  Object.entries(POMODORO_MODES).forEach(([mode, meta]) => {
    modes.append(el('button', object.mode === mode ? 'is-active' : '', {
      type: 'button',
      text: `${meta.label} ${meta.minutes}`,
      'aria-pressed': object.mode === mode ? 'true' : 'false',
      onclick: () => setPomodoroMode(object.id, mode)
    }));
  });

  const controls = el('div', 'pomodoro-controls');
  const play = el('button', 'primary', {
    type: 'button',
    text: '▶',
    'aria-label': 'Iniciar Pomodoro',
    onclick: () => {
      primePomodoroAudio();
      updateObject(object.id, { isRunning: true, lastTickAt: Date.now() });
    }
  });
  const pause = el('button', '', {
    type: 'button',
    text: 'Ⅱ',
    'aria-label': 'Pausar Pomodoro',
    onclick: () => updateObject(object.id, { isRunning: false, lastTickAt: Date.now() })
  });
  const reset = el('button', 'small', {
    type: 'button',
    text: '↺',
    'aria-label': 'Reiniciar temporizador actual',
    onclick: () => updateObject(object.id, {
      remainingSeconds: getPomodoroModeSeconds(object.mode),
      isRunning: false,
      lastTickAt: Date.now()
    })
  });
  controls.append(play, pause, reset);

  shell.append(header, display, cycles, modes, controls);
  frame.append(shell);
  return frame;
}

function createClock() {
  window.clearInterval(clockTimer);
  const clock = el('aside', 'retro-clock', { 'aria-label': 'Reloj digital' });
  const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick();
  clockTimer = window.setInterval(tick, 1000);
  return clock;
}

function getObjectTitle(object) {
  if (object.type === 'notebook') return 'Libreta';
  if (object.type === 'todo') return 'To-Do';
  if (object.type === 'pomodoro') return 'Pomodoro';
  return 'Sticky Note';
}

function getObjectEmoji(object) {
  if (object.type === 'notebook') return '📓';
  if (object.type === 'todo') return '☑️';
  if (object.type === 'pomodoro') return '⏱️';
  return '🗒️';
}

function getObjectExcerpt(object) {
  if (object.type === 'notebook') return (object.pages || [''])[0] || 'Libreta sin texto';
  if (object.type === 'todo') {
    const tasks = object.tasks || [];
    if (!tasks.length) return 'Lista sin tareas';
    return tasks.map((task) => `${task.done ? '✓' : '•'} ${task.text}`).join(' · ');
  }
  if (object.type === 'pomodoro') return `${POMODORO_MODES[object.mode]?.label || 'Work'} · ${formatTimer(object.remainingSeconds)}`;
  return object.content || 'Nota sin texto';
}

function createTrashPreview(object) {
  const preview = el('article', `trash-preview ${object.type}`, { tabindex: '0', role: 'button', 'aria-label': `Restaurar ${getObjectTitle(object)} arrastrando al escritorio` });
  preview.dataset.objectId = object.id;
  preview.append(
    el('span', 'trash-preview-icon', { text: getObjectEmoji(object) }),
    el('strong', '', { text: getObjectTitle(object) }),
    el('p', '', { text: getObjectExcerpt(object) })
  );
  makeTrashPreviewDraggable(preview, object);
  return preview;
}

function makeTrashPreviewDraggable(preview, object) {
  let restoreDrag = null;

  const cleanup = () => {
    restoreDrag?.ghost.remove();
    restoreDrag = null;
    document.body.classList.remove('is-restoring-from-trash');
  };

  preview.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    preview.setPointerCapture?.(event.pointerId);
    const rect = preview.getBoundingClientRect();
    const ghost = preview.cloneNode(true);
    ghost.classList.add('trash-restore-ghost');
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.append(ghost);
    document.body.classList.add('is-restoring-from-trash');
    restoreDrag = {
      pointerId: event.pointerId,
      ghost,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
  });

  preview.addEventListener('pointermove', (event) => {
    if (!restoreDrag || restoreDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    restoreDrag.ghost.style.left = `${event.clientX - restoreDrag.offsetX}px`;
    restoreDrag.ghost.style.top = `${event.clientY - restoreDrag.offsetY}px`;
  });

  preview.addEventListener('pointerup', (event) => {
    if (!restoreDrag || restoreDrag.pointerId !== event.pointerId) return;
    preview.releasePointerCapture?.(event.pointerId);
    const desk = document.querySelector('.virtual-desk');
    const dialog = document.querySelector('.trash-dialog');
    const deskRect = desk?.getBoundingClientRect();
    const dialogRect = dialog?.getBoundingClientRect();
    const onDesk = deskRect && isPointInsideRect(event.clientX, event.clientY, deskRect);
    const outsideDialog = !dialogRect || !isPointInsideRect(event.clientX, event.clientY, dialogRect);
    const x = Math.max(8, event.clientX - restoreDrag.offsetX);
    const y = Math.max(8, event.clientY - restoreDrag.offsetY);
    cleanup();

    if (onDesk && outsideDialog) {
      updateObject(object.id, { status: 'active', x, y, restoredAt: Date.now() }, true);
      showToast('Objeto restaurado al escritorio');
      return;
    }

    showToast('Arrastra fuera de la ventana para restaurar');
  });

  preview.addEventListener('pointercancel', cleanup);
}

function createTrashCan() {
  const trashedCount = getTrashedObjects().length;
  const button = el('button', `trash-can ${trashedCount ? 'is-full' : 'is-empty'}`, {
    type: 'button',
    title: 'Abrir Papelera',
    'aria-label': `Papelera de reciclaje ${trashedCount ? `con ${trashedCount} objeto${trashedCount === 1 ? '' : 's'}` : 'vacía'}`,
    onclick: () => {
      trashDialogOpen = true;
      render();
    }
  });
  button.append(el('span', 'trash-lid'), el('span', 'trash-body'), el('span', 'trash-papers'));
  return button;
}

function createTrashDialog() {
  const overlay = el('section', 'trash-overlay', { 'aria-label': 'Contenido de la Papelera' });
  const dialog = el('div', 'trash-dialog', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'trash-title' });
  const header = el('header', 'trash-dialog-header');
  header.append(
    el('div', '', { html: '<h2 id="trash-title">Papelera de Reciclaje</h2><p>Arrastra cualquier elemento fuera de esta ventana y suéltalo en el escritorio para restaurarlo.</p>' }),
    el('button', 'trash-close', { type: 'button', text: '×', 'aria-label': 'Cerrar Papelera', onclick: () => { trashDialogOpen = false; render(); } })
  );

  const trashedObjects = getTrashedObjects();
  const content = el('div', `trash-grid ${trashedObjects.length ? '' : 'is-empty'}`);
  if (trashedObjects.length) {
    trashedObjects.forEach((object) => content.append(createTrashPreview(object)));
  } else {
    content.append(el('p', 'trash-empty-message', { text: 'La Papelera está vacía. Los objetos eliminados aparecerán aquí.' }));
  }

  dialog.append(header, content);
  overlay.append(dialog);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) {
      trashDialogOpen = false;
      render();
    }
  });
  return overlay;
}

function createCalendar() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: firstDay }, () => null).concat(Array.from({ length: daysInMonth }, (_, index) => index + 1));
  const calendar = el('aside', 'mini-calendar', { 'aria-label': 'Calendario mensual' });
  calendar.append(el('header', '', { text: today.toLocaleDateString('es', { month: 'long', year: 'numeric' }) }));
  const weekdays = el('div', 'calendar-grid weekdays');
  ['D', 'L', 'M', 'M', 'J', 'V', 'S'].forEach((day) => weekdays.append(el('span', '', { text: day })));
  const grid = el('div', 'calendar-grid');
  cells.forEach((day, index) => {
    const cell = el('span', !day ? 'empty' : day === today.getDate() ? 'today' : day < today.getDate() ? 'past' : '', { text: day || '' });
    if (day && day < today.getDate()) cell.append(el('em', '', { text: 'X' }));
    grid.append(cell);
  });
  calendar.append(weekdays, grid);
  return calendar;
}

function render() {
  root.replaceChildren();
  const main = el('main', 'virtual-desk');
  applyBackground(main);
  main.append(el('div', 'ambient-glow'), createDock(), createBackgroundPanel(), createTrashCan());

  const widgets = el('section', 'fixed-widgets');
  widgets.append(createClock(), createCalendar());
  main.append(widgets);

  const layer = el('section', 'object-layer', { 'aria-label': 'Objetos arrastrables del escritorio' });
  getActiveObjects().forEach((object) => {
    if (object.type === 'sticky') layer.append(createStickyNote(object));
    if (object.type === 'notebook') layer.append(createNotebook(object));
    if (object.type === 'todo') layer.append(createTodoList(object));
    if (object.type === 'pomodoro') layer.append(createPomodoroWidget(object));
  });
  main.append(layer);
  if (trashDialogOpen) main.append(createTrashDialog());
  main.append(el('div', 'toast', { role: 'status', hidden: true }));
  root.append(main);
  ensurePomodoroTicker();
}

render();
