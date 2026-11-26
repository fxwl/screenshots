import type { AccountSwitchToastPayload } from '@sessionmesh/shared';
import { localeStorage } from '@sessionmesh/storage';

const TOAST_VISIBLE_MS = 1_900;
const TOAST_FADE_MS = 260;

let activeToastHost: HTMLElement | null = null;
let fadeOutTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function sanitizeHexColor(raw?: string): string {
  if (!raw) return '#2563eb';
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(trimmed)) {
    return trimmed;
  }
  return '#2563eb';
}

function pickBadgeForeground(hexBg: string): string {
  const cleaned = hexBg.replace(/^#/, '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map(ch => ch + ch)
          .join('')
      : cleaned;
  if (full.length !== 6) return '#ffffff';
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.22 ? '#111827' : '#ffffff';
}

function clearActiveToast(): void {
  if (fadeOutTimer !== null) {
    clearTimeout(fadeOutTimer);
    fadeOutTimer = null;
  }
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  if (activeToastHost) {
    try {
      activeToastHost.remove();
    } catch {
      // ignore DOM removal error
    }
    activeToastHost = null;
  }
}

function mountToast(payload: AccountSwitchToastPayload): void {
  const mountTarget = document.documentElement ?? document.body;
  if (!mountTarget) return;

  clearActiveToast();

  const host = document.createElement('div');
  host.setAttribute('data-sessionmesh-toast', '1');
  host.style.cssText =
    'all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647; pointer-events: none;';

  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .sm-toast {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 360px;
      padding: 8px 13px;
      border-radius: 9999px;
      background: rgba(17, 24, 39, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.35), 0 4px 10px -4px rgba(0, 0, 0, 0.25);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      color: #f9fafb;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 12.5px;
      line-height: 1.3;
      opacity: 0;
      transform: translateY(-8px) scale(0.97);
      transition: opacity ${TOAST_FADE_MS}ms cubic-bezier(0.16, 1, 0.3, 1),
                  transform ${TOAST_FADE_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      user-select: none;
    }
    .sm-toast.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    .sm-dot {
      width: 8px;
      height: 8px;
      border-radius: 9999px;
      flex-shrink: 0;
    }
    .sm-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 1px 6px;
      border-radius: 9999px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .sm-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .sm-meta {
      color: rgba(229, 231, 235, 0.72);
      font-size: 11.5px;
      font-weight: 400;
      flex-shrink: 0;
    }
  `;

  const pill = document.createElement('div');
  pill.className = 'sm-toast';

  const color = sanitizeHexColor(payload.color);

  const dot = document.createElement('span');
  dot.className = 'sm-dot';
  dot.style.backgroundColor = color;
  dot.style.boxShadow = `0 0 0 2px ${color}40`;
  pill.appendChild(dot);

  if (payload.badgeText?.trim()) {
    const badge = document.createElement('span');
    badge.className = 'sm-badge';
    badge.textContent = payload.badgeText.trim().slice(0, 6);
    badge.style.backgroundColor = color;
    badge.style.color = pickBadgeForeground(color);
    pill.appendChild(badge);
  }

  const labelText = payload.message?.trim() || payload.label?.trim() || payload.siteKey?.trim() || 'SessionMesh';
  const textEl = document.createElement('span');
  textEl.className = 'sm-text';
  textEl.textContent = labelText;
  pill.appendChild(textEl);

  if (typeof payload.index === 'number' && typeof payload.total === 'number' && payload.total > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'sm-meta';
    countEl.textContent = `(${payload.index}/${payload.total})`;
    pill.appendChild(countEl);
  }

  if (payload.siteKey?.trim() && payload.siteKey.trim() !== labelText) {
    const siteEl = document.createElement('span');
    siteEl.className = 'sm-meta';
    siteEl.textContent = `· ${payload.siteKey.trim()}`;
    pill.appendChild(siteEl);
  }

  shadow.appendChild(style);
  shadow.appendChild(pill);
  mountTarget.appendChild(host);
  activeToastHost = host;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (activeToastHost === host) {
        pill.classList.add('visible');
      }
    });
  });

  fadeOutTimer = setTimeout(() => {
    pill.classList.remove('visible');
    cleanupTimer = setTimeout(() => {
      if (activeToastHost === host) {
        clearActiveToast();
      } else {
        try {
          host.remove();
        } catch {
          // ignore
        }
      }
    }, TOAST_FADE_MS + 30);
  }, TOAST_VISIBLE_MS);
}

/**
 * Displays a sleek, page-isolated floating pill toast inside a Closed Shadow Root.
 */
export function showAccountToast(payload: AccountSwitchToastPayload): void {
  if (typeof document === 'undefined') return;
  if (!document.documentElement && !document.body) {
    document.addEventListener('DOMContentLoaded', () => mountToast(payload), { once: true });
    return;
  }
  mountToast(payload);
}

/**
 * Copies `text` to the system clipboard (with hidden textarea execCommand fallback)
 * and renders a Closed Shadow DOM toast confirmation on the page.
 */
export async function copyTextAndToast(text: string, toastMessage?: string): Promise<boolean> {
  let copied = false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied && typeof document !== 'undefined') {
    const container = document.body ?? document.documentElement;
    if (container) {
      const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.cssText =
        'position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none;';
      try {
        container.appendChild(textarea);
        textarea.focus({ preventScroll: true });
        textarea.select();
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        try {
          textarea.remove();
        } catch {
          // ignore
        }
        try {
          previousActive?.focus({ preventScroll: true });
        } catch {
          // ignore
        }
      }
    }
  }

  const isEn = localeStorage.resolve() === 'en';
  if (copied) {
    const msg = toastMessage || (isEn ? 'Copied to clipboard' : '已复制到剪贴板');
    showAccountToast({
      siteKey: '',
      label: msg,
      message: msg,
      badgeText: 'COPY',
      color: '#16a34a',
    });
  } else {
    const errMsg = isEn ? 'Copy failed, check clipboard permission' : '复制失败，请检查剪贴板权限';
    showAccountToast({
      siteKey: '',
      label: errMsg,
      message: errMsg,
      badgeText: 'ERR',
      color: '#dc2626',
    });
  }

  return copied;
}
