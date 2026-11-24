import type { PageReloadSafetyStatus } from '@sessionmesh/shared';

const NON_TEXT_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image', 'hidden']);
const ACTIVE_TYPING_GRACE_MS = 15_000;
const ACTIVE_VIEWING_GRACE_MS = 25_000;

function isEditableInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return !el.disabled && !('readOnly' in el && (el as HTMLTextAreaElement).readOnly);
  }
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

function findEditableTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (isEditableInput(target)) return target;
  if (target.isContentEditable) {
    return (target.closest('[contenteditable="true"], [contenteditable=""]') as HTMLElement | null) ?? target;
  }
  return null;
}

function isControlStillModified(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      return el.checked !== el.defaultChecked;
    }
    if (type === 'file') {
      return Boolean(el.files && el.files.length > 0);
    }
    return el.value !== el.defaultValue;
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value !== el.defaultValue;
  }
  if (el instanceof HTMLSelectElement) {
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      if (opt.selected !== opt.defaultSelected) {
        return true;
      }
    }
    return false;
  }
  if (el.isContentEditable) {
    return (el.textContent ?? '').trim().length > 0;
  }
  return true;
}

/**
 * Tracks live form edits, file uploads, and active contenteditable interactions
 * to answer CS_CHECK_PAGE_SAFE_TO_RELOAD accurately before SessionMesh auto-reloads a tab.
 */
export class PageReloadGuard {
  private readonly dirtyControls = new Set<HTMLElement>();
  private readonly dirtyContentEditables = new Set<HTMLElement>();
  private lastUserEditAt = 0;
  private lastUserInteractionAt = 0;
  private initialized = false;

  init(): void {
    if (this.initialized || typeof document === 'undefined') return;
    this.initialized = true;

    document.addEventListener('input', this.handleEditEvent, true);
    document.addEventListener('change', this.handleEditEvent, true);
    document.addEventListener('submit', this.handleFormResetOrSubmit, true);
    document.addEventListener('reset', this.handleFormResetOrSubmit, true);
    window.addEventListener('scroll', this.handleUserActivity, { capture: true, passive: true });
    window.addEventListener('wheel', this.handleUserActivity, { capture: true, passive: true });
    document.addEventListener('pointerdown', this.handleUserActivity, { capture: true, passive: true });
    document.addEventListener('keydown', this.handleUserActivity, { capture: true, passive: true });
  }

  dispose(): void {
    if (!this.initialized || typeof document === 'undefined') return;
    this.initialized = false;
    document.removeEventListener('input', this.handleEditEvent, true);
    document.removeEventListener('change', this.handleEditEvent, true);
    document.removeEventListener('submit', this.handleFormResetOrSubmit, true);
    document.removeEventListener('reset', this.handleFormResetOrSubmit, true);
    window.removeEventListener('scroll', this.handleUserActivity, true);
    window.removeEventListener('wheel', this.handleUserActivity, true);
    document.removeEventListener('pointerdown', this.handleUserActivity, true);
    document.removeEventListener('keydown', this.handleUserActivity, true);
    this.dirtyControls.clear();
    this.dirtyContentEditables.clear();
  }

  private readonly handleUserActivity = (event: Event): void => {
    if (event.isTrusted) {
      this.lastUserInteractionAt = Date.now();
    }
  };

  private readonly handleEditEvent = (event: Event): void => {
    const editable = findEditableTarget(event.target);
    if (!editable) return;

    if (event.isTrusted) {
      this.lastUserEditAt = Date.now();
    }

    if (isEditableInput(editable)) {
      this.dirtyControls.add(editable);
    } else if (editable.isContentEditable) {
      this.dirtyContentEditables.add(editable);
    }
  };

  private readonly handleFormResetOrSubmit = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    for (const el of Array.from(this.dirtyControls)) {
      if (form.contains(el)) {
        this.dirtyControls.delete(el);
      }
    }
    for (const el of Array.from(this.dirtyContentEditables)) {
      if (form.contains(el)) {
        this.dirtyContentEditables.delete(el);
      }
    }
  };

  checkSafeToReload(): PageReloadSafetyStatus {
    const reasons = new Set<string>();

    // 1. Prune detached elements and check dirty form controls
    for (const el of Array.from(this.dirtyControls)) {
      if (!el.isConnected) {
        this.dirtyControls.delete(el);
        continue;
      }
      if (isControlStillModified(el)) {
        reasons.add('unsaved_form_input');
      } else {
        this.dirtyControls.delete(el);
      }
    }

    // 2. Check dirty contenteditable regions
    for (const el of Array.from(this.dirtyContentEditables)) {
      if (!el.isConnected) {
        this.dirtyContentEditables.delete(el);
        continue;
      }
      if (isControlStillModified(el)) {
        reasons.add('unsaved_contenteditable');
      } else {
        this.dirtyContentEditables.delete(el);
      }
    }

    // 3. Check any file inputs with selected files waiting to upload
    if (typeof document !== 'undefined') {
      const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
      for (let i = 0; i < fileInputs.length; i++) {
        const input = fileInputs[i];
        if (input.files && input.files.length > 0) {
          reasons.add('pending_file_upload');
          break;
        }
      }

      // 4. Check currently focused editable control / contenteditable
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        if (active.isContentEditable) {
          reasons.add('active_contenteditable_focus');
        } else if (isEditableInput(active)) {
          const recentlyEdited = Date.now() - this.lastUserEditAt < ACTIVE_TYPING_GRACE_MS;
          if (recentlyEdited || isControlStillModified(active)) {
            reasons.add('active_input_focus');
          }
        }
      }
      // 5. Check active media playback (never interrupt video/audio playback)
      const mediaNodes = document.querySelectorAll<HTMLMediaElement>('video, audio');
      for (let i = 0; i < mediaNodes.length; i++) {
        const m = mediaNodes[i];
        if (!m.paused && !m.ended && m.readyState >= 2) {
          reasons.add('media_playing');
          break;
        }
      }

      // 6. Check recent user interaction on visible tab (never yank a page while user is reading/scrolling/clicking)
      if (
        document.visibilityState === 'visible' &&
        this.lastUserInteractionAt > 0 &&
        Date.now() - this.lastUserInteractionAt < ACTIVE_VIEWING_GRACE_MS
      ) {
        reasons.add('user_actively_viewing');
      }
    }

    const list = Array.from(reasons);
    return {
      safe: list.length === 0,
      reasons: list,
    };
  }
}
