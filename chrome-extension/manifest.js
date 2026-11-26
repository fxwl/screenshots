import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const isFirefox = process.env.__FIREFOX__ === 'true';

const basePermissions = ['cookies', 'tabs', 'webNavigation', 'storage', 'unlimitedStorage', 'alarms', 'contextMenus'];

const permissions = isFirefox ? basePermissions : [...basePermissions, 'sidePanel'];

const sidePanelConfig = {
  side_panel: {
    default_path: 'sidepanel/index.html',
  },
};

const firefoxSpecificConfig = {
  sidebar_action: {
    default_panel: 'sidepanel/index.html',
    default_title: '__MSG_extensionName__',
    default_icon: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
  },
  browser_specific_settings: {
    gecko: {
      id: 'sessionmesh@fxwl.github.io',
      strict_min_version: '115.0',
      data_collection_permissions: {
        required: ['none'],
      },
    },
  },
};

/**
 * After changing, please reload the extension at `chrome://extensions` or `edge://extensions`
 * @type {chrome.runtime.ManifestV3}
 */
const manifest = Object.assign(
  {
    manifest_version: 3,
    default_locale: 'en',
    name: '__MSG_extensionName__',
    version: packageJson.version,
    description: '__MSG_extensionDescription__',
    permissions,
    host_permissions: ['<all_urls>'],
    options_page: 'options/index.html',
    background: {
      service_worker: 'background.iife.js',
      type: 'module',
    },
    action: {
      default_popup: 'popup/index.html',
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
        128: 'icon-128.png',
      },
    },
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    content_scripts: [
      {
        matches: ['*://*/*'],
        js: ['content/index.iife.js'],
        run_at: 'document_start',
      },
    ],
    commands: {
      'rotate-account-next': {
        suggested_key: {
          default: 'Alt+Shift+Period',
          mac: 'Alt+Shift+Period',
        },
        description: '__MSG_cmdRotateAccountNext__',
      },
      'rotate-account-prev': {
        suggested_key: {
          default: 'Alt+Shift+Comma',
          mac: 'Alt+Shift+Comma',
        },
        description: '__MSG_cmdRotateAccountPrev__',
      },
      'sync-current-site': {
        suggested_key: {
          default: 'Alt+Shift+S',
          mac: 'Alt+Shift+S',
        },
        description: '__MSG_cmdSyncCurrentSite__',
      },
      'copy-current-curl': {
        suggested_key: {
          default: 'Alt+Shift+C',
          mac: 'Alt+Shift+C',
        },
        description: '__MSG_cmdCopyCurrentCurl__',
      },
    },
  },
  !isFirefox && { side_panel: { ...sidePanelConfig.side_panel } },
  isFirefox && firefoxSpecificConfig,
);

export default manifest;
