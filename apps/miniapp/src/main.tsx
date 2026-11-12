import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fraunces/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import { App } from "./App";
import { bootTelegram } from "./telegram";
import "./styles.css";

const telegram = bootTelegram();
const root = document.getElementById("root");
if (!root) throw new Error("root is missing");

createRoot(root).render(
  <StrictMode>
    <App telegram={telegram} />
  </StrictMode>,
);
