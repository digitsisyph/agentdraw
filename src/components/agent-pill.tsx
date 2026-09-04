import { useEffect, useRef } from 'react';
import type { WebMcpAvailability } from '../lib/canvas-bridge';
import { AgentGuide } from './agent-guide';

interface AgentPillProps {
  status: WebMcpAvailability;
  message: string;
  edits: number;
  guideOpen: boolean;
  onToggleGuide: () => void;
  onCloseGuide: () => void;
}

/** The one piece of chrome AgentDraw adds: is an agent able to see this page? Click for the guide. */
export function AgentPill({ status, message, edits, guideOpen, onToggleGuide, onCloseGuide }: AgentPillProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!guideOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseGuide();
    };
    const onPointer = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) onCloseGuide();
    };
    // Capture phase: Excalidraw handles Escape on its container and stops it there.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [guideOpen, onCloseGuide]);

  const label = status === 'available' ? 'Agent connected' : status === 'error' ? 'Agent error' : 'Agent';
  const hint =
    status === 'available'
      ? edits > 0
        ? `${edits} edit${edits === 1 ? '' : 's'} since the agent last looked. It will see them on its next inspect.`
        : 'An agent can read and draw on this board.'
      : status === 'error'
        ? message
        : 'No agent connected. Click to see how to connect one.';

  if (status === 'available') {
    // Connected: a plain status, nothing to open.
    return (
      <div className="ad-agent">
        <div className="ad-agent-pill is-available" title={hint} data-testid="agent-pill" data-status="available">
          <i className="ad-agent-pill__dot" aria-hidden="true" />
          <span className="ad-agent-pill__label">{label}</span>
          {edits > 0 ? <span className="ad-agent-pill__edits">· {edits} new</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="ad-agent" ref={wrapperRef}>
      <button
        type="button"
        className={`ad-agent-pill is-${status}`}
        title={hint}
        data-testid="agent-pill"
        data-status={status}
        aria-label={`${label}. ${hint}`}
        aria-haspopup="dialog"
        aria-expanded={guideOpen}
        onClick={onToggleGuide}
      >
        <i className="ad-agent-pill__dot" aria-hidden="true" />
        <span className="ad-agent-pill__label">{label}</span>
      </button>
      {guideOpen ? <AgentGuide status={status} message={message} onClose={onCloseGuide} /> : null}
    </div>
  );
}
