import { ZH_TO_EN_STATICS, ZH_TO_EN_TEMPLATES } from './dictionary';

export type UiLocale = 'zh-CN' | 'en';

interface CompiledTemplateRule {
  regex: RegExp;
  enPattern: string;
  staticWeight: number;
}

const ZH_CHAR_RE = /[\u4e00-\u9fff]/;

const FALLBACK_GLOSSARY: ReadonlyArray<readonly [string, string]> = [
  ['综合管理控制台', 'Control Center'],
  ['侧边栏管理台', 'Side Panel'],
  ['本地同步盘', 'Local Sync Folder'],
  ['端到端加密主密码', 'Master Password'],
  ['加密主密码', 'Master Password'],
  ['主密码', 'Master Password'],
  ['同步空间', 'Sync Space'],
  ['默认空间', 'Default Space'],
  ['本机设备', 'This Device'],
  ['配对码', 'Pairing Code'],
  ['配对口令', 'Pairing PIN'],
  ['多账号管理', 'Multi-Account'],
  ['坚果云', 'Nutstore'],
  ['阿里云 OSS', 'Aliyun OSS'],
  ['腾讯云 COS', 'Tencent COS'],
  ['群晖 NAS', 'Synology NAS'],
  ['刷新对应网页即可生效', 'refresh the tab to apply'],
  ['刷新页面即可生效', 'refresh the page to apply'],
  ['已复制到剪贴板', 'Copied to clipboard'],
  ['复制失败，请手动选中复制', 'Copy failed, please select and copy manually'],
  ['操作失败，请检查网络连接或重试', 'Action failed, please check your connection and retry'],
  ['全空间', 'all devices in space'],
  ['本机', 'this device'],
  ['同步中', 'Syncing'],
  ['已同步', 'Synced'],
  ['未纳管', 'Unmanaged'],
  ['已纳管', 'Managed'],
  ['临时分享', 'Temp Share'],
  ['默认账号', 'Default Account'],
  ['刚刚', 'just now'],
  ['分钟前', 'm ago'],
  ['小时前', 'h ago'],
  ['天前', 'd ago'],
  ['秒前', 's ago'],
  ['分钟', ' min'],
  ['小时', ' hr'],
  ['天', ' days'],
  ['条变更', ' changes'],
  ['条记录', ' records'],
  ['条', ''],
];

let compiledTemplatesCache: CompiledTemplateRule[] | null = null;
let lastTemplateCount = -1;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCompiledTemplates(): CompiledTemplateRule[] {
  const entries = Object.entries(ZH_TO_EN_TEMPLATES);
  if (compiledTemplatesCache && entries.length === lastTemplateCount) {
    return compiledTemplatesCache;
  }

  const rules: CompiledTemplateRule[] = [];
  for (const [zhPat, enPat] of entries) {
    const tokenRe = /\$\{(\d+)\}/g;
    let lastIdx = 0;
    let regexSrc = '^';
    let staticLen = 0;
    let match: RegExpExecArray | null;
    const spans: Array<{ before: string; idx: number }> = [];

    // Collect spans
    while ((match = tokenRe.exec(zhPat)) !== null) {
      const before = zhPat.slice(lastIdx, match.index);
      spans.push({ before, idx: Number(match[1]) });
      lastIdx = match.index + match[0].length;
    }
    const tail = zhPat.slice(lastIdx);

    spans.forEach((span, i) => {
      staticLen += span.before.length;
      // Allow flexible whitespace in static text
      const escaped = escapeRegExp(span.before).replace(/\s+/g, '\\s+');
      const isLastAndNoTail = i === spans.length - 1 && tail.length === 0;
      regexSrc += `${escaped}([\\s\\S]${isLastAndNoTail ? '*' : '*?'})`;
    });

    staticLen += tail.length;
    regexSrc += `${escapeRegExp(tail).replace(/\s+/g, '\\s+')}$`;

    try {
      rules.push({
        regex: new RegExp(regexSrc),
        enPattern: enPat,
        staticWeight: staticLen,
      });
    } catch {
      // skip malformed pattern
    }
  }

  // Match more specific templates (longer static Chinese text) first
  rules.sort((a, b) => b.staticWeight - a.staticWeight);
  compiledTemplatesCache = rules;
  lastTemplateCount = entries.length;
  return rules;
}

