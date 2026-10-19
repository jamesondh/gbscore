import { useEffect } from 'react';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import { InstrumentPanel } from './Instruments.tsx';
import { Conflict, EditBar, Errors, FolderCheck, StatusLine, Welcome } from './Panels.tsx';
import { Roll } from './roll/Roll.tsx';
import { releaseAll, resumeMidi } from './entry.ts';
import { onKey, onKeyUp, onLeave } from './keys.ts';
import { openShared, poll, restoreLast, useApp } from './store.ts';
import { isShare } from './share.ts';
import { mayDiscard, Toolbar } from './Toolbar.tsx';
import { PatternBar } from './Patterns.tsx';

const POLL_MS = 1000;

export function App() {
  const shown = useApp((s) => !!s.folder || !!s.open);
  const panel = useApp((s) => s.panel);

  useEffect(() => {
    void restoreLast();
    void resumeMidi();
    const timer = setInterval(() => void poll(), POLL_MS);
    const onFocus = () => void poll();
    const onHash = () => {
      if (!isShare(location.hash)) return; // a share link pasted into this tab
      if (mayDiscard()) void openShared();
      else history.replaceState(null, '', location.pathname + location.search); // or a reload would open it
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        {shown ? (
          <>
            <Toolbar />
            <Conflict />
            <FolderCheck />
            <PatternBar />
            <Roll />
            {panel && <InstrumentPanel />}
            <Errors />
            <EditBar />
            <StatusLine />
          </>
        ) : (
          <Welcome />
        )}
      </div>
    </TooltipProvider>
  );
}
