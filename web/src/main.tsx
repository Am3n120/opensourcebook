import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
// Shared styles first, so a screen's own CSS can refine them.
import "./design/index.css";
import { App } from "./App";
import { ApiProvider } from "./app/api";
import { OpenGate } from "./app/OpenGate";
import { carryOldStorage } from "./app/oldStorage";
import { DueReminders } from "./app/reminders";
import { applyTheme, followSystem } from "./design/theme";
import "./make/register";
import "./plan/register";

// What this browser kept under the old name, before anything reads it.
carryOldStorage();
applyTheme();
followSystem();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <OpenGate>
      <BrowserRouter>
        <ApiProvider>
          <DueReminders />
          <App />
        </ApiProvider>
      </BrowserRouter>
    </OpenGate>
  </StrictMode>,
);
