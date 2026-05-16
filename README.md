# VirtualDesk

VirtualDesk es una aplicación frontend de escritorio virtual construida con HTML, CSS y JavaScript vanilla. Incluye un fondo configurable, dock lateral, objetos arrastrables persistentes, notas adhesivas, libretas, listas de tareas, reloj retro y calendario mensual.

## Requisitos

- Node.js 18 o superior.
- npm.

## Instalación

```bash
npm install
```

## Ejecutar en desarrollo

```bash
npm run dev
```

Abre http://localhost:5173/ para usar la aplicación.

## Crear build de producción

```bash
npm run build
```


## Persistencia

La aplicación guarda automáticamente el estado completo del escritorio en `localStorage` usando la clave `virtualDeskState`. El estado incluye:

- Fondo actual por color o URL de imagen.
- Tipo de cada objeto del escritorio.
- Posición `x/y` de notas, libretas y listas de tareas.
- Contenido de Sticky Notes.
- Páginas, página activa y estado abierto/cerrado de Notebook.
- Tareas y estado completado de To-Do List.

Para reiniciar el escritorio, borra esa clave desde las herramientas de desarrollador del navegador o ejecuta:

```js
localStorage.removeItem('virtualDeskState')
```
