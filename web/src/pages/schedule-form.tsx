import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { CopyButton } from '../components/copy-button';
import type { InputValue } from '../components/input-editor';
import { EMPTY_INPUT, InputEditor } from '../components/input-editor';
import { Timestamp } from '../components/timestamp';
import { showToast } from '../components/toast';
import { api, seg } from '../lib/api';
import { encodeForWrite, parseInput } from '../lib/actions/encode';
import type { OverlapPolicy, ScheduleForm, SpecForm, SpecMode } from '../lib/actions/schedule';
import { buildSpec, createScheduleRequest, EMPTY_SPEC_FORM, OVERLAP_POLICIES, specToForm, updateScheduleRequest } from '../lib/actions/schedule';
import { sendAction } from '../lib/actions/workflow-actions';
import { canAll, deniedReason, SCHEDULE_GATES } from '../lib/me';
import { decodePayload } from '../lib/payload/decode';
import { stringifyJson } from '../lib/payload/json-bigint';
import { href, P } from '../routes';
import type { DescribeScheduleResponse } from './schedule-detail';

const MODES: { id: SpecMode; label: string }[] = [
  { id: 'interval', label: 'Interval' },
  { id: 'weekdays', label: 'Days of the week' },
  { id: 'monthdays', label: 'Days of the month' },
  { id: 'cron', label: 'Cron' },
  { id: 'calendar', label: 'Raw calendar' },
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function SpecEditor({ spec, onChange }: { spec: SpecForm; onChange: (s: SpecForm) => void }) {
  const set = (patch: Partial<SpecForm>) => onChange({ ...spec, ...patch });
  const toggleDay = (d: number) => set({ days: spec.days.includes(d) ? spec.days.filter((x) => x !== d) : [...spec.days, d] });
  const time = (
    <label class="field">
      <span>At (hour:minute)</span>
      <span class="toolbar-group">
        <input class="input input-narrow" type="number" min={0} max={23} aria-label="Hour" value={spec.hour} onInput={(e) => set({ hour: Number((e.currentTarget as HTMLInputElement).value) })} />:
        <input class="input input-narrow" type="number" min={0} max={59} aria-label="Minute" value={spec.minute} onInput={(e) => set({ minute: Number((e.currentTarget as HTMLInputElement).value) })} />
      </span>
    </label>
  );
  return (
    <fieldset class="field form-wide">
      <legend>When</legend>
      <div class="segmented" role="group" aria-label="Schedule kind">
        {MODES.map((m) => (
          <button key={m.id} type="button" class="btn" aria-pressed={spec.mode === m.id} onClick={() => set({ mode: m.id, days: [] })}>
            {m.label}
          </button>
        ))}
      </div>
      {spec.mode === 'interval' && (
        <div class="toolbar-group">
          <label class="field">
            <span>Every</span>
            <input class="input" value={spec.every} placeholder="1h, 15m, 1h30m" onInput={(e) => set({ every: (e.currentTarget as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>
              Offset <span class="muted">(optional)</span>
            </span>
            <input class="input" value={spec.offset} placeholder="5m" onInput={(e) => set({ offset: (e.currentTarget as HTMLInputElement).value })} />
          </label>
        </div>
      )}
      {spec.mode === 'weekdays' && (
        <>
          <div class="toolbar-group">
            {WEEKDAYS.map((d, i) => (
              <label key={d} class="check">
                <input type="checkbox" checked={spec.days.includes(i)} onChange={() => toggleDay(i)} /> {d}
              </label>
            ))}
          </div>
          {time}
        </>
      )}
      {spec.mode === 'monthdays' && (
        <>
          <div class="day-grid">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <label key={d} class="check">
                <input type="checkbox" checked={spec.days.includes(d)} onChange={() => toggleDay(d)} /> {d}
              </label>
            ))}
          </div>
          {time}
        </>
      )}
      {spec.mode === 'cron' && (
        <label class="field">
          <span>Cron expression</span>
          <input class="input input-mono" value={spec.cron} placeholder="0 */2 * * *" onInput={(e) => set({ cron: (e.currentTarget as HTMLInputElement).value })} />
        </label>
      )}
      {spec.mode === 'calendar' && (
        <label class="field">
          <span>
            <code>structuredCalendar</code> JSON
          </span>
          <textarea class="input input-mono" rows={8} spellcheck={false} value={spec.calendar} onInput={(e) => set({ calendar: (e.currentTarget as HTMLTextAreaElement).value })} />
        </label>
      )}
    </fieldset>
  );
}

const EMPTY_FORM = (ns: string): ScheduleForm => ({
  ns,
  scheduleId: '',
  workflowId: '',
  workflowType: '',
  taskQueue: '',
  spec: EMPTY_SPEC_FORM,
  timezone: '',
  jitter: '',
  overlap: 'SCHEDULE_OVERLAP_POLICY_SKIP',
  catchupWindow: '',
  pauseOnFailure: false,
  paused: false,
  notes: '',
});

const human = (d: string | undefined) => {
  const s = Number((d ?? '').replace(/s$/, ''));
  return Number.isFinite(s) && s > 0 ? `${s}s` : '';
};

/** Create (`…/schedules/create`) or edit (`…/schedules/:id/edit`) a schedule. */
export default function ScheduleFormPage() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const editId = params.id;
  const { route } = useLocation();
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM(ns));
  const [input, setInput] = useState<InputValue>(EMPTY_INPUT);
  const [conflictToken, setConflictToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!editId);
  const [preview, setPreview] = useState<{ times?: string[]; error?: string } | null>(null);
  const set = (patch: Partial<ScheduleForm>) => setForm({ ...form, ...patch });

  useEffect(() => {
    if (!editId) return;
    api.get<DescribeScheduleResponse>(`/api/v1/namespaces/${seg(ns)}/schedules/${seg(editId)}`).then(
      (d) => {
        const s = d.schedule;
        const a = s?.action?.startWorkflow;
        setForm({
          ...EMPTY_FORM(ns),
          scheduleId: editId,
          workflowId: a?.workflowId ?? '',
          workflowType: a?.workflowType?.name ?? '',
          taskQueue: a?.taskQueue?.name ?? '',
          spec: specToForm(s?.spec),
          timezone: s?.spec?.timezoneName ?? '',
          jitter: human(s?.spec?.jitter),
          overlap: (s?.policies?.overlapPolicy as OverlapPolicy | undefined) ?? 'SCHEDULE_OVERLAP_POLICY_SKIP',
          catchupWindow: human(s?.policies?.catchupWindow),
          pauseOnFailure: !!s?.policies?.pauseOnFailure,
          paused: !!s?.state?.paused,
          notes: s?.state?.notes ?? '',
        });
        const p0 = a?.input?.payloads?.[0];
        if (p0) {
          const dec = decodePayload(p0, true);
          setInput({ ...EMPTY_INPUT, text: dec.kind === 'value' ? stringifyJson(dec.value) : stringifyJson(p0) });
        }
        setConflictToken(d.conflictToken);
        setLoaded(true);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [ns, editId]);

  const gate = editId ? SCHEDULE_GATES.edit : SCHEDULE_GATES.create;
  if (!canAll(gate)) {
    return (
      <section class="page">
        <h1>{editId ? `Edit ${editId}` : 'Create a schedule'}</h1>
        <p class="alert">{deniedReason(gate)}</p>
      </section>
    );
  }

  const build = (payloads = parseInput(input.text, input.encoding, input.messageType)) =>
    editId ? updateScheduleRequest({ ...form, input: payloads }, conflictToken) : createScheduleRequest({ ...form, input: payloads });

  let specError: string | null = null;
  try {
    buildSpec(form.spec);
  } catch (err) {
    specError = err instanceof Error ? err.message : String(err);
  }

  const loadPreview = async () => {
    if (!editId) return;
    const now = new Date();
    try {
      const res = await api.get<{ startTime?: string[] }>(`/api/v1/namespaces/${seg(ns)}/schedules/${seg(editId)}/matching-times`, {
        startTime: now.toISOString(),
        endTime: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      });
      setPreview({ times: (res.startTime ?? []).slice(0, 10) });
    } catch (err) {
      setPreview({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payloads = await encodeForWrite(parseInput(input.text, input.encoding, input.messageType), ns);
      await sendAction(build(payloads));
      showToast({ kind: 'success', text: editId ? 'Schedule updated.' : 'Schedule created.' });
      route(href(P.schedule, { ns, id: editId ?? form.scheduleId.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const field = (label: string, key: 'scheduleId' | 'workflowId' | 'workflowType' | 'taskQueue' | 'timezone' | 'jitter' | 'catchupWindow' | 'notes', opts: { required?: boolean; placeholder?: string; disabled?: boolean } = {}) => (
    <label class="field">
      <span>{label}</span>
      <input class="input" required={opts.required} disabled={opts.disabled} placeholder={opts.placeholder} value={form[key]} onInput={(e) => set({ [key]: (e.currentTarget as HTMLInputElement).value })} />
    </label>
  );

  return (
    <section class="page">
      <p class="muted crumbs">
        <a href={href(P.schedules, { ns })}>{ns} schedules</a>
      </p>
      <h1>{editId ? `Edit ${editId}` : 'Create a schedule'}</h1>
      {!loaded && !error && <p class="muted">Loading…</p>}
      {loaded && (
        <form class="form-grid" onSubmit={submit}>
          {field('Schedule ID', 'scheduleId', { required: true, disabled: !!editId })}
          {field('Workflow ID', 'workflowId', { required: true, placeholder: 'Run IDs get the start time appended' })}
          {field('Workflow type', 'workflowType', { required: true })}
          {field('Task queue', 'taskQueue', { required: true })}
          <SpecEditor spec={form.spec} onChange={(spec) => set({ spec })} />
          {specError && <p class="field-error form-wide">{specError}</p>}
          {field('Time zone (IANA, empty = UTC)', 'timezone', { placeholder: 'Asia/Saigon' })}
          {field('Jitter', 'jitter', { placeholder: '30s' })}
          <label class="field">
            <span>Overlap policy</span>
            <select class="select" value={form.overlap} onChange={(e) => set({ overlap: (e.currentTarget as HTMLSelectElement).value as OverlapPolicy })}>
              {OVERLAP_POLICIES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {field('Catch-up window', 'catchupWindow', { placeholder: '1m (server default 1 year)' })}
          <label class="check">
            <input type="checkbox" checked={form.pauseOnFailure} onChange={() => set({ pauseOnFailure: !form.pauseOnFailure })} /> Pause when a run fails
          </label>
          <label class="check">
            <input type="checkbox" checked={form.paused} onChange={() => set({ paused: !form.paused })} /> Paused
          </label>
          {field('Note', 'notes')}
          <div class="form-wide">
            <InputEditor value={input} onChange={setInput} />
          </div>
          <section class="form-wide card card-pad">
            <h2>Preview</h2>
            {editId ? (
              <>
                <p class="muted">The next run times of the saved spec over 30 days (save first to preview changes).</p>
                <button type="button" class="btn btn-sm" onClick={() => void loadPreview()}>
                  Show next runs
                </button>
                {preview?.error && <p class="field-error">{preview.error}</p>}
                {preview?.times && (
                  <ul class="list-plain">
                    {preview.times.map((t) => (
                      <li key={t}>
                        <Timestamp value={t} />
                      </li>
                    ))}
                    {preview.times.length === 0 && <li class="muted">No runs in the next 30 days.</li>}
                  </ul>
                )}
              </>
            ) : (
              <p class="muted">After the schedule is created, its page lists the upcoming run times.</p>
            )}
          </section>
          {error && (
            <p class="alert alert-error form-wide" role="alert">
              {error}
            </p>
          )}
          <div class="dialog-footer form-wide">
            <CopyButton
              text={() => {
                try {
                  return build().cli;
                } catch (err) {
                  return `# ${err instanceof Error ? err.message : String(err)}`;
                }
              }}
              label="Copy as temporal CLI"
            />
            <span class="toolbar-spacer" />
            <a class="btn" href={editId ? href(P.schedule, { ns, id: editId }) : href(P.schedules, { ns })}>
              Cancel
            </a>
            <button type="submit" class="btn btn-primary" disabled={busy || !!specError}>
              {busy ? 'Saving…' : editId ? 'Save schedule' : 'Create schedule'}
            </button>
          </div>
        </form>
      )}
      {error && !loaded && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
