/**
 * Pure TypeScript RFC 4918 Namespace-Aware XML Parser for WebDAV 207 Multi-Status responses.
 * Deliberately avoids DOMParser (unavailable in Chromium/Edge MV3 Service Workers).
 * Supports D:, d:, default xmlns="DAV:", Apache lp1:, and Nextcloud oc:/nc: namespaces.
 */
import type { WebDAVResourceStat } from '../types';

const DAV_NS = 'DAV:';

export function normalizeEtag(etag?: string | null): string | undefined {
  if (etag === null || etag === undefined) return undefined;
  let s = etag.trim();
  if (!s) return undefined;
  // Unescape common XML quote entities if raw text was passed directly
  if (s.includes('&quot;')) {
    s = s.replace(/&quot;/g, '"');
  }
  // Strip weak validator prefix W/ or w/
  if (s.startsWith('W/') || s.startsWith('w/')) {
    s = s.slice(2).trim();
  }
  // Strip surrounding double quotes
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  return s.length > 0 ? s : undefined;
}

interface XmlNode {
  rawName: string;
  prefix: string;
  localName: string;
  namespaceURI: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeXmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          const codePoint = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
        }
        if (entity.startsWith('#')) {
          const codePoint = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
        }
        return _match;
      }
    }
  });
}

function splitQName(rawName: string): { prefix: string; localName: string } {
  const idx = rawName.indexOf(':');
  if (idx === -1) return { prefix: '', localName: rawName };
  return { prefix: rawName.slice(0, idx), localName: rawName.slice(idx + 1) };
}

function parseAttributes(attrSource: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrSource)) !== null) {
    const key = match[1];
    const val = match[2] !== undefined ? match[2] : match[3] ?? '';
    attrs[key] = decodeXmlEntities(val);
  }
  return attrs;
}

/**
 * Lightweight, zero-dependency, namespace-resolving XML parser.
 * Handles XML declarations, comments, CDATA, self-closing elements, and nested namespace scopes.
 */
