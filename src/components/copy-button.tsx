import { useState } from 'react';

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

/** Copies `text` to the clipboard and says so for a moment. */
export function CopyButton({ text, label = 'Copy', className = 'ad-copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className={className} onClick={() => void copy()}>
      {copied ? 'Copied' : label}
    </button>
  );
}
