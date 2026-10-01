import { useEffect } from 'react';
import { api, type Bootstrap } from './api';
import { Toasts } from './components/common';
import { OfflineBanner, TopBar } from './components/TopBar';
import { useRoute } from './router';
import { Compose } from './screens/Compose';
import { Edit } from './screens/Edit';
import { Generate } from './screens/Generate';
import { Home } from './screens/Home';
import { Library } from './screens/Library';
import { Video } from './screens/Video';
import { setState, toast, useApp } from './store';

export function App() {
  const route = useRoute();
  const boot = useApp((s) => s.boot);
  const online = useApp((s) => s.status?.comfy === 'online');

  useEffect(() => {
    api
      .get<Bootstrap>('/api/manifest')
      .then((b) => setState({ boot: b }))
      .catch((e) => toast(`Could not load settings: ${(e as Error).message}`, 'error'));
  }, [online]);

  return (
    <div className="app" style={{ gridTemplateRows: '56px auto 1fr' }}>
      <TopBar screen={route.screen} />
      <div>
        <OfflineBanner />
      </div>
      {!boot ? (
        <div className="empty" style={{ margin: 'auto' }}>
          Loading Darkroom…
        </div>
      ) : route.screen === 'home' ? (
        <Home />
      ) : route.screen === 'generate' ? (
        <Generate query={route.query} />
      ) : route.screen === 'edit' ? (
        <Edit id={route.id} />
      ) : route.screen === 'compose' ? (
        <Compose id={route.id} />
      ) : route.screen === 'video' ? (
        <Video query={route.query} />
      ) : (
        <Library />
      )}
      <Toasts />
    </div>
  );
}
