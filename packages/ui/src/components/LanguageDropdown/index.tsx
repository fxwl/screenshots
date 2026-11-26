import { Check, Languages } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type LanguageOptionValue = 'system' | 'zh-CN' | 'en';

export interface LanguageDropdownProps {
  localePreference: LanguageOptionValue;
  resolvedLocale?: 'zh-CN' | 'en';
  setLocalePreference: (locale: LanguageOptionValue) => void;
}

export function LanguageDropdown(props: LanguageDropdownProps) {
  const { localePreference, resolvedLocale = 'zh-CN', setLocalePreference } = props;
  const isEn = resolvedLocale === 'en';

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          title={isEn ? 'Switch interface language (中文 / English)' : '切换界面语言（中文 / English）'}>
          <Languages className="h-[1.1rem] w-[1.1rem]" />
          <span className="sr-only" data-no-i18n="true">
            Language
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => setLocalePreference('system')}
          className="flex items-center justify-between gap-3">
          <span data-no-i18n="true">{isEn ? 'Follow Browser' : '跟随浏览器'}</span>
          {localePreference === 'system' ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setLocalePreference('zh-CN')}
          className="flex items-center justify-between gap-3">
          <span data-no-i18n="true">简体中文</span>
          {localePreference === 'zh-CN' ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setLocalePreference('en')} className="flex items-center justify-between gap-3">
          <span data-no-i18n="true">English</span>
          {localePreference === 'en' ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
