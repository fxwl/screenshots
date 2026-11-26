import type {
  BrowserCandidateSite,
  CapabilityReport,
  InitialJoinReport,
  PairingPayload,
  PendingSiteDecision,
  RemoteSpacePasswordVerifyResult,
  RemoteSpaceProbeItem,
  SpaceSettings,
  StorageProviderConfig,
  SyncScopeMode,
  SyncTimingMode,
} from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@sessionmesh/ui';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CloudUpload,
  Copy,
  Crown,
  Dices,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  Globe,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  PanelRightOpen,
  Plus,
  QrCode,
  RefreshCw,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  Sliders,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  copyToClipboard,
  detectDefaultDeviceName,
  extractErrorMessage,
  formatRelativeTime,
  generateShortPairingPin,
  getStorageProviderMeta,
  openSidePanelFromWindow,
  PRESET_BLACKLIST_OPTIONS,
  saveUiNonSensitiveMeta,
  useUiBannerPrefs,
  useUxOnboardingPrefs,
  type PresetBlacklistCategory,
} from '../utils/helpers';
import { isDirectoryPickerSupported, pickAndStoreLocalDirectory } from '../utils/localDirHandles';
import { CapabilityReportView } from './CapabilityReportView';
import { PendingDecisionsPanel } from './PendingDecisionsPanel';
import {
  buildStorageConfigFromDraft,
  createDefaultStorageDraft,
  draftFromStorageConfig,
  extractStorageSecretForCompare,
  getStorageVerifyIdentity,
  StorageProviderForm,
  stripWebdavProvider,
  toNonSensitiveMetaPatch,
  validateStorageDraft,
  type StorageFormDraft,
} from './StorageProviderForm';

export interface OnboardingWizardProps {
  alreadyConfigured?: boolean;
  initialEntryMode?: 'new_device' | 'pair_code';
  onComplete: () => void | Promise<void>;
  onCancel?: () => void;
  onOpenTutorials?: () => void;
}

const STEPS = [
  { id: 1, title: '选择存储位置', subtitle: '本地同步盘 / Gist / R2 / WebDAV' },
  { id: 2, title: '设置加密密码', subtitle: '保护登录数据，仅你自己可解' },
  { id: 3, title: '勾选同步网站', subtitle: '挑出需要多端共享的网站' },
] as const;

function resolveProbeSpaceId(item: RemoteSpaceProbeItem): string {
  if (item.spaceId && item.spaceId !== 'unknown') return item.spaceId;
  if (item.hintId && item.hintId !== 'unknown') return item.hintId;
  return item.opaqueId;
}

function resolveProbeSpaceName(item: RemoteSpaceProbeItem): string {
  if (item.spaceName && item.spaceName !== 'unknown') return item.spaceName;
  if (item.hintId && item.hintId !== 'unknown') {
    return item.hintId === 'default' ? '默认同步空间' : item.hintId;
  }
  return item.spaceId || item.opaqueId;
}

function parseSmartPairingInput(raw: string): { code: string; pin?: string } {
  const codeMatch = raw.match(/smesh:\/\/pair\/[A-Za-z0-9._~+/=-]+/);
  const pinMatch = raw.match(/(?:口令|PIN|密码)\s*[:：]\s*([^\s\r\n]+)/i);
  return {
    code: codeMatch ? codeMatch[0] : raw.trim(),
    pin: pinMatch ? pinMatch[1].trim() : undefined,
  };
}

function readInitialEntryMode(propMode?: 'new_device' | 'pair_code'): 'new_device' | 'pair_code' {
  if (propMode) return propMode;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'pair') return 'pair_code';
  } catch {
    // ignore
  }
  return 'new_device';
}

