import { Button } from '@sessionmesh/ui';
import { FileUp, Loader2 } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';

export interface JsonImportModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  placeholder?: string;
  onImport: (parsedJson: unknown) => Promise<void>;
}

export const JsonImportModal: React.FC<JsonImportModalProps> = ({
  open,
  onClose,
  title,
  description,
  placeholder = '请粘贴合法 JSON 内容，或点击上方选择 .json 文件导入...',
  onImport,
}) => {
  const [rawText, setRawText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setRawText('');
      setParseError(null);
      setSubmitting(false);
    }
  }, [open]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRawText(String(reader.result ?? ''));
      setParseError(null);
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleSubmit = async () => {
    if (!rawText.trim()) {
      setParseError('请先粘贴或选择 JSON 内容');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      setParseError(`JSON 语法错误：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setParseError(null);
    setSubmitting(true);
    try {
      await onImport(parsed);
      onClose();
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            确认导入
          </Button>
        </>
      }>
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">JSON 内容</span>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => fileInputRef.current?.click()}>
              <FileUp className="mr-1 h-3.5 w-3.5" />
              从文件读取
            </Button>
          </div>
        </div>
        <textarea
          value={rawText}
          onChange={e => {
            setRawText(e.target.value);
            setParseError(null);
          }}
          rows={10}
          placeholder={placeholder}
          className="w-full rounded-md border border-input bg-background p-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {parseError ? <p className="text-xs text-rose-600 dark:text-rose-400">{parseError}</p> : null}
      </div>
    </Modal>
  );
};
