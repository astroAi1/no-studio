import { getHealth } from "./api.js";
import { mountNoStudioTool } from "./tools/no-studio.js";
import { mountNoGalleryPage } from "./tools/no-gallery.js";
import { mountRecoveryFaultsTool } from "./tools/recovery-faults.js";
import { startRouter } from "./router.js";

const root = document.getElementById("studio-root");
let currentCleanup = null;
let routerCleanup = null;

function escapeHtmlForFatal(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function showFatalError(error) {
  const message = (error && error.message) || String(error) || "Unknown runtime error";
  console.error("[No-Studio Fatal]", error);
  if (root) {
    root.innerHTML = `
      <div style="padding:24px;font:14px/1.5 GeistMono,monospace;color:#efefef">
        <h3 style="margin:0 0 8px;font-size:14px">No-Studio failed to start</h3>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#f0c2c2;background:#050505;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:12px;font-size:12px">${escapeHtmlForFatal(message)}</pre>
      </div>
    `;
  }
}

function titleForTool(tool) {
  if (tool === "no-gallery") return "No-Gallery";
  if (tool === "no-studio") return "No-Studio";
  return "No-Studio";
}

function mountTool(tool) {
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  document.title = titleForTool(tool);
  try {
    if (tool === "no-gallery") {
      currentCleanup = mountNoGalleryPage(root);
      return;
    }
    if (tool === "no-studio") {
      currentCleanup = mountNoStudioTool(root);
      return;
    }
    currentCleanup = mountRecoveryFaultsTool(root);
  } catch (error) {
    showFatalError(error);
  }
}

async function boot() {
  try {
    await getHealth();
  } catch (error) {
    console.warn("[No-Studio] API health check failed:", error.message);
  }

  routerCleanup = startRouter((tool) => {
    mountTool(tool);
  });
}

window.addEventListener("error", (event) => {
  showFatalError(event.error || new Error(event.message || "window error"));
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason || "Unhandled rejection"));
  showFatalError(reason);
});

boot();
