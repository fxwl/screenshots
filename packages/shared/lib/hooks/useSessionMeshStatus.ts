import { DEFAULT_SYNC_STATUS_SUMMARY, uiStateStorage } from '@sessionmesh/storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sendSessionMeshCommand } from '../ipc';
import type { CurrentSiteSnapshot, PopupSummaryPayload, SpaceSettings, SyncStatusSummary } from '../protocol';
import { isSyncableHttpUrl } from '../utils';
import { useStorage } from './useStorage';

export interface UseSessionMeshStatusResult {
  status: SyncStatusSummary;
  currentSite: CurrentSiteSnapshot | null;
  settings: SpaceSettings | null;
  refresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
  revision: number;
}

async function resolveCurrentTabUrl(explicitUrl?: string): Promise<string | undefined> {
  if (explicitUrl !== undefined) {
    return explicitUrl;
  }
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
    return undefined;
  }
  try {
    const tabs = await new Promise<chrome.tabs.Tab[]>(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, result => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(result || []);
      });
    });
    const url = tabs[0]?.url;
    return isSyncableHttpUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function isPopupSummaryPayload(data: unknown): data is PopupSummaryPayload {
  return Boolean(
    data && typeof data === 'object' && 'status' in data && typeof (data as PopupSummaryPayload).status === 'object',
  );
}

/**
 * Subscribes to reactive `uiStateStorage` (chrome.storage.local liveUpdate) AND
 * queries Background `GET_STATUS_SUMMARY` so Popup, Options, and SidePanel stay
 * synchronized in real time.
 */
export function useSessionMeshStatus(activeUrl?: string): UseSessionMeshStatusResult {
  const uiSnapshot = useStorage(uiStateStorage);
  const revision = uiSnapshot?.revision ?? 0;

  const [fetchedStatus, setFetchedStatus] = useState<SyncStatusSummary | null>(null);
  const [currentSite, setCurrentSite] = useState<CurrentSiteSnapshot | null>(null);
  const [settings, setSettings] = useState<SpaceSettings | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const targetUrl = await resolveCurrentTabUrl(activeUrl);
      const res = await sendSessionMeshCommand<PopupSummaryPayload | SyncStatusSummary>({
        type: 'GET_STATUS_SUMMARY',
        activeUrl: targetUrl,
      });

      if (!mountedRef.current || seq !== requestSeqRef.current) return;

      if (res.ok && res.data) {
        if (isPopupSummaryPayload(res.data)) {
          setFetchedStatus(res.data.status);
          setCurrentSite(res.data.currentSite ?? null);
          const payloadWithSettings = res.data as PopupSummaryPayload & { settings?: SpaceSettings };
          if (payloadWithSettings.settings) {
            setSettings(payloadWithSettings.settings);
          }
        } else {
          setFetchedStatus(res.data);
          setCurrentSite(null);
        }
        setError(null);
      } else {
        setError(res.error?.message || '无法获取同步状态');
      }
    } catch (err) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [activeUrl]);

  // Initial fetch + automatic refresh whenever Background bumps uiStateStorage.revision
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  // Prefer live uiStateStorage status once Background has published at least once,
  // while falling back cleanly to fetchedStatus or default unconfigured status.
  const status: SyncStatusSummary =
    (uiSnapshot && uiSnapshot.revision > 0 ? uiSnapshot.status : fetchedStatus) ??
    uiSnapshot?.status ??
    DEFAULT_SYNC_STATUS_SUMMARY;

  return {
    status,
    currentSite,
    settings,
    refresh,
    loading,
    error,
    revision,
  };
}