function parseXmlTree(xmlText: string): XmlNode | null {
  const root: XmlNode = {
    rawName: '#document',
    prefix: '',
    localName: '#document',
    namespaceURI: '',
    attributes: {},
    children: [],
    text: '',
  };

  interface StackFrame {
    node: XmlNode;
    nsMap: Record<string, string>;
  }

  const stack: StackFrame[] = [{ node: root, nsMap: {} }];
  const len = xmlText.length;
  let pos = 0;

  while (pos < len) {
    const lt = xmlText.indexOf('<', pos);
    if (lt === -1) {
      const trailing = xmlText.slice(pos);
      if (trailing) {
        stack[stack.length - 1].node.text += decodeXmlEntities(trailing);
      }
      break;
    }

    if (lt > pos) {
      const textChunk = xmlText.slice(pos, lt);
      stack[stack.length - 1].node.text += decodeXmlEntities(textChunk);
    }

    // Comment <!-- ... -->
    if (xmlText.startsWith('<!--', lt)) {
      const end = xmlText.indexOf('-->', lt + 4);
      pos = end === -1 ? len : end + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (xmlText.startsWith('<![CDATA[', lt)) {
      const end = xmlText.indexOf(']]>', lt + 9);
      const cdata = end === -1 ? xmlText.slice(lt + 9) : xmlText.slice(lt + 9, end);
      stack[stack.length - 1].node.text += cdata;
      pos = end === -1 ? len : end + 3;
      continue;
    }

    // Processing instruction <? ... ?>
    if (xmlText.startsWith('<?', lt)) {
      const end = xmlText.indexOf('?>', lt + 2);
      pos = end === -1 ? len : end + 2;
      continue;
    }

    // DOCTYPE / declaration <! ... >
    if (xmlText.startsWith('<!', lt)) {
      const end = xmlText.indexOf('>', lt + 2);
      pos = end === -1 ? len : end + 1;
      continue;
    }

    // Find closing '>' taking care not to match '>' inside quoted attribute values
    let gt = -1;
    let quoteChar: string | null = null;
    for (let i = lt + 1; i < len; i += 1) {
      const ch = xmlText[i];
      if (quoteChar) {
        if (ch === quoteChar) quoteChar = null;
      } else if (ch === '"' || ch === "'") {
        quoteChar = ch;
      } else if (ch === '>') {
        gt = i;
        break;
      }
    }

    if (gt === -1) {
      break;
    }

    const inside = xmlText.slice(lt + 1, gt).trim();
    pos = gt + 1;

    if (!inside) continue;

    // Closing tag </...>
    if (inside.startsWith('/')) {
      const closeName = inside.slice(1).trim();
      // Pop matching frame (tolerant of minor mismatch)
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        const frame = stack[i];
        if (
          frame.node.rawName === closeName ||
          frame.node.localName === splitQName(closeName).localName
        ) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const selfClosing = inside.endsWith('/');
    const tagBody = selfClosing ? inside.slice(0, -1).trim() : inside;

    const spaceIdx = tagBody.search(/[\s\r\n\t]/);
    const rawName = spaceIdx === -1 ? tagBody : tagBody.slice(0, spaceIdx);
    const attrPart = spaceIdx === -1 ? '' : tagBody.slice(spaceIdx + 1);
    const attributes = attrPart ? parseAttributes(attrPart) : {};

    const parentFrame = stack[stack.length - 1];
    const nsMap: Record<string, string> = { ...parentFrame.nsMap };
    for (const [k, v] of Object.entries(attributes)) {
      if (k === 'xmlns') {
        nsMap[''] = v;
      } else if (k.startsWith('xmlns:')) {
        nsMap[k.slice(6)] = v;
      }
    }

    const { prefix, localName } = splitQName(rawName);
    const namespaceURI = nsMap[prefix] ?? '';

    const node: XmlNode = {
      rawName,
      prefix,
      localName,
      namespaceURI,
      attributes,
      children: [],
      text: '',
    };

    parentFrame.node.children.push(node);
    if (!selfClosing) {
      stack.push({ node, nsMap });
    }
  }

  return root.children[0] ?? null;
}

function isDavOrUnqualified(node: XmlNode, localName: string): boolean {
  if (node.localName.toLowerCase() !== localName.toLowerCase()) return false;
  return node.namespaceURI === DAV_NS || node.namespaceURI === '' || node.namespaceURI.toUpperCase() === DAV_NS;
}

function findDirectChildren(parent: XmlNode, localName: string, davOnly = true): XmlNode[] {
  return parent.children.filter((c) =>
    davOnly ? isDavOrUnqualified(c, localName) : c.localName.toLowerCase() === localName.toLowerCase(),
  );
}

function findDirectChild(parent: XmlNode, localName: string, davOnly = true): XmlNode | undefined {
  return findDirectChildren(parent, localName, davOnly)[0];
}

function parseHttpStatusLine(statusText: string): number {
  const match = statusText.match(/HTTP\/\d+(?:\.\d+)?\s+(\d{3})/i);
  if (!match) return 200;
  return Number.parseInt(match[1], 10);
}

function safeDecodePath(rawPath: string): string {
  return rawPath
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function normalizePathSlashes(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, '/');
  if (collapsed === '' || collapsed === '/') return '/';
  const withLeading = collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

function extractPathnameFromHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return '/';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return trimmed;
    }
  }
  const qIdx = trimmed.indexOf('?');
  return qIdx === -1 ? trimmed : trimmed.slice(0, qIdx);
}

function stripBasePath(decodedPath: string, basePath?: string, detectedMountPrefix?: string): string {
  const normPath = normalizePathSlashes(decodedPath);
  if (detectedMountPrefix && detectedMountPrefix !== '/') {
    if (normPath === detectedMountPrefix) return '/';
    if (normPath.startsWith(`${detectedMountPrefix}/`)) {
      return normPath.slice(detectedMountPrefix.length);
    }
  }
  if (!basePath) return normPath;
  const normBase = normalizePathSlashes(safeDecodePath(basePath));
  if (normBase === '/') return normPath;
  if (normPath === normBase) return '/';
  if (normPath.startsWith(`${normBase}/`)) {
    return normPath.slice(normBase.length);
  }
  // Reverse-proxy prefix tolerance (e.g. client URL `/SessionMesh` proxied to `/dav/SessionMesh`)
  if (normPath.endsWith(normBase)) {
    return '/';
  }
  const idx = normPath.indexOf(`${normBase}/`);
  if (idx > 0) {
    return normPath.slice(idx + normBase.length);
  }
  return normPath;
}

