import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js';
import { browserLocalPersistence, getAuth, GoogleAuthProvider, onAuthStateChanged, setPersistence, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const inputSelector = 'textarea, input, button, select, [contenteditable="true"], [data-no-drag]';
const NOTEBOOK_OPEN_CLICK_MAX_MS = 180;
const NOTEBOOK_DRAG_MOVE_THRESHOLD = 6;

const NOTEBOOK_ROTATION_LIMIT = 45;
const NOTEBOOK_MIN_SCALE = 0.65;
const NOTEBOOK_DEFAULT_DIMENSIONS = { width: 210, height: 270 };
const TODO_DEFAULT_WIDTH = 270;
const TODO_MIN_WIDTH = 220;

const POMODORO_MODES = {
  work: { label: 'Work', minutes: 25, seconds: 25 * 60 },
  shortBreak: { label: 'Short Break', minutes: 5, seconds: 5 * 60 },
  longBreak: { label: 'Long Break', minutes: 15, seconds: 15 * 60 }
};

const FOCUS_STATIONS = {
  lofi: {
    label: 'Lo-fi / Deep Focus',
    tracks: [
      { title: 'Lo-fi Deep Focus — demo placeholder 01', url: '' },
      { title: 'Lo-fi Deep Focus — demo placeholder 02', url: '' }
    ]
  },
  edm: {
    label: 'EDM',
    tracks: [
      { title: 'EDM Focus Drive — demo placeholder 01', url: '' },
      { title: 'EDM Focus Drive — demo placeholder 02', url: '' }
    ]
  },
  classical: {
    label: 'Clásica Instrumental',
    tracks: [
      { title: 'Clásica Instrumental — demo placeholder 01', url: '' },
      { title: 'Clásica Instrumental — demo placeholder 02', url: '' }
    ]
  }
};

const DEFAULT_FOCUS_STATION = 'lofi';

const makeId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let root = null;
let toastTimer = null;
let pendingToastMessage = '';
let clockTimer = null;
let pomodoroTimer = null;
let pomodoroAudioContext = null;
let trashDialogOpen = false;
let pendingFocusAutoplayId = null;
let cloudSaveTimer = null;

const firebaseConfig = {
  apiKey: 'AIzaSyBWEd7-QyMFKoovtdyWHICymP8-9KH2Djk',
  authDomain: 'virtual-desk-2e8a1.firebaseapp.com',
  projectId: 'virtual-desk-2e8a1',
  storageBucket: 'virtual-desk-2e8a1.firebasestorage.app',
  messagingSenderId: '1075800179675',
  appId: '1:1075800179675:web:b0da4b2463f0055feb9dfe',
  measurementId: 'G-YMM74MBCGW'
};

const firebaseApp = initializeApp(firebaseConfig);
if (typeof window !== 'undefined') getAnalytics(firebaseApp);
const firebaseAuth = getAuth(firebaseApp);
const firestoreDb = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();
let currentUser = null;
let cloudSyncStatus = 'signed-out';

const defaultState = {
  background: { mode: 'color', value: '#5e789a' },
  objects: [
    {
      id: 'welcome-notebook',
      type: 'notebook',
      name: 'Notebook',
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
      notebookWidth: NOTEBOOK_DEFAULT_DIMENSIONS.width,
      notebookHeight: NOTEBOOK_DEFAULT_DIMENSIONS.height
    }
  ]
};

let state = structuredClone(defaultState);

function normalizeObject(object) {
  const baseObject = { status: 'active', ...object };
  if (baseObject?.type === 'pomodoro') return normalizePomodoro(baseObject);
  if (baseObject?.type === 'focusPlayer') return normalizeFocusPlayer(baseObject);
  if (baseObject?.type === 'todo') {
    return {
      ...baseObject,
      todoWidth: Math.max(TODO_MIN_WIDTH, Number(baseObject.todoWidth) || TODO_DEFAULT_WIDTH)
    };
  }
  if (baseObject?.type !== 'notebook') return baseObject;

  const legacyScale = Math.max(NOTEBOOK_MIN_SCALE, Number(baseObject.notebookScale) || 1);
  const legacyBase = baseObject.open ? { width: 460, height: 430 } : NOTEBOOK_DEFAULT_DIMENSIONS;
  const notebookWidth = Math.max(NOTEBOOK_DEFAULT_DIMENSIONS.width * NOTEBOOK_MIN_SCALE, Number(baseObject.notebookWidth) || legacyBase.width * legacyScale);
  const notebookHeight = Math.max(NOTEBOOK_DEFAULT_DIMENSIONS.height * NOTEBOOK_MIN_SCALE, Number(baseObject.notebookHeight) || legacyBase.height * legacyScale);

  return {
    rotation: 0,
    ...baseObject,
    rotation: clampNotebookRotation(baseObject.rotation),
    notebookWidth,
    notebookHeight
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

function removeUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, itemValue]) => itemValue !== undefined)
        .map(([key, itemValue]) => [key, removeUndefinedDeep(itemValue)])
    );
  }

  return value;
}


