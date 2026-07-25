import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { initPrefs } from "./lib/prefs.js";
import { setPollRate } from "./lib/usePolled.js";
import "./styles.css";

// Before the first render: the stored theme paints immediately, and the polling
// layer starts at the user's chosen rate rather than ramping down after mount.
initPrefs(setPollRate);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
