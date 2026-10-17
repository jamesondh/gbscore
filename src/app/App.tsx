import { useEffect } from 'react';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import { InstrumentPanel } from './Instruments.tsx';
import { Conflict, Errors, FolderCheck, StatusLine, Welcome } from './Panels.tsx';
import { Roll } from './roll/Roll.tsx';
import { releaseAll, resumeMidi } from './entry.ts';
import { onKey, onKeyUp, onLeave } from './keys.ts';
import { poll, restoreLast, useApp } from './store.ts';
import { Toolbar } from './Toolbar.tsx';
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
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
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
            <StatusLine />
          </>
        ) : (
          <Welcome />
        )}
      </div>
    </TooltipProvider>
  );
}