function persist() {
  scheduleCloudSave();
}

function getUserStateRef(uid) {
  return doc(firestoreDb, 'users', uid, 'desk', 'state');
}

function scheduleCloudSave() {
  if (!currentUser) return;

  window.clearTimeout(cloudSaveTimer);
  cloudSyncStatus = 'saving';
  updateCloudSyncIndicatorOnly();

  cloudSaveTimer = window.setTimeout(async () => {
    if (!currentUser) return;

    try {
      const cleanState = removeUndefinedDeep(state);
      await setDoc(getUserStateRef(currentUser.uid), {
        state: cleanState,
        updatedAt: serverTimestamp(),
        uid: currentUser.uid,
        email: currentUser.email || null
      }, { merge: true });

      cloudSyncStatus = 'saved';
      updateCloudSyncIndicatorOnly();
    } catch (error) {
      console.error('Firestore save failed:', error);
      cloudSyncStatus = 'error';
      updateCloudSyncIndicatorOnly();
      showToast('Error al guardar en Firebase. Verifica permisos o conexión.');
    }
  }, 350);
}

async function loadCloudState(uid) {
  try {
    const snapshot = await getDoc(getUserStateRef(uid));
    if (!snapshot.exists()) return false;
    const data = snapshot.data();
    if (!data?.state) return false;
    state = normalizeState(data.state);
    cloudSyncStatus = 'saved';
    return true;
  } catch (error) {
    console.error('Firestore load failed:', error);
    cloudSyncStatus = 'error';
    showToast('Error al cargar estado desde Firebase.');
    return false;
  }
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
  if (!toast) {
    pendingToastMessage = message;
    return;
  }
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
    ['notebook-icon', '📓', 'Crear libreta', () => addObject({ id: makeId('notebook'), type: 'notebook', name: 'Notebook', status: 'active', ...placeObject(18), open: false, activePage: 0, pages: [''], flipDirection: 'next', rotation: 0, notebookWidth: NOTEBOOK_DEFAULT_DIMENSIONS.width, notebookHeight: NOTEBOOK_DEFAULT_DIMENSIONS.height })],
    ['sticky-icon', '🗒️', 'Crear nota adhesiva', () => addObject({ id: makeId('note'), type: 'sticky', status: 'active', ...placeObject(42), content: '' })],
    ['todo-icon', '☑️', 'Crear lista de tareas', () => addObject({ id: makeId('todo'), type: 'todo', name: 'Today', status: 'active', ...placeObject(76), tasks: [], todoWidth: TODO_DEFAULT_WIDTH })],
    ['pomodoro-icon', '⏱️', 'Crear timer Pomodoro', () => addObject(createPomodoroObject(placeObject(108)))],
    ['focus-player-icon', '🎧', 'Crear reproductor Focus Player', () => addObject(createFocusPlayerObject(placeObject(142)))],
    ['settings-icon', '⚙️', 'Configuración', () => showToast('Configuración: Coming Soon')]
  ];

  buttons.forEach(([className, icon, label, handler]) => {
    const button = el('button', `dock-button ${className}`, { title: label, 'aria-label': label, onClick: handler });
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

function createFocusPlayerObject(position = placeObject(142)) {
  return {
    id: makeId('focus-player'),
    type: 'focusPlayer',
    status: 'active',
    ...position,
    station: DEFAULT_FOCUS_STATION,
    trackIndex: 0,
    volume: 0.65
  };
}

function getFocusStation(station = DEFAULT_FOCUS_STATION) {
  return FOCUS_STATIONS[station] ? station : DEFAULT_FOCUS_STATION;
}

function getFocusTracks(station = DEFAULT_FOCUS_STATION) {
  return FOCUS_STATIONS[getFocusStation(station)].tracks;
}

function normalizeFocusPlayer(object) {
  const station = getFocusStation(object.station);
  const tracks = getFocusTracks(station);
  const trackIndex = tracks.length ? clamp(Math.floor(Number(object.trackIndex) || 0), 0, tracks.length - 1) : 0;
  const volume = clamp(Number.isFinite(Number(object.volume)) ? Number(object.volume) : 0.65, 0, 1);
  return {
    ...object,
    station,
    trackIndex,
    volume
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

function getNotebookDimensions(object) {
  const width = Number(object.notebookWidth) || NOTEBOOK_DEFAULT_DIMENSIONS.width;
  const height = Number(object.notebookHeight) || NOTEBOOK_DEFAULT_DIMENSIONS.height;
  const scale = width / NOTEBOOK_DEFAULT_DIMENSIONS.width;
  return { width, height, scale };
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
    const latestObject = getObjectById(object.id, object);
    const patch = {
      status: 'trashed',
      trashedAt: Date.now()
    };
    if (latestObject.type === 'notebook') {
      patch.open = false;
    }
    updateObject(latestObject.id, patch, true);
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
    const latestObject = getObjectById(object.id, object);
    const droppedOnTrash = wasDragging && latestObject.status !== 'trashed' && isPointOverTrash(event.clientX, event.clientY);
    drag = null;
    frame.classList.remove('is-dragging');
    frame.style.zIndex = '';

    if (droppedOnTrash) {
      trashObjectWithAnimation(frame, latestObject, event);
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

function applyNotebookFrameSize(frame, object) {
  const { width, height, scale } = getNotebookDimensions(object);
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.setProperty('--notebook-width', `${width}px`);
  frame.style.setProperty('--notebook-height', `${height}px`);
  frame.style.setProperty('--notebook-scale', scale);
}

function fitNotebookDimensionsToViewport(object, requestedWidth, requestedHeight) {
  const current = getObjectById(object.id, object);
  const minWidth = NOTEBOOK_DEFAULT_DIMENSIONS.width * NOTEBOOK_MIN_SCALE;
  const minHeight = NOTEBOOK_DEFAULT_DIMENSIONS.height * NOTEBOOK_MIN_SCALE;
  const width = Math.max(minWidth, Number(requestedWidth) || NOTEBOOK_DEFAULT_DIMENSIONS.width);
  const height = Math.max(minHeight, Number(requestedHeight) || NOTEBOOK_DEFAULT_DIMENSIONS.height);
  const radians = Math.abs(clampNotebookRotation(current.rotation)) * Math.PI / 180;
  const rotatedWidth = width * Math.cos(radians) + height * Math.sin(radians);
  const rotatedHeight = width * Math.sin(radians) + height * Math.cos(radians);
  const rightLimit = (window.innerWidth - current.x - 8) * 2 / (width + rotatedWidth);
  const bottomLimit = (window.innerHeight - current.y - 8) * 2 / (height + rotatedHeight);
  const leftLimit = rotatedWidth > width ? Math.max(0, (current.x - 8) * 2 / (rotatedWidth - width)) : Infinity;
  const topLimit = rotatedHeight > height ? Math.max(0, (current.y - 8) * 2 / (rotatedHeight - height)) : Infinity;
  const viewportScale = clamp(Math.min(rightLimit, bottomLimit, leftLimit, topLimit), 0, 1);
  return {
    notebookWidth: Math.max(minWidth, width * viewportScale),
    notebookHeight: Math.max(minHeight, height * viewportScale)
  };
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
    const requestedWidth = resize.startWidth + aspectDelta;
    const requestedHeight = resize.startHeight + aspectDelta / resize.aspect;
    const current = getObjectById(object.id, object);
    const dimensions = fitNotebookDimensionsToViewport(current, requestedWidth, requestedHeight);
    applyNotebookFrameSize(frame, { ...current, ...dimensions });
    updateObject(object.id, dimensions, false);
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
    const { width, height } = getNotebookDimensions(current);
    resize = { startX: point.clientX, startY: point.clientY, startWidth: width, startHeight: height, aspect: width / height };
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

function getNotebookName(object) {
  return (object.name || 'Notebook').trim() || 'Notebook';
}

function getTodoPadName(object) {
  return (object.name || 'Today').trim() || 'Today';
}

function enableNotebookRename({ trigger, object, getLabel, onCancel }) {
  const currentName = getNotebookName(getObjectById(object.id, object));
  const input = el('input', 'notebook-name-input', { type: 'text', value: currentName, 'aria-label': 'Nombre de libreta', 'data-no-drag': true });
  let canceled = false;
  let committed = false;

  const commit = () => {
    if (committed || canceled) return;
    committed = true;
    const nextName = input.value.trim();
    if (nextName && nextName !== currentName) updateObject(object.id, { name: nextName });
    else render();
  };

  const cancel = () => {
    if (committed || canceled) return;
    canceled = true;
    onCancel(currentName);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', commit);

  trigger.replaceWith(input);
  input.focus();
  input.select();
  if (typeof getLabel === 'function') getLabel(input);
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
  applyNotebookFrameSize(frame, object);
  addNotebookRotation(frame, object);
  addNotebookResize(frame, object);
  if (!object.open) {
    const cover = el('div', 'notebook-cover', { role: 'button', tabindex: '0', 'aria-label': 'Abrir libreta' });
    cover.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      updateObject(object.id, { open: true });
    });
    const title = el('span', 'cover-title', { text: getNotebookName(object), 'data-no-drag': true });
    title.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      enableNotebookRename({
        trigger: title,
        object,
        onCancel: (name) => {
          title.textContent = name;
          render();
        }
      });
    });
    cover.append(el('span', 'spiral'), title, el('span', 'cover-subtitle', { text: 'click to open' }));
    frame.append(cover);
    return frame;
  }

  const wrap = el('div', 'notebook-open');
  const toolbar = el('header', 'notebook-toolbar notebook-drag-zone', { title: 'Arrastra desde este margen superior para mover la libreta' });
  const close = el('button', '', { text: 'Cerrar', onClick: () => updateObject(object.id, { open: false }) });
  const title = el('strong', 'notebook-name', { text: getNotebookName(object), 'data-no-drag': true });
  title.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    enableNotebookRename({
      trigger: title,
      object,
      onCancel: (name) => {
        title.textContent = name;
        render();
      }
    });
  });
  toolbar.append(close, title, el('span', '', { text: `Página ${(object.activePage || 0) + 1} / ${(object.pages || ['']).length}` }));

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
  const next = el('button', '', { text: 'Siguiente →', onClick: () => turnNotebookPage(object.id, 'next') });
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
  const title = el('span', 'todo-pad-title', { text: getTodoPadName(object), 'data-no-drag': true });
  title.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    enableNotebookRename({
      trigger: title,
      object: { ...object, name: getTodoPadName(object) },
      getLabel: (input) => {
        input.classList.remove('notebook-name-input');
        input.classList.add('todo-pad-title-input');
        input.setAttribute('aria-label', 'Nombre de lista de tareas');
      },
      onCancel: () => render()
    });
  });
  header.append(title, el('small', '', { text: `${tasks.filter((task) => task.done).length}/${tasks.length}` }));

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
    const text = el('textarea', 'todo-task-text', { 'aria-label': 'Editar tarea', rows: '1' });
    text.value = task.text;
    const resizeTaskInput = () => {
      text.style.height = 'auto';
      text.style.height = `${text.scrollHeight}px`;
    };
    resizeTaskInput();
    text.addEventListener('input', (event) => {
      resizeTaskInput();
      updateObject(object.id, { tasks: tasks.map((item) => item.id === task.id ? { ...item, text: event.target.value } : item) }, false);
    });
    label.append(checkbox, text);
    list.append(label);
  });

  frame.style.setProperty('--todo-width', `${Math.max(TODO_MIN_WIDTH, Number(object.todoWidth) || TODO_DEFAULT_WIDTH)}px`);
  addTodoResize(frame, object);
  frame.append(header, form, list);
  return frame;
}

