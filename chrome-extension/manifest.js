import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('../package.json', 'utf8'));

const isFirefox = process.env.__FIREFOX__ === 'true';

const basePermissions = ['cookies', 'tabs', 'webNavigation', 'storage', 'unlimitedStorage', 'alarms', 'contextMenus'];

const permissions = isFirefox ? basePermissions : [...basePermissions, 'sidePanel'];

const sidePanelConfig = {
  side_panel: {
    default_path: 'sidepanel/index.html',
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
  },
  !isFirefox && { side_panel: { ...sidePanelConfig.side_panel } },
);

export default manifest;
