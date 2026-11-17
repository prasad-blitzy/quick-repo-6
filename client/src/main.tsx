/**
 * The browser entry point: the one place the application is mounted, and the one place the
 * stylesheet is loaded.
 *
 * The mount point is looked up and checked rather than asserted with `!`, because a host page that
 * shipped without it would otherwise fail inside React with a null root instead of naming the
 * element it could not find. `StrictMode` is on: the surfaces it renders are written to tolerate a
 * repeated effect (the history and analysis reads compare a generation number), and the double
 * invocation is what surfaces a side effect that is supposed to be safe being unsafe.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles.css';

const MOUNT_ELEMENT_ID = 'root';

const mountElement = document.getElementById(MOUNT_ELEMENT_ID);

if (mountElement === null) {
  throw new Error(`The page holds no #${MOUNT_ELEMENT_ID} element for the application to mount on.`);
}

createRoot(mountElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
