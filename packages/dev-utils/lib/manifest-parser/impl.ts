import { ManifestParserInterface, Manifest } from './type';

export const ManifestParserImpl: ManifestParserInterface = {
  convertManifestToString: (manifest, env) => {
    if (env === 'firefox') {
      manifest = convertToFirefoxCompatibleManifest(manifest);
    }
    return JSON.stringify(manifest, null, 2);
  },
};

function convertToFirefoxCompatibleManifest(manifest: Manifest) {
  const manifestCopy = {
    ...manifest,
  } as { [key: string]: unknown };

  manifestCopy.background = {
    scripts: [manifest.background?.service_worker],
    type: 'module',
  };
  manifestCopy.options_ui = {
    page: manifest.options_page,
    open_in_tab: true,
  };
  manifestCopy.content_security_policy = {
    extension_pages: "script-src 'self'; object-src 'self'",
  };
  delete manifestCopy.options_page;
  return manifestCopy as Manifest;
}