function fitTodoWidthToViewport(object, requestedWidth) {
  const current = getObjectById(object.id, object);
  const maxWidth = Math.max(TODO_MIN_WIDTH, window.innerWidth - current.x - 8);
  return clamp(requestedWidth, TODO_MIN_WIDTH, maxWidth);
}

function applyTodoFrameWidth(frame, width) {
  frame.style.setProperty('--todo-width', `${width}px`);
}

function addTodoResize(frame, object) {
  const sides = ['left', 'right'];
  let resize = null;

  const move = (event) => {
    if (!resize) return;
    event.preventDefault();
    const point = getEventPoint(event);
    const dx = point.clientX - resize.startX;
    const requestedWidth = resize.side === 'right' ? resize.startWidth + dx : resize.startWidth - dx;
    const nextWidth = fitTodoWidthToViewport(object, requestedWidth);
    let nextX = resize.startXPos;

    if (resize.side === 'left') {
      const rightEdge = resize.startXPos + resize.startWidth;
      nextX = Math.max(8, rightEdge - nextWidth);
    }

    applyTodoFrameWidth(frame, nextWidth);
    setFrameTransform(frame, nextX, resize.startYPos);
    updateObject(object.id, { todoWidth: nextWidth, x: nextX }, false);
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

  const start = (side) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    bringToFront(object.id, false);
    const point = getEventPoint(event);
    const current = getObjectById(object.id, object);
    resize = {
      side,
      startX: point.clientX,
      startWidth: Math.max(TODO_MIN_WIDTH, Number(current.todoWidth) || TODO_DEFAULT_WIDTH),
      startXPos: current.x,
      startYPos: current.y
    };
    frame.classList.add('is-resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', stop);
    document.addEventListener('touchcancel', stop);
  };

  sides.forEach((side) => {
    const handle = el('span', `todo-resize-control ${side}`, { role: 'button', 'aria-label': `Redimensionar lista de tareas (${side})`, 'data-no-drag': true });
    handle.addEventListener('mousedown', start(side));
    handle.addEventListener('touchstart', start(side), { passive: false });
    frame.append(handle);
  });
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
      onClick: () => setPomodoroMode(object.id, mode)
    }));
  });

  const controls = el('div', 'pomodoro-controls');
  const play = el('button', 'primary', {
    type: 'button',
    text: '▶',
    'aria-label': 'Iniciar Pomodoro',
    onClick: () => {
      primePomodoroAudio();
      updateObject(object.id, { isRunning: true, lastTickAt: Date.now() });
    }
  });
  const pause = el('button', '', {
    type: 'button',
    text: 'Ⅱ',
    'aria-label': 'Pausar Pomodoro',
    onClick: () => updateObject(object.id, { isRunning: false, lastTickAt: Date.now() })
  });
  const reset = el('button', 'small', {
    type: 'button',
    text: '↺',
    'aria-label': 'Reiniciar temporizador actual',
    onClick: () => updateObject(object.id, {
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


function isFocusPlayerDragZone(event) {
  if (event.target.closest(inputSelector)) return false;
  if (event.target.closest('.focus-player-grip')) return true;

  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const edgeSize = 14;
  return x <= edgeSize || y <= edgeSize || x >= rect.width - edgeSize || y >= rect.height - edgeSize;
}

function getFocusTrack(object) {
  const tracks = getFocusTracks(object.station);
  return tracks[object.trackIndex] || tracks[0] || { title: 'Sin tracks configurados', url: '' };
}

function getNextFocusTrackIndex(object, direction = 1) {
  const tracks = getFocusTracks(object.station);
  if (!tracks.length) return 0;
  return (Number(object.trackIndex || 0) + direction + tracks.length) % tracks.length;
}

function updateFocusTimeDisplay(id, currentTime = 0, duration = 0) {
  const display = document.querySelector(`[data-focus-player-id="${id}"] .focus-player-time`);
  if (!display) return;
  display.textContent = `${formatTimer(currentTime)} / ${Number.isFinite(duration) && duration > 0 ? formatTimer(duration) : '--:--'}`;
}

function updateFocusPlaybackState(id, isPlaying) {
  const frame = document.querySelector(`[data-focus-player-id="${id}"]`);
  const playButton = frame?.querySelector('.focus-play-toggle');
  if (!frame || !playButton) return;
  frame.classList.toggle('is-playing', isPlaying);
  playButton.textContent = isPlaying ? 'Ⅱ' : '▶';
  playButton.setAttribute('aria-label', isPlaying ? 'Pausar música de enfoque' : 'Reproducir música de enfoque');
}

function updateFocusAudioSource(audio, object) {
  const track = getFocusTrack(object);
  audio.volume = object.volume;
  if (audio.dataset.src !== track.url) {
    audio.dataset.src = track.url;
    audio.src = track.url || '';
    audio.load();
  }
}

function playFocusAudio(audio, object) {
  const track = getFocusTrack(object);
  if (!track.url) {
    showToast('Focus Player listo: reemplaza las URLs demo por tus audios.');
    updateFocusPlaybackState(object.id, false);
    return;
  }

  audio.play()
    .then(() => updateFocusPlaybackState(object.id, true))
    .catch(() => {
      updateFocusPlaybackState(object.id, false);
      showToast('El navegador bloqueó el audio. Pulsa Play otra vez.');
    });
}

function moveFocusTrack(object, direction, shouldAutoplay = false) {
  pendingFocusAutoplayId = shouldAutoplay ? object.id : null;
  updateObject(object.id, { trackIndex: getNextFocusTrackIndex(object, direction) });
}

function createFocusPlayerWidget(object) {
  const frame = createFrame(object, 'focus-player-widget', { canStart: isFocusPlayerDragZone });
  frame.dataset.focusPlayerId = object.id;

  const stationMeta = FOCUS_STATIONS[getFocusStation(object.station)];
  const track = getFocusTrack(object);
  const shell = el('div', 'focus-player-shell');
  const header = el('header', 'focus-player-grip', { title: 'Arrastra desde la barra o los bordes' });
  header.append(el('span', 'focus-player-led'), el('strong', '', { text: 'Focus Player' }), el('span', '', { text: stationMeta.label }));

  const stationRow = el('div', 'focus-stations', { 'aria-label': 'Seleccionar estación de música' });
  Object.entries(FOCUS_STATIONS).forEach(([station, meta]) => {
    const button = el('button', object.station === station ? 'is-active' : '', {
      type: 'button',
      text: meta.label,
      'aria-pressed': object.station === station ? 'true' : 'false',
      onClick: () => updateObject(object.id, { station, trackIndex: 0 })
    });
    stationRow.append(button);
  });

  const display = el('div', 'focus-player-display');
  const marquee = el('div', 'focus-track-marquee');
  marquee.append(el('span', '', { text: track.title || 'Sin título' }));
  display.append(marquee, el('div', 'focus-player-time', { text: '00:00 / --:--', 'aria-live': 'polite' }));

  const audio = el('audio', '', { preload: 'metadata' });
  updateFocusAudioSource(audio, object);
  audio.addEventListener('loadedmetadata', () => updateFocusTimeDisplay(object.id, audio.currentTime, audio.duration));
  audio.addEventListener('timeupdate', () => updateFocusTimeDisplay(object.id, audio.currentTime, audio.duration));
  audio.addEventListener('play', () => updateFocusPlaybackState(object.id, true));
  audio.addEventListener('pause', () => updateFocusPlaybackState(object.id, false));
  audio.addEventListener('ended', () => moveFocusTrack(getObjectById(object.id, object), 1, true));
  audio.addEventListener('error', () => {
    updateFocusPlaybackState(object.id, false);
    if (audio.currentSrc) showToast('No se pudo cargar esta pista de Focus Player.');
  });

  const controls = el('div', 'focus-player-controls');
  controls.append(
    el('button', '', { type: 'button', text: '⏮', 'aria-label': 'Pista anterior', onClick: () => moveFocusTrack(getObjectById(object.id, object), -1, !audio.paused) }),
    el('button', 'focus-play-toggle primary', {
      type: 'button',
      text: '▶',
      'aria-label': 'Reproducir música de enfoque',
      onClick: () => {
        if (audio.paused) playFocusAudio(audio, getObjectById(object.id, object));
        else audio.pause();
      }
    }),
    el('button', '', { type: 'button', text: '⏭', 'aria-label': 'Siguiente pista', onClick: () => moveFocusTrack(getObjectById(object.id, object), 1, !audio.paused) })
  );

  const volumeLabel = el('label', 'focus-volume');
  const volume = el('input', '', { type: 'range', min: '0', max: '1', step: '0.01', value: object.volume, 'aria-label': 'Volumen del Focus Player' });
  volume.addEventListener('input', (event) => {
    const nextVolume = Number(event.target.value);
    audio.volume = nextVolume;
    updateObject(object.id, { volume: nextVolume }, false);
  });
  volumeLabel.append(el('span', '', { text: 'Vol' }), volume);

  shell.append(header, stationRow, display, controls, volumeLabel, audio);
  frame.append(shell);

  window.requestAnimationFrame(() => {
    updateFocusTimeDisplay(object.id, audio.currentTime, audio.duration);
    if (pendingFocusAutoplayId === object.id) {
      pendingFocusAutoplayId = null;
      playFocusAudio(audio, object);
    }
  });

  return frame;
}


function updateCloudSyncIndicatorOnly() {
  const indicator = document.querySelector('.local-mode-indicator');
  if (!indicator) return;

  const copyByStatus = {
    'signed-out': {
      title: 'Cloud Sync OFF',
      subtitle: 'Inicia sesión para sincronizar en la nube'
    },
    saving: {
      title: 'Cloud Sync...',
      subtitle: 'Guardando cambios en Firebase'
    },
    saved: {
      title: 'Cloud Sync ON',
      subtitle: 'Guardado en Firebase'
    },
    error: {
      title: 'Cloud Sync Error',
      subtitle: 'No se pudo guardar/cargar en Firebase'
    }
  };

  const statusCopy = copyByStatus[cloudSyncStatus] || copyByStatus['signed-out'];
  const strong = indicator.querySelector('strong');
  const small = indicator.querySelector('small');

  if (strong) strong.textContent = statusCopy.title;
  if (small) small.textContent = statusCopy.subtitle;
}

function createLocalModeIndicator() {
  const indicator = el('aside', 'local-mode-indicator', {
    'aria-live': 'polite',
    'aria-label': 'Cloud sync status'
  });
  const copy = el('div');
  const copyByStatus = {
    'signed-out': { title: 'Cloud Sync OFF', subtitle: 'Inicia sesión para sincronizar en la nube' },
    saving: { title: 'Cloud Sync...', subtitle: 'Guardando cambios en Firebase' },
    saved: { title: 'Cloud Sync ON', subtitle: 'Guardado en Firebase' },
    error: { title: 'Cloud Sync Error', subtitle: 'No se pudo guardar/cargar en Firebase' }
  };
  const statusCopy = copyByStatus[cloudSyncStatus] || copyByStatus['signed-out'];
  copy.append(el('strong', '', { text: statusCopy.title }), el('small', '', { text: statusCopy.subtitle }));
  indicator.append(el('span', 'local-mode-dot', { 'aria-hidden': 'true' }), copy);
  return indicator;
}

function createAuthPanel() {
  const panel = el('aside', 'auth-panel', { 'aria-label': 'Estado de sesión' });
  const copy = el('div', 'auth-copy');
  if (currentUser) {
    copy.append(el('strong', '', { text: 'Google conectado' }), el('small', '', { text: currentUser.email || 'Usuario autenticado' }));
  } else {
    copy.append(el('strong', '', { text: 'Sin sesión' }), el('small', '', { text: 'Inicia sesión para guardar en la nube' }));
  }

  const action = el('button', 'auth-action', {
    type: 'button',
    text: currentUser ? 'Cerrar sesión' : 'Log in con Google',
    onClick: async () => {
      try {
        if (currentUser) {
          await signOut(firebaseAuth);
          cloudSyncStatus = 'signed-out';
          showToast('Sesión cerrada. El guardado en nube está desactivado.');
        } else {
          await setPersistence(firebaseAuth, browserLocalPersistence);
          await signInWithPopup(firebaseAuth, googleProvider);
          showToast('Sesión iniciada con Google.');
        }
      } catch (error) {
        console.error('Google auth failed:', error);
        showToast('No se pudo completar el login con Google.');
      }
    }
  });
  panel.append(copy, action);
  return panel;
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
  if (object.type === 'focusPlayer') return 'Focus Player';
  return 'Sticky Note';
}

function getObjectEmoji(object) {
  if (object.type === 'notebook') return '📓';
  if (object.type === 'todo') return '☑️';
  if (object.type === 'pomodoro') return '⏱️';
  if (object.type === 'focusPlayer') return '🎧';
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
  if (object.type === 'focusPlayer') return `${FOCUS_STATIONS[getFocusStation(object.station)].label} · ${getFocusTrack(object).title}`;
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
    onClick: () => {
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
    el('button', 'trash-close', { type: 'button', text: '×', 'aria-label': 'Cerrar Papelera', onClick: () => { trashDialogOpen = false; render(); } })
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
  if (!root) return;
  root.replaceChildren();
  const main = el('main', 'virtual-desk');
  applyBackground(main);
  main.append(el('div', 'ambient-glow'), createDock(), createBackgroundPanel(), createTrashCan());

  const widgets = el('section', 'fixed-widgets');
  widgets.append(createAuthPanel(), createLocalModeIndicator(), createClock(), createCalendar());
  main.append(widgets);

  const layer = el('section', 'object-layer', { 'aria-label': 'Objetos arrastrables del escritorio' });
  getActiveObjects().forEach((object) => {
    if (object.type === 'sticky') layer.append(createStickyNote(object));
    if (object.type === 'notebook') layer.append(createNotebook(object));
    if (object.type === 'todo') layer.append(createTodoList(object));
    if (object.type === 'pomodoro') layer.append(createPomodoroWidget(object));
    if (object.type === 'focusPlayer') layer.append(createFocusPlayerWidget(object));
  });
  main.append(layer);
  if (trashDialogOpen) main.append(createTrashDialog());
  main.append(el('div', 'toast', { role: 'status', hidden: true }));
  root.append(main);
  ensurePomodoroTicker();
  if (pendingToastMessage) {
    const message = pendingToastMessage;
    pendingToastMessage = '';
    showToast(message);
  }
}

function bootVirtualDesk() {
  root = document.getElementById('root');
  if (!root) return;

  render();

  onAuthStateChanged(firebaseAuth, async (user) => {
    currentUser = user || null;
    cloudSyncStatus = currentUser ? 'saving' : 'signed-out';
    render();
    if (currentUser) {
      const restored = await loadCloudState(currentUser.uid);
      if (restored) showToast('Estado restaurado desde Firebase.');
      else {
        cloudSyncStatus = cloudSyncStatus === 'error' ? 'error' : 'saving';
        persist();
      }
    }
    render();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootVirtualDesk, { once: true });
} else {
  bootVirtualDesk();
}
