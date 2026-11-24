import type { SessionMeshCommand, SessionMeshResponse } from '../protocol';

export class SessionMeshCommandError extends Error {
  readonly code: string;
  readonly phase?: string;
  readonly suggestion?: string;

  constructor(error?: SessionMeshResponse['error'], fallbackMessage = 'Command failed') {
    super(error?.message || fallbackMessage);
    this.name = 'SessionMeshCommandError';
    this.code = error?.code || 'ERR_UNKNOWN';
    this.phase = error?.phase;
    this.suggestion = error?.suggestion;
  }
}

/**
 * Send a typed SessionMeshCommand to the MV3 Background Service Worker via chrome.runtime.sendMessage.
 * Safely catches runtime disconnection, lastError, malformed replies, and timeouts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendSessionMeshCommand<T = any>(
  cmd: SessionMeshCommand,
  timeoutMs = 30_000,
): Promise<SessionMeshResponse<T>> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return {
      ok: false,
      error: {
        code: 'ERR_RUNTIME_UNAVAILABLE',
        phase: 'ipc',
        message: 'Extension runtime is unavailable',
        suggestion: '请在浏览器扩展环境中打开页面，或刷新扩展后重试。',
      },
    };
  }

  return new Promise<SessionMeshResponse<T>>(resolve => {
    let settled = false;
    const finish = (response: SessionMeshResponse<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: {
          code: 'ERR_IPC_TIMEOUT',
          phase: 'ipc',
          message: `Command ${cmd.type} timed out after ${timeoutMs}ms`,
          suggestion: '后台服务响应超时，请稍后重试。',
        },
      });
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(cmd, (response: SessionMeshResponse<T> | undefined) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          finish({
            ok: false,
            error: {
              code: 'ERR_IPC_RUNTIME',
              phase: 'ipc',
              message: lastError.message || 'Background communication failed',
              suggestion: '后台服务可能正在重启，请重试操作。',
            },
          });
          return;
        }
        if (!response || typeof response.ok !== 'boolean') {
          finish({
            ok: false,
            error: {
              code: 'ERR_IPC_EMPTY_RESPONSE',
              phase: 'ipc',
              message: `No valid response returned for ${cmd.type}`,
              suggestion: '请检查扩展后台 Service Worker 状态并重试。',
            },
          });
          return;
        }
        finish(response);
      });
    } catch (err) {
      finish({
        ok: false,
        error: {
          code: 'ERR_IPC_EXCEPTION',
          phase: 'ipc',
          message: err instanceof Error ? err.message : String(err),
          suggestion: '扩展上下文已更新，请重新打开页面。',
        },
      });
    }
  });
}

/**
 * Send a command and return its `data`, throwing SessionMeshCommandError when `!res.ok`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function unwrapCommand<T = any>(cmd: SessionMeshCommand, timeoutMs?: number): Promise<T> {
  const res = await sendSessionMeshCommand<T>(cmd, timeoutMs);
  if (!res.ok) {
    throw new SessionMeshCommandError(res.error, `Command ${cmd.type} failed`);
  }
  return res.data as T;
}
