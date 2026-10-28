import { JsonText } from '../../components/json-view';
import type { RunContext } from '../workflow-layout';
import { Coverage } from './history';

/** Upstream's `?json` view: the describe response plus the loaded events, raw. */
export function JsonTab({ store }: RunContext) {
  return (
    <div>
      <Coverage store={store} />
      <JsonText value={{ workflow: store.describe.value, events: store.history.events.value }} />
    </div>
  );
}