function translateCoreSegment(collapsed: string, depth: number): string {
  const exact = ZH_TO_EN_STATICS[collapsed];
  if (exact !== undefined) {
    return exact;
  }

  // Strip surrounding CJK/ASCII punctuation wrappers like （...） or 「...」 if inner matches
  if (collapsed.startsWith('，') && collapsed.length > 1) {
    const inner = translateCoreSegment(collapsed.slice(1).trim(), depth + 1);
    if (!ZH_CHAR_RE.test(inner)) {
      return `, ${inner}`;
    }
  }
  if (collapsed.startsWith('（') && collapsed.endsWith('）') && collapsed.length > 2) {
    const inner = translateCoreSegment(collapsed.slice(1, -1).trim(), depth + 1);
    if (!ZH_CHAR_RE.test(inner)) {
      return ` (${inner})`;
    }
  }

  if (depth < 3) {
    const rules = getCompiledTemplates();
    for (const rule of rules) {
      const m = rule.regex.exec(collapsed);
      if (m) {
        const rendered = rule.enPattern.replace(/\$\{(\d+)\}/g, (_, idxStr) => {
          const idx = Number(idxStr);
          const captured = m[idx + 1] ?? '';
          if (captured && ZH_CHAR_RE.test(captured)) {
            return translateUiTextInternal(captured, depth + 1);
          }
          return captured;
        });
        return rendered
          .replace(/\s+,/g, ',')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
    }
  }

  // Delimiter-wise split fallback (e.g. `A · B` or `A：B`)
  if (depth < 2) {
    for (const [sep, outSep] of [
      [' · ', ' · '],
      [' — ', ' — '],
      ['：', ': '],
      [' / ', ' / '],
    ] as const) {
      if (collapsed.includes(sep)) {
        const parts = collapsed.split(sep);
        if (parts.length >= 2 && parts.length <= 5) {
          const translatedParts = parts.map(p => (ZH_CHAR_RE.test(p) ? translateUiTextInternal(p, depth + 1) : p));
          const joined = translatedParts.join(outSep);
          if (joined !== collapsed) {
            return applyFallbackGlossary(joined);
          }
        }
      }
    }
  }

  return applyFallbackGlossary(collapsed);
}

function applyFallbackGlossary(input: string): string {
  if (!ZH_CHAR_RE.test(input)) return input;
  let out = input;
  for (const [zh, en] of FALLBACK_GLOSSARY) {
    if (out.includes(zh)) {
      out = out.split(zh).join(en);
    }
  }
  out = out
    .replace(/（/g, ' (')
    .replace(/）/g, ')')
    .replace(/「/g, '"')
    .replace(/」/g, '"')
    .replace(/，/g, ', ')
    .replace(/。/g, '.')
    .replace(/：/g, ': ')
    .replace(/、/g, ', ')
    .replace(/\s{2,}/g, ' ');
  return out.trim();
}

function translateUiTextInternal(raw: string, depth: number): string {
  if (!raw || !ZH_CHAR_RE.test(raw)) return raw;

  const leadMatch = /^\s*/.exec(raw);
  const trailMatch = /\s*$/.exec(raw);
  const leading = leadMatch ? leadMatch[0] : '';
  const trailing = trailMatch ? trailMatch[0] : '';
  const trimmed = raw.slice(leading.length, raw.length - trailing.length);
  if (!trimmed) return raw;

  // Preserve literal language name
  if (trimmed === '简体中文') return raw;

  const directExact = ZH_TO_EN_STATICS[trimmed];
  if (directExact !== undefined) {
    return `${leading}${directExact}${trailing}`;
  }

  const collapsed = trimmed.replace(/\s+/g, ' ');
  const translated = translateCoreSegment(collapsed, depth);
  return `${leading}${translated}${trailing}`;
}

export function translateUiText(raw: string, locale: UiLocale): string {
  if (locale !== 'en' || !raw || !ZH_CHAR_RE.test(raw)) {
    return raw;
  }
  return translateUiTextInternal(raw, 0);
}

export function t(zh: string, en: string, locale: UiLocale = 'zh-CN'): string {
  return locale === 'en' ? en : zh;
}