export function parseWebDAVMultistatusXml(xmlText: string, basePath?: string): WebDAVResourceStat[] {
  if (!xmlText || !xmlText.trim()) return [];
  const docEl = parseXmlTree(xmlText);
  if (!docEl) return [];

  const responseNodes = isDavOrUnqualified(docEl, 'multistatus')
    ? findDirectChildren(docEl, 'response', true)
    : isDavOrUnqualified(docEl, 'response')
      ? [docEl]
      : [];

  const results: WebDAVResourceStat[] = [];

  for (const resp of responseNodes) {
    const hrefNode = findDirectChild(resp, 'href', true);
    const rawHref = hrefNode ? hrefNode.text.trim() : '';
    if (!rawHref) continue;

    const rawPathname = extractPathnameFromHref(rawHref);
    const decodedPathname = safeDecodePath(rawPathname);
    const relativePath = stripBasePath(decodedPathname, basePath);
    const segments = relativePath.split('/').filter(Boolean);
    const name = segments.length > 0 ? segments[segments.length - 1] : '';

    let isCollection = false;
    let hasResourceTypeProp = false;
    let etag: string | undefined;
    let size = 0;
    let hasContentLength = false;
    let ocSize: number | undefined;
    let lastModified: number | undefined;
    let quotaUsedBytes: number | undefined;
    let quotaAvailableBytes: number | undefined;
    let status = 200;

    const respStatusNode = findDirectChild(resp, 'status', true);
    if (respStatusNode && respStatusNode.text.trim()) {
      status = parseHttpStatusLine(respStatusNode.text.trim());
    }

    const propstats = findDirectChildren(resp, 'propstat', true);
    let saw2xxPropstat = false;
    let firstPropstatStatus: number | undefined;

    for (const ps of propstats) {
      const statusNode = findDirectChild(ps, 'status', true);
      const psStatus = statusNode && statusNode.text.trim() ? parseHttpStatusLine(statusNode.text.trim()) : 200;
      if (firstPropstatStatus === undefined) firstPropstatStatus = psStatus;

      // RFC 4918: only extract properties from successful 2xx propstats!
      if (psStatus < 200 || psStatus >= 300) {
        continue;
      }
      saw2xxPropstat = true;
      status = psStatus;

      const propNode = findDirectChild(ps, 'prop', true);
      if (!propNode) continue;

      for (const prop of propNode.children) {
        const local = prop.localName.toLowerCase();
        const isDav = prop.namespaceURI === DAV_NS || prop.namespaceURI === '' || prop.namespaceURI.toUpperCase() === DAV_NS;

        if (isDav && local === 'resourcetype') {
          hasResourceTypeProp = true;
          if (findDirectChild(prop, 'collection', true)) {
            isCollection = true;
          }
        } else if (isDav && local === 'getetag') {
          const normalized = normalizeEtag(prop.text);
          if (normalized !== undefined) etag = normalized;
        } else if (isDav && local === 'getcontentlength') {
          const parsed = Number.parseInt(prop.text.trim(), 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            size = parsed;
            hasContentLength = true;
          }
        } else if (isDav && local === 'getlastmodified') {
          const ms = Date.parse(prop.text.trim());
          if (!Number.isNaN(ms)) {
            lastModified = ms;
          }
        } else if (isDav && local === 'quota-used-bytes') {
          const parsed = Number.parseInt(prop.text.trim(), 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            quotaUsedBytes = parsed;
          }
        } else if (isDav && local === 'quota-available-bytes') {
          const parsed = Number.parseInt(prop.text.trim(), 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            quotaAvailableBytes = parsed;
          }
        } else if (local === 'size' && prop.namespaceURI.includes('owncloud')) {
          const parsed = Number.parseInt(prop.text.trim(), 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            ocSize = parsed;
          }
        }
      }
    }

    if (propstats.length > 0 && !saw2xxPropstat && firstPropstatStatus !== undefined) {
      status = firstPropstatStatus;
    }

    if (!hasResourceTypeProp && rawPathname.endsWith('/')) {
      isCollection = true;
    }
    if (!hasContentLength && !isCollection && ocSize !== undefined) {
      size = ocSize;
    }

    const stat: WebDAVResourceStat = {
      path: relativePath,
      href: rawHref,
      name,
      isCollection,
      etag,
      size,
      lastModified,
      status,
      quotaUsedBytes,
      quotaAvailableBytes,
    };
    results.push(stat);
  }

  return results;
}
