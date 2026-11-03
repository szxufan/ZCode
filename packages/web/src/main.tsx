import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { RemoteApp } from "./app.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root missing");
}

createRoot(container).render(
  <StrictMode>
    <RemoteApp />
  </StrictMode>,
);
