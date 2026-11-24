import type { InitialJoinReport, SyncStatusSummary } from '@sessionmesh/core';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from '@sessionmesh/ui';
import {
  CheckCircle2,
  Copy,
  Edit3,
  FolderPlus,
  KeyRound,
  Laptop,
  Layers,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  copyToClipboard,
  extractErrorMessage,
  getDeviceStatusMeta,
  loadUiNonSensitiveMeta,
  useUiBannerPrefs,
} from '../utils/helpers';

interface SpacesPairingTabProps {
  status: SyncStatusSummary;
  onRefreshStatus: () => Promise<void>;
}

export function SpacesPairingTab({ status, onRefreshStatus }: SpacesPairingTabProps) {
  const { isBannerVisible, dismissBanner } = useUiBannerPrefs();
  const [rootPathHint, setRootPathHint] = useState('/SessionMesh');

  // Switch space modal (optional password)
  const [switchTarget, setSwitchTarget] = useState<{ spaceId: string; name: string } | null>(null);
  const [switchPassword, setSwitchPassword] = useState('');
  const [switching, setSwitching] = useState(false);

  // Create space modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newSpaceId, setNewSpaceId] = useState('');
  const [newSpaceName, setNewSpaceName] = useState('');
  const [newSpacePass, setNewSpacePass] = useState('');
  const [newSpaceConfirm, setNewSpaceConfirm] = useState('');
  const [creatingSpace, setCreatingSpace] = useState(false);

  // Rename space modal
  const [renameTarget, setRenameTarget] = useState<{ spaceId: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  // Rotate password modal
  const [rotateOpen, setRotateOpen] = useState(false);
  const [oldPass, setOldPass] = useState('');
  const [nextPass, setNextPass] = useState('');
  const [nextPassConfirm, setNextPassConfirm] = useState('');
  const [rotating, setRotating] = useState(false);

  // Delete space modal
  const [deleteTarget, setDeleteTarget] = useState<{ spaceId: string; name: string } | null>(null);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [hideDeleteRemoteWarn, setHideDeleteRemoteWarn] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Pairing code generator
  const [pairingPassphrase, setPairingPassphrase] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');
  const [generatingCode, setGeneratingCode] = useState(false);

  useEffect(() => {
    void loadUiNonSensitiveMeta().then(meta => {
      if (meta.rootPath) setRootPathHint(meta.rootPath);
    });
    void unwrapCommand<{ webdav?: { rootPath?: string } | null }>({ type: 'GET_STATUS_SUMMARY' })
      .then(res => {
        if (res?.webdav?.rootPath) setRootPathHint(res.webdav.rootPath);
      })
      .catch(() => undefined);
  }, []);

  const handleSwitchSpace = async () => {
    if (!switchTarget) return;
    setSwitching(true);
    try {
      await unwrapCommand({
        type: 'SWITCH_SPACE',
        spaceId: switchTarget.spaceId,
        encryptionPassword: switchPassword || undefined,
      });
      toast.success(`已切换至同步空间「${switchTarget.name}」`);
      setSwitchTarget(null);
      setSwitchPassword('');
      await onRefreshStatus();
    } catch (err) {
      toast.error(`切换空间失败：${extractErrorMessage(err)}`);
    } finally {
      setSwitching(false);
    }
  };

  const handleCreateSpace = async () => {
    if (!newSpaceId.trim() || !newSpaceName.trim()) {
      toast.warning('请填写空间 ID 和名称');
      return;
    }
    if (newSpacePass.length < 6 || newSpacePass !== newSpaceConfirm) {
      toast.warning('请输入至少 6 位加密密码并确保两次输入一致');
      return;
    }
    setCreatingSpace(true);
    try {
      const rep = await unwrapCommand<InitialJoinReport>({
        type: 'CREATE_SPACE',
        spaceId: newSpaceId.trim(),
        spaceName: newSpaceName.trim(),
        encryptionPassword: newSpacePass,
      });
      toast.success(`已创建并切换到新空间「${rep?.spaceName || newSpaceName.trim()}」`);
      setCreateOpen(false);
      setNewSpaceId('');
      setNewSpaceName('');
      setNewSpacePass('');
      setNewSpaceConfirm('');
      await onRefreshStatus();
    } catch (err) {
      toast.error(`创建空间失败：${extractErrorMessage(err)}`);
    } finally {
      setCreatingSpace(false);
    }
  };

  const handleRenameSpace = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    setRenaming(true);
    try {
      await unwrapCommand({
        type: 'RENAME_SPACE',
        spaceId: renameTarget.spaceId,
        newName: renameValue.trim(),
      });
      toast.success(`空间已重命名为「${renameValue.trim()}」`);
      setRenameTarget(null);
      await onRefreshStatus();
    } catch (err) {
      toast.error(`重命名失败：${extractErrorMessage(err)}`);
    } finally {
      setRenaming(false);
    }
  };

  const handleRotatePassword = async () => {
    if (!oldPass || nextPass.length < 6 || nextPass !== nextPassConfirm) {
      toast.warning('请填写当前密码及至少 6 位新密码，并确认两次新密码一致');
      return;
    }
    setRotating(true);
    try {
      await unwrapCommand({
        type: 'ROTATE_SPACE_PASSWORD',
        oldPassword: oldPass,
        newPassword: nextPass,
      });
      toast.success('端到端空间加密密码已轮换并递增 keyEpoch（历史数据平滑兼容）');
      setRotateOpen(false);
      setOldPass('');
      setNextPass('');
      setNextPassConfirm('');
      await onRefreshStatus();
    } catch (err) {
      toast.error(`密码轮换失败：${extractErrorMessage(err)}`);
    } finally {
      setRotating(false);
    }
  };

  const handleDeleteSpace = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await unwrapCommand({
        type: 'DELETE_LOCAL_SPACE',
        spaceId: deleteTarget.spaceId,
        deleteRemote,
      });
      toast.success(
        deleteRemote
          ? `已删除空间「${deleteTarget.name}」的本地及远端加密数据`
          : `已移除本机空间「${deleteTarget.name}」（云端数据已保留）`,
      );
      setDeleteTarget(null);
      setDeleteRemote(false);
      await onRefreshStatus();
    } catch (err) {
      toast.error(`删除空间失败：${extractErrorMessage(err)}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!pairingPassphrase.trim()) {
      toast.warning('请设置或输入用于保护此配对码的口令（设备 B/C 粘贴时需输入相同口令）');
      return;
    }
    setGeneratingCode(true);
    try {
      const res = await unwrapCommand<string | { code: string }>({
        type: 'GENERATE_PAIRING_CODE',
        passphrase: pairingPassphrase.trim(),
      });
      const codeStr = typeof res === 'string' ? res : res?.code || '';
      if (!codeStr) {
        throw new Error('后端未返回有效配对码');
      }
      setGeneratedCode(codeStr);
      toast.success('已生成 AES-256-GCM 加密配对码');
    } catch (err) {
      toast.error(`生成配对码失败：${extractErrorMessage(err)}`);
    } finally {
      setGeneratingCode(false);
    }
  };

  const nonSensitiveSummary = [
    '=== SessionMesh 非敏感连接摘要（不含任何密码）===',
    `WebDAV 地址: ${status.webdavUrl || '(请填写您的 WebDAV URL)'}`,
    `远端根目录: ${rootPathHint}`,
    `同步空间 ID: ${status.activeSpaceId || 'default'}`,
    `同步空间名称: ${status.activeSpaceName || '默认同步空间'}`,
    'WebDAV 密码: ********（请手动输入）',
    '端到端加密主密码: ********（请手动输入）',
  ].join('\n');

  return (
    <div className="space-y-5">
      {/* Add Other Devices (B/C) & Pairing Code Card */}
      <Card className="border-primary/35 bg-primary/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Laptop className="h-5 w-5 text-primary" />
            添加其他设备（设备 B / C）— 10 秒快速配对
          </CardTitle>
          <CardDescription>
            生成加密配对码 <code>smesh://pair/...</code> 发送到你的另一台电脑，在首次向导 Step 1
            粘贴即可自动填入所有连接与空间参数。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Pairing & Shared Credential Security Notice */}
          {isBannerVisible('spaces_pairing_security_notice', 'security') ? (
            <Alert className="border-amber-500/40 bg-amber-500/10 pr-24">
              <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-sm font-semibold">跨设备配对与凭据安全提示</AlertTitle>
              <AlertDescription className="text-xs leading-relaxed">
                加密配对码包含 WebDAV
                连接信息，请仅在自己的受信任设备间私密传输，完成后及时删除聊天记录。若某设备不再信任，请同时轮换空间主密码与
                WebDAV 应用密码。
              </AlertDescription>
              <div className="absolute right-3 top-3 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void dismissBanner('spaces_pairing_security_notice')}
                  className="rounded px-1.5 py-0.5 text-[11px] text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
                  不再提示
                </button>
                <button
                  type="button"
                  aria-label="关闭安全提示"
                  onClick={() => void dismissBanner('spaces_pairing_security_notice')}
                  className="rounded p-1 text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </Alert>
          ) : null}

          <div className="rounded-xl border border-border bg-background p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <QrCode className="h-4 w-4 text-primary" />
              方式一：生成 <code>smesh://pair/...</code> 加密配对码（推荐）
            </div>
            <p className="text-xs text-muted-foreground">
              配对码使用你下方输入的口令进行 AES-256-GCM
              加密。新设备粘贴后需输入相同口令解密，并仍需验证空间端到端主密码。
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={pairingPassphrase}
                onChange={e => setPairingPassphrase(e.target.value)}
                placeholder="输入配对码加密口令（可设为一次性口令或空间主密码）"
                className="flex-1"
              />
              <Button
                type="button"
                disabled={generatingCode || status.locked}
                onClick={handleGeneratePairingCode}
                className="sm:w-44">
                {generatingCode ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-2 h-4 w-4" />
                )}
                生成加密配对码
              </Button>
            </div>

            {generatedCode ? (
              <div className="space-y-2 pt-1">
                <Textarea value={generatedCode} readOnly rows={3} className="font-mono text-xs bg-muted/40" />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    提示：请勿公开分享配对码，建议传输完成后删除聊天记录。
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => copyToClipboard(generatedCode, '已复制 smesh://pair 配对码')}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    复制配对码
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Non-sensitive copyable config summary */}
          <div className="rounded-xl border border-border bg-background p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">方式二：复制非敏感配置摘要（严格隐藏所有密码）</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(nonSensitiveSummary, '已复制非敏感连接摘要')}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                一键复制摘要
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs text-muted-foreground whitespace-pre-wrap">
              {nonSensitiveSummary}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Space List & Lifecycle Management */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className="h-5 w-5 text-primary" />
                多同步空间隔离管理（{status.spaces.length}）
              </CardTitle>
              <CardDescription>
                不同空间的数据、规则、设备与加密密钥完全隔离（例如「工作空间」与「个人空间」）。
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={status.locked}
                onClick={() => setRotateOpen(true)}>
                <KeyRound className="mr-1.5 h-4 w-4" />
                轮换当前空间加密密码
              </Button>
              <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
                <FolderPlus className="mr-1.5 h-4 w-4" />
                新建同步空间
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {status.spaces.length === 0 ? (
            <p className="text-xs text-muted-foreground">尚未加载同步空间列表。</p>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border">
              {status.spaces.map(sp => {
                const isActive = sp.spaceId === status.activeSpaceId;
                const st = getDeviceStatusMeta(sp.status);
                return (
                  <div
                    key={sp.spaceId}
                    className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 ${
                      isActive ? 'bg-primary/[0.04]' : ''
                    }`}>
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-sm text-foreground">{sp.name}</span>
                        {isActive ? (
                          <Badge variant="default">
                            <CheckCircle2 className="h-3 w-3" />
                            当前激活
                          </Badge>
                        ) : null}
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">Space ID: {sp.spaceId}</div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {!isActive ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setSwitchTarget({ spaceId: sp.spaceId, name: sp.name });
                            setSwitchPassword('');
                          }}>
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                          切换至此空间
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setRenameTarget({ spaceId: sp.spaceId, name: sp.name });
                          setRenameValue(sp.name);
                        }}>
                        <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                        重命名
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          setDeleteTarget({ spaceId: sp.spaceId, name: sp.name });
                          setDeleteRemote(false);
                        }}>
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Switch Space Dialog */}
      <Dialog open={!!switchTarget} onOpenChange={open => !open && setSwitchTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>切换至同步空间「{switchTarget?.name}」</DialogTitle>
            <DialogDescription>
              切换后将完全重置活跃同步上下文并拉取目标空间最新状态。如果目标空间尚未在本机解锁，请填写其端到端加密密码（已解锁空间可留空）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>端到端加密密码（可选，未解锁时必填）</Label>
            <Input
              type="password"
              value={switchPassword}
              onChange={e => setSwitchPassword(e.target.value)}
              placeholder="若该空间已保存本机加密密钥可留空"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={switching} onClick={() => setSwitchTarget(null)}>
              取消
            </Button>
            <Button type="button" disabled={switching} onClick={handleSwitchSpace}>
              {switching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              确认切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Space Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建独立同步空间</DialogTitle>
            <DialogDescription>在当前 WebDAV 目录下创建全新端到端加密空间，数据与现有空间完全隔离。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>空间 ID（字母/数字/连字符）*</Label>
              <Input
                value={newSpaceId}
                onChange={e => setNewSpaceId(e.target.value)}
                placeholder="例如 work 或 personal"
              />
            </div>
            <div className="space-y-1.5">
              <Label>空间名称 *</Label>
              <Input
                value={newSpaceName}
                onChange={e => setNewSpaceName(e.target.value)}
                placeholder="例如 公司工作账号"
              />
            </div>
            <div className="space-y-1.5">
              <Label>端到端加密密码（至少 6 位）*</Label>
              <Input type="password" value={newSpacePass} onChange={e => setNewSpacePass(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>确认加密密码 *</Label>
              <Input type="password" value={newSpaceConfirm} onChange={e => setNewSpaceConfirm(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={creatingSpace} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={creatingSpace} onClick={handleCreateSpace}>
              {creatingSpace ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              创建并切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Space Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={open => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名同步空间</DialogTitle>
            <DialogDescription>修改空间「{renameTarget?.spaceId}」的显示名称。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>新名称</Label>
            <Input value={renameValue} onChange={e => setRenameValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={renaming} onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button type="button" disabled={renaming} onClick={handleRenameSpace}>
              {renaming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              保存名称
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate Password Dialog */}
      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>轮换当前空间端到端加密密码</DialogTitle>
            <DialogDescription>
              将生成新的空间数据密钥（DEK）并递增 <code>keyEpoch</code>，同时使用新密码重新封装{' '}
              <code>metadata/space.enc</code>。其他设备下次同步时需输入新密码解锁。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>当前端到端加密密码 *</Label>
              <Input type="password" value={oldPass} onChange={e => setOldPass(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>新端到端加密密码（至少 6 位）*</Label>
              <Input type="password" value={nextPass} onChange={e => setNextPass(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>确认新密码 *</Label>
              <Input type="password" value={nextPassConfirm} onChange={e => setNextPassConfirm(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={rotating} onClick={() => setRotateOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={rotating} onClick={handleRotatePassword}>
              {rotating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              确认轮换密码
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Space Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除同步空间「{deleteTarget?.name}」</DialogTitle>
            <DialogDescription>默认仅移除本机该空间的缓存与配置，不影响云端及其他设备。</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <input
              id="delete-space-remote-checkbox"
              type="checkbox"
              checked={deleteRemote}
              onChange={e => {
                setDeleteRemote(e.target.checked);
                if (e.target.checked) setHideDeleteRemoteWarn(false);
              }}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-destructive"
            />
            <label htmlFor="delete-space-remote-checkbox" className="block flex-1 cursor-pointer">
              <span className="block font-semibold text-destructive">同时永久删除 WebDAV 远端该空间全部加密数据</span>
              <span className="mt-0.5 block text-muted-foreground">
                高危操作！勾选后其他设备也将无法再读取此空间的云端事件和快照。
              </span>
            </label>
          </div>
          {deleteRemote && !hideDeleteRemoteWarn ? (
            <Alert variant="destructive" className="pr-10">
              <AlertTitle className="text-xs">请再次确认</AlertTitle>
              <AlertDescription className="text-xs">远端空间文件一旦删除将无法撤销。</AlertDescription>
              <button
                type="button"
                aria-label="关闭确认提示"
                onClick={() => setHideDeleteRemoteWarn(true)}
                className="absolute right-3 top-3 rounded p-1 text-destructive/80 hover:bg-destructive/10 hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={handleDeleteSpace}>
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {deleteRemote ? '永久删除本地与云端' : '仅从本机移除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
