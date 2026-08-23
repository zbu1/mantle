import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig } from "./app/app.config";
import { initLogging, logError, formatError } from "./app/core/logger";

initLogging();

/**
 * Last-resort UI for when Angular itself never mounts (e.g. a bootstrap-time
 * error, or an infinite effect loop pegging the event loop before the first
 * render). Built with plain DOM calls — no Angular — since it has to work
 * when the framework is the thing that failed. Individual failures that
 * happen *after* bootstrap (e.g. a vault failing to open) have their own
 * in-app fallback and don't go through this path.
 */
function renderBootstrapFailure(err: unknown): void {
  const root = document.body;
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.setAttribute(
    "style",
    "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
      "height:100vh;padding:24px;text-align:center;font-family:system-ui,sans-serif;" +
      "background:#1e1e1e;color:#e5e5e5;",
  );
  const title = document.createElement("div");
  title.textContent = "Mantle failed to start";
  title.setAttribute("style", "font-size:16px;font-weight:600;");
  const detail = document.createElement("div");
  detail.textContent = formatError(err);
  detail.setAttribute("style", "max-width:640px;font-size:12px;color:#a3a3a3;white-space:pre-wrap;");
  const reload = document.createElement("button");
  reload.textContent = "Reload";
  reload.setAttribute(
    "style",
    "margin-top:8px;padding:6px 14px;font-size:13px;border-radius:6px;border:1px solid #444;" +
      "background:#2a2a2a;color:#e5e5e5;cursor:pointer;",
  );
  reload.addEventListener("click", () => location.reload());
  panel.append(title, detail, reload);
  root.appendChild(panel);
}

bootstrapApplication(App, appConfig).catch((err) => {
  logError(`Bootstrap failed: ${formatError(err)}`);
  renderBootstrapFailure(err);
});
