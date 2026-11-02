/**
 * Copy text to the system clipboard.
 * The desktop shell denies web clipboard permissions, so prefer its IPC bridge;
 * fall back to the async Clipboard API, then to a hidden textarea + execCommand
 * (works on plain-http remote origins where navigator.clipboard is undefined).
 */
export async function copyText(text: string): Promise<void> {
  const desktop = window.vmotionDesktop?.writeClipboard;
  if (desktop && (await desktop(text))) return;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy path
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('无法写入剪贴板');
  } finally {
    area.remove();
  }
}
