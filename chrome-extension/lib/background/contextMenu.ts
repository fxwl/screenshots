import { localeStorage, type ResolvedLocale } from '@sessionmesh/storage';

export const MENU_IDS = {
  ROOT: 'sessionmesh-root',
  OPEN_SIDEPANEL: 'sessionmesh-open-sidepanel',
  ADD_MANAGED_SITE: 'sessionmesh-add-managed-site',
  ROTATE_SITE_ACCOUNT: 'sessionmesh-rotate-site-account',
  SYNC_CURRENT_SITE: 'sessionmesh-sync-current-site',
  TOGGLE_PAUSE: 'sessionmesh-toggle-pause',
  BLACKLIST_CURRENT_SITE: 'sessionmesh-blacklist-current-site',
  OPEN_OPTIONS: 'sessionmesh-open-options',
} as const;

export interface ContextMenuActionHandlers {
  onAddManagedSite: (tabUrl?: string) => Promise<void>;
  onRotateSiteAccount: (tabUrl?: string) => Promise<void>;
  onSyncCurrentSite: (tabUrl?: string) => Promise<void>;
  onTogglePause: () => Promise<void>;
  onBlacklistCurrentSite: (tabUrl?: string) => Promise<void>;
}

interface FirefoxBrowserNamespace {
  sidebarAction?: {
    open?: () => Promise<void>;
  };
}

function getFirefoxSidebarAction(): FirefoxBrowserNamespace['sidebarAction'] {
  return (globalThis as unknown as { browser?: FirefoxBrowserNamespace }).browser?.sidebarAction;
}

let listenerRegistered = false;

function createMenuSafe(props: chrome.contextMenus.CreateProperties): void {
  try {
    chrome.contextMenus.create(props, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // ignore menu creation errors
  }
}

/**
 * Idempotently creates the SessionMesh right-click context menu hierarchy
 * in the active UI language (`zh-CN` or `en`), supporting both Chromium Side Panel and Firefox Sidebar.
 */
export function setupContextMenus(locale?: ResolvedLocale): void {
  if (typeof chrome === 'undefined' || !chrome.contextMenus) return;
  const isEn = (locale ?? localeStorage.resolve()) === 'en';
  const canOpenSidebar =
    typeof chrome.sidePanel?.open === 'function' || typeof getFirefoxSidebarAction()?.open === 'function';

  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;

      createMenuSafe({
        id: MENU_IDS.ROOT,
        title: isEn ? 'SessionMesh Multi-Device Sync' : 'SessionMesh 多设备同步',
        contexts: ['all'],
      });

      if (canOpenSidebar) {
        createMenuSafe({
          id: MENU_IDS.OPEN_SIDEPANEL,
          parentId: MENU_IDS.ROOT,
          title: isEn ? 'Open SessionMesh Side Panel' : '打开 SessionMesh 侧边栏管理台',
          contexts: ['all'],
        });
      }

      createMenuSafe({
        id: MENU_IDS.ADD_MANAGED_SITE,
        parentId: MENU_IDS.ROOT,
        title: isEn ? '➕ Enable Auto-Sync for Current Site' : '➕ 开启当前网站的自动同步',
        contexts: ['all'],
      });

      createMenuSafe({
        id: MENU_IDS.ROTATE_SITE_ACCOUNT,
        parentId: MENU_IDS.ROOT,
        title: isEn ? '🔄 Switch to Next Account on Site' : '🔄 切换当前网站下一个账号',
        contexts: ['all'],
      });

      createMenuSafe({
        id: MENU_IDS.SYNC_CURRENT_SITE,
        parentId: MENU_IDS.ROOT,
        title: isEn ? 'Sync Current Site Now' : '立即同步当前网站',
        contexts: ['all'],
      });

      createMenuSafe({
        id: MENU_IDS.TOGGLE_PAUSE,
        parentId: MENU_IDS.ROOT,
        title: isEn ? 'Pause / Resume Global Sync' : '暂停 / 恢复全局同步',
        contexts: ['all'],
      });

      createMenuSafe({
        id: MENU_IDS.BLACKLIST_CURRENT_SITE,
        parentId: MENU_IDS.ROOT,
        title: isEn ? '🚫 Exclude Current Site (Do Not Sync)' : '🚫 排除当前网站（不同步）',
        contexts: ['all'],
      });

      createMenuSafe({
        id: MENU_IDS.OPEN_OPTIONS,
        parentId: MENU_IDS.ROOT,
        title: isEn ? 'Open SessionMesh Control Center' : '打开 SessionMesh 控制中心',
        contexts: ['all'],
      });
    });
  } catch {
    // ignore contextMenus errors
  }
}

/**
 * Registers the top-level chrome.contextMenus.onClicked listener (safe across MV3 SW restarts).
 */
export function registerContextMenuListener(handlers: ContextMenuActionHandlers): void {
  if (listenerRegistered || typeof chrome === 'undefined' || !chrome.contextMenus?.onClicked) return;
  listenerRegistered = true;

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    switch (info.menuItemId) {
      case MENU_IDS.OPEN_SIDEPANEL: {
        // Must execute synchronously inside user gesture before any await
        if (tab?.windowId !== undefined && typeof chrome.sidePanel?.open === 'function') {
          chrome.sidePanel.open({ windowId: tab.windowId }).catch(err => {
            console.warn('SessionMesh sidePanel.open failed:', err);
          });
        } else {
          const ffSidebar = getFirefoxSidebarAction();
          if (typeof ffSidebar?.open === 'function') {
            ffSidebar.open().catch(err => {
              console.warn('SessionMesh sidebarAction.open failed:', err);
            });
          } else if (chrome.tabs?.create && chrome.runtime?.getURL) {
            chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/index.html') });
          }
        }
        break;
      }
      case MENU_IDS.OPEN_OPTIONS: {
        chrome.runtime.openOptionsPage();
        break;
      }
      case MENU_IDS.ADD_MANAGED_SITE: {
        void handlers.onAddManagedSite(tab?.url || info.pageUrl);
        break;
      }
      case MENU_IDS.ROTATE_SITE_ACCOUNT: {
        void handlers.onRotateSiteAccount(tab?.url || info.pageUrl);
        break;
      }
      case MENU_IDS.SYNC_CURRENT_SITE: {
        void handlers.onSyncCurrentSite(tab?.url || info.pageUrl);
        break;
      }
      case MENU_IDS.TOGGLE_PAUSE: {
        void handlers.onTogglePause();
        break;
      }
      case MENU_IDS.BLACKLIST_CURRENT_SITE: {
        void handlers.onBlacklistCurrentSite(tab?.url || info.pageUrl);
        break;
      }
      default:
        break;
    }
  });
}
