import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OverlayView } from "./OverlayView";
import "./styles.css";

const isOverlayRoute = window.location.pathname === "/overlay" || new URLSearchParams(window.location.search).get("view") === "overlay";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isOverlayRoute ? <OverlayView /> : <App />}
  </React.StrictMode>
);
