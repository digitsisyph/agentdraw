import { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import { AgentPill } from './components/agent-pill';
import { CopyButton } from './components/copy-button';
import {
  CanvasBridge,
  attachWebMcpTools,
  type BridgeState,
  type WebMcpAvailability,
} from './lib/canvas-bridge';
import { createDebouncedSaver, loadDocument, type StoredDocument } from './lib/persistence';
import { htmlOf, isHtmlLink } from './lib/html-embed';
import { BOOTSTRAP_PROMPT } from './lib/site';
import { installWebMcpMockIfRequested } from './lib/webmcp-mock';

/** Agent HTML renders in our own sandboxed frame; every other embeddable keeps Excalidraw's default iframe. */
function renderEmbeddable(element: NonDeleted<ExcalidrawEmbeddableElement>) {
  const html = htmlOf(element);
  if (html === null) return null;
  return (
    <iframe
      className="ad-html-embed"
      title="Page drawn by the agent"
      srcDoc={html}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
    />
  );
}

const guideIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.7L12 15l-1.8-4.3L5.5 9l4.7-1.4z" />
    <path d="M5 17l.9 2.1L8 20l-2.1.9L5 23l-.9-2.1L2 20l2.1-.9z" />
  </svg>
);

/** Any http(s) page may be embedded: dev servers and previews are the point. */
function validateEmbeddable(link: string) {
  return /^https?:\/\//i.test(link) || isHtmlLink(link);
}

function documentFrom(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): StoredDocument {
  return {
    elements: elements.filter((element) => !element.isDeleted),
    appState: {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
      viewBackgroundColor: appState.viewBackgroundColor,
    },
    files,
    savedAt: new Date().toISOString(),
  };
}

export function App() {
  const [bridgeState, setBridgeState] = useState<BridgeState | null>(null);
  const [toolStatus, setToolStatus] = useState<WebMcpAvailability>('unavailable');
  const [toolMessage, setToolMessage] = useState('Checking browser support…');
  const [guideOpen, setGuideOpen] = useState(false);
  const [initialData] = useState<Promise<ExcalidrawInitialDataState | null>>(() =>
    loadDocument().then((document) =>
      document
        ? {
            elements: document.elements,
            appState: document.appState,
            files: document.files,
            scrollToContent: false,
          }
        : null,
    ),
  );
  const bridgeRef = useRef<CanvasBridge | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const saverRef = useRef(createDebouncedSaver());

  // Excalidraw hands over its imperative API once; that is when the bridge
  // and the WebMCP tools come alive.
  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    cleanupRef.current?.();
    installWebMcpMockIfRequested();
    const bridge = new CanvasBridge(api, setBridgeState, () => {
      // Agent writes are rare and discrete: persist them at once so a reload
      // a moment later cannot lose what the agent just drew.
      saverRef.current.persistNow(documentFrom(api.getSceneElements(), api.getAppState(), api.getFiles()));
    });
    bridgeRef.current = bridge;
    const detachTools = attachWebMcpTools(bridge, (status, message) => {
      setToolStatus(status);
      setToolMessage(message);
      if (status === 'available') setGuideOpen(false);
    });
    cleanupRef.current = () => {
      detachTools();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const flush = () => saverRef.current.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      cleanupRef.current?.();
    };
  }, []);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      bridgeRef.current?.handleChange(elements, appState);
      saverRef.current.schedule(documentFrom(elements, appState, files));
    },
    [],
  );

  const edits = bridgeState?.userEditsSinceLastInspect ?? 0;
  const connected = toolStatus === 'available';
  const openGuide = useCallback(() => setGuideOpen(true), []);
  const closeGuide = useCallback(() => setGuideOpen(false), []);
  const toggleGuide = useCallback(() => setGuideOpen((open) => !open), []);

  return (
    <div className="ad-studio" data-testid="agentdraw-studio">
      <Excalidraw
        excalidrawAPI={handleApi}
        initialData={initialData}
        onChange={handleChange}
        validateEmbeddable={validateEmbeddable}
        renderEmbeddable={renderEmbeddable}
        renderTopRightUI={() => (
          <AgentPill
            status={toolStatus}
            message={toolMessage}
            edits={edits}
            guideOpen={guideOpen}
            onToggleGuide={toggleGuide}
            onCloseGuide={closeGuide}
          />
        )}
        name="AgentDraw"
      >
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          {connected ? null : (
            <MainMenu.Item onSelect={openGuide} icon={guideIcon}>
              Draw with an agent
            </MainMenu.Item>
          )}
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.MenuHint />
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo>AgentDraw</WelcomeScreen.Center.Logo>
            <WelcomeScreen.Center.Heading>
              A whiteboard your agent can draw on.
            </WelcomeScreen.Center.Heading>
            {connected ? null : (
              <div className="ad-welcome__prompt">
                <span className="ad-welcome__prompt-label">Paste this into your Agent app:</span>
                <code className="ad-welcome__prompt-text">{BOOTSTRAP_PROMPT}</code>
                <CopyButton text={BOOTSTRAP_PROMPT} label="Copy prompt" className="ad-welcome__prompt-copy" />
                <span className="ad-welcome__prompt-note">
                  Their built-in browser gives the agent this board’s tools. Nothing to install.
                </span>
              </div>
            )}
            <WelcomeScreen.Center.Menu>
              {connected ? null : (
                <WelcomeScreen.Center.MenuItem onSelect={openGuide} icon={guideIcon}>
                  How to draw with an agent
                </WelcomeScreen.Center.MenuItem>
              )}
              <WelcomeScreen.Center.MenuItemLoadScene />
              <WelcomeScreen.Center.MenuItemHelp />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>
    </div>
  );
}
