const uiConfig = require('@sessionmesh/ui/tailwind.config');

/** @type {import('tailwindcss').Config} */
module.exports = {
  ...uiConfig,
  content: [...(uiConfig.content || []), '../sidepanel/src/**/*.{ts,tsx}'],
};
