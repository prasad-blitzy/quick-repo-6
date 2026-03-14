/**
 * entrypoints/popup/main.tsx — Popup Bootstrap Entry Point
 *
 * Minimal bootstrap file that mounts the Preact <App /> component into the
 * #app DOM element defined in index.html. This is the JavaScript entry point
 * loaded via <script type="module" src="./main.tsx"> in the popup HTML shell.
 *
 * Responsibilities:
 *   - Import Preact's render function
 *   - Import the root App component
 *   - Mount <App /> into the #app container
 *
 * Per AAP Section 0.5.1 Group 2: "Popup entry point — Preact render bootstrap"
 * Per AAP Section 0.7.5: Preact 10.29.0 only — no React or ReactDOM imports.
 */

import { render } from 'preact';
import { App } from './App';

/**
 * Mount the popup application.
 *
 * The non-null assertion (!) is safe here because the popup's index.html
 * always contains <div id="app"></div> — this markup is controlled by us
 * and guaranteed to be present when this module executes.
 */
render(<App />, document.getElementById('app')!);
