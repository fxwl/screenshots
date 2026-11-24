import type { PendingSiteDecision } from '@sessionmesh/core';
import { unwrapCommand, useSessionMeshStatus, useTheme, withErrorBoundary, withSuspense } from '@sessionmesh/shared';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ThemeDropdown,
  Toaster,
} from '@sessionmesh/ui';
import {
  AlertTriangle,
  Ban,
  Layers,
  Loader2,
  Lock,
  Monitor,
  PanelRightOpen,
  RefreshCw,
  Server,
  Settings2,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { OnboardingWizard } from './components/OnboardingWizard';
import { PendingDecisionsPanel } from './components/PendingDecisionsPanel';
import { PolicyAdvancedTab } from './components/PolicyAdvancedTab';
import { RulesBlacklistTab } from './components/RulesBlacklistTab';
import { SpacesPairingTab } from './components/SpacesPairingTab';
import { WebDAVTab } from './components/WebDAVTab';
import { extractErrorMessage, getDeviceStatusMeta, openSidePanelFromWindow } from './utils/helpers';

const Options = () => {
  const { theme, setTheme } = useTheme();
  const { status, settings, refresh, loading } = useSessionMeshStatus();

  const [forceWizard, setForceWizard] = useState<boolean>(() => {
    try {
      return new URLSearchParams(window.location.search).get('onboarding') === '1';
    } catch {
      return false;
    }
  });
  const [activeTab, setActiveTab] = useState('webdav');

  // Unlock form when locked
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  // Sync now
  const [syncingNow, setSyncingNow] = useState(false);

  // Dismiss latest error
  const [dismissingError, setDismissingError] = useState(false);
  const [dismissedErrorTs, setDismissedErrorTs] = useState<number | null>(null);

  // Pending decisions drawer
  const [pendingDecisions, setPendingDecisions] = useState<PendingSiteDecision[]>([]);
  const [showPendingPanel, setShowPendingPanel] = useState(true);

  const loadPendingDecisions = useCallback(async () => {
    if (!status?.configured || status.locked || (status.pendingDecisionsCount ?? 0) === 0) {
      setPendingDecisions([]);
      return;
    }
    try {
      const list = await unwrapCommand<PendingSiteDecision[]>({ type: 'GET_PENDING_DECISIONS' });
      setPendingDecisions(Array.isArray(list) ? list : []);
    } catch {
      // ignore transient error
    }
  }, [status?.configured, status?.locked, status?.pendingDecisionsCount]);

  useEffect(() => {
    void loadPendingDecisions();
  }, [loadPendingDecisions]);

  const handleUnlock = async () => {
    if (!unlockPassword) {
      toast.warning('请输入端到端加密主密码');
      return;
    }
    setUnlocking(true);
    try {
      await unwrapCommand({
        type: 'UNLOCK_SESSION',
        encryptionPassword: unlockPassword,
        spaceId: status?.activeSpaceId,
      });
      setUnlockPassword('');
      toast.success('会话已解锁，同步引擎已恢复运行');
      await refresh();
    } catch (err) {
      toast.error(`解锁失败：${extractErrorMessage(err)}`);
    } finally {
      setUnlocking(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncingNow(true);
    try {
      const res = await unwrapCommand<{
        pushedEvents: number;
        pulledEvents: number;
        appliedCookies: number;
        failedCookies: number;
        errorMessage?: string;
        errorCode?: string;
      }>({ type: 'SYNC_NOW' });
      if (res?.errorMessage) {
        toast.warning(`WebDAV 云端暂时繁忙，系统将继续后台自动退避重试：${res.errorMessage}`);
      } else {
        const applied = res?.appliedCookies ?? 0;
        const refreshHint = applied > 0 && !settings?.autoRefresh ? '，刷新对应网页即可生效' : '';
        toast.success(
          `同步完成：上传 ${res?.pushedEvents ?? 0} 条，拉取 ${res?.pulledEvents ?? 0} 条，应用 ${applied} 条 Cookie${refreshHint}`,
        );
      }
      await refresh();
    } catch (err) {
      toast.error(`同步失败：${extractErrorMessage(err)}`);
    } finally {
      setSyncingNow(false);
    }
  };

  const handleDismissLatestError = async () => {
    if (status?.latestError?.timestamp) {
      setDismissedErrorTs(status.latestError.timestamp);
    }
    setDismissingError(true);
    try {
      await unwrapCommand({ type: 'DISMISS_LATEST_ERROR' });
      await refresh();
    } catch (err) {
      setDismissedErrorTs(null);
      toast.error(`关闭错误提示失败：${extractErrorMessage(err)}`);
    } finally {
      setDismissingError(false);
    }
  };

  const showInitialLoading = loading && !status.configured && !forceWizard;
  const inWizardMode = forceWizard || (!loading && !status.configured);

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <img src={chrome.runtime.getURL('options/logo.png')} alt="SessionMesh" className="h-8 w-8 object-contain" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight">SessionMesh</span>
                <Badge variant="outline" className="text-[10px]">
                  E2E WebDAV Sync
                </Badge>
              </div>
              {status?.configured ? (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Layers className="h-3 w-3" />
                    {status.activeSpaceName || status.activeSpaceId || '默认空间'}
                  </span>
                  {status.device?.name ? (
                    <span className="inline-flex items-center gap-1">
                      <Monitor className="h-3 w-3" />
                      {status.device.name}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {status?.configured ? (
              <>
                <Badge variant={getDeviceStatusMeta(status.status, settings?.syncTimingMode).variant}>
                  {getDeviceStatusMeta(status.status, settings?.syncTimingMode).label}
                </Badge>
                {!inWizardMode ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={syncingNow || status.locked}
                      onClick={handleSyncNow}>
                      {syncingNow ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      立即同步
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={openSidePanelFromWindow}>
                      <PanelRightOpen className="mr-1.5 h-3.5 w-3.5" />
                      打开管理侧边栏
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setForceWizard(true)}>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      配置向导
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
            <ThemeDropdown setTheme={setTheme} />
          </div>
        </div>
      </header>

      {/* Main Content */}
      {showInitialLoading ? (
        <div className="flex min-h-[60vh] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          正在加载 SessionMesh 状态...
        </div>
      ) : inWizardMode ? (
        <OnboardingWizard
          alreadyConfigured={!!status?.configured}
          onComplete={async () => {
            setForceWizard(false);
            try {
              window.scrollTo({ top: 0, behavior: 'instant' });
            } catch {
              window.scrollTo(0, 0);
            }
            await refresh();
          }}
          onCancel={
            status?.configured
              ? () => {
                  if (window.location.search.includes('onboarding=1')) {
                    window.history.replaceState({}, '', window.location.pathname);
                  }
                  setForceWizard(false);
                  try {
                    window.scrollTo({ top: 0, behavior: 'instant' });
                  } catch {
                    window.scrollTo(0, 0);
                  }
                }
              : undefined
          }
        />
      ) : status ? (
        <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
          {/* Session Lock / Key-Rotation Decrypt Error Card */}
          {status.locked || status.status === 'DECRYPT_ERROR' ? (
            <Card
              className={
                status.status === 'DECRYPT_ERROR'
                  ? 'border-destructive/50 bg-destructive/5'
                  : 'border-amber-500/45 bg-amber-500/5'
              }>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Lock
                    className={`h-5 w-5 ${
                      status.status === 'DECRYPT_ERROR' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'
                    }`}
                  />
                  {status.status === 'DECRYPT_ERROR'
                    ? '需要输入最新端到端主密码以重新解锁'
                    : '同步会话已锁定，请输入端到端主密码解锁'}
                </CardTitle>
                <CardDescription>
                  {status.status === 'DECRYPT_ERROR'
                    ? '检测到空间端到端主密码已变更或校验未通过，请输入最新主密码验证后即可自动恢复同步（本地与云端数据均完好保留）。'
                    : '本地与云端数据均安全保留。验证主密码后将立即恢复自动同步与控制中心全部操作。'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="password"
                    value={unlockPassword}
                    onChange={e => setUnlockPassword(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void handleUnlock();
                    }}
                    placeholder="输入空间端到端加密主密码"
                    className="max-w-md"
                  />
                  <Button type="button" disabled={unlocking} onClick={handleUnlock}>
                    {unlocking ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Unlock className="mr-2 h-4 w-4" />
                    )}
                    {status.status === 'DECRYPT_ERROR' ? '验证并恢复同步' : '解锁会话'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Latest Error Alert (only shown when actionable, silencing transient self-healing blips) */}
          {status.latestError &&
          status.status !== 'DECRYPT_ERROR' &&
          dismissedErrorTs !== status.latestError.timestamp &&
          (status.attentionItems ?? []).some(
            item =>
              item.kind === 'latest_error' ||
              item.kind === 'auth_error' ||
              item.kind === 'decrypt_error' ||
              item.kind === 'storage_full',
          ) ? (
            <Alert
              variant={
                (status.attentionItems ?? []).some(item => item.severity === 'error') ? 'destructive' : 'default'
              }
              className={
                (status.attentionItems ?? []).some(item => item.severity === 'error')
                  ? 'pr-24'
                  : 'border-amber-500/45 bg-amber-500/5 pr-24'
              }>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle className="text-sm font-semibold">
                {status.latestError.retryable
                  ? `WebDAV 云端暂时繁忙 [${status.latestError.code}] — 后台自动退避重试中`
                  : `同步异常 [${status.latestError.code}] — 本地与云端数据均安全保留`}
              </AlertTitle>
              <AlertDescription className="mt-1 space-y-1 text-xs">
                <p>{status.latestError.message}</p>
                {status.latestError.suggestion ? (
                  <p className="font-medium">处理建议：{status.latestError.suggestion}</p>
                ) : null}
              </AlertDescription>
              <button
                type="button"
                disabled={dismissingError}
                onClick={() => void handleDismissLatestError()}
                className="absolute right-3 top-3 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-3.5 w-3.5" />
                关闭提示
              </button>
            </Alert>
          ) : null}

          {/* Pending Site Decisions Urgent Section */}
          {pendingDecisions.length > 0 ? (
            <Card className="border-amber-500/45">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-5 w-5" />有 {pendingDecisions.length} 个待确认同步决策的网站
                  </CardTitle>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowPendingPanel(prev => !prev)}>
                    {showPendingPanel ? '暂时折叠' : '展开处理'}
                  </Button>
                </div>
              </CardHeader>
              {showPendingPanel ? (
                <CardContent>
                  <PendingDecisionsPanel
                    decisions={pendingDecisions}
                    onResolved={async () => {
                      await refresh();
                      await loadPendingDecisions();
                    }}
                  />
                </CardContent>
              ) : null}
            </Card>
          ) : null}

          {/* 4-Tab Control Center */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 sm:grid-cols-4">
              <TabsTrigger value="webdav" className="py-2 text-xs sm:text-sm">
                <Server className="h-4 w-4" />
                WebDAV 存储与维护
              </TabsTrigger>
              <TabsTrigger value="spaces" className="py-2 text-xs sm:text-sm">
                <Layers className="h-4 w-4" />
                同步空间与跨设备配对
              </TabsTrigger>
              <TabsTrigger value="rules" className="py-2 text-xs sm:text-sm">
                <Ban className="h-4 w-4" />
                同步规则与双层黑名单
              </TabsTrigger>
              <TabsTrigger value="policy" className="py-2 text-xs sm:text-sm">
                <Settings2 className="h-4 w-4" />
                同步策略与高级设置
              </TabsTrigger>
            </TabsList>

            <TabsContent value="webdav" className="mt-5">
              <WebDAVTab status={status} onRefreshStatus={refresh} onOpenWizard={() => setForceWizard(true)} />
            </TabsContent>

            <TabsContent value="spaces" className="mt-5">
              <SpacesPairingTab status={status} onRefreshStatus={refresh} />
            </TabsContent>

            <TabsContent value="rules" className="mt-5">
              <RulesBlacklistTab status={status} />
            </TabsContent>

            <TabsContent value="policy" className="mt-5">
              <PolicyAdvancedTab status={status} onRefreshStatus={refresh} onOpenWizard={() => setForceWizard(true)} />
            </TabsContent>
          </Tabs>
        </main>
      ) : null}

      <Toaster theme={theme} position="top-center" richColors visibleToasts={2} toastOptions={{ duration: 2800 }} />
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(
    Options,
    <div className="flex h-screen w-screen items-center justify-center text-sm text-muted-foreground">
      正在加载 SessionMesh 控制中心...
    </div>,
  ),
  <div className="flex h-screen w-screen items-center justify-center p-6 text-sm text-destructive">
    SessionMesh 控制中心渲染异常，请刷新页面重试。
  </div>,
);
