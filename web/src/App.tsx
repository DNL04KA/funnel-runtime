import { useRoute } from './lib/router.js';
import { FunnelPage } from './pages/FunnelPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AnalyticsPage } from './pages/AnalyticsPage.js';

export function App(): JSX.Element {
  const route = useRoute();
  if (route.name === 'admin') return <AdminPage />;
  if (route.name === 'analytics') return <AnalyticsPage />;
  return <FunnelPage />;
}
