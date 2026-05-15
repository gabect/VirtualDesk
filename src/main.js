const STORAGE_KEY = 'virtualDeskState';
const inputSelector = 'textarea, input, button, select, [contenteditable="true"]';

const makeId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const root = document.getElementById('root');
let saveTimer = null;
let toastTimer = null;
let clockTimer = null;

const defaultState = {
  background: { mode: 'color', value: '#5e789a' },
  objects: [
    {
      id: 'welcome-notebook',
      type: 'notebook',
      x: 170,
      y: 92,
      open: false,
      activePage: 0,
      pages: [
        'Bienvenido a VirtualDesk. Haz clic en la libreta para abrirla y escribe tus ideas.',
        'Usa las flechas para cambiar de página. Todo se guarda automáticamente.'
      ],
      flipDirection: 'next'
    }
  ]
};

let state = loadState();

function normalizeState(value) {
  return {
    ...defaultState,
    ...value,
    background: { ...defaultState.background, ...(value?.background || {}) },
    objects: Array.isArray(value?.objects) ? value.objects : defaultState.objects
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
    ['notebook-icon', '📓', 'Crear libreta', () => addObject({ id: makeId('notebook'), type: 'notebook', ...placeObject(18), open: false, activePage: 0, pages: [''], flipDirection: 'next' })],
    ['sticky-icon', '🗒️', 'Crear nota adhesiva', () => addObject({ id: makeId('note'), type: 'sticky', ...placeObject(42), content: '' })],
    ['todo-icon', '☑️', 'Crear lista de tareas', () => addObject({ id: makeId('todo'), type: 'todo', ...placeObject(76), tasks: [] })],
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

function makeDraggable(frame, object) {
  let drag = null;
  frame.addEventListener('pointerdown', (event) => {
    bringToFront(object.id, false);
    frame.style.zIndex = 1000;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest(inputSelector)) return;
    frame.setPointerCapture?.(event.pointerId);
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: object.x, originY: object.y };
    frame.classList.add('is-dragging');
  });
  frame.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = Math.max(8, drag.originX + event.clientX - drag.startX);
    const y = Math.max(8, drag.originY + event.clientY - drag.startY);
    frame.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    updateObject(object.id, { x, y }, false);
  });
  const stop = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    frame.releasePointerCapture?.(event.pointerId);
    drag = null;
    frame.classList.remove('is-dragging');
    frame.style.zIndex = '';
    persist();
  };
  frame.addEventListener('pointerup', stop);
  frame.addEventListener('pointercancel', stop);
}

function createFrame(object, className) {
  const frame = el('article', `desk-object ${className}`);
  frame.style.transform = `translate3d(${object.x}px, ${object.y}px, 0)`;
  makeDraggable(frame, object);
  return frame;
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
  const frame = createFrame(object, `notebook ${object.open ? 'open' : 'closed'}`);
  if (!object.open) {
    const cover = el('button', 'notebook-cover', { 'aria-label': 'Abrir libreta' });
    cover.addEventListener('click', () => updateObject(object.id, { open: true }));
    cover.append(el('span', 'spiral'), el('span', 'cover-title', { text: 'Notebook' }), el('span', 'cover-subtitle', { text: 'click to open' }));
    frame.append(cover);
    return frame;
  }

  const wrap = el('div', 'notebook-open');
  const toolbar = el('header', 'notebook-toolbar');
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

function createClock() {
  window.clearInterval(clockTimer);
  const clock = el('aside', 'retro-clock', { 'aria-label': 'Reloj digital' });
  const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick();
  clockTimer = window.setInterval(tick, 1000);
  return clock;
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
  main.append(el('div', 'ambient-glow'), createDock(), createBackgroundPanel());

  const widgets = el('section', 'fixed-widgets');
  widgets.append(createClock(), createCalendar());
  main.append(widgets);

  const layer = el('section', 'object-layer', { 'aria-label': 'Objetos arrastrables del escritorio' });
  state.objects.forEach((object) => {
    if (object.type === 'sticky') layer.append(createStickyNote(object));
    if (object.type === 'notebook') layer.append(createNotebook(object));
    if (object.type === 'todo') layer.append(createTodoList(object));
  });
  main.append(layer, el('div', 'toast', { role: 'status', hidden: true }));
  root.append(main);
}

render();
