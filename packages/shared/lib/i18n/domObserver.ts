import { translateUiText, type UiLocale } from './translator';

interface TrackedStringPair {
  raw: string;
  rendered: string;
}

const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'] as const;
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

const trackedTextNodes = new WeakMap<Text, TrackedStringPair>();
const trackedElements = new WeakMap<Element, Map<string, TrackedStringPair>>();

function shouldSkipElement(el: Element | null): boolean {
  let curr: Element | null = el;
  while (curr) {
    if (SKIPPED_TAGS.has(curr.tagName)) return true;
    if (curr.getAttribute('data-no-i18n') === 'true') return true;
    if (curr.getAttribute('contenteditable') === 'true') return true;
    curr = curr.parentElement;
  }
  return false;
}

function processTextNode(node: Text, locale: UiLocale): void {
  if (shouldSkipElement(node.parentElement)) return;
  const current = node.data;
  const tracked = trackedTextNodes.get(node);

  if (locale === 'en') {
    if (tracked && current === tracked.rendered) {
      return;
    }
    const raw = current;
    const rendered = translateUiText(raw, 'en');
    if (rendered !== raw) {
      trackedTextNodes.set(node, { raw, rendered });
      node.data = rendered;
    } else if (tracked) {
      trackedTextNodes.delete(node);
    }
  } else if (tracked) {
    if (current === tracked.rendered) {
      node.data = tracked.raw;
    }
    trackedTextNodes.delete(node);
  }
}

function processElementAttrs(el: Element, locale: UiLocale): void {
  if (shouldSkipElement(el)) return;
  let attrMap = trackedElements.get(el);

  for (const attr of TRANSLATABLE_ATTRS) {
    const current = el.getAttribute(attr);
    if (current === null) continue;
    const tracked = attrMap?.get(attr);

    if (locale === 'en') {
      if (tracked && current === tracked.rendered) {
        continue;
      }
      const raw = current;
      const rendered = translateUiText(raw, 'en');
      if (rendered !== raw) {
        if (!attrMap) {
          attrMap = new Map();
          trackedElements.set(el, attrMap);
        }
        attrMap.set(attr, { raw, rendered });
        el.setAttribute(attr, rendered);
      } else if (tracked) {
        attrMap?.delete(attr);
      }
    } else if (tracked) {
      if (current === tracked.rendered) {
        el.setAttribute(attr, tracked.raw);
      }
      attrMap?.delete(attr);
    }
  }
}

function walkAndProcessSubtree(root: Node, locale: UiLocale): void {
  if (root.nodeType === Node.TEXT_NODE) {
    processTextNode(root as Text, locale);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    if (shouldSkipElement(el)) return;
    processElementAttrs(el, locale);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      processTextNode(current as Text, locale);
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      processElementAttrs(current as Element, locale);
    }
    current = walker.nextNode();
  }
}

/**
 * Installs bidirectional DOM localization & `window.confirm` translation for `locale`.
 * Returns a cleanup function when `locale` changes or unmounts.
 */
export function installDomLocaleObserver(locale: UiLocale): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }

  document.documentElement.lang = locale;

  let isApplying = false;
  const runGuarded = (fn: () => void) => {
    if (isApplying) return;
    isApplying = true;
    try {
      fn();
    } finally {
      isApplying = false;
    }
  };

  // Apply immediately to existing DOM
  runGuarded(() => {
    if (document.body) {
      walkAndProcessSubtree(document.body, locale);
    }
    if (document.title) {
      if (locale === 'en') {
        const nextTitle = translateUiText(document.title, 'en');
        if (nextTitle !== document.title) {
          document.documentElement.setAttribute('data-orig-title', document.title);
          document.title = nextTitle;
        }
      } else {
        const origTitle = document.documentElement.getAttribute('data-orig-title');
        if (origTitle) {
          document.title = origTitle;
          document.documentElement.removeAttribute('data-orig-title');
        }
      }
    }
  });

  if (locale !== 'en') {
    return () => undefined;
  }

  // Patch window.confirm while in English mode
  const origConfirm = window.confirm.bind(window);
  window.confirm = (message?: string): boolean => {
    return origConfirm(message ? translateUiText(message, 'en') : message);
  };

  const dirtyNodes = new Set<Node>();
  let scheduled = false;

  const flushDirty = () => {
    scheduled = false;
    if (dirtyNodes.size === 0) return;
    const batch = Array.from(dirtyNodes);
    dirtyNodes.clear();
    runGuarded(() => {
      for (const node of batch) {
        if (!node.isConnected) continue;
        walkAndProcessSubtree(node, 'en');
      }
    });
  };

  const scheduleFlush = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flushDirty);
  };

  const observer = new MutationObserver(mutations => {
    if (isApplying) return;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        dirtyNodes.add(m.target);
      } else if (m.type === 'attributes') {
        dirtyNodes.add(m.target);
      } else if (m.type === 'childList') {
        m.addedNodes.forEach(added => {
          dirtyNodes.add(added);
        });
      }
    }
    if (dirtyNodes.size > 0) {
      scheduleFlush();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATABLE_ATTRS],
  });

  return () => {
    observer.disconnect();
    dirtyNodes.clear();
    window.confirm = origConfirm;
  };
}
