/**
 * The modules Admin shares with extensions (ADR-lite 1376). Admin's import map points `react`, `react/jsx-runtime`,
 * `react-dom` and `react-dom/client` at small modules that re-export these, so an extension renders with Admin's own
 * React instead of a second copy. The kit and the extension helper are real modules beside them.
 */
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";

export const SHARED_GLOBAL = "__MANTLE_ADMIN_SHARED__";

export function installExtensionShared(): void {
  Object.defineProperty(globalThis, SHARED_GLOBAL, {
    value: Object.freeze({ react: React, "react/jsx-runtime": JsxRuntime, "react-dom": ReactDOM, "react-dom/client": ReactDOMClient }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
