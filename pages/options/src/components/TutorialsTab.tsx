import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sessionmesh/ui';
import {
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FolderOpen,
  Globe,
  HelpCircle,
  Keyboard,
  Lock,
  QrCode,
  Repeat,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { copyToClipboard, openExternalUrl, useUxOnboardingPrefs } from '../utils/helpers';

export interface TutorialsTabProps {
  onNavigate: (section: 'sites' | 'accounts' | 'rules' | 'devices_spaces' | 'storage_settings', sub?: string) => void;
  onStartWizard: () => void;
}

const RECOMMENDED_CORS_JSON = JSON.stringify(
  [
    {
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'PUT', 'HEAD', 'DELETE'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag', 'x-amz-request-id', 'x-oss-request-id'],
      MaxAgeSeconds: 3600,
    },
  ],
  null,
  2,
);

const FAQ_ITEMS = [
  {
    id: 'why_not_instant',
    q: '为什么我在网页刚登录完，网盘里还没看到立刻上传？',
    a: '这是专门设计的「离开页面时合并上传」保护机制！在您浏览网页时，网站往往会每秒修改很多次 Cookie；SessionMesh 会在后台安静合并这些变动，等您关闭标签页、切换到其他网站，或手动点一次「立即同步」时一次性打包上传，既省流量又防止两台电脑互相抢写。如果您喜欢秒级同步，可在「存储与系统设置 → 同步策略」中改为「实时上传」。',
  },
  {
    id: 'jianguoyun_401',
    q: '坚果云 / Nextcloud 连接提示 401 Unauthorized（认证失败）怎么办？',
    a: '99% 是因为填成了网页登录密码！坚果云和开启两步验证的 Nextcloud 要求在网页后台【安全选项 → 第三方应用管理】单独生成一个「应用专用密码」，而且坚果云的服务器地址必须带上已有同步文件夹名（例如 https://dav.jianguoyun.com/dav/我的坚果云/），不能只写到 /dav/。',
  },
  {
    id: 'clean_new_account',
    q: '在同一网站登录第 2 个小号时，为什么千万不要点网页自带的「退出登录」？',
    a: '如果在网页里直接点「退出登录」，网站服务器会把您第 1 个账号的登录凭证直接作废，导致所有电脑上的大号一起掉线！正确做法是：点击浏览器右上角 SessionMesh 图标 →「+ 存新号」→「新建空白小号」。扩展会先把大号完好封存，再清空本地浏览器让您直接登录小号，之后就能按 Alt+Shift+. 随时秒切两个号了！',
  },
  {
    id: 'why_no_auto_reload',
    q: '另一台电脑更新了登录态后，我当前打开的网页为什么没有自动刷新？',
    a: '为了防止您正在网页里打字、写文档或填表单时页面突然刷新导致内容丢失，后台自动拉取最新 Cookie 后默认「静默写入生效」，您手动按 F5 刷新或点击网页内任意链接即可直接进入登录状态。',
  },
  {
    id: 'forgot_master_pass',
    q: '忘记了「端到端加密主密码」还能找回云端数据吗？',
    a: '由于采用严格的零知识加密，密码永不上传且没有任何后门，全部设备都遗忘密码时无法解密旧云端文件。但只要您还有任意一台处于「已解锁」状态的电脑，就可以在「设备与同步空间」或直接新建一个同步空间把当前浏览器里的登录态重新加密同步上去。',
  },
] as const;

export function TutorialsTab({ onNavigate, onStartWizard }: TutorialsTabProps) {
  const { resetGuideProgress, markGuideTaskDone } = useUxOnboardingPrefs();
  const [openFaq, setOpenFaq] = useState<string>('why_not_instant');

  return (
    <div className="space-y-5">
      {/* 1. 30-Second Visual Mental Model */}
      <Card className="border-primary/35 bg-primary/[0.03]">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-5 w-5 text-primary" />
                30 秒看懂 SessionMesh 怎么工作
              </CardTitle>
              <CardDescription>
                无需注册任何第三方账号，你的网站登录态只在你自己的设备和自选网盘/文件夹之间加密流转。
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={async () => {
                  await resetGuideProgress();
                  toast.success('已重新开启新手上手清单与弹窗引导卡片');
                }}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                重看新手清单与气泡引导
              </Button>
              <Button type="button" size="sm" className="h-8 text-xs" onClick={onStartWizard}>
                重新打开配置向导
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-border bg-background p-3.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                  1
                </span>
                电脑 A 正常登录并开启同步
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                在常看的网站正常扫码或密码登录，点一下右上角扩展图标里的<strong>「开启此网站自动同步」</strong>。
              </p>
            </div>

            <div className="rounded-xl border border-border bg-background p-3.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                  2
                </span>
                本地锁进密码箱再存入网盘
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                关闭网页时，浏览器先用你的<strong>加密主密码</strong>将 Cookie 与前端登录态锁成乱码密文，再写入你的
                OneDrive / Gist / R2 / 坚果云。
              </p>
            </div>

            <div className="rounded-xl border border-border bg-background p-3.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                  3
                </span>
                电脑 B 打开网页直接免登
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                电脑 B 通过<strong>配对码</strong>
                接入同一空间后，会自动拉取解密写入浏览器，打开该网站即刻处于已登录状态！
              </p>
            </div>
          </div>

          {/* Plain-Language Glossary */}
          <div className="rounded-xl border border-border bg-background/80 p-3.5">
            <div className="mb-2 text-xs font-semibold text-foreground">📖 4 个常见状态词大白话解释：</div>
            <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-muted/40 p-2.5">
                <Badge variant="success" className="mb-1 text-[10px]">
                  同步中
                </Badge>
                <p className="text-[11px] text-muted-foreground">该网站已开启多电脑自动同步，一端更新多端共享。</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-2.5">
                <Badge variant="secondary" className="mb-1 text-[10px]">
                  未开启同步
                </Badge>
                <p className="text-[11px] text-muted-foreground">普通浏览网页默认不上传，保护隐私且不占空间。</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-2.5">
                <Badge variant="outline" className="mb-1 text-[10px]">
                  仅本机独立
                </Badge>
                <p className="text-[11px] text-muted-foreground">两台电脑在此网站各登各的号，互不覆盖干扰。</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-2.5">
                <Badge variant="info" className="mb-1 text-[10px]">
                  后悔药恢复点
                </Badge>
                <p className="text-[11px] text-muted-foreground">
                  每次切换账号或拉取覆盖前自动备份旧状态，可随时一键撤回。
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. Four Core Scenarios Step-by-Step Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Scenario 1: Sync Websites */}
        <Card>
          <CardHeader className="pb-2.5">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <Globe className="h-4 w-4 text-primary" />
              场景一：如何挑选网站开启或关闭同步？
            </CardTitle>
            <CardDescription className="text-xs">支持弹窗一键开启、右键菜单开启或批量勾选</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground leading-relaxed">
              <li>
                <strong className="text-foreground">日常最快方式</strong>：打开任意已登录网站，点击浏览器右上角
                SessionMesh 图标 → 点击蓝色按钮<strong>「开启此网站多端自动同步」</strong>。
              </li>
              <li>
                <strong className="text-foreground">右键快捷操作</strong>：在网页空白处点击鼠标右键 →「SessionMesh
                多设备同步 → 开启当前网站的自动同步」。
              </li>
              <li>
                <strong className="text-foreground">批量添加已有网站</strong>：在控制中心「网站与 Cookies」点击「+
                添加同步网站」，一次勾选本机几十个常用站。
              </li>
            </ol>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => onNavigate('sites')}>
              前往网站列表挑选网站
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>

        {/* Scenario 2: Pair 2nd Computer */}
        <Card>
          <CardHeader className="pb-2.5">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <QrCode className="h-4 w-4 text-primary" />
              场景二：10 秒把登录态同步到第 2 台电脑
            </CardTitle>
            <CardDescription className="text-xs">无需在第 2 台电脑重新输长串网盘地址与密钥</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground leading-relaxed">
              <li>
                在已配好的第 1 台电脑点击下方按钮，点<strong>「随机口令一键生成」</strong>并
                <strong>「复制完整配对包」</strong>。
              </li>
              <li>
                在第 2 台电脑安装 SessionMesh，在欢迎页点击<strong>「我有配对码，10 秒接入」</strong>
                ，直接整段粘贴（会自动提取配对码与口令）。
              </li>
              <li>
                输入第 1 台电脑设置的<strong>加密主密码</strong>，点「一键验证并完成接入」即大功告成！
              </li>
            </ol>
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              onClick={() => onNavigate('devices_spaces', 'spaces')}>
              去生成跨设备配对码
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>

        {/* Scenario 3: Multi-Account Rotation */}
        <Card>
          <CardHeader className="pb-2.5">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <Users className="h-4 w-4 text-primary" />
              场景三：同一网站挂多个大小号并一键秒切
            </CardTitle>
            <CardDescription className="text-xs">无损封存原账号 + 快捷键秒切 + 自定义色标角标</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground leading-relaxed">
              <li>
                登录第 1 个账号后，打开扩展弹窗点击<strong>「+ 存新号 → 新建空白小号」</strong>
                （切记不要点网页里的退出登录！）。
              </li>
              <li>页面会自动清空为未登录态，此时直接在网页登录第 2 个小号，两个号就都安全存好了。</li>
              <li>
                日常只需按键盘 <code className="rounded bg-muted px-1 py-0.5 font-mono">Alt+Shift+.</code> 或在弹窗点
                <strong>「切号」</strong>即可来回秒切，还能给不同账号设专属颜色角标（如红标「生产」、绿标「个人」）。
              </li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => {
                  void markGuideTaskDone('multi_account');
                  onNavigate('accounts');
                }}>
                <Repeat className="mr-1.5 h-3.5 w-3.5" />
                前往多账号管理中心
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => onNavigate('storage_settings', 'policy')}>
                <Keyboard className="mr-1.5 h-3.5 w-3.5" />
                查看全局快捷键
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Scenario 4: Frontend Dev Localhost Sync */}
        <Card>
          <CardHeader className="pb-2.5">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <ArrowLeftRight className="h-4 w-4 text-primary" />
              场景四：前端开发把线上 Cookie 一键注入 localhost
            </CardTitle>
            <CardDescription className="text-xs">自动改写 Domain 并适配本地 HTTP Secure / SameSite</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <ol className="list-decimal space-y-1.5 pl-4 text-muted-foreground leading-relaxed">
              <li>
                先在浏览器正常登录线上或测试环境网站（如 <code>app.example.com</code>）。
              </li>
              <li>
                切到你的本地开发标签页（如 <code>http://localhost:3000</code>），直接点右上角 SessionMesh
                图标，面板会自动弹出<strong>「注入线上登录态到本地页」</strong>卡片！
              </li>
              <li>
                选好线上源域名点<strong>「注入并自动同步」</strong>，以后线上切小号或刷新令牌，本地页也会自动跟着更新。
              </li>
            </ol>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => onNavigate('rules')}>
              管理跨环境同步规则
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* 3. Storage Provider Quick Cheat Sheet */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="h-5 w-5 text-primary" />4 种存储方式怎么选？凭据获取一键直达
          </CardTitle>
          <CardDescription>你可以随时在「存储与系统设置」中切换存储位置或导出单文件加密备份</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="flex flex-col justify-between gap-2 rounded-xl border border-border p-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground">本地同步盘目录</span>
                  <Badge variant="info" className="text-[10px]">
                    零密钥
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  适合装了 OneDrive / iCloud Drive / Dropbox 客户端的用户，直接点选本地同步文件夹即可，无需申请任何
                  API。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => onNavigate('storage_settings', 'webdav')}>
                去配置本地文件夹
              </Button>
            </div>

            <div className="flex flex-col justify-between gap-2 rounded-xl border border-border p-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground">GitHub 私密 Gist</span>
                  <Badge variant="success" className="text-[10px]">
                    免费易用
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  只需一个只勾 <code>gist</code> 权限的 Token，扩展会自动创建私密 Secret Gist 并拦截任何公开 Gist。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() =>
                  openExternalUrl('https://github.com/settings/tokens/new?scopes=gist&description=SessionMesh%20Sync')
                }>
                一键去 GitHub 生成 Token
                <ExternalLink className="ml-1 h-3 w-3" />
              </Button>
            </div>

            <div className="flex flex-col justify-between gap-2 rounded-xl border border-border p-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground">Cloudflare R2 / OSS</span>
                  <Badge variant="success" className="text-[10px]">
                    强一致推荐
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  R2 每月 10GB 免费且支持强一致防覆盖锁，多设备高频同步最稳；阿里云 OSS 可一键复制跨域规则。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => void copyToClipboard(RECOMMENDED_CORS_JSON, '已复制标准 S3/OSS CORS 规则 JSON')}>
                <Copy className="mr-1 h-3 w-3" />
                复制 S3/OSS 跨域 JSON
              </Button>
            </div>

            <div className="flex flex-col justify-between gap-2 rounded-xl border border-border p-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground">坚果云 / NAS WebDAV</span>
                  <Badge variant="outline" className="text-[10px]">
                    国内直连
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  国内无需代理即可高速同步。坚果云请务必使用「第三方应用管理」里生成的应用密码，并自动开启低频省流模式。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => openExternalUrl('https://www.jianguoyun.com/d/home#/safety')}>
                打开坚果云安全设置
                <ExternalLink className="ml-1 h-3 w-3" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. Interactive FAQ Accordion */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <HelpCircle className="h-5 w-5 text-primary" />
            新手高频疑问与排错自检
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {FAQ_ITEMS.map(item => {
            const expanded = openFaq === item.id;
            return (
              <div key={item.id} className="rounded-xl border border-border bg-background">
                <button
                  type="button"
                  onClick={() => setOpenFaq(prev => (prev === item.id ? '' : item.id))}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-xs font-semibold text-foreground hover:bg-muted/30">
                  <span className="flex items-center gap-2">
                    <BookOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
                    {item.q}
                  </span>
                  {expanded ? (
                    <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </button>
                {expanded ? (
                  <div className="border-t border-border/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                    {item.a}
                  </div>
                ) : null}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] px-4 py-3 text-xs">
            <div className="flex items-center gap-2 text-foreground">
              <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                <strong>安全好习惯：</strong>
                切勿在网吧或公共电脑登录同步空间；网银、支付宝与密码管理器建议始终保留在排除黑名单中。
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              <Lock className="h-3.5 w-3.5 text-emerald-600" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
