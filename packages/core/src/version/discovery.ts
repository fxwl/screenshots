import type {
  BrowserCookieInput,
  DeviceSiteBinding,
  PendingSiteDecision,
  SiteDecisionAction,
  SiteTrack,
  SpaceSettings,
} from '../types';
import { isAnalyticsNoiseCookie } from '../psl';

export interface SiteDiscoveryInput {
  siteKey: string;
  isBlacklisted: boolean;
  existingBinding?: DeviceSiteBinding;
  localCookies: BrowserCookieInput[];
  localStorageCount: number;
  remoteTracks: SiteTrack[];
  deviceId: string;
  deviceName: string;
  filterNoise: boolean;
  nowMs?: number;
}

export interface SiteDiscoveryDecision {
  binding: DeviceSiteBinding;
  createdTrack?: SiteTrack;
  pendingDecision?: PendingSiteDecision;
  action:
    | 'skip_blacklisted'
    | 'create_initial_track'
    | 'auto_pull_remote'
    | 'sync_bound_track'
    | 'await_user_choice';
}

function isBoundState(state: DeviceSiteBinding['state']): boolean {
  return state === 'AUTO_BOUND' || state === 'USER_BOUND' || state === 'INDEPENDENT';
}

function buildInitialTrackId(deviceId: string, siteKey: string): string {
  return `trk_${deviceId}_${siteKey}`;
}

