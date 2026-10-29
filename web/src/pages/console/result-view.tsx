import { useState } from 'preact/hooks';
import { CopyButton } from '../../components/copy-button';
import { JsonView } from '../../components/json-view';
import { listTable, stackText } from '../../lib/console/output';
import type { Table } from '../../lib/console/output';
import type { StepResult } from '../../lib/console/run';

export interface ConsoleResult {
  /** The CLI line or method name shown as the result's title. */
  label: string;
  method: string;
  cli?: string;
  output?: 'stack';
  state: 'running' | 'ok' | 'error';
  response?: unknown;
  error?: string;
  steps: StepResult[];
  ms?: number;
}

function TableView({ table }: { table: Table }) {
  if (table.rows.length === 0) return <p class="muted">No rows.</p>;
  return (
    <div class="console-table card">
      <table class="table">
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The latest console result: title, step count, copy-as-CLI, and the response as JSON or a table. */
export function ResultView({ result, onStop }: { result: ConsoleResult; onStop: () => void }) {
  const table = result.state === 'ok' ? listTable(result.method, result.response) : null;
  const stack = result.state === 'ok' && result.output === 'stack' ? stackText(result.response) : null;
  const [view, setView] = useState<'json' | 'table'>('table');
  const showTable = table !== null && view === 'table';

  return (
    <section class="card card-pad" aria-label="Result">
      <div class="console-result-head">
        <code>{result.label}</code>
        <span class="toolbar-spacer" />
        <span class="muted" role="status">
          {result.state === 'running'
            ? result.steps.length
              ? `Running… (${result.steps.length} ${result.steps.length === 1 ? 'call' : 'calls'} done)`
              : 'Running…'
            : `${result.state === 'ok' ? 'Done' : 'Failed'}${result.ms !== undefined ? ` in ${result.ms} ms` : ''}${result.steps.length > 1 ? `, ${result.steps.length} calls` : ''}`}
        </span>
        {result.state === 'running' && (
          <button type="button" class="btn btn-sm" onClick={onStop}>
            Stop
          </button>
        )}
        {result.cli && <CopyButton text={result.cli} label="Copy as CLI" />}
        <div class="segmented" role="group" aria-label="Output format">
          <button type="button" class="btn btn-sm" aria-pressed={!showTable} onClick={() => setView('json')}>
            JSON
          </button>
          <button type="button" class="btn btn-sm" aria-pressed={showTable} disabled={table === null} title={table === null ? 'This response has no list to show as a table' : undefined} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      </div>
      {result.state === 'error' && (
        <p class="alert alert-error" role="alert">
          {result.error}
        </p>
      )}
      {result.state === 'ok' &&
        (showTable ? (
          <TableView table={table} />
        ) : (
          <div class="stack">
            {stack !== null && <pre class="code-block">{stack}</pre>}
            <JsonView value={result.response} openDepth={2} />
          </div>
        ))}
    </section>
  );
}
