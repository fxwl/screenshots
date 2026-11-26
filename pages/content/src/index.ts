import type { ContentPageMountConfig, ContentScriptCommand, SessionMeshCommand } from '@sessionmesh/shared';
import { copyTextAndToast, showAccountToast } from './accountToast';
import { IndexedDbBridge } from './indexedDbBridge';
import { isExtensionContextAlive, isSupportedHttpOrigin, LocalStorageMonitor } from './localStorageMonitor';
import { PageReloadGuard } from './reloadGuard';
import { SessionStorageMonitor } from './sessionStorageMonitor';

declare global {
  interface Window {
    __SESSIONMESH_CONTENT_INITIALIZED__?: boolean;
  }
}

function unwrapMountConfig(raw: unknown): ContentPageMountConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if ('ok' in obj) {
    if (!obj.ok || !obj.data || typeof obj.data !== 'object') return null;
    return obj.data as ContentPageMountConfig;
  }
  if ('acknowledged' in obj || 'syncSessionStorage' in obj || 'syncIndexedDb' in obj || 'pendingToast' in obj) {
    return obj as unknown as ContentPageMountConfig;
  }
  return null;
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
  const ssMonitor = new SessionStorageMonitor();
  const idbBridge = new IndexedDbBridge();
  const reloadGuard = new PageReloadGuard();

  const applyMountConfig = (cfg: ContentPageMountConfig | null): void => {
    if (!cfg) return;
    ssMonitor.configure({
      enabled: Boolean(cfg.syncSessionStorage),
      keyAllowlist: cfg.sessionStorageKeyAllowlist,
    });
    idbBridge.configure({
      enabled: Boolean(cfg.syncIndexedDb),
      targets: cfg.indexedDbTargets,
      maxTotalBytes: cfg.indexedDbMaxTotalBytes,
    });
    if (cfg.pendingToast) {
      showAccountToast(cfg.pendingToast);
    }
  };

  let mountReported = false;
  const sendCommandWithConfigHandling = (cmd: SessionMeshCommand): void => {
    if (!isExtensionContextAlive()) return;
    try {
      let outbound = cmd;
      if (cmd.type === 'CONTENT_PAGE_MOUNTED') {
        mountReported = true;
        if (ssMonitor.isEnabled()) {
          outbound = { ...cmd, sessionItems: ssMonitor.readFilteredSnapshot() };
        }
      } else if (cmd.type === 'CONTENT_PAGE_LEAVING') {
        if (ssMonitor.isEnabled()) {
          const sessionChanges = ssMonitor.collectLeavingChanges();
          if (sessionChanges.length > 0) {
            outbound = { ...cmd, sessionChanges };
          }
        }
        if (idbBridge.isEnabled()) {
          void idbBridge.flushOnPageLeaving();
        }
      }

      chrome.runtime.sendMessage(outbound, response => {
        void chrome.runtime.lastError;
        if (outbound.type === 'CONTENT_PAGE_MOUNTED') {
          applyMountConfig(unwrapMountConfig(response));
        }
      });
    } catch {
      lsMonitor.dispose();
      ssMonitor.dispose();
      idbBridge.dispose();
    }
  };

  // Hook LocalStorageMonitor's single outbound dispatcher without modifying localStorageMonitor.ts,
  // ensuring CONTENT_PAGE_MOUNTED fires only once and its ContentPageMountConfig response is preserved.
  const lsInternal = lsMonitor as unknown as { sendToBackground?: (cmd: SessionMeshCommand) => void };
  if (typeof lsInternal.sendToBackground === 'function') {
    lsInternal.sendToBackground = sendCommandWithConfigHandling;
  }

  lsMonitor.init();
  ssMonitor.init();
  idbBridge.init();
  reloadGuard.init();

  if (!mountReported) {
    sendCommandWithConfigHandling({
      type: 'CONTENT_PAGE_MOUNTED',
      origin: window.location.origin,
      items: {},
    });
  }

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
      case 'CS_GET_SESSION_STORAGE': {
        sendResponse(ssMonitor.handleGetSessionStorage(cmd.origin));
        return;
      }
      case 'CS_APPLY_SESSION_STORAGE': {
        sendResponse(ssMonitor.handleApplySessionStorage(cmd.origin, cmd.mutations));
        return;
      }
      case 'CS_INSPECT_INDEXED_DB': {
        void idbBridge
          .handleInspectIndexedDb(cmd.origin)
          .then(res => sendResponse(res))
          .catch(err =>
            sendResponse({
              available: false,
              databases: [],
              reason: err instanceof Error ? err.message : 'indexeddb_inspect_failed',
            }),
          );
        return true;
      }
      case 'CS_GET_INDEXED_DB_RECORDS': {
        void idbBridge
          .handleGetIndexedDbRecords(cmd.origin, cmd.targets, cmd.maxTotalBytes)
          .then(res => sendResponse(res))
          .catch(err =>
            sendResponse({
              available: false,
              totalBytes: 0,
              records: [],
              reason: err instanceof Error ? err.message : 'indexeddb_read_failed',
            }),
          );
        return true;
      }
      case 'CS_APPLY_INDEXED_DB_MUTATIONS': {
        void idbBridge
          .handleApplyIndexedDbMutations(cmd.origin, cmd.mutations, cmd.clearStores)
          .then(res => sendResponse(res))
          .catch(err =>
            sendResponse({
              applied: false,
              reason: err instanceof Error ? err.message : 'indexeddb_apply_failed',
            }),
          );
        return true;
      }
      case 'CS_CONFIGURE_EXTENDED_MONITORS': {
        if (cmd.origin !== window.location.origin) {
          sendResponse({ configured: false, reason: 'origin_mismatch' });
          return;
        }
        ssMonitor.configure({
          enabled: Boolean(cmd.syncSessionStorage),
          keyAllowlist: cmd.sessionStorageKeyAllowlist,
        });
        idbBridge.configure({
          enabled: Boolean(cmd.syncIndexedDb),
          targets: cmd.indexedDbTargets,
          maxTotalBytes: cmd.indexedDbMaxTotalBytes,
        });
        sendResponse({ configured: true });
        return;
      }
      case 'CS_SHOW_ACCOUNT_TOAST': {
        showAccountToast(cmd.payload);
        sendResponse({ shown: true });
        return;
      }
      case 'CS_COPY_TEXT_TO_CLIPBOARD': {
        void copyTextAndToast(cmd.text, cmd.toastMessage)
          .then(copied => sendResponse({ copied }))
          .catch(() => sendResponse({ copied: false }));
        return true;
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
