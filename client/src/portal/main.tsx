import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/figtree";
import "../styles.css";
import "./portal.css";
import { applyTheme, savedTheme } from "../theme";
import { Portal } from "./Portal";

applyTheme(savedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Portal />
  </StrictMode>,
);
