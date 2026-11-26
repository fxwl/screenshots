import type { ImportArchiveBackupMode, ImportArchiveBackupResult, SyncStatusSummary } from '@sessionmesh/core';
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
} from '@sessionmesh/ui';
import {
  Archive,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  Loader2,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { downloadBase64File, extractErrorMessage, formatBytes, readFileAsBase64 } from '../utils/helpers';

interface LocalBackupCardProps {
  status: SyncStatusSummary;
  onRefreshStatus?: () => Promise<void>;
}

function buildFallbackArchiveFilename(spaceName?: string): string {
  const safeSpace =
    (spaceName || 'default')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'default';
  const dateStr = new Date().toISOString().slice(0, 10);
  return `sessionmesh-backup-${safeSpace}-${dateStr}.smesh-backup`;
}

export function LocalBackupCard({ status, onRefreshStatus }: LocalBackupCardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Export state
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [showExportPass, setShowExportPass] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Import state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [showImportPass, setShowImportPass] = useState(false);
  const [importMode, setImportMode] = useState<ImportArchiveBackupMode>('merge');
  const [importing, setImporting] = useState(false);
  const [lastImportResult, setLastImportResult] = useState<ImportArchiveBackupResult | null>(null);

  const disabled = !status.configured || status.locked;

  const handleExportArchive = async () => {
    setExporting(true);
    try {
      const res = await unwrapCommand<{ base64: string; suggestedFilename: string; byteLength: number }>({
        type: 'EXPORT_ARCHIVE_BACKUP',
        passphrase: exportPassphrase.trim() || undefined,
      });
      if (!res?.base64) {
        throw new Error('后端未返回有效的加密归档数据');
      }
      const filename =
        res.suggestedFilename || buildFallbackArchiveFilename(status.activeSpaceName || status.activeSpaceId);
      downloadBase64File(filename, res.base64);
      toast.success(`已导出单文件加密备份：${filename}（${formatBytes(res.byteLength)}）`);
    } catch (err) {
      toast.error(`导出备份失败：${extractErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImportArchive = async () => {
    if (!selectedFile) {
      toast.warning('请先选择需要导入的 .smesh-backup 加密备份文件');
      return;
    }
    setImporting(true);
    try {
      const base64 = await readFileAsBase64(selectedFile);
      const result = await unwrapCommand<ImportArchiveBackupResult>({
        type: 'IMPORT_ARCHIVE_BACKUP',
        base64,
        passphrase: importPassphrase.trim() || undefined,
        mode: importMode,
      });
      setLastImportResult(result);
      toast.success(
        `备份导入完成：Cookie ${result.importedCookies} 条、LocalStorage ${result.importedLocalStorage} 条、账号轨道 ${result.importedTracks} 条`,
      );
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await onRefreshStatus?.();
    } catch (err) {
      toast.error(`导入恢复失败：${extractErrorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card className="border-primary/25">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileArchive className="h-5 w-5 text-primary" />
              本地加密单文件备份与迁移（.smesh-backup）
            </CardTitle>
            <CardDescription>
              跨浏览器通用（Chrome / Edge / Firefox 均可使用，不限当前云存储后端）。导出后可手动存入 OneDrive / iCloud /
              U 盘离线迁移或容灾恢复。
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-[11px]">
            SMES v2 · AES-256-GCM
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Export .smesh-backup */}
          <div className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-muted/15 p-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Download className="h-4 w-4 text-primary" />
                导出加密备份文件
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                将当前空间的 Cookie、LocalStorage、SessionStorage、IndexedDB、多账号轨道与同步规则打包为单个{' '}
                <code>.smesh-backup</code> 认证加密文件。
              </p>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="sm-export-backup-pass" className="text-xs">
                    专属备份加密口令（可选）
                  </Label>
                  <button
                    type="button"
                    onClick={() => setShowExportPass(prev => !prev)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    {showExportPass ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showExportPass ? '隐藏' : '显示'}
                  </button>
                </div>
                <Input
                  id="sm-export-backup-pass"
                  type={showExportPass ? 'text' : 'password'}
                  disabled={disabled || exporting}
                  value={exportPassphrase}
                  onChange={e => setExportPassphrase(e.target.value)}
                  placeholder="留空或输入独立备份保护口令"
                />
                <p className="text-[11px] text-muted-foreground">
                  提示：留空将使用当前空间默认保护口令（建议重要冷备份设置独立口令并妥善保管）。
                </p>
              </div>
            </div>

            <Button
              type="button"
              disabled={disabled || exporting}
              onClick={() => void handleExportArchive()}
              className="w-full sm:w-fit">
              {exporting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Archive className="mr-1.5 h-4 w-4" />}
              导出 .smesh-backup 加密备份
            </Button>
          </div>

          {/* Import .smesh-backup */}
          <div className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-muted/15 p-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Upload className="h-4 w-4 text-primary" />
                导入加密备份恢复
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sm-import-backup-file" className="text-xs">
                  选择备份文件（.smesh-backup）
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    id="sm-import-backup-file"
                    type="file"
                    accept=".smesh-backup,.enc,.bin,application/octet-stream"
                    disabled={disabled || importing}
                    onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted"
                  />
                </div>
                {selectedFile ? (
                  <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
                    已选文件：<code>{selectedFile.name}</code>（{formatBytes(selectedFile.size)}）
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="sm-import-backup-pass" className="text-xs">
                    备份解密口令
                  </Label>
                  <button
                    type="button"
                    onClick={() => setShowImportPass(prev => !prev)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    {showImportPass ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showImportPass ? '隐藏' : '显示'}
                  </button>
                </div>
                <Input
                  id="sm-import-backup-pass"
                  type={showImportPass ? 'text' : 'password'}
                  disabled={disabled || importing}
                  value={importPassphrase}
                  onChange={e => setImportPassphrase(e.target.value)}
                  placeholder="输入导出备份时设置的解密口令（未设置则留空）"
                />
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium leading-none">恢复模式</div>
                <div className="grid gap-2">
                  <div
                    className={`flex items-start gap-2.5 rounded-lg border p-2.5 text-xs transition-colors ${
                      importMode === 'merge'
                        ? 'border-primary bg-primary/[0.06]'
                        : 'border-border bg-background hover:bg-muted/30'
                    }`}>
                    <input
                      id="sm-archive-import-mode-merge"
                      type="radio"
                      name="sm-archive-import-mode"
                      value="merge"
                      checked={importMode === 'merge'}
                      onChange={() => setImportMode('merge')}
                      disabled={disabled || importing}
                      className="mt-0.5 cursor-pointer accent-primary"
                    />
                    <label htmlFor="sm-archive-import-mode-merge" className="block flex-1 cursor-pointer">
                      <span className="flex items-center gap-1.5 font-semibold text-foreground">
                        因果智能合并 (merge)
                        <Badge variant="success" className="px-1.5 py-0 text-[9px]">
                          推荐
                        </Badge>
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        保留本机独有站点并按因果版本合并增量账号与记录，安全无损。
                      </span>
                    </label>
                  </div>

                  <div
                    className={`flex items-start gap-2.5 rounded-lg border p-2.5 text-xs transition-colors ${
                      importMode === 'replace'
                        ? 'border-amber-500/70 bg-amber-500/[0.06]'
                        : 'border-border bg-background hover:bg-muted/30'
                    }`}>
                    <input
                      id="sm-archive-import-mode-replace"
                      type="radio"
                      name="sm-archive-import-mode"
                      value="replace"
                      checked={importMode === 'replace'}
                      onChange={() => setImportMode('replace')}
                      disabled={disabled || importing}
                      className="mt-0.5 cursor-pointer accent-primary"
                    />
                    <label htmlFor="sm-archive-import-mode-replace" className="block flex-1 cursor-pointer">
                      <span className="block font-semibold text-foreground">全量覆盖恢复 (replace)</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        用备份文件内容全量覆盖恢复当前空间状态（适合新机还原或彻底回滚）。
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="secondary"
              disabled={disabled || importing || !selectedFile}
              onClick={() => void handleImportArchive()}
              className="w-full sm:w-fit">
              {importing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-1.5 h-4 w-4" />
              )}
              解密并导入恢复
            </Button>
          </div>
        </div>

        {lastImportResult ? (
          <Alert className="border-emerald-500/40 bg-emerald-500/5 pr-10">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <AlertTitle className="text-sm font-semibold">
              已导入备份「{lastImportResult.spaceName}」（
              {lastImportResult.mode === 'merge' ? '因果智能合并' : '全量覆盖恢复'}）
            </AlertTitle>
            <AlertDescription className="mt-1.5 flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">Cookie：{lastImportResult.importedCookies}</Badge>
              <Badge variant="outline">LocalStorage：{lastImportResult.importedLocalStorage}</Badge>
              <Badge variant="outline">SessionStorage：{lastImportResult.importedSessionStorage}</Badge>
              <Badge variant="outline">IndexedDB：{lastImportResult.importedIndexedDb}</Badge>
              <Badge variant="outline">账号轨道：{lastImportResult.importedTracks}</Badge>
            </AlertDescription>
            <button
              type="button"
              aria-label="关闭导入结果"
              onClick={() => setLastImportResult(null)}
              className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
