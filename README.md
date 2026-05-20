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


## Persistencia en la nube (Firebase)

La aplicación guarda el estado del escritorio **solo en la nube** usando Firebase + Firestore (sin guardado local en `localStorage`).

- Al iniciar sesión con Google, se restaura el estado del usuario desde Firestore si ya existe.
- Si es la primera vez del usuario, se crea el documento con el estado inicial.
- Se guardan fondo, texto, posición de widgets/objetos y todas las acciones persistidas del escritorio dentro de `state`.

Colección usada en Firestore:

- `users/{uid}/desk/state`
