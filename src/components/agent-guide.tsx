import type { WebMcpAvailability } from '../lib/canvas-bridge';
import { BOOTSTRAP_PROMPT } from '../lib/site';
import { CopyButton } from './copy-button';

interface AgentGuideProps {
  status: Exclude<WebMcpAvailability, 'available'>;
  message: string;
  onClose: () => void;
}

/** The card behind the agent button: one status line, one prompt to copy, one link. */
export function AgentGuide({ status, message, onClose }: AgentGuideProps) {
  const statusLine = status === 'error' ? message : 'No agent connected.';

  return (
    <section className="ad-agent-guide" aria-label="Draw with an agent" data-testid="agent-guide">
      <div className="ad-agent-guide__head">
        <strong>Draw with an agent</strong>
        <button type="button" className="ad-agent-guide__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className={`ad-agent-guide__status is-${status}`}>{statusLine}</p>
      <p className="ad-agent-guide__lead">Paste this into your Agent app:</p>
      <div className="ad-agent-guide__bootstrap">
        <code>{BOOTSTRAP_PROMPT}</code>
        <CopyButton text={BOOTSTRAP_PROMPT} label="Copy" />
      </div>
      <p className="ad-agent-guide__foot">
        <a href="/llms.txt" target="_blank" rel="noreferrer">
          llms.txt
        </a>
      </p>
    </section>
  );
}
