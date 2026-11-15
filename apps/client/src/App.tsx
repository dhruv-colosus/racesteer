import { PadScreen } from './pad/PadScreen';
import { parseRoute, usePathname } from './router';
import { Home } from './screens/Home';
import { RoomScreen } from './screens/RoomScreen';
import { Solo } from './screens/Solo';

export function App() {
  const route = parseRoute(usePathname());
  switch (route.name) {
    case 'solo':
      return <Solo />;
    case 'room':
      // Keyed by code so moving between rooms always starts from a clean slate.
      return <RoomScreen key={route.code} code={route.code} />;
    case 'pad':
      return <PadScreen key={`${route.code}/${route.token}`} code={route.code} token={route.token} />;
    default:
      return <Home />;
  }
}
