import { getHealth } from "./api.js";
import { mountNoStudioTool } from "./tools/no-studio.js";
import { mountNoGalleryPage } from "./tools/no-gallery.js";

const root = document.getElementById("studio-root");
let currentCleanup = null;

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

async function boot() {
  try {
    await getHealth();
  } catch (error) {
    console.warn("[No-Studio] API health check failed:", error.message);
  }

  try {
    const rawPath = String(window.location.pathname || "/").replace(/\/+$/, "") || "/";
    const isGallery = rawPath === "/tools/no-gallery" || rawPath === "/no-gallery";
    currentCleanup = isGallery
      ? mountNoGalleryPage(root)
      : mountNoStudioTool(root);
  } catch (error) {
    showFatalError(error);
  }
}

window.addEventListener("error", (event) => {
  showFatalError(event.error || new Error(event.message || "window error"));
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason || "Unhandled rejection"));
  showFatalError(reason);
});

boot();
