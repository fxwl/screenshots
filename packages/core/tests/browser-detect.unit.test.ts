import { describe, expect, it } from 'vitest';
import { detectBrowserFromHints, detectBrowserRuntime } from '../../shared/lib/utils/browserDetect';

describe('Enhanced Multi-Browser Detection Suite (v1.3.1)', () => {
  it('BD-001: Accurately identifies Edge, Chrome, Chromium, Firefox, and Safari', () => {
    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70',
      }),
    ).toEqual({ browser: 'Edge', browserVersion: '131.0.2903.70' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36',
        brands: [
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Chromium', version: '131' },
        ],
      }),
    ).toEqual({ browser: 'Chrome', browserVersion: '131.0.6778.85' });

    // Open-source Chromium has Chrome/ in UA but only Chromium (no Google Chrome) in Client Hints
    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36',
        brands: [
          { brand: 'Chromium', version: '131' },
          { brand: 'Not_A Brand', version: '24' },
        ],
      }),
    ).toEqual({ browser: 'Chromium', browserVersion: '131.0.6778.85' });

    expect(
      detectBrowserFromHints({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
      }),
    ).toEqual({ browser: 'Firefox', browserVersion: '133.0' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      }),
    ).toEqual({ browser: 'Safari', browserVersion: '17.5' });
  });

  it('BD-002: Accurately identifies Chromium forks via UA tokens (Vivaldi, Opera, Opera GX, Yandex, Whale, QQ, 360, Quark)', () => {
    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Vivaldi/7.0.3495.15',
      }),
    ).toEqual({ browser: 'Vivaldi', browserVersion: '7.0.3495.15' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/114.0.0.0',
      }),
    ).toEqual({ browser: 'Opera', browserVersion: '114.0.0.0' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/114.0.0.0',
        brands: [
          { brand: 'Opera GX', version: '114' },
          { brand: 'Chromium', version: '130' },
        ],
      }),
    ).toEqual({ browser: 'Opera GX', browserVersion: '114.0.0.0' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36',
      }),
    ).toEqual({ browser: 'Yandex', browserVersion: '24.10.0.0' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 QQBrowser/13.2.5812.400',
      }),
    ).toEqual({ browser: 'QQ Browser', browserVersion: '13.2.5812.400' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.95 Safari/537.36 QIHU 360EE',
      }),
    ).toEqual({ browser: '360 Extreme', browserVersion: '122.0.6261.95' });

    expect(
      detectBrowserFromHints({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 QuarkPC/2.1.5.100',
      }),
    ).toEqual({ browser: 'Quark', browserVersion: '2.1.5.100' });
  });

  it('BD-003: Accurately identifies Brave & Arc via navigator.brave.isBrave() and Client Hints even with masked Chrome UA', async () => {
    const chromeLikeUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    const braveDetected = await detectBrowserRuntime({
      userAgent: chromeLikeUa,
      userAgentData: {
        brands: [
          { brand: 'Brave', version: '131' },
          { brand: 'Chromium', version: '131' },
        ],
        getHighEntropyValues: async () => ({
          fullVersionList: [
            { brand: 'Brave', version: '131.1.73.91' },
            { brand: 'Chromium', version: '131.0.6778.85' },
          ],
        }),
      },
      brave: {
        isBrave: async () => true,
      },
    });
    expect(braveDetected).toEqual({ browser: 'Brave', browserVersion: '131.1.73.91' });

    // Brave with only isBrave() and no Brave brand in Client Hints
    const braveFlagOnly = await detectBrowserRuntime({
      userAgent: chromeLikeUa,
      brave: {
        isBrave: async () => true,
      },
    });
    expect(braveFlagOnly).toEqual({ browser: 'Brave', browserVersion: '131.0.0.0' });

    // Arc via Client Hints
    const arcDetected = await detectBrowserRuntime({
      userAgent: chromeLikeUa,
      userAgentData: {
        brands: [
          { brand: 'Arc', version: '131' },
          { brand: 'Chromium', version: '131' },
        ],
      },
    });
    expect(arcDetected).toEqual({ browser: 'Arc', browserVersion: '131.0.0.0' });
  });

  it('BD-004: Accurately identifies Firefox forks (Zen, Floorp, Waterfox, LibreWolf)', () => {
    expect(
      detectBrowserFromHints({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0 Zen/1.0.1',
      }),
    ).toEqual({ browser: 'Zen', browserVersion: '1.0.1' });

    expect(
      detectBrowserFromHints({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 Floorp/11.19.1',
      }),
    ).toEqual({ browser: 'Floorp', browserVersion: '11.19.1' });

    expect(
      detectBrowserFromHints({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0 Waterfox/6.5.2',
      }),
    ).toEqual({ browser: 'Waterfox', browserVersion: '6.5.2' });
  });
});
