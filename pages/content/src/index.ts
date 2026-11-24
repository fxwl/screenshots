import type { ContentScriptCommand } from '@sessionmesh/shared';
import { isExtensionContextAlive, isSupportedHttpOrigin, LocalStorageMonitor } from './localStorageMonitor';
import { PageReloadGuard } from './reloadGuard';

declare global {
  interface Window {
    __SESSIONMESH_CONTENT_INITIALIZED__?: boolean;
  }
}

function bootstrapContentScript(): void {
  if (typeof window === 'undefined' || !isSupportedHttpOrigin() || !isExtensionContextAlive()) {
    return;
  }
  if (window.__SESSIONMESH_CONTENT_INITIALIZED__) {
    return;
  }
  window.__SESSIONMESH_CONTENT_INITIALIZED__ = true;

  const lsMonitor = new LocalStorageMonitor();
  const reloadGuard = new PageReloadGuard();

  lsMonitor.init();
  reloadGuard.init();

  const onMessage = (
    message: ContentScriptCommand | unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | void => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }

    const cmd = message as ContentScriptCommand;
    switch (cmd.type) {
      case 'CS_GET_LOCAL_STORAGE': {
        sendResponse(lsMonitor.handleGetLocalStorage(cmd.origin));
        return;
      }
      case 'CS_APPLY_LOCAL_STORAGE': {
        sendResponse(lsMonitor.handleApplyLocalStorage(cmd.origin, cmd.mutations));
        return;
      }
      case 'CS_CHECK_PAGE_SAFE_TO_RELOAD': {
        sendResponse(reloadGuard.checkSafeToReload());
        return;
      }
      default:
        return;
    }
  };

  chrome.runtime.onMessage.addListener(onMessage);
}

bootstrapContentScript();
