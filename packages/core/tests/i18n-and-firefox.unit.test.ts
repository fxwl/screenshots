import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManifestParser } from '../../dev-utils/lib/manifest-parser/index';
import { ZH_TO_EN_STATICS, ZH_TO_EN_TEMPLATES } from '../../shared/lib/i18n/dictionary';
import { t, translateUiText } from '../../shared/lib/i18n/translator';

describe('UI Internationalization (zh-CN / en) & Firefox MV3 Manifest Suite', () => {
  it('I18N-001: Translates static strings, preserves zh-CN passthrough, and keeps literal 简体中文 label intact', () => {
    expect(Object.keys(ZH_TO_EN_STATICS).length).toBeGreaterThan(2000);
    expect(Object.keys(ZH_TO_EN_TEMPLATES).length).toBeGreaterThan(400);

    expect(translateUiText('综合管理控制台', 'zh-CN')).toBe('综合管理控制台');
    expect(translateUiText('综合管理控制台', 'en')).toBe('Control Center');
    expect(translateUiText('  立即同步  ', 'en')).toMatch(/^\s+[A-Za-z ]+\s+$/);
    expect(translateUiText('简体中文', 'en')).toBe('简体中文');
    expect(t('你好', 'Hello', 'zh-CN')).toBe('你好');
    expect(t('你好', 'Hello', 'en')).toBe('Hello');
  });

  it('I18N-002: Translates parameterized template strings and nested Chinese fragments cleanly into English', () => {
    const sampleSync = '同步完成：上传 3 条，拉取 5 条，应用 4 条 Cookie，刷新对应网页即可生效';
    const translated = translateUiText(sampleSync, 'en');
    expect(translated).not.toMatch(/[\u4e00-\u9fff]/);
    expect(translated).toContain('3');
    expect(translated).toContain('5');
    expect(translated).toContain('4');

    const samplePair = '已切换至空间「个人工作空间」';
    const translatedPair = translateUiText(samplePair, 'en');
    expect(translatedPair).toContain('个人工作空间');
    expect(translatedPair.replace('个人工作空间', '')).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('I18N-003: Zero stray Chinese characters across all dictionary English target values', () => {
    const zhRe = /[\u4e00-\u9fff]/;
    for (const [zh, en] of Object.entries(ZH_TO_EN_STATICS)) {
      if (zh === '简体中文' || zh.includes('中文 / English')) continue;
      expect(en, `Static key "${zh}" still contains CJK in "${en}"`).not.toMatch(zhRe);
      expect(en.trim().length, `Static key "${zh}" mapped to empty string`).toBeGreaterThan(0);
    }
    for (const [zhPat, enPat] of Object.entries(ZH_TO_EN_TEMPLATES)) {
      expect(enPat, `Template key "${zhPat}" still contains CJK in "${enPat}"`).not.toMatch(zhRe);
    }
  });

  it('FF-001: Firefox MV3 manifest includes gecko add-on ID, sidebar_action, module background scripts, and omits sidePanel', async () => {
    const prevFirefox = process.env.__FIREFOX__;
    process.env.__FIREFOX__ = 'true';
    try {
      const manifestJsPath = path.resolve(__dirname, '../../../chrome-extension/manifest.js');
      const mod = await import(`${pathToFileURL(manifestJsPath).href}?ff=${Date.now()}`);
      const ffJson = ManifestParser.convertManifestToString(mod.default, 'firefox');
      const parsed = JSON.parse(ffJson) as Record<string, unknown>;

      expect(parsed.manifest_version).toBe(3);
      expect(parsed.permissions).not.toContain('sidePanel');
      expect(parsed.side_panel).toBeUndefined();

      const sidebar = parsed.sidebar_action as { default_panel?: string };
      expect(sidebar?.default_panel).toBe('sidepanel/index.html');

      const bss = parsed.browser_specific_settings as {
        gecko?: { id?: string; strict_min_version?: string; data_collection_permissions?: { required?: string[] } };
      };
      expect(bss?.gecko?.id).toBe('sessionmesh@fxwl.github.io');
      expect(bss?.gecko?.strict_min_version).toBe('115.0');
      expect(bss?.gecko?.data_collection_permissions?.required).toEqual(['none']);

      const bg = parsed.background as { scripts?: string[]; service_worker?: string; type?: string };
      expect(bg?.scripts).toEqual(['background.iife.js']);
      expect(bg?.type).toBe('module');

      const optionsUi = parsed.options_ui as { page?: string; open_in_tab?: boolean; browser_style?: boolean };
      expect(optionsUi?.page).toBe('options/index.html');
      expect(optionsUi?.open_in_tab).toBe(true);
      expect(optionsUi?.browser_style).toBeUndefined();
    } finally {
      if (prevFirefox === undefined) delete process.env.__FIREFOX__;
      else process.env.__FIREFOX__ = prevFirefox;
    }
  });
});
