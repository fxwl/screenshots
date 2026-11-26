import type {
  BrowserCandidateSite,
  CapabilityReport,
  InitialJoinReport,
  PendingSiteDecision,
  RemoteSpacePasswordVerifyResult,
  RemoteSpaceProbeItem,
  SpaceSettings,
  SyncScopeMode,
  SyncTimingMode,
  WebDAVAuthType,
  WebDAVConfig,
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
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudUpload,
  Crown,
  Eye,
  EyeOff,
  FolderPlus,
  Globe,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  PanelRightOpen,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  detectDefaultDeviceName,
  extractErrorMessage,
  formatRelativeTime,
  openSidePanelFromWindow,
  PRESET_BLACKLIST_OPTIONS,
  saveUiNonSensitiveMeta,
  useUiBannerPrefs,
  WEBDAV_PRESETS,
  type PresetBlacklistCategory,
} from '../utils/helpers';
import { CapabilityReportView } from './CapabilityReportView';
import { PendingDecisionsPanel } from './PendingDecisionsPanel';

interface OnboardingWizardProps {
  alreadyConfigured?: boolean;
  onComplete: () => void | Promise<void>;
  onCancel?: () => void;
}

const STEPS = [
  { id: 1, title: '连接 WebDAV', subtitle: '支持配对码快填与自动空间探测' },
  { id: 2, title: '同步空间与加密', subtitle: '加入已有空间或创建新空间' },
  { id: 3, title: '纳管范围与安全', subtitle: '按需纳管、主基准设备与黑名单' },
  { id: 4, title: '选择同步网站', subtitle: '勾选纳管网站与处理重叠决策' },
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

export function OnboardingWizard({ alreadyConfigured = false, onComplete, onCancel }: OnboardingWizardProps) {
  const { isBannerVisible, dismissBanner } = useUiBannerPrefs();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1: Pairing code quick-fill
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingPassphrase, setPairingPassphrase] = useState('');
  const [decodingPairing, setDecodingPairing] = useState(false);
  const [pairedFromDevice, setPairedFromDevice] = useState<string | null>(null);

  // Step 1: WebDAV connection form
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<WebDAVAuthType>('basic');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [rootPath, setRootPath] = useState('/SessionMesh');
  const [showWebdavSecret, setShowWebdavSecret] = useState(false);
  const [allowLocalHttp, setAllowLocalHttp] = useState(false);
  const [storageFormat, setStorageFormat] = useState<'binary_enc' | 'base64_txt' | undefined>(undefined);
  const [activePresetTip, setActivePresetTip] = useState<string | null>(null);

  // Step 1: Capability test
  const [testingConn, setTestingConn] = useState(false);
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
  const userEditedStep2Ref = useRef(false);
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

  // Step 3: Managed scope, authority device, security & blacklist presets + settings
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

  // Step 4: InitialJoinReport + Opt-In Managed Sites picker state
  const [joinReport, setJoinReport] = useState<InitialJoinReport | null>(null);
  const [pendingDecisions, setPendingDecisions] = useState<PendingSiteDecision[]>([]);
  const [blacklistedUploaded, setBlacklistedUploaded] = useState<Record<string, boolean>>({});
  const [blacklistingSite, setBlacklistingSite] = useState<Record<string, boolean>>({});
  const [showExcludedList, setShowExcludedList] = useState(false);

  const [candidateSites, setCandidateSites] = useState<BrowserCandidateSite[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selectedCandidateKeys, setSelectedCandidateKeys] = useState<Record<string, boolean>>({});
  const [addingManaged, setAddingManaged] = useState(false);

  // Scroll cleanly to top whenever moving between onboarding steps
  useEffect(() => {
    try {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch {
      window.scrollTo(0, 0);
    }
  }, [step]);

  // Auto-hint Nutstore low-frequency mode when URL matches jianguoyun.com
  useEffect(() => {
    if (url.toLowerCase().includes('jianguoyun.com')) {
      setLowFrequencyMode(true);
    }
  }, [url]);

  const buildWebDAVConfig = (): WebDAVConfig => {
    const trimmedUrl = url.trim();
    const rawRoot = (rootPath.trim() || '/SessionMesh').replace(/\/+$/, '');
    const normalizedRoot = rawRoot ? (rawRoot.startsWith('/') ? rawRoot : `/${rawRoot}`) : '/SessionMesh';
    const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmedUrl);
    return {
      url: trimmedUrl,
      authType,
      username: authType === 'bearer' ? undefined : username.trim(),
      password: authType === 'bearer' ? undefined : password,
      bearerToken: authType === 'bearer' ? bearerToken.trim() : undefined,
      rootPath: normalizedRoot,
      retryPolicy: lowFrequencyMode ? 'low_frequency_nutstore' : 'standard',
      storageFormat,
      allowInsecureLocalhostForTesting: allowLocalHttp && isLocalhost ? true : undefined,
    };
  };

  const validateStep1 = (): string | null => {
    const trimmed = url.trim();
    if (!trimmed) return '请填写 WebDAV 服务器地址。';
    const isHttps = trimmed.startsWith('https://');
    const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
    if (!isHttps && !(allowLocalHttp && isLocalHttp)) {
      return '出于凭据安全要求，WebDAV 服务器必须使用 https:// 协议（禁止不安全的明文 HTTP）。';
    }
    try {
      new URL(trimmed);
    } catch {
      return 'WebDAV URL 格式无效，请检查协议、主机名与路径。';
    }
    if (authType === 'bearer') {
      if (!bearerToken.trim()) return '请填写 Bearer Token。';
    } else {
      if (!username.trim()) return '请填写 WebDAV 用户名。';
      if (!password) return '请填写 WebDAV 密码或应用专用密码。';
    }
    return null;
  };

  const probeSpaces = async (explicitConfig?: WebDAVConfig) => {
    if (!explicitConfig) {
      const errMsg = validateStep1();
      if (errMsg) {
        setStep1Error(errMsg);
        return;
      }
      setStep1Error(null);
    }
    setProbingSpaces(true);
    setProbeError(null);
    try {
      const list = await unwrapCommand<RemoteSpaceProbeItem[]>({
        type: 'PROBE_REMOTE_SPACES',
        config: explicitConfig ?? buildWebDAVConfig(),
      });
      const safeList = Array.isArray(list) ? list : [];
      setRemoteSpaces(safeList);
      setHasProbedSpaces(true);
      if (!pairedFromDevice && !userEditedStep2Ref.current) {
        if (safeList.length > 0) {
          setSpaceMode('join');
          const first = safeList[0];
          if (first) {
            const targetId = resolveProbeSpaceId(first);
            const targetName = resolveProbeSpaceName(first);
            setSpaceId(targetId);
            setSpaceName(targetName);
          }
        } else {
          setSpaceMode('create');
        }
      }
    } catch (err) {
      setProbeError(extractErrorMessage(err));
      setHasProbedSpaces(true);
    } finally {
      setProbingSpaces(false);
    }
  };

  const handleSelectRemoteSpaceAndAdvance = (item: RemoteSpaceProbeItem) => {
    const targetId = resolveProbeSpaceId(item);
    const targetName = resolveProbeSpaceName(item);
    setSpaceMode('join');
    setSpaceId(targetId);
    setSpaceName(targetName);
    setStep1Error(null);
    setStep(2);
  };

  const handleDecodePairingCode = async () => {
    if (!pairingCode.trim() || !pairingPassphrase) {
      toast.warning('请同时输入 smesh://pair/... 配对码和解密口令');
      return;
    }
    setDecodingPairing(true);
    try {
      const decoded = await unwrapCommand<{
        webdav: WebDAVConfig;
        spaceId: string;
        spaceName: string;
        fromDeviceName: string;
      }>({
        type: 'DECODE_PAIRING_CODE',
        code: pairingCode.trim(),
        passphrase: pairingPassphrase,
      });

      setUrl(decoded.webdav.url || '');
      setAuthType(decoded.webdav.authType || 'basic');
      setUsername(decoded.webdav.username || '');
      setPassword(decoded.webdav.password || '');
      setBearerToken(decoded.webdav.bearerToken || '');
      setRootPath(decoded.webdav.rootPath || '/SessionMesh');
      if (decoded.webdav.allowInsecureLocalhostForTesting) {
        setAllowLocalHttp(true);
      }
      if (decoded.webdav.storageFormat) {
        setStorageFormat(decoded.webdav.storageFormat);
      }
      if (decoded.spaceId) {
        setSpaceId(decoded.spaceId);
        setSpaceMode('join');
      }
      if (decoded.spaceName) {
        setSpaceName(decoded.spaceName);
      }
      setPairedFromDevice(decoded.fromDeviceName || '其他设备');
      setPairingOpen(false);
      setStep1Error(null);
      setHasProbedSpaces(false);
      toast.success(`已从「${decoded.fromDeviceName || '其他设备'}」配对码自动填入 WebDAV 与空间信息`);
    } catch (err) {
      toast.error(`配对码解密失败：${extractErrorMessage(err)}`);
    } finally {
      setDecodingPairing(false);
    }
  };

  const handleRunCapabilityTest = async () => {
    const errMsg = validateStep1();
    if (errMsg) {
      setStep1Error(errMsg);
      return;
    }
    setStep1Error(null);
    setTestingConn(true);
    try {
      const cfg = buildWebDAVConfig();
      const report = await unwrapCommand<CapabilityReport>({
        type: 'TEST_WEBDAV_CONNECTION',
        config: cfg,
      });
      setCapabilityReport(report);
      if (report.recommendedStorageFormat) {
        setStorageFormat(report.recommendedStorageFormat);
      }
      await saveUiNonSensitiveMeta({
        webdavUrl: cfg.url,
        authType: cfg.authType,
        rootPath: cfg.rootPath,
        username: cfg.username,
        lastCapabilityReport: report,
      });
      if (report.overallOk) {
        toast.success(
          `19 项检测完成：${report.consistencyLevel === 'strong_cas' ? '强一致 CAS 模式' : '单写者追加兼容模式'}`,
        );
        // Pillar 2: Immediately auto-detect remote spaces right in Step 1!
        await probeSpaces({
          ...cfg,
          storageFormat: report.recommendedStorageFormat ?? cfg.storageFormat,
        });
      } else {
        toast.error('WebDAV 能力检测未通过，请展开清单查看失败项');
      }
    } catch (err) {
      const msg = extractErrorMessage(err);
      setStep1Error(msg);
      toast.error(`连接测试失败：${msg}`);
    } finally {
      setTestingConn(false);
    }
  };

  const goToStep2 = async () => {
    const errMsg = validateStep1();
    if (errMsg) {
      setStep1Error(errMsg);
      return;
    }
    if (capabilityReport && !capabilityReport.overallOk) {
      toast.warning('当前服务器未通过能力检测，请先修复 WebDAV 配置后再继续');
      return;
    }
    setStep1Error(null);
    setStep(2);
    if (!hasProbedSpaces) {
      void probeSpaces();
    }
  };

  const currentVerifyKey = `${url.trim()}|${rootPath.trim()}|${spaceMode}|${spaceId.trim()}|${encryptionPassword}`;

  const verifyStep2EncryptionPassword = async (): Promise<boolean> => {
    const trimmedSpaceId = spaceId.trim();
    if (!trimmedSpaceId) {
      toast.warning('请先填写同步空间 ID（如 default）');
      return false;
    }
    if (!encryptionPassword || encryptionPassword.length < 6) {
      toast.warning('请输入至少 6 位的端到端加密主密码');
      return false;
    }
    if (spaceMode === 'create' && encryptionPassword !== confirmPassword) {
      toast.warning('两次输入的端到端加密密码不一致，请核对');
      return false;
    }

    setVerifyingPassword(true);
    try {
      const cfg = buildWebDAVConfig();
      const res = await unwrapCommand<RemoteSpacePasswordVerifyResult>({
        type: 'VERIFY_SPACE_PASSWORD',
        webdav: cfg,
        spaceId: trimmedSpaceId,
        encryptionPassword,
      });

      if (spaceMode === 'join') {
        if (!res.exists) {
          const msg = `远端 WebDAV 未找到 ID 为「${trimmedSpaceId}」的同步空间，请核对空间 ID 或切换为「创建新同步空间」`;
          setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
          toast.error(msg);
          return false;
        }
        if (!res.verified) {
          const msg = res.errorMessage || '端到端加密主密码错误，无法解密远端空间元数据，请核对后重试';
          setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
          toast.error(msg);
          return false;
        }
        if (res.spaceName) {
          setSpaceName(res.spaceName);
        }
        const okMsg = `主密码验证通过：已成功解密远端空间「${res.spaceName || res.spaceId || trimmedSpaceId}」`;
        setPasswordVerifyState({ ok: true, key: currentVerifyKey, message: okMsg });
        toast.success(okMsg);
        return true;
      }

      // spaceMode === 'create'
      if (res.exists && !res.verified) {
        const msg = `远端已存在 ID 为「${trimmedSpaceId}」的同步空间，但当前主密码无法解密。请更换全新的空间 ID，或切换为「加入已有同步空间」并输入原主密码。`;
        setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
        toast.error(msg);
        return false;
      }
      if (res.exists && res.verified) {
        if (res.spaceName) {
          setSpaceName(res.spaceName);
        }
        setSpaceMode('join');
        const nextKey = `${url.trim()}|${rootPath.trim()}|join|${trimmedSpaceId}|${encryptionPassword}`;
        const okMsg = `检测到远端已存在空间「${res.spaceName || res.spaceId || trimmedSpaceId}」且主密码校验通过，已自动切换为加入模式`;
        setPasswordVerifyState({ ok: true, key: nextKey, message: okMsg });
        toast.success(okMsg);
        return true;
      }

      const okMsg = `校验通过：远端空间 ID「${trimmedSpaceId}」尚未占用，主密码可用于初始化新空间`;
      setPasswordVerifyState({ ok: true, key: currentVerifyKey, message: okMsg });
      toast.success(okMsg);
      return true;
    } catch (err) {
      const msg = `主密码校验失败：${extractErrorMessage(err)}`;
      setPasswordVerifyState({ ok: false, key: currentVerifyKey, message: msg });
      toast.error(msg);
      return false;
    } finally {
      setVerifyingPassword(false);
    }
  };

  const goToStep3 = async () => {
    if (!spaceId.trim()) {
      toast.warning('请填写同步空间 ID（如 default）');
      return;
    }
    if (!deviceName.trim()) {
      toast.warning('请填写本机设备名称（如 Windows Edge）');
      return;
    }
    if (!encryptionPassword || encryptionPassword.length < 6) {
      toast.warning('请输入至少 6 位的端到端加密密码');
      return;
    }
    if (spaceMode === 'create' && encryptionPassword !== confirmPassword) {
      toast.warning('两次输入的端到端加密密码不一致，请核对');
      return;
    }
    if (authType !== 'bearer' && password && encryptionPassword === password) {
      toast.warning('强烈建议端到端加密密码与 WebDAV 密码不同，以防云盘密码泄漏导致密文被解');
    }

    // Always verify E2E encryption password against remote WebDAV before leaving Step 2
    if (!passwordVerifyState?.ok || passwordVerifyState.key !== currentVerifyKey) {
      const ok = await verifyStep2EncryptionPassword();
      if (!ok) {
        return;
      }
    }
    setStep(3);
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
    if (step === 4 && joinReport) {
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

  const handleClearCandidateSelection = () => {
    setSelectedCandidateKeys({});
  };

  const handleAddSelectedManagedSites = async () => {
    if (selectedCandidateList.length === 0) {
      toast.warning('请先勾选至少一个需要纳入同步管理的网站');
      return;
    }
    setAddingManaged(true);
    try {
      await unwrapCommand({
        type: 'ADD_MANAGED_SITES',
        siteKeys: selectedCandidateList,
      });
      toast.success(`已将 ${selectedCandidateList.length} 个网站纳入同步管理并开始加密同步`);
      setSelectedCandidateKeys({});
      await loadCandidateSites();
    } catch (err) {
      toast.error(`纳入同步管理失败：${extractErrorMessage(err)}`);
    } finally {
      setAddingManaged(false);
    }
  };

  const handleSaveAndJoin = async () => {
    setJoiningSpace(true);
    setJoinError(null);
    try {
      const cfg = buildWebDAVConfig();
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
        webdav: cfg,
        spaceId: spaceId.trim(),
        spaceName: spaceName.trim() || spaceId.trim(),
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
          toast.warning(`已加入空间，但设置主基准设备失败：${extractErrorMessage(authErr)}`);
        }
      }

      await saveUiNonSensitiveMeta({
        webdavUrl: cfg.url,
        authType: cfg.authType,
        rootPath: cfg.rootPath,
        username: cfg.username,
        lastCapabilityReport: capabilityReport ?? undefined,
      });

      setJoinReport(report);
      setPendingDecisions(report.pendingDecisions ?? []);
      setStep(4);
      toast.success(
        report.isNewSpace ? `已创建新同步空间「${report.spaceName}」` : `已成功加入同步空间「${report.spaceName}」`,
      );
    } catch (err) {
      const msg = extractErrorMessage(err);
      setJoinError(msg);
      toast.error(`加入空间失败：${msg}`);
    } finally {
      setJoiningSpace(false);
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
          reason: '首次配置向导快速拉黑',
          presetCategory: 'custom',
        },
      });
      setBlacklistedUploaded(prev => ({ ...prev, [siteKey]: true }));
      toast.success(`已将 ${siteKey} 加入本机黑名单，不再同步`);
    } catch (err) {
      toast.error(`拉黑失败：${extractErrorMessage(err)}`);
    } finally {
      setBlacklistingSite(prev => ({ ...prev, [siteKey]: false }));
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <img src={chrome.runtime.getURL('options/logo.png')} alt="SessionMesh" className="h-8 w-8 object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">SessionMesh 首次配置向导</h1>
            <p className="text-xs text-muted-foreground">
              4 步连接通用 WebDAV · 端到端 AES-256-GCM 加密 · 多设备自动发现与轨道决策
            </p>
          </div>
        </div>
        {alreadyConfigured && onCancel ? (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            返回控制中心
          </Button>
        ) : null}
      </div>

      {/* 4-Step Progress Bar */}
      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STEPS.map(item => {
          const done = step > item.id;
          const active = step === item.id;
          return (
            <div
              key={item.id}
              className={`rounded-xl border px-3 py-2.5 transition-all ${
                active
                  ? 'border-primary bg-primary/8 shadow-sm'
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
                <span className="truncate text-xs font-semibold text-foreground">{item.title}</span>
              </div>
              <p className="mt-1 truncate pl-8 text-[11px] text-muted-foreground">{item.subtitle}</p>
            </div>
          );
        })}
      </div>

      {/* STEP 1 */}
      {step === 1 ? (
        <div className="space-y-4">
          {/* Collapsible Pairing Code Card */}
          <Card className="border-primary/30 bg-primary/[0.03]">
            <button
              type="button"
              onClick={() => setPairingOpen(prev => !prev)}
              className="flex w-full items-center justify-between px-5 py-3.5 text-left">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <QrCode className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    已有其他设备？粘贴 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">smesh://pair/...</code>{' '}
                    配对码一键填入
                  </div>
                  <p className="text-xs text-muted-foreground">
                    10 秒完成设备 B/C 接入，自动解密填充 WebDAV 地址、凭据、根目录与空间信息
                  </p>
                </div>
              </div>
              {pairingOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>

            {pairingOpen ? (
              <CardContent className="border-t border-border/60 pt-4 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pairingCode">加密配对码</Label>
                  <Textarea
                    id="pairingCode"
                    rows={3}
                    value={pairingCode}
                    onChange={e => setPairingCode(e.target.value)}
                    placeholder="粘贴从设备 A 生成的 smesh://pair/v1.xxxx..."
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="pairingPassphrase">配对解密口令</Label>
                    <Input
                      id="pairingPassphrase"
                      type="password"
                      value={pairingPassphrase}
                      onChange={e => setPairingPassphrase(e.target.value)}
                      placeholder="输入生成配对码时设置的口令（通常为空间加密密码）"
                    />
                  </div>
                  <Button
                    type="button"
                    onClick={handleDecodePairingCode}
                    disabled={decodingPairing}
                    className="sm:w-44">
                    {decodingPairing ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    解密并一键填入
                  </Button>
                </div>
              </CardContent>
            ) : null}
          </Card>

          {pairedFromDevice ? (
            <Alert className="border-emerald-500/40 bg-emerald-500/10 pr-10">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <AlertTitle className="text-sm">已从「{pairedFromDevice}」配对码自动填入</AlertTitle>
              <AlertDescription className="text-xs">
                目标同步空间：<strong>{spaceName}</strong>（ID: <code>{spaceId}</code>
                ）。建议先点击下方测试连接，再进入下一步输入空间主加密密码。
              </AlertDescription>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setPairedFromDevice(null)}
                className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Server className="h-5 w-5 text-primary" />
                Step 1 · 连接 WebDAV 服务器
              </CardTitle>
              <CardDescription>
                支持任意标准 RFC 4918 HTTPS WebDAV 服务。所有同步数据在离开浏览器前均强制端到端加密。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Provider Quick-Hint Chips */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">常见 WebDAV 服务地址示例（点击快速参考/填充）：</Label>
                <div className="flex flex-wrap gap-2">
                  {WEBDAV_PRESETS.map(preset => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setUrl(preset.exampleUrl);
                        setAuthType(preset.defaultAuthType);
                        setRootPath(preset.defaultRootPath);
                        setActivePresetTip(preset.tip);
                        if (preset.recommendLowFreq) setLowFrequencyMode(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:border-primary/50 hover:bg-primary/10">
                      <Cloud className="h-3 w-3 text-primary" />
                      {preset.label}
                    </button>
                  ))}
                </div>
                {activePresetTip ? (
                  <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{activePresetTip}</p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="webdavUrl">WebDAV 服务器地址（强制 HTTPS）*</Label>
                  <Input
                    id="webdavUrl"
                    type="url"
                    value={url}
                    onChange={e => {
                      setUrl(e.target.value);
                      setStep1Error(null);
                      setHasProbedSpaces(false);
                      userEditedStep2Ref.current = false;
                    }}
                    placeholder="https://dav.jianguoyun.com/dav/ 或 https://cloud.example.com/remote.php/dav/files/user/"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>认证方式</Label>
                  <Select value={authType} onValueChange={val => setAuthType(val as WebDAVAuthType)}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择认证方式" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic 账号密码</SelectItem>
                      <SelectItem value="app_password">应用专用密码（坚果云 / Nextcloud 推荐）</SelectItem>
                      <SelectItem value="bearer">Bearer Token</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="rootPath">远端根目录</Label>
                  <Input
                    id="rootPath"
                    value={rootPath}
                    onChange={e => {
                      setRootPath(e.target.value);
                      setHasProbedSpaces(false);
                      userEditedStep2Ref.current = false;
                    }}
                    placeholder="/SessionMesh"
                  />
                </div>

                {authType === 'bearer' ? (
                  <div className="space-y-1.5 sm:col-span-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="bearerToken">Bearer Token *</Label>
                      <button
                        type="button"
                        onClick={() => setShowWebdavSecret(prev => !prev)}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        {showWebdavSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {showWebdavSecret ? '隐藏' : '显示'}
                      </button>
                    </div>
                    <Input
                      id="bearerToken"
                      type={showWebdavSecret ? 'text' : 'password'}
                      value={bearerToken}
                      onChange={e => setBearerToken(e.target.value)}
                      placeholder="输入 Bearer Access Token"
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="webdavUser">用户名 / 邮箱 *</Label>
                      <Input
                        id="webdavUser"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        placeholder="user@example.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="webdavPass">{authType === 'app_password' ? '应用专用密码 *' : '密码 *'}</Label>
                        <button
                          type="button"
                          onClick={() => setShowWebdavSecret(prev => !prev)}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          {showWebdavSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          {showWebdavSecret ? '隐藏' : '显示'}
                        </button>
                      </div>
                      <Input
                        id="webdavPass"
                        type={showWebdavSecret ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="输入 WebDAV 密码或应用专用密码"
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Local HTTP testing option (only visibly helpful if localhost URL entered) */}
              {url.trim().startsWith('http://localhost') || url.trim().startsWith('http://127.0.0.1') ? (
                <div className="flex items-center justify-between rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs">
                  <span>检测到本机回环地址，仅限开发或本地 Mock 测试允许放行 HTTP：</span>
                  <Switch checked={allowLocalHttp} onCheckedChange={setAllowLocalHttp} />
                </div>
              ) : null}

              {step1Error ? (
                <Alert variant="destructive" className="pr-10">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle className="text-sm">配置校验提示</AlertTitle>
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

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={testingConn || probingSpaces}
                    onClick={handleRunCapabilityTest}>
                    {testingConn ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    测试连接（19 项能力检测）
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    disabled={probingSpaces || testingConn}
                    onClick={() => void probeSpaces()}>
                    {probingSpaces ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="mr-2 h-4 w-4" />
                    )}
                    检测已有同步空间
                  </Button>
                </div>

                <Button type="button" onClick={goToStep2}>
                  下一步：选择空间与加密
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>

              {/* Pillar 2: Auto-Detected Remote Spaces Card Right Inside Step 1 */}
              {probingSpaces || hasProbedSpaces || probeError ? (
                <div className="rounded-xl border border-primary/35 bg-primary/[0.03] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Layers className="h-4 w-4 text-primary" />
                      远端同步空间自动检测结果
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={probingSpaces}
                      onClick={() => void probeSpaces()}
                      className="h-7 px-2 text-xs">
                      {probingSpaces ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      重新检测
                    </Button>
                  </div>

                  {probingSpaces ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      正在自动扫描 WebDAV 目录中的已有同步空间...
                    </div>
                  ) : probeError ? (
                    <Alert variant="destructive" className="pr-10">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle className="text-xs font-semibold">远端空间探测异常</AlertTitle>
                      <AlertDescription className="text-xs">
                        {probeError}（您仍可直接进入下一步手动输入空间 ID 创建或加入）
                      </AlertDescription>
                      <button
                        type="button"
                        aria-label="关闭提示"
                        onClick={() => setProbeError(null)}
                        className="absolute right-3 top-3 rounded p-1 text-destructive/80 hover:bg-destructive/10 hover:text-destructive">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Alert>
                  ) : remoteSpaces.length > 0 ? (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-900 dark:text-emerald-200">
                        🎉 检测到服务器上已有 {remoteSpaces.length}{' '}
                        个同步空间！直接点击下方空间即可一键选用并进入下一步。
                      </div>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        {remoteSpaces.map(s => {
                          const displayName = s.spaceName || s.hintId || s.opaqueId;
                          const displayId = s.spaceId || s.hintId || s.opaqueId;
                          return (
                            <div
                              key={s.opaqueId}
                              role="button"
                              tabIndex={0}
                              onClick={() => handleSelectRemoteSpaceAndAdvance(s)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleSelectRemoteSpaceAndAdvance(s);
                                }
                              }}
                              className="flex cursor-pointer flex-col justify-between gap-2.5 rounded-xl border border-border bg-background p-3.5 text-left transition-all hover:border-primary hover:shadow-sm">
                              <div className="space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
                                  <Badge variant="info" className="shrink-0 text-[10px]">
                                    已有空间
                                  </Badge>
                                </div>
                                <div className="font-mono text-xs text-muted-foreground break-all">
                                  (ID: {displayId})
                                </div>
                                {s.updatedAt ? (
                                  <div className="text-[11px] text-muted-foreground">
                                    最近更新：{formatRelativeTime(s.updatedAt)}
                                  </div>
                                ) : null}
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                className="h-8 w-full text-xs"
                                onClick={e => {
                                  e.stopPropagation();
                                  handleSelectRemoteSpaceAndAdvance(s);
                                }}>
                                选用此空间并进入下一步
                                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-sky-500/35 bg-sky-500/10 px-3 py-2.5 text-xs font-medium text-sky-900 dark:text-sky-200">
                      ✨ 当前 WebDAV 目录尚无同步空间，下一步将直接为您创建新空间
                    </div>
                  )}
                </div>
              ) : null}

              {capabilityReport ? (
                <div className="pt-2">
                  <CapabilityReportView report={capabilityReport} defaultExpanded={!capabilityReport.overallOk} />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* STEP 2 */}
      {step === 2 ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <KeyRound className="h-5 w-5 text-primary" />
                  Step 2 · 同步空间与端到端加密密码
                </CardTitle>
                <CardDescription>
                  自动探测 WebDAV 远端是否已有同步空间：支持设备 B/C 一键加入已有空间，或首台设备 A 创建新空间。
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={probingSpaces}
                onClick={() => void probeSpaces()}>
                {probingSpaces ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                重新探测远端空间
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Probed remote spaces */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">选择加入模式</Label>
                {probingSpaces ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在扫描远端目录...
                  </span>
                ) : (
                  <Badge variant={remoteSpaces.length > 0 ? 'info' : 'secondary'}>
                    {remoteSpaces.length > 0 ? `探测到 ${remoteSpaces.length} 个远端空间` : '远端暂无已有空间'}
                  </Badge>
                )}
              </div>

              {probeError ? (
                <div className="relative rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 pr-9 text-xs text-amber-900 dark:text-amber-200">
                  远端空间探测提示：{probeError}（你仍可手动填写空间 ID 创建或加入）
                  <button
                    type="button"
                    aria-label="关闭提示"
                    onClick={() => setProbeError(null)}
                    className="absolute right-2 top-1.5 rounded p-1 text-amber-800/80 hover:bg-amber-500/20 dark:text-amber-200">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    userEditedStep2Ref.current = true;
                    setSpaceMode('create');
                    if (!spaceId) setSpaceId('default');
                  }}
                  className={`rounded-xl border p-3.5 text-left transition-all ${
                    spaceMode === 'create'
                      ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                      : 'border-border bg-card hover:border-primary/40'
                  }`}>
                  <div className="flex items-center gap-2 font-semibold text-sm">
                    <FolderPlus className="h-4 w-4 text-primary" />
                    创建新同步空间 — 首台设备 A
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    在 WebDAV 初始化全新加密空间，下一步可自由选择需要同步管理的网站。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    userEditedStep2Ref.current = true;
                    setSpaceMode('join');
                  }}
                  className={`rounded-xl border p-3.5 text-left transition-all ${
                    spaceMode === 'join'
                      ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                      : 'border-border bg-card hover:border-primary/40'
                  }`}>
                  <div className="flex items-center gap-2 font-semibold text-sm">
                    <Layers className="h-4 w-4 text-primary" />
                    加入已有同步空间 — 设备 B / C
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    先校验密码并拉取远端元数据，绝不覆盖云端数据；重叠站点按基准策略或询问决策处理。
                  </p>
                </button>
              </div>

              {remoteSpaces.length > 0 && spaceMode === 'join' ? (
                <div className="space-y-2 rounded-xl border border-border bg-muted/25 p-3">
                  <div className="text-xs font-medium text-muted-foreground">点击选择探测到的远端空间：</div>
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
                          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-xs transition-colors ${
                            selected
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-border bg-background hover:border-primary/40'
                          }`}>
                          <div className="min-w-0 space-y-0.5">
                            <div className="font-semibold truncate text-foreground">{candidateName}</div>
                            <div className="font-mono text-[11px] text-muted-foreground truncate">
                              ID: {candidateId}
                            </div>
                            {sp.updatedAt ? (
                              <div className="text-[10px] text-muted-foreground">
                                更新于：{formatRelativeTime(sp.updatedAt)}
                              </div>
                            ) : null}
                          </div>
                          {selected ? <Badge variant="default">已选</Badge> : <Badge variant="outline">选择</Badge>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
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
                <p className="text-[11px] text-muted-foreground">同一空间的多台设备需填写相同 ID</p>
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
                  placeholder="我的主力空间"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="deviceName">本机设备名称 *</Label>
                <Input
                  id="deviceName"
                  value={deviceName}
                  onChange={e => setDeviceName(e.target.value)}
                  placeholder="Windows Edge"
                />
                <p className="text-[11px] text-muted-foreground">用于区分轨道来源（如「公司台式机」）</p>
              </div>
            </div>

            {/* E2E Encryption Password */}
            <div className="rounded-xl border border-primary/30 bg-primary/[0.04] p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <Lock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-foreground">
                    端到端加密主密码（E2E Encryption Password）
                  </div>
                  <p className="text-xs text-muted-foreground">
                    该密码<strong>永不发送至 WebDAV 服务器</strong>，仅在本地通过 PBKDF2-SHA256 + AES-256-GCM
                    加解密空间密钥。 请务必设置与 WebDAV 登录密码<strong>不同</strong>
                    的强密码并妥善保管，遗忘后任何人都无法恢复云端加密数据。
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="encPass">
                      {spaceMode === 'join' ? '输入该空间的端到端加密密码 *' : '设置端到端加密密码 *'}
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
                    onKeyDown={e => {
                      if (e.key === 'Enter' && encryptionPassword.length >= 6 && !verifyingPassword) {
                        e.preventDefault();
                        void verifyStep2EncryptionPassword();
                      }
                    }}
                    placeholder="至少 6 位，建议包含字母、数字与符号"
                  />
                </div>

                {spaceMode === 'create' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="confirmEncPass">确认端到端加密密码 *</Label>
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
                  <div className="flex flex-col justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={verifyingPassword || encryptionPassword.length < 6 || !spaceId.trim()}
                      onClick={() => void verifyStep2EncryptionPassword()}
                      className="h-9 w-fit text-xs">
                      {verifyingPassword ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="mr-1.5 h-3.5 w-3.5 text-primary" />
                      )}
                      立即验证主密码
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      将只读解密校验 <code>metadata/space.enc</code>，密码错误立即拦截且零破坏。
                    </span>
                  </div>
                )}
              </div>

              {spaceMode === 'create' ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="text-[11px] text-muted-foreground">
                    {confirmPassword && encryptionPassword !== confirmPassword ? (
                      <span className="text-destructive font-medium">两次输入的加密主密码不一致</span>
                    ) : encryptionPassword.length > 0 && encryptionPassword.length < 6 ? (
                      <span className="text-amber-600 dark:text-amber-400">主密码至少需要 6 位字符</span>
                    ) : encryptionPassword.length >= 6 && encryptionPassword === confirmPassword ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        两次输入一致，可校验远端空间 ID 是否可用
                      </span>
                    ) : (
                      <span>点击「校验空间与密码」或「下一步」时将自动核验远端空间状态</span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      verifyingPassword ||
                      encryptionPassword.length < 6 ||
                      encryptionPassword !== confirmPassword ||
                      !spaceId.trim()
                    }
                    onClick={() => void verifyStep2EncryptionPassword()}
                    className="h-7 px-2.5 text-[11px]">
                    {verifyingPassword ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-1 h-3 w-3 text-primary" />
                    )}
                    校验空间与密码
                  </Button>
                </div>
              ) : null}

              {passwordVerifyState && passwordVerifyState.key === currentVerifyKey ? (
                <div
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                    passwordVerifyState.ok
                      ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-destructive/40 bg-destructive/10 text-destructive'
                  }`}>
                  {passwordVerifyState.ok ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                  )}
                  <span>{passwordVerifyState.message}</span>
                </div>
              ) : null}

              {authType !== 'bearer' &&
              password &&
              encryptionPassword &&
              encryptionPassword === password &&
              isBannerVisible('onboarding_same_password_warn', 'security') ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>提示：当前端到端加密密码与 WebDAV 密码一致，强烈建议使用独立密码。</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void dismissBanner('onboarding_same_password_warn')}
                    className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20">
                    不再提示
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={verifyingPassword}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                上一步
              </Button>
              <Button type="button" onClick={() => void goToStep3()} disabled={verifyingPassword}>
                {verifyingPassword ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    正在校验主密码...
                  </>
                ) : (
                  <>
                    下一步：安全须知与黑名单
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* STEP 3 */}
      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              Step 3 · 同步纳管范围、主基准设备与敏感黑名单
            </CardTitle>
            <CardDescription>
              选择「仅同步已选网站（按需纳管）」或「全站自动同步」，并配置敏感站点黑名单预设。所有选项均可随时在控制中心修改。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {isBannerVisible('onboarding_step3_security_notice', 'security') ? (
              <Alert className="border-amber-500/40 bg-amber-500/10 pr-24">
                <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <AlertTitle className="text-sm font-semibold">凭据加密同步安全须知</AlertTitle>
                <AlertDescription className="text-xs leading-relaxed">
                  纳入同步管理的网站登录态（Cookie 与 LocalStorage）将经 AES-256-GCM
                  加密后同步至你同一空间下的其他受信任设备。
                  请勿在公共电脑登录同步空间，并建议勾选下方敏感站点黑名单预设，确保网银、密码管理器及 WebDAV
                  管理页始终仅保留在本机。
                </AlertDescription>
                <div className="absolute right-3 top-3 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void dismissBanner('onboarding_step3_security_notice')}
                    className="rounded px-1.5 py-0.5 text-[11px] text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
                    不再提示
                  </button>
                  <button
                    type="button"
                    aria-label="关闭安全须知"
                    onClick={() => void dismissBanner('onboarding_step3_security_notice')}
                    className="rounded p-1 text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </Alert>
            ) : null}

            {/* Pillar 1: Sync Scope Mode Selector */}
            <div className="space-y-2.5">
              <Label className="text-sm font-semibold">同步纳管范围</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSyncScopeMode('managed_only')}
                  className={`rounded-xl border p-3.5 text-left transition-all ${
                    syncScopeMode === 'managed_only'
                      ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                      : 'border-border bg-card hover:border-primary/40'
                  }`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      仅同步已纳入管理的网站（managed_only）
                    </span>
                    <Badge variant="success" className="shrink-0 text-[10px]">
                      推荐
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                    推荐：仅纳入我选择的网站才同步，不抓取无关浏览网页。下一步可直接勾选本机需要同步的网站，或随时在弹窗/右键菜单一键加入。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setSyncScopeMode('all_sites')}
                  className={`rounded-xl border p-3.5 text-left transition-all ${
                    syncScopeMode === 'all_sites'
                      ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                      : 'border-border bg-card hover:border-primary/40'
                  }`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">全站自动纳管（all_sites）</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      全量抓取
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                    全站无差别自动抓取并同步除黑名单以外的所有浏览网站登录态，适合希望零手动挑站的用户。
                  </p>
                </button>
              </div>
            </div>

            {/* Pillar 3: Optional Set As Primary Authority Device */}
            <div
              className={`flex items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                setAsPrimaryAuthority
                  ? 'border-primary/60 bg-primary/[0.05]'
                  : 'border-border bg-card hover:bg-muted/30'
              }`}>
              <input
                id="onboarding-primary-authority"
                type="checkbox"
                checked={setAsPrimaryAuthority}
                onChange={e => setSetAsPrimaryAuthority(e.target.checked)}
                className="mt-1 h-4 w-4 cursor-pointer rounded border-input accent-primary"
              />
              <label htmlFor="onboarding-primary-authority" className="block flex-1 cursor-pointer space-y-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  <Crown className="h-4 w-4 text-amber-500" />
                  将本机设为此空间的主基准设备（其他跟随设备冲突时默认以本机为准）
                </span>
                <span className="block text-xs text-muted-foreground">
                  勾选后会将空间基准策略设为「统一以指定基准设备为准（primary_device）」并指向本机。其他未配置独立策略的设备遇到重叠站点时将自动跟随本机版本，免去逐一确认弹窗。
                </span>
              </label>
            </div>

            {/* Preset Blacklist Categories */}
            <div className="space-y-2.5">
              <Label className="text-sm font-semibold">敏感黑名单预设（加入空间级 / 本机排除列表）</Label>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {PRESET_BLACKLIST_OPTIONS.map(opt => {
                  const checked = selectedPresets.includes(opt.category);
                  const inputId = `preset-bl-${opt.category}`;
                  return (
                    <div
                      key={opt.category}
                      className={`flex items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                        checked ? 'border-primary/50 bg-primary/[0.04]' : 'border-border bg-card hover:bg-muted/30'
                      }`}>
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePreset(opt.category)}
                        className="mt-1 h-4 w-4 cursor-pointer rounded border-input accent-primary"
                      />
                      <label htmlFor={inputId} className="block flex-1 cursor-pointer space-y-1">
                        <span className="block text-sm font-medium text-foreground">{opt.title}</span>
                        <span className="block text-xs text-muted-foreground">{opt.description}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground/80">{opt.examples}</span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Strategy Toggles */}
            <div className="space-y-2.5">
              <Label className="text-sm font-semibold">初始同步与保护策略</Label>
              <div className="divide-y divide-border rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between gap-4 p-3.5">
                  <div>
                    <div className="text-sm font-medium">自动同步</div>
                    <p className="text-xs text-muted-foreground">自动聚合上传并按需同步云端最新登录态</p>
                  </div>
                  <Switch checked={autoSync} onCheckedChange={setAutoSync} />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 p-3.5">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      上传时机
                      <Badge variant="info" className="text-[10px]">
                        推荐离开页面时
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      推荐在关闭或离开网页时合并上传最终状态，避免浏览过程中频繁请求网盘或双端互刷
                    </p>
                  </div>
                  <Select
                    value={syncTimingMode}
                    disabled={!autoSync}
                    onValueChange={v => setSyncTimingMode(v as SyncTimingMode)}>
                    <SelectTrigger className="w-48 h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on_page_leave">关闭/离开页面时上传（推荐）</SelectItem>
                      <SelectItem value="realtime">网页变动实时上传</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-4 p-3.5">
                  <div>
                    <div className="text-sm font-medium">LocalStorage 自动同步</div>
                    <p className="text-xs text-muted-foreground">
                      严格按 Origin 隔离同步前端 Token / SPA 登录态，支持未打开站点待上下文缓存
                    </p>
                  </div>
                  <Switch checked={syncLocalStorage} onCheckedChange={setSyncLocalStorage} />
                </div>

                <div className="flex items-center justify-between gap-4 p-3.5">
                  <div>
                    <div className="text-sm font-medium">手动同步后自动刷新网页（默认关闭）</div>
                    <p className="text-xs text-muted-foreground">
                      默认静默更新 Cookie 不打断正在浏览的网页；开启后仅在手动同步或切换轨道时生效，后台轮询绝不强刷页面
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Label
                        htmlFor="onboarding-refresh-protection"
                        className="text-xs font-normal text-muted-foreground">
                        表单保护
                      </Label>
                      <Switch
                        id="onboarding-refresh-protection"
                        checked={refreshProtection}
                        disabled={!autoRefresh}
                        onCheckedChange={setRefreshProtection}
                      />
                    </div>
                    <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 p-3.5">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      坚果云低频省流模式
                      {url.toLowerCase().includes('jianguoyun.com') ? (
                        <Badge variant="info" className="text-[10px]">
                          已为坚果云自动推荐
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      降低后台轮询频率并充分利用 ETag 短路与批次合并，避免触发网盘 API 限流（429）
                    </p>
                  </div>
                  <Switch checked={lowFrequencyMode} onCheckedChange={setLowFrequencyMode} />
                </div>

                <div className="flex items-center justify-between gap-4 p-3.5">
                  <div>
                    <div className="text-sm font-medium">浏览器重启主密码锁（高安全模式）</div>
                    <p className="text-xs text-muted-foreground">
                      开启后，每次彻底关闭并重启浏览器时需重新输入端到端主密码解锁同步引擎
                    </p>
                  </div>
                  <Switch checked={sessionLockEnabled} onCheckedChange={setSessionLockEnabled} />
                </div>
              </div>
            </div>

            {joinError ? (
              <Alert variant="destructive" className="pr-10">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle className="text-sm">保存并加入空间失败（本地与云端数据均安全保留）</AlertTitle>
                <AlertDescription className="text-xs">{joinError}</AlertDescription>
                <button
                  type="button"
                  aria-label="关闭错误提示"
                  onClick={() => setJoinError(null)}
                  className="absolute right-3 top-3 rounded p-1 text-destructive/80 hover:bg-destructive/10 hover:text-destructive">
                  <X className="h-3.5 w-3.5" />
                </button>
              </Alert>
            ) : null}

            <div className="flex items-center justify-between pt-2">
              <Button type="button" variant="outline" disabled={joiningSpace} onClick={() => setStep(2)}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                上一步
              </Button>
              <Button type="button" disabled={joiningSpace} onClick={handleSaveAndJoin} className="min-w-[180px]">
                {joiningSpace ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    正在校验并扫描站点...
                  </>
                ) : (
                  <>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    保存并加入同步空间
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* STEP 4 */}
      {step === 4 && joinReport ? (
        <div className="space-y-4">
          <Card className="border-emerald-500/40 bg-emerald-500/5">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                  <div>
                    <CardTitle className="text-lg">
                      {joinReport.isNewSpace ? '同步空间创建成功！' : '已成功加入同步空间！'}
                    </CardTitle>
                    <CardDescription>
                      空间「{joinReport.spaceName}」（ID: {joinReport.spaceId}）·{' '}
                      {syncScopeMode === 'managed_only'
                        ? '已启用按需纳管模式，请在下方勾选需要同步的网站'
                        : '已完成首次全站自动识别'}
                    </CardDescription>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {setAsPrimaryAuthority ? (
                    <Badge variant="warning" className="text-[11px]">
                      <Crown className="mr-1 h-3 w-3" />
                      空间主基准设备
                    </Badge>
                  ) : null}
                  <Badge variant="success">设备 ID: {joinReport.deviceId.slice(0, 12)}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">已自动同步到本地</div>
                  <div className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {joinReport.autoSyncedSites.length}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">本机已有加密上传</div>
                  <div className="mt-1 text-2xl font-bold text-primary">{joinReport.localUploadedSites.length}</div>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">待确认决策网站</div>
                  <div className="mt-1 text-2xl font-bold text-amber-600 dark:text-amber-400">
                    {pendingDecisions.length}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">黑名单已跳过</div>
                  <div className="mt-1 text-2xl font-bold text-muted-foreground">
                    {joinReport.excludedBlacklistedSites.length}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Pillar 1: Searchable Opt-In Managed Sites Picker */}
          <Card className="border-primary/40">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Globe className="h-5 w-5 text-primary" />
                    勾选本机需要纳入同步管理的网站
                  </CardTitle>
                  <CardDescription>
                    扫描本机浏览器中已有 Cookie 的站点；仅勾选的网站会上传加密同步（其余日常浏览网页保持仅本地）。
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
                  重新扫描
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {candidateError ? (
                <Alert variant="destructive" className="pr-10">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle className="text-xs font-semibold">扫描浏览器站点失败</AlertTitle>
                  <AlertDescription className="text-xs">{candidateError}</AlertDescription>
                  <button
                    type="button"
                    aria-label="关闭提示"
                    onClick={() => setCandidateError(null)}
                    className="absolute right-3 top-3 rounded p-1 text-destructive/80 hover:bg-destructive/10 hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={candidateSearch}
                    onChange={e => setCandidateSearch(e.target.value)}
                    placeholder="搜索站点域名（如 github.com、bilibili.com）..."
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
                  onClick={handleClearCandidateSelection}
                  className="h-9 text-xs">
                  清空
                </Button>
              </div>

              {loadingCandidates ? (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin text-primary" />
                  正在扫描本机浏览器已登录站点...
                </div>
              ) : filteredCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                  {candidateSites.length === 0
                    ? '本机浏览器当前未检测到可纳管站点 Cookie，后续访问任意网站时可在扩展弹窗或右键菜单一键纳入管理。'
                    : '未找到匹配搜索关键词的网站。'}
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
                                包含域名：{site.domains.slice(0, 3).join(', ')}
                                {site.domains.length > 3 ? ` 等 ${site.domains.length} 个` : ''}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px]">
                            {site.cookieCount} Cookie
                          </Badge>
                          {site.alreadyManaged ? (
                            <Badge variant="success" className="text-[10px]">
                              已纳管
                            </Badge>
                          ) : site.blacklisted ? (
                            <Badge variant="destructive" className="text-[10px]">
                              黑名单
                            </Badge>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <span className="text-xs text-muted-foreground">
                  共扫描到 {candidateSites.length} 个站点，当前已勾选 <strong>{selectedCandidateList.length}</strong>{' '}
                  个待纳管网站
                </span>
                <Button
                  type="button"
                  size="sm"
                  disabled={selectedCandidateList.length === 0 || addingManaged}
                  onClick={handleAddSelectedManagedSites}>
                  {addingManaged ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1.5 h-4 w-4" />
                  )}
                  将所选网站纳入同步管理
                  {selectedCandidateList.length > 0 ? ` (${selectedCandidateList.length})` : ''}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Pending Decisions (Device B & Device C) */}
          {pendingDecisions.length > 0 ? (
            <Card className="border-amber-500/40">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  待您确认的网站（{pendingDecisions.length}）
                </CardTitle>
                <CardDescription>
                  以下站点在本机与云端同时存在登录态，或云端存在多条账号轨道。请逐项或批量选择同步策略。
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

          {/* Auto-synced sites */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                已自动覆盖同步到本地的网站（{joinReport.autoSyncedSites.length}）
              </CardTitle>
              <CardDescription>云端已有单条轨道且本机无旧登录态，已自动拉取并绑定双向同步。</CardDescription>
            </CardHeader>
            <CardContent>
              {joinReport.autoSyncedSites.length === 0 ? (
                <p className="text-xs text-muted-foreground">本次无新增自动拉取覆盖的网站。</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {joinReport.autoSyncedSites.map(site => (
                    <Badge key={site} variant="success" className="px-2.5 py-1 text-xs">
                      {site}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Local uploaded sites with quick Blacklist button */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <CloudUpload className="h-4 w-4 text-primary" />
                本机已有并加密上传的网站（{joinReport.localUploadedSites.length}）
              </CardTitle>
              <CardDescription>
                以下本机站点已自动建立初始轨道并加密上传。如有不希望同步的网站，可点击右侧按钮一键加入黑名单。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {joinReport.localUploadedSites.length === 0 ? (
                <p className="text-xs text-muted-foreground">本次无本机独有站点上传。</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {joinReport.localUploadedSites.map(site => {
                    const doneBl = !!blacklistedUploaded[site];
                    const busyBl = !!blacklistingSite[site];
                    return (
                      <div
                        key={site}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
                        <span className="truncate text-sm font-medium text-foreground">{site}</span>
                        {doneBl ? (
                          <Badge variant="secondary" className="text-[11px]">
                            已拉黑
                          </Badge>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busyBl}
                            onClick={() => handleQuickBlacklistUploaded(site)}
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive">
                            {busyBl ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <Ban className="mr-1 h-3 w-3" />
                            )}
                            加入黑名单
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Excluded Blacklisted Sites */}
          {joinReport.excludedBlacklistedSites.length > 0 ? (
            <Card>
              <button
                type="button"
                onClick={() => setShowExcludedList(prev => !prev)}
                className="flex w-full items-center justify-between px-6 py-4 text-left">
                <span className="text-sm font-medium text-muted-foreground">
                  已按敏感黑名单自动跳过 {joinReport.excludedBlacklistedSites.length} 个站点
                </span>
                {showExcludedList ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showExcludedList ? (
                <CardContent className="pt-0">
                  <div className="flex flex-wrap gap-1.5">
                    {joinReport.excludedBlacklistedSites.map(site => (
                      <Badge key={site} variant="secondary" className="text-xs">
                        {site}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              ) : null}
            </Card>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={openSidePanelFromWindow}>
              <PanelRightOpen className="mr-2 h-4 w-4" />
              打开侧边栏完整管理台
            </Button>
            <Button
              type="button"
              onClick={async () => {
                // Remove ?onboarding=1 query param cleanly
                if (window.location.search.includes('onboarding=1')) {
                  window.history.replaceState({}, '', window.location.pathname);
                }
                await onComplete();
              }}>
              进入 SessionMesh 控制中心
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