function buildUniqueIndependentTrackId(
  deviceId: string,
  siteKey: string,
  existingTrackIds: string[],
  nowMs: number,
): string {
  const base = buildInitialTrackId(deviceId, siteKey);
  if (!existingTrackIds.includes(base)) {
    return base;
  }
  let candidate = `${base}_${nowMs}`;
  let suffix = 1;
  while (existingTrackIds.includes(candidate)) {
    candidate = `${base}_${nowMs}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * SiteDiscoveryEngine: Evaluates all 5 multi-device discovery flows for a site:
 * 1. Blacklisted -> skip_blacklisted (highest priority)
 * 2. Already validly bound (AUTO_BOUND / USER_BOUND / INDEPENDENT) -> sync_bound_track
 * 3. Unbound, 0 remote tracks, local meaningful data > 0 -> create_initial_track (AUTO_BOUND)
 * 4. Unbound, 1 remote track, local meaningful data === 0 -> auto_pull_remote (AUTO_BOUND)
 * 5. Unbound, >=1 remote tracks & local meaningful > 0 (both_sides_have_data)
 *    OR >=2 remote tracks & local meaningful === 0 (multiple_remote_tracks) -> await_user_choice (PENDING_CHOICE)
 */
export function evaluateSiteDiscovery(input: SiteDiscoveryInput): SiteDiscoveryDecision {
  const now = input.nowMs ?? Date.now();
  const meaningfulCookies = input.filterNoise
    ? input.localCookies.filter((cookie) => !isAnalyticsNoiseCookie(cookie.name))
    : input.localCookies;
  const localCookieCount = meaningfulCookies.length;
  const localStorageCount = Math.max(0, input.localStorageCount);
  const hasLocalMeaningfulData = localCookieCount > 0 || localStorageCount > 0;
  const availableTrackIds = input.remoteTracks.map((t) => t.trackId);

  // Flow 1: Blacklist always takes absolute precedence
  if (input.isBlacklisted) {
    return {
      binding: {
        siteKey: input.siteKey,
        state: 'BLACKLISTED',
        trackId: undefined,
        availableTrackIds,
        hasLocalBaseline: hasLocalMeaningfulData,
        localCookieCount,
        decidedAt: now,
        decidedBy:
          input.existingBinding?.state === 'BLACKLISTED'
            ? input.existingBinding.decidedBy
            : 'auto',
      },
      action: 'skip_blacklisted',
    };
  }

  // Flow 2: Already validly bound to an active/valid track
  if (
    input.existingBinding &&
    isBoundState(input.existingBinding.state) &&
    input.existingBinding.trackId
  ) {
    const boundTrackId = input.existingBinding.trackId;
    const trackExistsRemotely = input.remoteTracks.some((t) => t.trackId === boundTrackId);
    const isOwnPendingTrack =
      input.remoteTracks.length === 0 ||
      input.existingBinding.state === 'INDEPENDENT' ||
      boundTrackId.startsWith(`trk_${input.deviceId}_`);

    if (trackExistsRemotely || isOwnPendingTrack) {
      return {
        binding: {
          ...input.existingBinding,
          availableTrackIds: availableTrackIds.includes(boundTrackId)
            ? availableTrackIds
            : [...availableTrackIds, boundTrackId],
          hasLocalBaseline: input.existingBinding.hasLocalBaseline || hasLocalMeaningfulData,
          localCookieCount,
        },
        action: 'sync_bound_track',
      };
    }
  }

  // Flow 3: Unbound discovery
  const remoteTrackCount = input.remoteTracks.length;

  // 3a: Remote has 0 tracks & local has meaningful data -> create initial SiteTrack
  if (remoteTrackCount === 0 && hasLocalMeaningfulData) {
    const trackId = buildInitialTrackId(input.deviceId, input.siteKey);
    const createdTrack: SiteTrack = {
      trackId,
      siteKey: input.siteKey,
      label: `${input.deviceName} 的版本`,
      originDeviceId: input.deviceId,
      originDeviceName: input.deviceName,
      cookieCount: localCookieCount,
      localStorageCount,
      updatedAt: now,
      memberDeviceIds: [input.deviceId],
      revision: 1,
    };

    return {
      binding: {
        siteKey: input.siteKey,
        state: 'AUTO_BOUND',
        trackId,
        availableTrackIds: [trackId],
        hasLocalBaseline: true,
        localCookieCount,
        decidedAt: now,
        decidedBy: 'auto',
      },
      createdTrack,
      action: 'create_initial_track',
    };
  }

  // 3b: Remote has exactly 1 track & local has no meaningful data -> auto-bind & pull
  if (remoteTrackCount === 1 && !hasLocalMeaningfulData) {
    const targetTrack = input.remoteTracks[0];
    return {
      binding: {
        siteKey: input.siteKey,
        state: 'AUTO_BOUND',
        trackId: targetTrack.trackId,
        availableTrackIds,
        hasLocalBaseline: false,
        localCookieCount: 0,
        decidedAt: now,
        decidedBy: 'auto',
      },
      action: 'auto_pull_remote',
    };
  }

  // 3c: Remote has >= 1 tracks & local ALSO has meaningful data -> DO NOT overwrite; await user choice
  if (remoteTrackCount >= 1 && hasLocalMeaningfulData) {
    const pendingDecision: PendingSiteDecision = {
      siteKey: input.siteKey,
      reason: 'both_sides_have_data',
      hasLocalData: true,
      localCookieCount,
      localLocalStorageCount: localStorageCount,
      remoteTracks: [...input.remoteTracks],
      detectedAt: now,
    };

    return {
      binding: {
        siteKey: input.siteKey,
        state: 'PENDING_CHOICE',
        trackId: undefined,
        availableTrackIds,
        hasLocalBaseline: true,
        localCookieCount,
        decidedAt: now,
        decidedBy: 'auto',
      },
      pendingDecision,
      action: 'await_user_choice',
    };
  }

  // 3d: Remote has >= 2 tracks & local has no meaningful data -> ask which track to follow
  if (remoteTrackCount >= 2 && !hasLocalMeaningfulData) {
    const pendingDecision: PendingSiteDecision = {
      siteKey: input.siteKey,
      reason: 'multiple_remote_tracks',
      hasLocalData: false,
      localCookieCount: 0,
      localLocalStorageCount: 0,
      remoteTracks: [...input.remoteTracks],
      detectedAt: now,
    };

    return {
      binding: {
        siteKey: input.siteKey,
        state: 'PENDING_CHOICE',
        trackId: undefined,
        availableTrackIds,
        hasLocalBaseline: false,
        localCookieCount: 0,
        decidedAt: now,
        decidedBy: 'auto',
      },
      pendingDecision,
      action: 'await_user_choice',
    };
  }

  // Neither remote nor local has meaningful data (e.g., site only contains analytics noise cookies).
  // Keep trackId undefined so subsequent login or remote track creation triggers discovery automatically.
  return {
    binding: {
      siteKey: input.siteKey,
      state: 'AUTO_BOUND',
      trackId: undefined,
      availableTrackIds: [],
      hasLocalBaseline: false,
      localCookieCount: 0,
      decidedAt: now,
      decidedBy: 'auto',
    },
    action: 'sync_bound_track',
  };
}

/**
 * Applies an explicit user decision for a site (`use_remote_track`, `use_local_override_track`,
 * `keep_independent`, or `blacklist`).
 */
export function applyUserSiteDecision(params: {
  siteKey: string;
  action: SiteDecisionAction;
  currentBinding?: DeviceSiteBinding;
  remoteTracks: SiteTrack[];
  deviceId: string;
  deviceName: string;
  localCookieCount: number;
  localStorageCount: number;
  nowMs?: number;
}): {
  binding: DeviceSiteBinding;
  newTrack?: SiteTrack;
  blacklistToAdd?: { scope: 'space' | 'device'; pattern: string };
  mode:
    | 'pull_remote_into_local'
    | 'push_local_override_remote'
    | 'push_local_new_track'
    | 'blacklisted';
} {
  const now = params.nowMs ?? Date.now();
  const availableTrackIds = params.remoteTracks.map((t) => t.trackId);
  const localCookieCount = Math.max(0, params.localCookieCount);
  const localStorageCount = Math.max(0, params.localStorageCount);
  const hasLocalBaseline = localCookieCount > 0 || localStorageCount > 0;

  switch (params.action.type) {
    case 'use_remote_track': {
      const targetTrackId = params.action.trackId;
      if (!targetTrackId) {
        throw new Error(`use_remote_track requires a non-empty trackId for site "${params.siteKey}"`);
      }
      if (
        params.remoteTracks.length > 0 &&
        !params.remoteTracks.some((t) => t.trackId === targetTrackId)
      ) {
        throw new Error(`Remote track "${targetTrackId}" not found for site "${params.siteKey}"`);
      }

      return {
        binding: {
          siteKey: params.siteKey,
          state: 'USER_BOUND',
          trackId: targetTrackId,
          availableTrackIds: availableTrackIds.includes(targetTrackId)
            ? availableTrackIds
            : [...availableTrackIds, targetTrackId],
          hasLocalBaseline,
          localCookieCount,
          decidedAt: now,
          decidedBy: 'user',
        },
        mode: 'pull_remote_into_local',
      };
    }

    case 'use_local_override_track': {
      const targetTrackId =
        params.action.trackId ??
        params.remoteTracks[0]?.trackId ??
        buildInitialTrackId(params.deviceId, params.siteKey);

      const existsRemotely = params.remoteTracks.some((t) => t.trackId === targetTrackId);
      const newTrack: SiteTrack | undefined = existsRemotely
        ? undefined
        : {
            trackId: targetTrackId,
            siteKey: params.siteKey,
            label: `${params.deviceName} 的版本`,
            originDeviceId: params.deviceId,
            originDeviceName: params.deviceName,
            cookieCount: localCookieCount,
            localStorageCount,
            updatedAt: now,
            memberDeviceIds: [params.deviceId],
            revision: 1,
          };

      return {
        binding: {
          siteKey: params.siteKey,
          state: 'USER_BOUND',
          trackId: targetTrackId,
          availableTrackIds: availableTrackIds.includes(targetTrackId)
            ? availableTrackIds
            : [...availableTrackIds, targetTrackId],
          hasLocalBaseline: true,
          localCookieCount,
          decidedAt: now,
          decidedBy: 'user',
        },
        newTrack,
        mode: 'push_local_override_remote',
      };
    }

    case 'keep_independent': {
      const trackId = buildUniqueIndependentTrackId(
        params.deviceId,
        params.siteKey,
        availableTrackIds,
        now,
      );
      const label = params.action.customLabel?.trim() || `${params.deviceName} 的独立版本`;
      const newTrack: SiteTrack = {
        trackId,
        siteKey: params.siteKey,
        label,
        originDeviceId: params.deviceId,
        originDeviceName: params.deviceName,
        cookieCount: localCookieCount,
        localStorageCount,
        updatedAt: now,
        memberDeviceIds: [params.deviceId],
        revision: 1,
      };

      return {
        binding: {
          siteKey: params.siteKey,
          state: 'INDEPENDENT',
          trackId,
          availableTrackIds: [...availableTrackIds, trackId],
          hasLocalBaseline,
          localCookieCount,
          decidedAt: now,
          decidedBy: 'user',
        },
        newTrack,
        mode: 'push_local_new_track',
      };
    }

    case 'blacklist': {
      return {
        binding: {
          siteKey: params.siteKey,
          state: 'BLACKLISTED',
          trackId: undefined,
          availableTrackIds,
          hasLocalBaseline,
          localCookieCount,
          decidedAt: now,
          decidedBy: 'user',
        },
        blacklistToAdd: {
          scope: params.action.scope,
          pattern: params.siteKey,
        },
        mode: 'blacklisted',
      };
    }
  }
}

/**
 * Evaluates whether an overlap / multi-track `await_user_choice` discovery result can be
 * resolved automatically based on per-device sync policies (`devicePolicies`) and space-level
 * authority policy (`authorityMode` + `primaryDeviceId`).
 *
 * Returns `null` when user confirmation is still required (e.g. `authorityMode: 'ask'`).
 */
export function resolveAutomaticSiteDecisionAction(params: {
  localDeviceId: string;
  settings: SpaceSettings;
  remoteTracks: SiteTrack[];
  hasLocalData: boolean;
}): SiteDecisionAction | null {
  const { localDeviceId, settings, remoteTracks, hasLocalData } = params;
  const localDevPolicy = settings.devicePolicies?.[localDeviceId];

  // 1. Per-device explicit independent_tracks mode -> keep own track with zero prompt
  if (localDevPolicy?.mode === 'independent_tracks') {
    return { type: 'keep_independent' };
  }

  // 2. Determine target leader device: per-device follow_device > space primary_device
  let targetLeaderId: string | undefined;
  if (localDevPolicy?.mode === 'follow_device' && localDevPolicy.followDeviceId) {
    targetLeaderId = localDevPolicy.followDeviceId;
  } else if (
    (!localDevPolicy || localDevPolicy.mode === 'inherit') &&
    settings.authorityMode === 'primary_device' &&
    settings.primaryDeviceId
  ) {
    targetLeaderId = settings.primaryDeviceId;
  }

  if (targetLeaderId) {
    const leaderId = targetLeaderId;
    if (localDeviceId === leaderId) {
      if (hasLocalData) {
        return {
          type: 'use_local_override_track',
          trackId: remoteTracks[0]?.trackId,
        };
      }
      const ownTrack =
        remoteTracks.find((t) => t.originDeviceId === localDeviceId) ??
        remoteTracks.find((t) => t.memberDeviceIds.includes(localDeviceId));
      if (ownTrack) {
        return { type: 'use_remote_track', trackId: ownTrack.trackId };
      }
      if (remoteTracks.length > 0) {
        const newest = [...remoteTracks].sort(
          (a, b) =>
            b.updatedAt - a.updatedAt ||
            (b.revision ?? 0) - (a.revision ?? 0) ||
            a.trackId.localeCompare(b.trackId),
        )[0];
        return { type: 'use_remote_track', trackId: newest.trackId };
      }
      return null;
    }

    const matched =
      remoteTracks.find((t) => t.originDeviceId === leaderId) ??
      remoteTracks.find((t) => t.memberDeviceIds.includes(leaderId)) ??
      (remoteTracks.length === 1 ? remoteTracks[0] : undefined);
    if (matched) {
      return { type: 'use_remote_track', trackId: matched.trackId };
    }
    return null;
  }

  // 3. Space-level latest_wins mode -> adopt newest remote track automatically
  if (
    (!localDevPolicy || localDevPolicy.mode === 'inherit') &&
    settings.authorityMode === 'latest_wins' &&
    remoteTracks.length > 0
  ) {
    const newest = [...remoteTracks].sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        (b.revision ?? 0) - (a.revision ?? 0) ||
        a.trackId.localeCompare(b.trackId),
    )[0];
    return { type: 'use_remote_track', trackId: newest.trackId };
  }

  return null;
}
