import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fraunces/latin-500.css";
import "@fontsource/ibm-plex-sans/cyrillic-400.css";
import "@fontsource/ibm-plex-sans/cyrillic-500.css";
import "@fontsource/ibm-plex-sans/cyrillic-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-ext-400.css";
import "@fontsource/ibm-plex-sans/latin-ext-500.css";
import "@fontsource/ibm-plex-sans/latin-ext-600.css";
import { App } from "./App";
import "./styles.css";
import { bootTelegram } from "./telegram";

// Sets the colour scheme before the first paint of the interface.
bootTelegram();
const root = document.getElementById("root");
if (!root) throw new Error("root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
