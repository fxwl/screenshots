import type { LogEntry, StorageBackend, StructuredError } from '../types';

const DIAGNOSTICS_NS = 'diagnostics_logs';
const DIAGNOSTICS_KEY = 'entries';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrubs passwords, Bearer/Basic tokens, pairing codes, URL credentials,
 * Cookie/Set-Cookie headers, and any explicitly registered secrets from text.
 * Enforces Prohibition #15 (zero sensitive credential leakage in logs/UI).
 */
export function scrubSensitiveText(text: string, extraSecrets?: string[]): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text ?? '';
  }

  let out = text;

  // 1. Explicitly supplied secrets (longest first to prevent partial match fragments)
  if (extraSecrets && extraSecrets.length > 0) {
    const candidates = new Set<string>();
    for (const raw of extraSecrets) {
      if (!raw || raw.length < 3) continue;
      candidates.add(raw);
      try {
        const encoded = encodeURIComponent(raw);
        if (encoded && encoded !== raw && encoded.length >= 3) {
          candidates.add(encoded);
        }
      } catch {
        // ignore invalid URI sequences
      }
    }
    const sorted = Array.from(candidates).sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
    }
  }

  // 2. Pairing codes: smesh://pair/v1.<base64url>
  out = out.replace(/smesh:\/\/pair\/[^\s"'<>]+/gi, 'smesh://pair/[REDACTED]');

  // 3. URL embedded credentials: https://user:pass@host
  out = out.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]@');

  // 4. Authorization headers and standalone Bearer / Basic tokens
  out = out.replace(
    /(Authorization\s*:\s*)(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    '$1$2 [REDACTED]',
  );
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{6,}=*/g, '$1 [REDACTED]');

  // 5. Raw Cookie / Set-Cookie headers
  out = out.replace(/(Set-Cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
  out = out.replace(/(Cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');

  // 6. Query parameters containing sensitive keys
  out = out.replace(
    /([?&](?:password|passwd|pwd|token|secret|passphrase|auth|access_token|cookie)=)[^&\s]+/gi,
    '$1[REDACTED]',
  );

  // 7. JSON-like sensitive fields
  out = out.replace(
    /("(?:password|passwd|encryptionPassword|bearerToken|passphrase|currentDekBase64|dek|dekBase64|secret|cookieValue|authorization)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  );

  // 8. Key=value or key: value sensitive tokens in free-form text
  out = out.replace(
    /(\b(?:password|passwd|encryptionPassword|bearerToken|passphrase|secret|cookieValue)\s*[:=]\s*)(?!\[REDACTED\])([^\s,;'"}\]]+)/gi,
    '$1[REDACTED]',
  );

  return out;
}

interface HttpErrorLike {
  status?: number;
  code?: string;
  phase?: string;
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  suggestion?: string;
  name?: string;
}

function isStructuredErrorShape(err: unknown): err is StructuredError {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    typeof e.phase === 'string' &&
    typeof e.message === 'string' &&
    typeof e.retryable === 'boolean' &&
    typeof e.suggestion === 'string' &&
    typeof e.timestamp === 'number'
  );
}

/**
 * Normalizes any thrown error (WebDAVHttpError, Crypto decrypt error,
 * network/offline failure, validation error) into a scrubbed StructuredError.
 */
export function toStructuredError(
  err: unknown,
  defaultPhase = 'sync',
  target?: string,
): StructuredError {
  const now = Date.now();

  if (isStructuredErrorShape(err)) {
    return {
      ...err,
      message: scrubSensitiveText(err.message),
      target: err.target ? scrubSensitiveText(err.target) : target ? scrubSensitiveText(target) : undefined,
      suggestion: scrubSensitiveText(err.suggestion),
    };
  }

  const obj = (err && typeof err === 'object' ? (err as HttpErrorLike) : {}) as HttpErrorLike;
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof obj.message === 'string'
        ? obj.message
        : typeof err === 'string'
          ? err
          : 'Unknown error';
  const message = scrubSensitiveText(rawMessage);
  const safeTarget = target ? scrubSensitiveText(target) : undefined;
  const status = typeof obj.status === 'number' ? obj.status : undefined;

  // WebDAV HTTP error mapping
  if (status !== undefined && status > 0) {
    if (status === 401) {
      return {
        code: obj.code || 'ERR_WEBDAV_AUTH',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: false,
        suggestion:
          obj.suggestion ||
          'WebDAV 认证失败（401），请检查用户名、密码或应用专用密码。本地与云端数据均安全保留。',
        timestamp: now,
      };
    }
    if (status === 403) {
      return {
        code: obj.code || 'ERR_WEBDAV_FORBIDDEN',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: false,
        suggestion:
          obj.suggestion ||
          'WebDAV 权限不足（403），当前账户无权写入或读取该目录，请检查目录权限。',
        timestamp: now,
      };
    }
    if (status === 404) {
      return {
        code: obj.code || 'ERR_WEBDAV_NOT_FOUND',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: false,
        suggestion:
          obj.suggestion || '远端路径不存在（404），请确认 WebDAV 根目录配置是否正确。',
        timestamp: now,
      };
    }
    if (status === 412) {
      return {
        code: obj.code || 'ERR_WEBDAV_CONFLICT',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: true,
        suggestion:
          obj.suggestion || '远端资源版本已更新（412），系统将自动拉取最新数据并合并重试。',
        timestamp: now,
      };
    }
    if (status === 423) {
      return {
        code: obj.code || 'ERR_WEBDAV_LOCKED',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: true,
        suggestion:
          obj.suggestion || '远端资源已被服务器锁定（423），稍后将自动重试。',
        timestamp: now,
      };
    }
    if (status === 429) {
      return {
        code: obj.code || 'ERR_WEBDAV_RATE_LIMIT',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: true,
        suggestion:
          obj.suggestion ||
          'WebDAV 请求频率受限（429），建议启用「低频省流模式」，系统将自动退避重试。',
        timestamp: now,
      };
    }
    if (status === 507) {
      return {
        code: 'ERR_STORAGE_FULL',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: false,
        suggestion:
          obj.suggestion ||
          'WebDAV 存储空间已满（507），已立即暂停写入重试。请释放远端空间或执行历史垃圾回收后重试。',
        timestamp: now,
      };
    }
    if (status >= 500) {
      return {
        code: obj.code || 'ERR_WEBDAV_SERVER',
        phase: obj.phase || defaultPhase,
        message,
        target: safeTarget,
        status,
        retryable: true,
        suggestion:
          obj.suggestion ||
          `WebDAV 服务器暂时不可用（${status}），待同步变更已安全保存，稍后将自动重试。`,
        timestamp: now,
      };
    }
    return {
      code: obj.code || `ERR_WEBDAV_${status}`,
      phase: obj.phase || defaultPhase,
      message,
      target: safeTarget,
      status,
      retryable: obj.retryable ?? false,
      suggestion:
        obj.suggestion || `WebDAV 请求返回异常状态码 ${status}，请检查服务器配置与日志。`,
      timestamp: now,
    };
  }

  // Decryption / password / integrity error detection
  const combinedText = `${obj.code || ''} ${obj.name || ''} ${rawMessage}`;
  if (
    /DECRYPT|decrypt|OperationError|authentication tag|wrong password|invalid password|invalid passphrase|AAD|SMES|tamper|corrupt/i.test(
      combinedText,
    )
  ) {
    return {
      code: 'DECRYPT_ERROR',
      phase: obj.phase || 'decrypt',
      message,
      target: safeTarget,
      retryable: false,
      suggestion:
        '端到端加密密码不正确或远端密文已损坏。已中止写入以保护本地与云端数据安全，请核对加密密码。',
      timestamp: now,
    };
  }

  // Network / offline / timeout errors
  if (
    obj.code === 'ERR_NETWORK_OFFLINE' ||
    /offline|network|Failed to fetch|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|AbortError|timeout|unreachable/i.test(
      combinedText,
    )
  ) {
    return {
      code: 'ERR_NETWORK_OFFLINE',
      phase: obj.phase || defaultPhase,
      message,
      target: safeTarget,
      retryable: true,
      suggestion:
        '当前网络离线或 WebDAV 服务器不可达。所有待同步变更已本地持久化，网络恢复后将自动补传。',
      timestamp: now,
    };
  }

  // URL / HTTPS validation errors
  if (/https|invalid url|insecure/i.test(combinedText)) {
    return {
      code: obj.code || 'ERR_INVALID_URL',
      phase: obj.phase || 'config',
      message,
      target: safeTarget,
      retryable: false,
      suggestion: '请填写合法的 HTTPS WebDAV 服务地址（默认禁止非加密 HTTP）。',
      timestamp: now,
    };
  }

  return {
    code: obj.code || 'ERR_UNKNOWN',
    phase: obj.phase || defaultPhase,
    message,
    target: safeTarget,
    retryable: obj.retryable ?? false,
    suggestion: obj.suggestion || '同步过程中出现异常，请查看诊断日志并稍后重试。',
    timestamp: now,
  };
}

export class DiagnosticLogger {
  private readonly storage: StorageBackend;
  private readonly maxEntries: number;
  private readonly secrets = new Set<string>();
  private counter = 0;

  constructor(storage: StorageBackend, maxEntries = 500) {
    this.storage = storage;
    this.maxEntries = Math.max(10, maxEntries);
  }

  registerSecret(secret?: string): void {
    if (secret && secret.length >= 3) {
      this.secrets.add(secret);
    }
  }

  async log(entry: Omit<LogEntry, 'id' | 'timestamp'> & { timestamp?: number }): Promise<LogEntry> {
    const extraSecrets = Array.from(this.secrets);
    const timestamp = entry.timestamp ?? Date.now();
    this.counter += 1;

    const scrubbed: LogEntry = {
      id: `log_${timestamp}_${this.counter}`,
      spaceId: entry.spaceId,
      level: entry.level,
      phase: entry.phase,
      code: entry.code,
      message: scrubSensitiveText(entry.message, extraSecrets),
      siteKey: entry.siteKey,
      objectId: entry.objectId ? scrubSensitiveText(entry.objectId, extraSecrets) : undefined,
      deviceId: entry.deviceId,
      suggestion: entry.suggestion ? scrubSensitiveText(entry.suggestion, extraSecrets) : undefined,
      timestamp,
    };

    const existing = (await this.storage.get<LogEntry[]>(DIAGNOSTICS_NS, DIAGNOSTICS_KEY)) ?? [];
    existing.push(scrubbed);
    const trimmed =
      existing.length > this.maxEntries
        ? existing.slice(existing.length - this.maxEntries)
        : existing;

    await this.storage.set(DIAGNOSTICS_NS, DIAGNOSTICS_KEY, trimmed);
    return scrubbed;
  }

  async list(filter?: { spaceId?: string; siteKey?: string; limit?: number }): Promise<LogEntry[]> {
    const existing = (await this.storage.get<LogEntry[]>(DIAGNOSTICS_NS, DIAGNOSTICS_KEY)) ?? [];
    let filtered = existing;
    if (filter?.spaceId) {
      filtered = filtered.filter((e) => e.spaceId === filter.spaceId);
    }
    if (filter?.siteKey) {
      filtered = filtered.filter((e) => e.siteKey === filter.siteKey);
    }
    // Newest first
    const ordered = [...filtered].reverse();
    if (filter?.limit && filter.limit > 0) {
      return ordered.slice(0, filter.limit);
    }
    return ordered;
  }

  async clear(spaceId?: string): Promise<void> {
    if (!spaceId) {
      await this.storage.set(DIAGNOSTICS_NS, DIAGNOSTICS_KEY, []);
      return;
    }
    const existing = (await this.storage.get<LogEntry[]>(DIAGNOSTICS_NS, DIAGNOSTICS_KEY)) ?? [];
    const remaining = existing.filter((e) => e.spaceId !== spaceId);
    await this.storage.set(DIAGNOSTICS_NS, DIAGNOSTICS_KEY, remaining);
  }
}
