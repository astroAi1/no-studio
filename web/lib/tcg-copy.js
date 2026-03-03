export async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  if (!value) throw new Error("Nothing to copy");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "readonly");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Clipboard unavailable");
}

export function stringifyPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}
