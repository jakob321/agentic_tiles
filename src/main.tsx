import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isVsCodeHost } from "./api";
import "./styles.css";
import "./vscode.css";

// The rules in vscode.css apply only inside the VS Code webview.
if (isVsCodeHost) document.body.classList.add("vscode-host");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