export function OnboardingWizard({
  alreadyConfigured = false,
  initialEntryMode,
  onComplete,
  onCancel,
  onOpenTutorials,
}: OnboardingWizardProps) {
  const { isBannerVisible, dismissBanner } = useUiBannerPrefs();
  const { prefs: uxPrefs, updatePrefs: updateUxPrefs, markGuideTaskDone } = useUxOnboardingPrefs();
  const expertMode = uxPrefs.onboardingExpertMode;

  const [entryMode, setEntryMode] = useState<'new_device' | 'pair_code'>(() => readInitialEntryMode(initialEntryMode));
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Express Pairing state (Channel B)
  const [pairingCode, setPairingCode] = useState('');
  const [pairingPassphrase, setPairingPassphrase] = useState('');
  const [decodingPairing, setDecodingPairing] = useState(false);
  const [pairedFromDevice, setPairedFromDevice] = useState<string | null>(null);
  const [pickingPairedLocalDir, setPickingPairedLocalDir] = useState(false);

  // Step 1: Multi-backend storage form (default to easiest beginner option if supported, or webdav)
  const [storageDraft, setStorageDraft] = useState<StorageFormDraft>(() =>
    createDefaultStorageDraft(isDirectoryPickerSupported() ? 'local_directory' : 'github_gist'),
  );
  const [testingConn, setTestingConn] = useState(false);
  const [advancingStep1, setAdvancingStep1] = useState(false);
  const [capabilityReport, setCapabilityReport] = useState<CapabilityReport | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Step 1 & Step 2: Remote space probe + encryption password
  const [probingSpaces, setProbingSpaces] = useState(false);
  const [hasProbedSpaces, setHasProbedSpaces] = useState(false);
  const [remoteSpaces, setRemoteSpaces] = useState<RemoteSpaceProbeItem[]>([]);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [spaceMode, setSpaceMode] = useState<'create' | 'join'>('create');
  const [spaceId, setSpaceId] = useState('default');
  const [spaceName, setSpaceName] = useState('默认同步空间');
  const [showCustomSpaceMeta, setShowCustomSpaceMeta] = useState(false);
  const userEditedStep2Ref = useRef(false);
  const storageVersionRef = useRef(0);
  const [deviceName, setDeviceName] = useState(() => detectDefaultDeviceName());
  const [encryptionPassword, setEncryptionPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showEncPassword, setShowEncPassword] = useState(false);
  const [verifyingPassword, setVerifyingPassword] = useState(false);
  const [passwordVerifyState, setPasswordVerifyState] = useState<{
    ok: boolean;
    key: string;
    message: string;
  } | null>(null);

  // Step 2 Collapsible Advanced Policy Settings
  const [policyExpanded, setPolicyExpanded] = useState(false);
  const [syncScopeMode, setSyncScopeMode] = useState<SyncScopeMode>('managed_only');
  const [setAsPrimaryAuthority, setSetAsPrimaryAuthority] = useState(false);
  const [selectedPresets, setSelectedPresets] = useState<PresetBlacklistCategory[]>(() =>
    PRESET_BLACKLIST_OPTIONS.filter(p => p.defaultChecked).map(p => p.category),
  );
  const [autoSync, setAutoSync] = useState(true);
  const [syncTimingMode, setSyncTimingMode] = useState<SyncTimingMode>('on_page_leave');
  const [syncLocalStorage, setSyncLocalStorage] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshProtection, setRefreshProtection] = useState(true);
  const [lowFrequencyMode, setLowFrequencyMode] = useState(false);
  const [sessionLockEnabled, setSessionLockEnabled] = useState(false);
  const [joiningSpace, setJoiningSpace] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Step 3: InitialJoinReport + Opt-In Managed Sites picker + Instant Pairing Generator
  const [joinReport, setJoinReport] = useState<InitialJoinReport | null>(null);
  const [pendingDecisions, setPendingDecisions] = useState<PendingSiteDecision[]>([]);
  const [blacklistedUploaded, setBlacklistedUploaded] = useState<Record<string, boolean>>({});
  const [blacklistingSite, setBlacklistingSite] = useState<Record<string, boolean>>({});
  const [showReportDetails, setShowReportDetails] = useState(false);

  const [candidateSites, setCandidateSites] = useState<BrowserCandidateSite[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selectedCandidateKeys, setSelectedCandidateKeys] = useState<Record<string, boolean>>({});
  const [addingManaged, setAddingManaged] = useState(false);

  // Instant pairing generator on Step 3 finish screen
  const [finishPairingOpen, setFinishPairingOpen] = useState(false);
  const [finishPairingPin, setFinishPairingPin] = useState('');
  const [finishPairingCode, setFinishPairingCode] = useState('');
  const [generatingFinishPair, setGeneratingFinishPair] = useState(false);

  useEffect(() => {
    try {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch {
      window.scrollTo(0, 0);
    }
  }, [step, entryMode]);

  useEffect(() => {
    if (expertMode) {
      setShowCustomSpaceMeta(true);
      setPolicyExpanded(true);
    }
  }, [expertMode]);

  useEffect(() => {
    if (storageDraft.provider === 'webdav' && storageDraft.webdavUrl.toLowerCase().includes('jianguoyun.com')) {
      setLowFrequencyMode(true);
    }
  }, [storageDraft.provider, storageDraft.webdavUrl]);

  const handleStorageDraftChange = (next: StorageFormDraft) => {
    storageVersionRef.current += 1;
    setStorageDraft(next);
    setStep1Error(null);
    setHasProbedSpaces(false);
    setProbeError(null);
    setCapabilityReport(null);
    userEditedStep2Ref.current = false;
  };

  const probeSpaces = async (
    explicitStorage?: StorageProviderConfig,
    expectedVersion?: number,
  ): Promise<RemoteSpaceProbeItem[]> => {
    const versionAtStart = expectedVersion ?? storageVersionRef.current;
    if (!explicitStorage) {
      const errMsg = validateStorageDraft(storageDraft);
      if (errMsg) {
        setStep1Error(errMsg);
        return [];
      }
      setStep1Error(null);
    }
    setProbingSpaces(true);
    setProbeError(null);
    try {
      const storage = explicitStorage ?? buildStorageConfigFromDraft(storageDraft, { lowFrequencyMode });
      const list = await unwrapCommand<RemoteSpaceProbeItem[]>({
        type: 'PROBE_STORAGE_SPACES',
        storage,
      });
      if (storageVersionRef.current !== versionAtStart) {
        return [];
      }
      const safeList = Array.isArray(list) ? list : [];
      setRemoteSpaces(safeList);
      setHasProbedSpaces(true);
      if (!pairedFromDevice && !userEditedStep2Ref.current) {
        if (safeList.length > 0) {
          setSpaceMode('join');
          const first = safeList[0];
          if (first) {
            setSpaceId(resolveProbeSpaceId(first));
            setSpaceName(resolveProbeSpaceName(first));
          }
        } else {
          setSpaceMode('create');
        }
      }
      return safeList;
    } catch (err) {
      if (storageVersionRef.current === versionAtStart) {
        setProbeError(extractErrorMessage(err));
        setHasProbedSpaces(true);
      }
      return [];
    } finally {
      setProbingSpaces(false);
    }
  };

  const runCapabilityTestInternal = async (opts?: { silentSuccessToast?: boolean }): Promise<boolean> => {
    const errMsg = validateStorageDraft(storageDraft);
    if (errMsg) {
      setStep1Error(errMsg);
      return false;
    }
    const versionAtStart = storageVersionRef.current;
    const draftSnapshot = storageDraft;
    setStep1Error(null);
    setTestingConn(true);
    try {
      const cfg = buildStorageConfigFromDraft(draftSnapshot, { lowFrequencyMode });
      const report = await unwrapCommand<CapabilityReport>({
        type: 'TEST_STORAGE_CONNECTION',
        storage: cfg,
      });
      if (storageVersionRef.current !== versionAtStart) {
        return false;
      }
      setCapabilityReport(report);

      let nextDraft = draftSnapshot;
      let nextCfg = cfg;
      if (report.overallOk && report.recommendedStorageFormat && draftSnapshot.provider === 'webdav') {
        nextDraft = { ...nextDraft, webdavStorageFormat: report.recommendedStorageFormat };
        setStorageDraft(prev =>
          storageVersionRef.current === versionAtStart && prev.provider === 'webdav'
            ? { ...prev, webdavStorageFormat: report.recommendedStorageFormat }
            : prev,
        );
        nextCfg = buildStorageConfigFromDraft(nextDraft, { lowFrequencyMode });
      }
      if (
        report.overallOk &&
        report.resolvedGistId &&
        draftSnapshot.provider === 'github_gist' &&
        !draftSnapshot.gistId.trim()
      ) {
        nextDraft = { ...nextDraft, gistId: report.resolvedGistId };
        setStorageDraft(prev =>
          storageVersionRef.current === versionAtStart && prev.provider === 'github_gist' && !prev.gistId.trim()
            ? { ...prev, gistId: report.resolvedGistId! }
            : prev,
        );
        nextCfg = buildStorageConfigFromDraft(nextDraft, { lowFrequencyMode });
      }

      await saveUiNonSensitiveMeta({
        ...toNonSensitiveMetaPatch(nextDraft),
        lastCapabilityReport: report,
      });
      if (storageVersionRef.current !== versionAtStart) {
        return false;
      }
      if (report.overallOk) {
        if (!opts?.silentSuccessToast) {
          toast.success('存储连接检测通过！');
        }
        await probeSpaces(nextCfg, versionAtStart);
        return true;
      }
      toast.error('存储连接检测未通过，请展开下方检测详情排查');
      return false;
    } catch (err) {
      if (storageVersionRef.current === versionAtStart) {
        const msg = extractErrorMessage(err);
        setStep1Error(msg);
        toast.error(`连接失败：${msg}`);
      }
      return false;
    } finally {
      setTestingConn(false);
    }
  };

  const handleSelectRemoteSpaceAndAdvance = (item: RemoteSpaceProbeItem) => {
    setSpaceMode('join');
    setSpaceId(resolveProbeSpaceId(item));
    setSpaceName(resolveProbeSpaceName(item));
    setStep1Error(null);
    setStep(2);
  };

  const goToStep2 = async () => {
    const errMsg = validateStorageDraft(storageDraft);
    if (errMsg) {
      setStep1Error(errMsg);
      return;
    }
    if (capabilityReport?.overallOk) {
      setStep1Error(null);
      setStep(2);
      if (!hasProbedSpaces) {
        void probeSpaces();
      }
      return;
    }
    setAdvancingStep1(true);
    try {
      const ok = await runCapabilityTestInternal({ silentSuccessToast: true });
      if (ok) {
        setStep(2);
      }
    } finally {
      setAdvancingStep1(false);
    }
  };

  const handleDecodePairingCode = async () => {
    const parsed = parseSmartPairingInput(pairingCode);
    const effectiveCode = parsed.code;
    const effectivePassphrase = pairingPassphrase || parsed.pin || '';

    if (!effectiveCode || !effectivePassphrase) {
      toast.warning('请粘贴 smesh://pair/... 配对码并填写配对口令');
      return;
    }
    if (parsed.pin && !pairingPassphrase) {
      setPairingPassphrase(parsed.pin);
    }
    if (effectiveCode !== pairingCode.trim()) {
      setPairingCode(effectiveCode);
    }

    setDecodingPairing(true);
    setJoinError(null);
    try {
      const decoded = await unwrapCommand<PairingPayload>({
        type: 'DECODE_PAIRING_CODE',
        code: effectiveCode,
        passphrase: effectivePassphrase,
      });

      const resolvedStorage: StorageProviderConfig | undefined =
        decoded.storage ?? (decoded.webdav ? { provider: 'webdav', ...decoded.webdav } : undefined);

      if (resolvedStorage) {
        storageVersionRef.current += 1;
        setStorageDraft(draftFromStorageConfig(resolvedStorage));
        if (resolvedStorage.provider === 'webdav' && resolvedStorage.url.toLowerCase().includes('jianguoyun.com')) {
          setLowFrequencyMode(true);
        }
      }

      if (decoded.spaceId) {
        setSpaceId(decoded.spaceId);
        setSpaceMode('join');
      }
      if (decoded.spaceName) {
        setSpaceName(decoded.spaceName);
      }
      setPairedFromDevice(decoded.fromDeviceName || '其他设备');
      setStep1Error(null);
      setHasProbedSpaces(false);
      setCapabilityReport(null);

      if (resolvedStorage?.provider === 'local_directory') {
        toast.info('配对码已解密！请点击下方按钮选择本机对应的云盘同步文件夹。');
      } else {
        toast.success(`配对码解密成功！输入空间主密码即可一键接入「${decoded.spaceName || decoded.spaceId}」`);
      }
    } catch (err) {
      toast.error(`配对码解密失败：${extractErrorMessage(err)}`);
    } finally {
      setDecodingPairing(false);
    }
  };

  const handlePickPairedLocalDir = async () => {
    setPickingPairedLocalDir(true);
    try {
      const picked = await pickAndStoreLocalDirectory();
      setStorageDraft(prev => ({
        ...prev,
        localDirHandleKey: picked.handleKey,
        localDirLabel: picked.directoryLabel,
      }));
      toast.success(`已选择同步文件夹「${picked.directoryLabel}」`);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        toast.error(`选择文件夹失败：${extractErrorMessage(err)}`);
      }
    } finally {
      setPickingPairedLocalDir(false);
    }
  };

  const currentVerifyKey = `${getStorageVerifyIdentity(storageDraft)}|${spaceMode}|${spaceId.trim()}|${encryptionPassword}`;

  const verifyStep2EncryptionPassword = async (): Promise<boolean> => {
    const trimmedSpaceId = spaceId.trim() || 'default';
    if (!encryptionPassword || encryptionPassword.length < 6) {
      toast.warning('请输入至少 6 位的端到端加密主密码');
      return false;
    }
    if (spaceMode === 'create' && encryptionPassword !== confirmPassword) {
      toast.warning('两次输入的加密主密码不一致，请核对');
      return false;
    }

    setVerifyingPassword(true);
    try {
      const cfg = buildStorageConfigFromDraft(storageDraft, { lowFrequencyMode });
      const res = await unwrapCommand<RemoteSpacePasswordVerifyResult>({
        type: 'VERIFY_STORAGE_SPACE_PASSWORD',
        storage: cfg,
        spaceId: trimmedSpaceId,
        encryptionPassword,
      });

      if (spaceMode === 'join') {
        if (!res.exists) {
          const msg = `存储中未找到空间「${trimmedSpaceId}」，请检查存储目录或切换为「创建新空间」`;
          setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
          toast.error(msg);
          return false;
        }
        if (!res.verified) {
          const msg = res.errorMessage || '加密主密码不正确，无法解锁远端空间，请核对当初在首台电脑设置的密码';
          setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
          toast.error(msg);
          return false;
        }
        if (res.spaceName) {
          setSpaceName(res.spaceName);
        }
        const okMsg = `主密码验证通过：已解锁空间「${res.spaceName || res.spaceId || trimmedSpaceId}」`;
        setPasswordVerifyState({ ok: true, key: currentVerifyKey, message: okMsg });
        return true;
      }

      // spaceMode === 'create'
      if (res.exists && !res.verified) {
        const msg = `存储中已存在空间「${trimmedSpaceId}」，且当前密码无法解锁它。若这是您的第 2 台电脑，请输入原主密码；若想另建新空间，请点开「自定义空间名称/ID」更换空间 ID。`;
        setShowCustomSpaceMeta(true);
        setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
        toast.error(msg);
        return false;
      }
      if (res.exists && res.verified) {
        if (res.spaceName) {
          setSpaceName(res.spaceName);
        }
        setSpaceMode('join');
        const nextKey = `${getStorageVerifyIdentity(storageDraft)}|join|${trimmedSpaceId}|${encryptionPassword}`;
        const okMsg = `检测到已有空间「${res.spaceName || trimmedSpaceId}」且主密码匹配，已自动切换为加入该空间`;
        setPasswordVerifyState({ ok: true, key: nextKey, message: okMsg });
        toast.success(okMsg);
        return true;
      }

      setPasswordVerifyState({
        ok: true,
        key: currentVerifyKey,
        message: '主密码校验就绪，可安全初始化加密空间',
      });
      return true;
    } catch (err) {
      const msg = `校验失败：${extractErrorMessage(err)}`;
      setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
      toast.error(msg);
      return false;
    } finally {
      setVerifyingPassword(false);
    }
  };

  const executeVerifyAndJoin = async () => {
    const draftErr = validateStorageDraft(storageDraft);
    if (draftErr) {
      setJoinError(draftErr);
      toast.warning(draftErr);
      return;
    }
    if (!deviceName.trim()) {
      toast.warning('请填写本机名称（例如：公司台式机 / 家用笔记本）');
      return;
    }
    if (!encryptionPassword || encryptionPassword.length < 6) {
      toast.warning('请输入至少 6 位的端到端加密主密码');
      return;
    }
    if (spaceMode === 'create' && encryptionPassword !== confirmPassword) {
      toast.warning('两次输入的加密主密码不一致，请核对');
      return;
    }

    const storageSecret = extractStorageSecretForCompare(storageDraft);
    if (storageSecret && encryptionPassword === storageSecret) {
      toast.warning('建议加密主密码与存储凭据设置不同密码，安全性更高');
    }

    setJoiningSpace(true);
    setJoinError(null);
    try {
      if (!passwordVerifyState?.ok || passwordVerifyState.key !== currentVerifyKey) {
        const verified = await verifyStep2EncryptionPassword();
        if (!verified) {
          setJoiningSpace(false);
          return;
        }
      }

      const effectiveSpaceId = spaceId.trim() || 'default';
      const cfg = buildStorageConfigFromDraft(storageDraft, { lowFrequencyMode });
      const settingsPatch: Partial<SpaceSettings> = {
        autoSync,
        syncTimingMode,
        syncLocalStorage,
        autoRefresh,
        refreshProtection,
        lowFrequencyMode,
        sessionLockEnabled,
        pollingIntervalSec: lowFrequencyMode ? 300 : 60,
        syncScopeMode,
      };
      const report = await unwrapCommand<InitialJoinReport>({
        type: 'SAVE_AND_JOIN_SPACE',
        storage: cfg,
        webdav: cfg.provider === 'webdav' ? stripWebdavProvider(cfg) : undefined,
        spaceId: effectiveSpaceId,
        spaceName: spaceName.trim() || effectiveSpaceId,
        encryptionPassword,
        deviceName: deviceName.trim(),
        presetCategories: selectedPresets,
        settingsPatch,
      });

      if (setAsPrimaryAuthority && report.deviceId) {
        try {
          await unwrapCommand({
            type: 'SET_SPACE_AUTHORITY_POLICY',
            authorityMode: 'primary_device',
            primaryDeviceId: report.deviceId,
          });
        } catch (authErr) {
          toast.warning(`已开启空间，但设为主基准设备失败：${extractErrorMessage(authErr)}`);
        }
      }

      await saveUiNonSensitiveMeta({
        ...toNonSensitiveMetaPatch(storageDraft),
        lastCapabilityReport: capabilityReport ?? undefined,
      });

      setJoinReport(report);
      setPendingDecisions(report.pendingDecisions ?? []);
      setEntryMode('new_device');
      setStep(3);
      toast.success(
        report.isNewSpace ? `已创建加密同步空间「${report.spaceName}」` : `已加入同步空间「${report.spaceName}」`,
      );
    } catch (err) {
      const msg = extractErrorMessage(err);
      setJoinError(msg);
      toast.error(`开启同步失败：${msg}`);
    } finally {
      setJoiningSpace(false);
    }
  };

  const togglePreset = (cat: PresetBlacklistCategory) => {
    setSelectedPresets(prev => (prev.includes(cat) ? prev.filter(item => item !== cat) : [...prev, cat]));
  };

  const loadCandidateSites = useCallback(async () => {
    setLoadingCandidates(true);
    setCandidateError(null);
    try {
      const list = await unwrapCommand<BrowserCandidateSite[]>({ type: 'SCAN_BROWSER_CANDIDATE_SITES' });
      const safeList = Array.isArray(list) ? list : [];
      safeList.sort((a, b) => {
        const rankA = a.blacklisted ? 2 : a.alreadyManaged ? 1 : 0;
        const rankB = b.blacklisted ? 2 : b.alreadyManaged ? 1 : 0;
        if (rankA !== rankB) return rankA - rankB;
        return b.cookieCount - a.cookieCount;
      });
      setCandidateSites(safeList);
    } catch (err) {
      setCandidateError(extractErrorMessage(err));
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  useEffect(() => {
    if (step === 3 && joinReport) {
      void loadCandidateSites();
    }
  }, [step, joinReport, loadCandidateSites]);

  const filteredCandidates = useMemo(() => {
    const q = candidateSearch.trim().toLowerCase();
    if (!q) return candidateSites;
    return candidateSites.filter(
      site => site.siteKey.toLowerCase().includes(q) || site.domains.some(domain => domain.toLowerCase().includes(q)),
    );
  }, [candidateSites, candidateSearch]);

  const selectableVisibleCandidates = useMemo(
    () => filteredCandidates.filter(site => !site.alreadyManaged && !site.blacklisted),
    [filteredCandidates],
  );

  const selectedCandidateList = useMemo(
    () =>
      Object.entries(selectedCandidateKeys)
        .filter(([, checked]) => checked)
        .map(([key]) => key),
    [selectedCandidateKeys],
  );

  const toggleCandidateSelection = (key: string) => {
    setSelectedCandidateKeys(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleSelectAllVisibleCandidates = () => {
    setSelectedCandidateKeys(prev => {
      const next = { ...prev };
      for (const site of selectableVisibleCandidates) {
        next[site.siteKey] = true;
      }
      return next;
    });
  };

  const handleAddSelectedManagedSites = async (silentIfEmpty = false): Promise<boolean> => {
    if (selectedCandidateList.length === 0) {
      if (!silentIfEmpty) {
        toast.warning('请先勾选至少一个需要同步的网站');
      }
      return true;
    }
    setAddingManaged(true);
    try {
      await unwrapCommand({
        type: 'ADD_MANAGED_SITES',
        siteKeys: selectedCandidateList,
      });
      await markGuideTaskDone('first_site');
      toast.success(`已开启 ${selectedCandidateList.length} 个网站的自动加密同步`);
      setSelectedCandidateKeys({});
      await loadCandidateSites();
      return true;
    } catch (err) {
      toast.error(`添加同步网站失败：${extractErrorMessage(err)}`);
      return false;
    } finally {
      setAddingManaged(false);
    }
  };

  const handleQuickBlacklistUploaded = async (siteKey: string) => {
    setBlacklistingSite(prev => ({ ...prev, [siteKey]: true }));
    try {
      await unwrapCommand({
        type: 'ADD_BLACKLIST_ENTRY',
        entry: {
          pattern: siteKey,
          matchType: 'subdomain',
          scope: 'device',
          reason: '首次向导快速拉黑',
          presetCategory: 'custom',
        },
      });
      setBlacklistedUploaded(prev => ({ ...prev, [siteKey]: true }));
      toast.success(`已将 ${siteKey} 加入本机排除黑名单`);
    } catch (err) {
      toast.error(`操作失败：${extractErrorMessage(err)}`);
    } finally {
      setBlacklistingSite(prev => ({ ...prev, [siteKey]: false }));
    }
  };

  const handleGenerateInstantPairBundle = async () => {
    const pin = finishPairingPin.trim() || generateShortPairingPin(6);
    setFinishPairingPin(pin);
    setGeneratingFinishPair(true);
    try {
      const res = await unwrapCommand<string | { code: string }>({
        type: 'GENERATE_PAIRING_CODE',
        passphrase: pin,
      });
      const codeStr = typeof res === 'string' ? res : res?.code || '';
      if (!codeStr) throw new Error('未能生成配对码');
      setFinishPairingCode(codeStr);
      await markGuideTaskDone('second_device');
      toast.success('已生成跨设备配对码与口令！');
    } catch (err) {
      toast.error(`生成配对码失败：${extractErrorMessage(err)}`);
    } finally {
      setGeneratingFinishPair(false);
    }
  };

  const handleFinishWizard = async () => {
    if (selectedCandidateList.length > 0) {
      const ok = await handleAddSelectedManagedSites(true);
      if (!ok) return;
    }
    if (window.location.search.includes('onboarding=1') || window.location.search.includes('mode=pair')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    await onComplete();
  };

  const pairedProviderMeta = getStorageProviderMeta(storageDraft.provider);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <img src={chrome.runtime.getURL('options/logo.png')} alt="SessionMesh" className="h-8 w-8 object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">欢迎使用 SessionMesh</h1>
            <p className="text-xs text-muted-foreground">
              多台电脑无感共享网站登录状态 · 你的数据只加密存在你自己的网盘或文件夹里
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const next = !expertMode;
              void updateUxPrefs({ onboardingExpertMode: next });
              toast.info(next ? '已切换至专家模式（展开全部高级参数）' : '已切换至极简模式（隐藏低频工程选项）');
            }}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              expertMode
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-muted/50 text-muted-foreground hover:text-foreground'
            }`}>
            <Sliders className="h-3.5 w-3.5" />
            {expertMode ? '专家模式：已开启' : '极简向导模式'}
          </button>

          {alreadyConfigured && onOpenTutorials ? (
            <Button type="button" variant="ghost" size="sm" onClick={onOpenTutorials}>
              <BookOpen className="mr-1.5 h-4 w-4" />
              图文教程
            </Button>
          ) : null}

          {alreadyConfigured && onCancel ? (
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              返回控制中心
            </Button>
          ) : null}
        </div>
      </div>

      {/* Top Entry Fork (First Device vs Second Device Pairing) — shown before final Step 3 */}
      {step < 3 ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setEntryMode('new_device')}
            className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all ${
              entryMode === 'new_device'
                ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/40 shadow-2xs'
                : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
            }`}>
            <div
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                entryMode === 'new_device' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}>
              <Rocket className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-foreground">我是第 1 台电脑（从零开始）</span>
                <Badge variant="success" className="px-1.5 py-0 text-[10px]">
                  3 步完成
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                选择本地同步盘、GitHub Gist 或云盘，设置加密主密码并挑出要同步的网站
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setEntryMode('pair_code')}
            className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all ${
              entryMode === 'pair_code'
                ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/40 shadow-2xs'
                : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
            }`}>
            <div
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                entryMode === 'pair_code' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}>
              <QrCode className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-foreground">我有配对码（接入第 2 台电脑）</span>
                <Badge variant="info" className="px-1.5 py-0 text-[10px]">
                  10 秒一步接入
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                粘贴另一台电脑生成的 <code className="rounded bg-muted px-1">smesh://pair/...</code>{' '}
                配对码，免填服务器配置
              </p>
            </div>
          </button>
        </div>
      ) : null}

      {/* CHANNEL B: Express One-Screen Pairing Flow */}
      {entryMode === 'pair_code' && step < 3 ? (
        <Card className="border-primary/35">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <QrCode className="h-5 w-5 text-primary" />
              使用配对码快速接入现有同步空间
            </CardTitle>
            <CardDescription>
              在已配置好的第 1 台电脑打开「控制中心 → 设备与同步空间 →
              跨设备配对」生成配对码，直接整段粘贴到下方即可自动识别。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3 rounded-xl border border-border bg-muted/15 p-4">
              <div className="space-y-1.5">
                <Label htmlFor="expressPairingCode">1. 粘贴配对码（支持直接粘贴整段配对消息，自动提取口令）*</Label>
                <Textarea
                  id="expressPairingCode"
                  rows={3}
                  value={pairingCode}
                  onChange={e => {
                    const val = e.target.value;
                    setPairingCode(val);
                    const parsed = parseSmartPairingInput(val);
                    if (parsed.pin && !pairingPassphrase) {
                      setPairingPassphrase(parsed.pin);
                    }
                  }}
                  placeholder="粘贴 smesh://pair/v1.xxxx...（或整段包含配对码与口令的文本）"
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="expressPairingPin">2. 输入配对口令 *</Label>
                  <Input
                    id="expressPairingPin"
                    type="password"
                    value={pairingPassphrase}
                    onChange={e => setPairingPassphrase(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void handleDecodePairingCode();
                    }}
                    placeholder="生成配对码时的 6 位口令或自定义口令"
                  />
                </div>
                <Button
                  type="button"
                  onClick={() => void handleDecodePairingCode()}
                  disabled={decodingPairing}
                  variant={pairedFromDevice ? 'outline' : 'default'}
                  className="sm:w-44">
                  {decodingPairing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 h-4 w-4" />
                  )}
                  {pairedFromDevice ? '重新解析配对码' : '解析配对码'}
                </Button>
              </div>
            </div>

            {pairedFromDevice ? (
              <div className="space-y-4 rounded-xl border border-emerald-500/40 bg-emerald-500/[0.04] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div>
                      <div className="text-sm font-bold text-foreground">
                        已识别来自「{pairedFromDevice}」的空间：{spaceName}（ID: <code>{spaceId}</code>）
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        存储方式：{pairedProviderMeta.label} · 确认本机名称并输入空间加密主密码即可完成接入
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setEntryMode('new_device');
                      setStep(1);
                    }}
                    className="text-xs text-primary hover:underline">
                    查看/微调存储详情 →
                  </button>
                </div>

                {storageDraft.provider === 'local_directory' ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                    <span>
                      当前空间使用本地同步盘，请在本机选择对应的 OneDrive / iCloud / Dropbox 同步文件夹：
                      {storageDraft.localDirLabel ? <strong>（已选：{storageDraft.localDirLabel}）</strong> : null}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={pickingPairedLocalDir}
                      onClick={() => void handlePickPairedLocalDir()}>
                      {pickingPairedLocalDir ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      选择本机同步文件夹
                    </Button>
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="pairedDeviceName">给这台电脑起个名字 *</Label>
                    <Input
                      id="pairedDeviceName"
                      value={deviceName}
                      onChange={e => setDeviceName(e.target.value)}
                      placeholder="例如：家里笔记本 / MacBook"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="pairedEncPass">输入该空间的加密主密码 *</Label>
                      {pairingPassphrase.length >= 6 && encryptionPassword !== pairingPassphrase ? (
                        <button
                          type="button"
                          onClick={() => setEncryptionPassword(pairingPassphrase)}
                          className="text-[11px] text-primary hover:underline">
                          与配对口令相同？点此填入
                        </button>
                      ) : null}
                    </div>
                    <Input
                      id="pairedEncPass"
                      type={showEncPassword ? 'text' : 'password'}
                      value={encryptionPassword}
                      onChange={e => {
                        setEncryptionPassword(e.target.value);
                        setPasswordVerifyState(null);
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !joiningSpace) void executeVerifyAndJoin();
                      }}
                      placeholder="输入首台电脑设置的端到端加密主密码"
                    />
                  </div>
                </div>

                {joinError ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle className="text-xs font-semibold">接入提示</AlertTitle>
                    <AlertDescription className="text-xs">{joinError}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex justify-end">
                  <Button
                    type="button"
                    disabled={joiningSpace || verifyingPassword}
                    onClick={() => void executeVerifyAndJoin()}
                    className="min-w-[210px]">
                    {joiningSpace || verifyingPassword ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        正在验证密码并同步空间...
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="mr-2 h-4 w-4" />
                        一键验证并完成接入
                      </>
                    )}
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* CHANNEL A: 3-Step Streamlined Flow */}
      {entryMode === 'new_device' || step === 3 ? (
        <>
          {/* 3-Step Progress Bar */}
          <div className="mb-5 grid grid-cols-3 gap-2.5">
            {STEPS.map(item => {
              const done = step > item.id;
              const active = step === item.id;
              return (
                <div
                  key={item.id}
                  className={`rounded-xl border px-3 py-2.5 transition-all ${
                    active
                      ? 'border-primary bg-primary/8 shadow-2xs'
                      : done
                        ? 'border-emerald-500/35 bg-emerald-500/5'
                        : 'border-border bg-card/60 opacity-75'
                  }`}>
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        done
                          ? 'bg-emerald-600 text-white'
                          : active
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground'
                      }`}>
                      {done ? <Check className="h-3.5 w-3.5" /> : item.id}
                    </span>
                    <span className="truncate text-xs font-semibold text-foreground sm:text-sm">{item.title}</span>
                  </div>
                  <p className="mt-1 hidden truncate pl-8 text-[11px] text-muted-foreground sm:block">
                    {item.subtitle}
                  </p>
                </div>
              );
            })}
          </div>

          {/* STEP 1: Choose Storage Location */}
          {step === 1 ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Server className="h-5 w-5 text-primary" />第 1 步 · 选择把加密登录数据存放在哪里
                </CardTitle>
                <CardDescription>
                  SessionMesh 没有第三方中心服务器，所有登录状态都会在浏览器本地用 AES-256-GCM 加密后存入你选的位置。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <StorageProviderForm
                  draft={storageDraft}
                  onChange={handleStorageDraftChange}
                  onLowFrequencyHint={recommended => {
                    if (recommended) setLowFrequencyMode(true);
                  }}
                  notifyPermissionOnGrant={false}
                  expertMode={expertMode}
                />

                {step1Error ? (
                  <Alert variant="destructive" className="pr-10">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle className="text-sm">请检查存储配置</AlertTitle>
                    <AlertDescription className="text-xs">{step1Error}</AlertDescription>
                    <button
                      type="button"
                      aria-label="关闭提示"
                      onClick={() => setStep1Error(null)}
                      className="absolute right-3 top-3 rounded p-1 text-destructive/80 hover:bg-destructive/10 hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </Alert>
                ) : null}

                {/* Auto-Detected Remote Spaces Card (if user clicked Test Connection on Step 1) */}
                {remoteSpaces.length > 0 ? (
                  <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/[0.06] p-3.5 space-y-2.5">
                    <div className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
                      🎉 在该存储位置检测到已有同步空间！点击即可直接加入：
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {remoteSpaces.map(s => {
                        const displayName = resolveProbeSpaceName(s);
                        const displayId = resolveProbeSpaceId(s);
                        return (
                          <button
                            key={s.opaqueId}
                            type="button"
                            onClick={() => handleSelectRemoteSpaceAndAdvance(s)}
                            className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-background px-3 py-2.5 text-left text-xs transition-all hover:border-primary hover:shadow-2xs">
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-foreground">{displayName}</div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">
                                ID: {displayId}
                                {s.updatedAt ? ` · ${formatRelativeTime(s.updatedAt)}` : ''}
                              </div>
                            </div>
                            <Badge variant="default" className="shrink-0">
                              选用并下一步 →
                            </Badge>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {capabilityReport ? (
                  <div className="pt-1">
                    <CapabilityReportView report={capabilityReport} defaultExpanded={!capabilityReport.overallOk} />
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={testingConn || advancingStep1 || probingSpaces}
                    onClick={() => void runCapabilityTestInternal()}>
                    {testingConn && !advancingStep1 ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-1.5 h-4 w-4" />
                    )}
                    先测试连通性
                  </Button>

                  <Button
                    type="button"
                    disabled={testingConn || advancingStep1}
                    onClick={() => void goToStep2()}
                    className="min-w-[200px]">
                    {advancingStep1 ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        正在验证连接与空间...
                      </>
                    ) : (
                      <>
                        下一步：设置加密密码
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* STEP 2: Encryption Master Password + Smart Recommended Policy */}
          {step === 2 ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <KeyRound className="h-5 w-5 text-primary" />第 2 步 ·{' '}
                      {spaceMode === 'join' ? '输入主密码加入已有空间' : '设置加密主密码'}
                    </CardTitle>
                    <CardDescription>
                      {spaceMode === 'join'
                        ? `检测到已有空间「${spaceName}」，输入当初设置的加密主密码即可安全同步。`
                        : '给你的登录数据加一把私人密码锁，多台电脑输入同一个主密码即可互通。'}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        userEditedStep2Ref.current = true;
                        setSpaceMode(prev => (prev === 'create' ? 'join' : 'create'));
                      }}
                      className="rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                      {spaceMode === 'create' ? '改为加入已有空间' : '改为新建独立空间'}
                    </button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-5">
                {probeError ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                    <span>远端空间扫描提示：{probeError}（仍可直接继续初始化或加入）</span>
                    <button
                      type="button"
                      aria-label="关闭提示"
                      onClick={() => setProbeError(null)}
                      className="rounded p-0.5 hover:bg-amber-500/20">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}

                {remoteSpaces.length > 1 && spaceMode === 'join' ? (
                  <div className="space-y-2 rounded-xl border border-border bg-muted/25 p-3">
                    <div className="text-xs font-medium text-muted-foreground">选择要加入的同步空间：</div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {remoteSpaces.map(sp => {
                        const candidateId = resolveProbeSpaceId(sp);
                        const candidateName = resolveProbeSpaceName(sp);
                        const selected = spaceId === candidateId;
                        return (
                          <button
                            key={sp.opaqueId}
                            type="button"
                            onClick={() => {
                              setSpaceId(candidateId);
                              setSpaceName(candidateName);
                            }}
                            className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs ${
                              selected ? 'border-primary bg-primary/10' : 'border-border bg-background'
                            }`}>
                            <span className="truncate font-semibold">{candidateName}</span>
                            <Badge variant={selected ? 'default' : 'outline'}>{selected ? '已选' : '选择'}</Badge>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {/* E2E Encryption Password Card */}
                <div className="rounded-xl border border-primary/30 bg-primary/[0.04] p-4 space-y-3.5">
                  <div className="flex items-start gap-2.5">
                    <Lock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div className="space-y-0.5">
                      <div className="text-sm font-semibold text-foreground">端到端加密主密码（请牢记）</div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        此密码<strong>绝不上传任何服务器</strong>。即使网盘或 GitHub 账号泄漏，没有此密码也无法解密你的
                        Cookie。建议使用与网盘密码不同的独立密码并记入密码本（遗忘后无法找回）。
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="encPass">
                          {spaceMode === 'join' ? '输入该空间的加密主密码 *' : '设置加密主密码（至少 6 位）*'}
                        </Label>
                        <button
                          type="button"
                          onClick={() => setShowEncPassword(prev => !prev)}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          {showEncPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          {showEncPassword ? '隐藏' : '显示'}
                        </button>
                      </div>
                      <Input
                        id="encPass"
                        type={showEncPassword ? 'text' : 'password'}
                        value={encryptionPassword}
                        onChange={e => {
                          setEncryptionPassword(e.target.value);
                          setPasswordVerifyState(null);
                        }}
                        placeholder="至少 6 位字母、数字或符号"
                      />
                    </div>

                    {spaceMode === 'create' ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="confirmEncPass">再次输入主密码确认 *</Label>
                        <Input
                          id="confirmEncPass"
                          type={showEncPassword ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={e => {
                            setConfirmPassword(e.target.value);
                            setPasswordVerifyState(null);
                          }}
                          placeholder="再次输入以防误填"
                        />
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Label htmlFor="deviceNameJoin">给这台电脑起个名字 *</Label>
                        <Input
                          id="deviceNameJoin"
                          value={deviceName}
                          onChange={e => setDeviceName(e.target.value)}
                          placeholder="例如：公司电脑 / 家用笔记本"
                        />
                      </div>
                    )}
                  </div>

                  {spaceMode === 'create' && confirmPassword && encryptionPassword !== confirmPassword ? (
                    <p className="text-xs font-medium text-destructive">两次输入的加密主密码不一致，请核对</p>
                  ) : null}

                  {extractStorageSecretForCompare(storageDraft) &&
                  encryptionPassword &&
                  encryptionPassword === extractStorageSecretForCompare(storageDraft) &&
                  isBannerVisible('onboarding_same_password_warn', 'security') ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                      <span>提示：当前加密主密码与存储密钥相同，建议换一个独立密码更安全。</span>
                      <button
                        type="button"
                        onClick={() => void dismissBanner('onboarding_same_password_warn')}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20">
                        知道了
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* Device Name (in create mode) + Optional Custom Space Name/ID */}
                <div className="space-y-3">
                  {spaceMode === 'create' ? (
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="flex-1 min-w-[220px] space-y-1.5">
                        <Label htmlFor="deviceNameCreate">给这台电脑起个好认的名字 *</Label>
                        <Input
                          id="deviceNameCreate"
                          value={deviceName}
                          onChange={e => setDeviceName(e.target.value)}
                          placeholder="例如：公司台式机 / MacBook"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowCustomSpaceMeta(prev => !prev)}
                        className="inline-flex items-center gap-1 pb-2 text-xs text-muted-foreground hover:text-foreground">
                        <FolderPlus className="h-3.5 w-3.5" />
                        {showCustomSpaceMeta
                          ? '收起空间 ID 设置'
                          : `自定义空间名称 / ID（当前：${spaceName} · ${spaceId}）`}
                      </button>
                    </div>
                  ) : (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => setShowCustomSpaceMeta(prev => !prev)}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        {showCustomSpaceMeta ? '收起空间 ID 设置' : `手动指定空间 ID（当前：${spaceId}）`}
                      </button>
                    </div>
                  )}

                  {showCustomSpaceMeta ? (
                    <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3.5 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="spaceId">同步空间 ID *</Label>
                        <Input
                          id="spaceId"
                          value={spaceId}
                          onChange={e => {
                            userEditedStep2Ref.current = true;
                            setSpaceId(e.target.value);
                          }}
                          placeholder="default"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          用于隔离工作/个人不同空间，大多数用户保持 default 即可
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="spaceName">空间显示名称</Label>
                        <Input
                          id="spaceName"
                          value={spaceName}
                          onChange={e => {
                            userEditedStep2Ref.current = true;
                            setSpaceName(e.target.value);
                          }}
                          placeholder="默认同步空间"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Smart Recommended Safety Summary + Collapsible Expert Policy */}
                <div className="rounded-xl border border-border bg-card">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <div className="text-xs">
                        <span className="font-semibold text-foreground">已自动启用新手安全推荐配置：</span>
                        <span className="text-muted-foreground">
                          {syncScopeMode === 'managed_only' ? '仅同步你选中的网站' : '全站自动同步'} ·
                          自动排除网银与密码库 ·{' '}
                          {syncTimingMode === 'on_page_leave' ? '离开网页时合并上传' : '实时上传'}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPolicyExpanded(prev => !prev)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                      {policyExpanded ? '收起高级策略' : '自定义同步策略'}
                      {policyExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                  </div>

                  {policyExpanded ? (
                    <div className="space-y-4 border-t border-border p-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => setSyncScopeMode('managed_only')}
                          className={`rounded-xl border p-3 text-left transition-all ${
                            syncScopeMode === 'managed_only'
                              ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                              : 'border-border bg-background'
                          }`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-foreground">仅同步我选中的网站</span>
                            <Badge variant="success" className="text-[10px]">
                              推荐
                            </Badge>
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            只同步您在下一步勾选或平时手动开启的网站，不上传无关浏览记录。
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSyncScopeMode('all_sites')}
                          className={`rounded-xl border p-3 text-left transition-all ${
                            syncScopeMode === 'all_sites'
                              ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                              : 'border-border bg-background'
                          }`}>
                          <div className="text-xs font-semibold text-foreground">全站自动同步（黑名单除外）</div>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            自动同步所有访问网站的登录状态，无需逐个挑站。
                          </p>
                        </button>
                      </div>

                      <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/20 p-3 text-xs">
                        <input
                          id="onboarding-primary-authority"
                          type="checkbox"
                          checked={setAsPrimaryAuthority}
                          onChange={e => setSetAsPrimaryAuthority(e.target.checked)}
                          className="mt-0.5 h-4 w-4 cursor-pointer rounded accent-primary"
                        />
                        <label htmlFor="onboarding-primary-authority" className="flex-1 cursor-pointer">
                          <strong className="inline-flex items-center gap-1 text-foreground">
                            <Crown className="h-3.5 w-3.5 text-amber-500" />
                            将这台电脑设为主力基准设备
                          </strong>
                          <span className="mt-0.5 block text-muted-foreground">
                            勾选后，其他电脑遇到同名网站登录冲突时将默认跟随本机登录态，省去手动弹窗确认。
                          </span>
                        </label>
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-foreground">自动排除敏感网站（推荐保持勾选）：</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {PRESET_BLACKLIST_OPTIONS.map(opt => {
                            const checked = selectedPresets.includes(opt.category);
                            const presetId = `onboarding-preset-${opt.category}`;
                            return (
                              <div
                                key={opt.category}
                                className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-xs">
                                <input
                                  id={presetId}
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => togglePreset(opt.category)}
                                  className="mt-0.5 h-4 w-4 cursor-pointer rounded accent-primary"
                                />
                                <label htmlFor={presetId} className="flex-1 cursor-pointer">
                                  <strong className="block text-foreground">{opt.title}</strong>
                                  <span className="text-[11px] text-muted-foreground">{opt.examples}</span>
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="divide-y divide-border rounded-xl border border-border text-xs">
                        <div className="flex items-center justify-between gap-3 p-3">
                          <div>
                            <div className="font-medium text-foreground">开启自动同步</div>
                            <div className="text-[11px] text-muted-foreground">关闭后仅在手动点击同步时上传或拉取</div>
                          </div>
                          <Switch checked={autoSync} onCheckedChange={setAutoSync} />
                        </div>
                        <div className="flex items-center justify-between gap-3 p-3">
                          <div>
                            <div className="font-medium text-foreground">上传时机</div>
                            <div className="text-[11px] text-muted-foreground">离开页面时合并上传最省网盘请求</div>
                          </div>
                          <Select
                            value={syncTimingMode}
                            disabled={!autoSync}
                            onValueChange={v => setSyncTimingMode(v as SyncTimingMode)}>
                            <SelectTrigger className="h-8 w-44 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="on_page_leave">离开网页时上传（推荐）</SelectItem>
                              <SelectItem value="realtime">实时立即上传</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between gap-3 p-3">
                          <div>
                            <div className="font-medium text-foreground">同步 LocalStorage 前端登录态</div>
                            <div className="text-[11px] text-muted-foreground">许多现代网页将登录 Token 存在此处</div>
                          </div>
                          <Switch checked={syncLocalStorage} onCheckedChange={setSyncLocalStorage} />
                        </div>
                        <div className="flex items-center justify-between gap-3 p-3">
                          <div>
                            <div className="font-medium text-foreground">手动同步后自动刷新网页</div>
                            <div className="text-[11px] text-muted-foreground">默认关闭以防打断正在输入的表单</div>
                          </div>
                          <div className="flex items-center gap-2.5">
                            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Label htmlFor="onboarding-refresh-guard" className="text-[11px] font-normal">
                                表单保护
                              </Label>
                              <Switch
                                id="onboarding-refresh-guard"
                                checked={refreshProtection}
                                disabled={!autoRefresh}
                                onCheckedChange={setRefreshProtection}
                              />
                            </div>
                            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-3 p-3">
                          <div>
                            <div className="font-medium text-foreground">坚果云低频省流模式</div>
                            <div className="text-[11px] text-muted-foreground">降低轮询频率避免网盘 429 限流</div>
                          </div>
                          <Switch checked={lowFrequencyMode} onCheckedChange={setLowFrequencyMode} />
                        </div>
                        <div className="flex items-center justify-between gap-3 p-3">
                          <div>
                            <div className="font-medium text-foreground">关闭浏览器自动上锁（高安全模式）</div>
                            <div className="text-[11px] text-muted-foreground">每次重启浏览器需重新输入加密主密码</div>
                          </div>
                          <Switch checked={sessionLockEnabled} onCheckedChange={setSessionLockEnabled} />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                {joinError ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle className="text-xs font-semibold">未能完成开启</AlertTitle>
                    <AlertDescription className="text-xs">{joinError}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex items-center justify-between pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={joiningSpace || verifyingPassword}
                    onClick={() => setStep(1)}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    上一步
                  </Button>
                  <Button
                    type="button"
                    disabled={joiningSpace || verifyingPassword}
                    onClick={() => void executeVerifyAndJoin()}
                    className="min-w-[200px]">
                    {joiningSpace || verifyingPassword ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        正在加密初始化空间...
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="mr-2 h-4 w-4" />
                        下一步：勾选同步网站
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* STEP 3: Pick Websites to Sync + Optional Quick Pair 2nd Computer */}
          {step === 3 && joinReport ? (
            <div className="space-y-4">
              <Card className="border-emerald-500/40 bg-emerald-500/5">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                      <div>
                        <CardTitle className="text-lg">
                          {joinReport.isNewSpace ? '🎉 加密同步空间已就绪！' : '🎉 已成功连入同步空间！'}
                        </CardTitle>
                        <CardDescription>
                          最后一步：勾选这台电脑上希望多端共享登录的网站（以后也可以随时点击浏览器右上角扩展图标一键开启）。
                        </CardDescription>
                      </div>
                    </div>
                    <Badge variant="success">设备：{deviceName}</Badge>
                  </div>
                </CardHeader>
              </Card>

              {/* Pending Decisions first when joining Device B/C */}
              {pendingDecisions.length > 0 ? (
                <Card className="border-amber-500/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                      请确认这 {pendingDecisions.length} 个重叠网站用哪边的账号
                    </CardTitle>
                    <CardDescription>
                      这台电脑和云端都已经登录过以下网站，为防误覆盖，请您选一下用云端账号还是本机账号：
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <PendingDecisionsPanel
                      decisions={pendingDecisions}
                      onResolved={resolvedKeys => {
                        setPendingDecisions(prev => prev.filter(d => !resolvedKeys.includes(d.siteKey)));
                      }}
                    />
                  </CardContent>
                </Card>
              ) : null}

              {/* Searchable Website Picker */}
              <Card className="border-primary/40">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Globe className="h-5 w-5 text-primary" />
                        勾选本机已登录、需要同步到其他电脑的网站
                      </CardTitle>
                      <CardDescription>
                        未勾选的日常网页仅保留在本机，不会上传。勾选后点击下方「完成配置」也会自动为您保存开启！
                      </CardDescription>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={loadingCandidates}
                      onClick={() => void loadCandidateSites()}>
                      {loadingCandidates ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      刷新列表
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {candidateError ? (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-xs">{candidateError}</AlertDescription>
                    </Alert>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={candidateSearch}
                        onChange={e => setCandidateSearch(e.target.value)}
                        placeholder="搜索网站域名（如 github.com、bilibili.com）..."
                        className="h-9 pl-8 text-xs"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={selectableVisibleCandidates.length === 0}
                      onClick={handleSelectAllVisibleCandidates}
                      className="h-9 text-xs">
                      全选 ({selectableVisibleCandidates.length})
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={selectedCandidateList.length === 0}
                      onClick={() => setSelectedCandidateKeys({})}
                      className="h-9 text-xs">
                      清空勾选
                    </Button>
                  </div>

                  {loadingCandidates ? (
                    <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin text-primary" />
                      正在扫描当前浏览器已登录的网站...
                    </div>
                  ) : filteredCandidates.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                      {candidateSites.length === 0
                        ? '当前浏览器暂无已登录网站 Cookie。稍后打开任意网站登录时，点击右上角 SessionMesh 图标即可一键开启同步！'
                        : '没有匹配该关键词的网站。'}
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-y-auto divide-y divide-border rounded-xl border border-border">
                      {filteredCandidates.map(site => {
                        const disabled = site.alreadyManaged || site.blacklisted;
                        const checked = !!selectedCandidateKeys[site.siteKey];
                        return (
                          <label
                            key={site.siteKey}
                            className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs transition-colors ${
                              disabled
                                ? 'bg-muted/20 opacity-75'
                                : checked
                                  ? 'cursor-pointer bg-primary/[0.06]'
                                  : 'cursor-pointer hover:bg-muted/35'
                            }`}>
                            <div className="flex min-w-0 items-center gap-2.5">
                              <input
                                type="checkbox"
                                disabled={disabled}
                                checked={site.alreadyManaged ? true : checked}
                                onChange={() => !disabled && toggleCandidateSelection(site.siteKey)}
                                className="h-4 w-4 rounded border-input accent-primary"
                              />
                              <div className="min-w-0">
                                <div className="truncate font-semibold text-foreground">{site.siteKey}</div>
                                {site.domains.length > 1 ? (
                                  <div className="truncate text-[10px] text-muted-foreground">
                                    包含子域：{site.domains.slice(0, 3).join(', ')}
                                    {site.domains.length > 3 ? ` 等 ${site.domains.length} 个` : ''}
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                              <Badge variant="outline" className="text-[10px]">
                                {site.cookieCount} 条登录凭据
                              </Badge>
                              {site.alreadyManaged ? (
                                <Badge variant="success" className="text-[10px]">
                                  同步中
                                </Badge>
                              ) : site.blacklisted ? (
                                <Badge variant="destructive" className="text-[10px]">
                                  已排除
                                </Badge>
                              ) : null}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {selectedCandidateList.length > 0 ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary/[0.06] px-3 py-2">
                      <span className="text-xs text-foreground">
                        已勾选 <strong>{selectedCandidateList.length}</strong> 个网站
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        disabled={addingManaged}
                        onClick={() => void handleAddSelectedManagedSites()}>
                        {addingManaged ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        立即开启同步 ({selectedCandidateList.length})
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              {/* Quick Pair 2nd Computer Card right inside Finish Step */}
              <Card className="border-primary/25 bg-primary/[0.02]">
                <button
                  type="button"
                  onClick={() => setFinishPairingOpen(prev => !prev)}
                  className="flex w-full items-center justify-between px-5 py-3.5 text-left">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                      <Laptop className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-foreground">
                        想顺便连上第 2 台电脑？一键生成跨设备配对码
                      </div>
                      <p className="text-xs text-muted-foreground">
                        不用在另一台电脑重填服务器密钥，复制配对码发过去 10 秒即可连入
                      </p>
                    </div>
                  </div>
                  {finishPairingOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {finishPairingOpen ? (
                  <CardContent className="space-y-3 border-t border-border pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={generatingFinishPair}
                        onClick={() => void handleGenerateInstantPairBundle()}>
                        {generatingFinishPair ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Dices className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        一键生成随机口令与配对码
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        在另一台电脑安装扩展后选择「我有配对码」，整段粘贴即可自动识别
                      </span>
                    </div>

                    {finishPairingCode ? (
                      <div className="space-y-2 rounded-xl border border-border bg-background p-3 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            随机配对口令：
                            <code className="rounded bg-muted px-2 py-0.5 font-bold">{finishPairingPin}</code>
                          </span>
                          <div className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px]"
                              onClick={() => void copyToClipboard(finishPairingCode, '已仅复制配对码')}>
                              <Copy className="mr-1 h-3 w-3" />
                              仅复制配对码
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 text-[11px]"
                              onClick={() =>
                                void copyToClipboard(
                                  `SessionMesh 跨设备配对码：\n${finishPairingCode}\n口令：${finishPairingPin}\n（在向导选择「我有配对码」整段粘贴，再输入空间加密主密码即可接入；用完请删除聊天记录）`,
                                  '已复制完整配对信息，发到另一台电脑粘贴即可！',
                                )
                              }>
                              <Copy className="mr-1 h-3 w-3" />
                              复制完整配对包（含口令）
                            </Button>
                          </div>
                        </div>
                        <Textarea value={finishPairingCode} readOnly rows={2} className="font-mono text-[11px]" />
                      </div>
                    ) : null}
                  </CardContent>
                ) : null}
              </Card>

              {/* Compact Collapsible Sync Details (Auto-synced / Uploaded / Blacklisted) */}
              {joinReport.autoSyncedSites.length > 0 ||
              joinReport.localUploadedSites.length > 0 ||
              joinReport.excludedBlacklistedSites.length > 0 ? (
                <Card>
                  <button
                    type="button"
                    onClick={() => setShowReportDetails(prev => !prev)}
                    className="flex w-full items-center justify-between px-5 py-3 text-left text-xs text-muted-foreground hover:text-foreground">
                    <span>
                      首次同步摘要：自动同步到本地 {joinReport.autoSyncedSites.length} 个 · 本机上传{' '}
                      {joinReport.localUploadedSites.length} 个 · 敏感黑名单自动保护跳过{' '}
                      {joinReport.excludedBlacklistedSites.length} 个
                    </span>
                    {showReportDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showReportDetails ? (
                    <CardContent className="space-y-3 border-t border-border pt-3 text-xs">
                      {joinReport.autoSyncedSites.length > 0 ? (
                        <div>
                          <div className="mb-1.5 font-medium text-foreground">已从云端自动同步到本地：</div>
                          <div className="flex flex-wrap gap-1.5">
                            {joinReport.autoSyncedSites.map(site => (
                              <Badge key={site} variant="success">
                                {site}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {joinReport.localUploadedSites.length > 0 ? (
                        <div>
                          <div className="mb-1.5 flex items-center gap-1 font-medium text-foreground">
                            <CloudUpload className="h-3.5 w-3.5 text-primary" />
                            本机已加密上传站点（可快速排除）：
                          </div>
                          <div className="grid gap-1.5 sm:grid-cols-2">
                            {joinReport.localUploadedSites.map(site => (
                              <div
                                key={site}
                                className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5">
                                <span className="truncate">{site}</span>
                                {blacklistedUploaded[site] ? (
                                  <Badge variant="secondary">已排除</Badge>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={blacklistingSite[site]}
                                    onClick={() => void handleQuickBlacklistUploaded(site)}
                                    className="inline-flex items-center gap-1 text-destructive hover:underline">
                                    <Ban className="h-3 w-3" />
                                    不同步此站
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {joinReport.excludedBlacklistedSites.length > 0 ? (
                        <div>
                          <div className="mb-1.5 font-medium text-muted-foreground">敏感黑名单已自动跳过：</div>
                          <div className="flex flex-wrap gap-1.5">
                            {joinReport.excludedBlacklistedSites.map(site => (
                              <Badge key={site} variant="secondary">
                                {site}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </CardContent>
                  ) : null}
                </Card>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <p className="text-xs text-muted-foreground">
                  💡 提示：建议把浏览器右上角的 <strong>SessionMesh 拼图图标固定（Pin）在工具栏</strong>
                  ，平时点一下就能切号或开同步。
                </p>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button type="button" variant="outline" onClick={openSidePanelFromWindow}>
                    <PanelRightOpen className="mr-1.5 h-4 w-4" />
                    打开侧边栏
                  </Button>
                  <Button
                    type="button"
                    disabled={addingManaged}
                    onClick={() => void handleFinishWizard()}
                    className="min-w-[190px]">
                    {addingManaged ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {selectedCandidateList.length > 0
                      ? `保存所选 (${selectedCandidateList.length}) 并完成`
                      : '完成配置，开始使用'}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
