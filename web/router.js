const PRIMARY_TOOL = "no-studio";
const VALID_TOOLS = new Set([PRIMARY_TOOL]);
const LEGACY_ALIASES = new Map([
  ["no-palette", PRIMARY_TOOL],
  ["no-generate", PRIMARY_TOOL],
  ["gif-lab", PRIMARY_TOOL],
  ["tcg-forge", PRIMARY_TOOL],
]);

export function toolPath(toolId = PRIMARY_TOOL) {
  const normalized = VALID_TOOLS.has(toolId) ? toolId : PRIMARY_TOOL;
  return `/tools/${normalized}`;
}

export function parseRoute(pathname = window.location.pathname) {
  const raw = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (raw === "/" || raw === "/index.html") return PRIMARY_TOOL;
  const match = raw.match(/^\/tools\/([^/]+)$/);
  const tool = match ? match[1] : null;
  const normalized = LEGACY_ALIASES.get(tool) || tool;
  return VALID_TOOLS.has(normalized) ? normalized : PRIMARY_TOOL;
}

export function normalizeUrlIfNeeded() {
  const parsed = parseRoute(window.location.pathname);
  const expectedPath = toolPath(parsed);
  if (window.location.pathname !== expectedPath) {
    window.history.replaceState({ tool: parsed }, "", expectedPath);
  }
}

export function navigateToTool(toolId = PRIMARY_TOOL) {
  const next = VALID_TOOLS.has(toolId) ? toolId : PRIMARY_TOOL;
  const path = toolPath(next);
  if (window.location.pathname !== path) {
    window.history.pushState({ tool: next }, "", path);
  }
  window.dispatchEvent(new CustomEvent("np:routechange", { detail: { tool: next } }));
}

export function startRouter(onChange) {
  normalizeUrlIfNeeded();
  const handle = () => onChange(parseRoute(window.location.pathname));
  const clickHandler = (event) => {
    const link = event.target.closest("[data-tool-link]");
    if (!link) return;
    event.preventDefault();
    navigateToTool(link.getAttribute("data-tool-link") || PRIMARY_TOOL);
  };
  const popHandler = () => {
    normalizeUrlIfNeeded();
    handle();
  };
  const customHandler = (event) => onChange(event.detail && event.detail.tool ? event.detail.tool : parseRoute());

  document.addEventListener("click", clickHandler);
  window.addEventListener("popstate", popHandler);
  window.addEventListener("np:routechange", customHandler);
  handle();

  return () => {
    document.removeEventListener("click", clickHandler);
    window.removeEventListener("popstate", popHandler);
    window.removeEventListener("np:routechange", customHandler);
  };
}
