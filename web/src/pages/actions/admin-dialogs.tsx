// Admin dialogs: namespace create/edit/delete and search attribute add/remove.
// Loaded on demand from the namespace pages; the server allows them to the
// admin role only and enforces the typed confirmations (contract §1.6).
import { useState } from 'preact/hooks';
import { ActionDialog } from '../../components/modal';
import { showToast } from '../../components/toast';
import { confirmed, TypedConfirm } from '../../components/typed-confirm';
import type { ActionRequest } from '../../lib/actions/workflow-actions';
import { sendAction } from '../../lib/actions/workflow-actions';
import type { ArchivalState, NamespaceForm } from '../../lib/actions/admin';
import {
  addSearchAttributeRequest,
  deleteNamespaceRequest,
  explainAddSearchAttributeError,
  registerNamespaceRequest,
  removeSearchAttributesRequest,
  SEARCH_ATTRIBUTE_TYPES,
  updateNamespaceRequest,
} from '../../lib/actions/admin';
import type { SAType } from '../../lib/query/build';
import { invalidateNamespace } from '../../lib/server-info';

/** Builds the CLI line, or explains why it cannot yet. */
const cliOf = (build: () => ActionRequest) => () => {
  try {
    return build().cli;
  } catch (err) {
    return `# ${err instanceof Error ? err.message : String(err)}`;
  }
};

const input = (set: (v: string) => void) => (e: Event) => set((e.currentTarget as HTMLInputElement).value);

function ArchivalSelect({ label, value, onChange }: { label: string; value: ArchivalState; onChange: (v: ArchivalState) => void }) {
  return (
    <label class="field">
      <span>{label}</span>
      <select class="select" value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value as ArchivalState)}>
        <option value="">Server default / unchanged</option>
        <option value="ARCHIVAL_STATE_ENABLED">Enabled</option>
        <option value="ARCHIVAL_STATE_DISABLED">Disabled</option>
      </select>
    </label>
  );
}

export interface NamespaceDialogProps {
  /** Present when editing an existing namespace; its name is then fixed. */
  initial?: NamespaceForm;
  onClose: () => void;
  onDone: (name: string) => void;
}

/** RegisterNamespace (create) or UpdateNamespace (edit). */
export function NamespaceDialog({ initial, onClose, onDone }: NamespaceDialogProps) {
  const editing = !!initial;
  const [f, setF] = useState<NamespaceForm>(
    initial ?? { name: '', description: '', ownerEmail: '', retention: '3d', historyArchival: '', visibilityArchival: '' },
  );
  const set = (k: keyof NamespaceForm) => input((v) => setF({ ...f, [k]: v }));
  const build = () => (editing ? updateNamespaceRequest(f) : registerNamespaceRequest(f));
  return (
    <ActionDialog
      title={editing ? `Edit ${f.name}` : 'Create a namespace'}
      submitLabel={editing ? 'Save' : 'Create namespace'}
      canSubmit={!!f.name.trim() && !!f.retention.trim()}
      cli={cliOf(build)}
      onClose={onClose}
      onSubmit={async () => {
        await sendAction(build());
        invalidateNamespace(f.name.trim());
        showToast({ kind: 'success', text: editing ? `Namespace ${f.name} updated.` : `Namespace ${f.name.trim()} created.` });
        onDone(f.name.trim());
      }}
    >
      {!editing && (
        <label class="field">
          <span>Name</span>
          <input class="input" required value={f.name} autocomplete="off" spellcheck={false} onInput={set('name')} />
        </label>
      )}
      <label class="field">
        <span>
          Retention <span class="muted">(at least 1d, e.g. 3d or 72h)</span>
        </span>
        <input class="input" required value={f.retention} onInput={set('retention')} />
      </label>
      <label class="field">
        <span>
          Description <span class="muted">(optional)</span>
        </span>
        <input class="input" value={f.description} onInput={set('description')} />
      </label>
      <label class="field">
        <span>
          Owner email <span class="muted">(optional)</span>
        </span>
        <input class="input" type="email" value={f.ownerEmail} onInput={set('ownerEmail')} />
      </label>
      <ArchivalSelect label="History archival" value={f.historyArchival} onChange={(v) => setF({ ...f, historyArchival: v })} />
      <ArchivalSelect label="Visibility archival" value={f.visibilityArchival} onChange={(v) => setF({ ...f, visibilityArchival: v })} />
      <p class="muted">Archival can only be enabled when the cluster has an archival provider configured.</p>
    </ActionDialog>
  );
}

/** OperatorService DeleteNamespace. Asynchronous: the namespace is renamed and removed in the background. */
export function DeleteNamespaceDialog({ ns, onClose, onDone }: { ns: string; onClose: () => void; onDone: (renamedTo: string) => void }) {
  const [typed, setTyped] = useState('');
  const build = () => deleteNamespaceRequest(ns);
  return (
    <ActionDialog
      title={`Delete ${ns}`}
      submitLabel="Delete namespace"
      danger
      canSubmit={confirmed(ns, typed)}
      cli={cliOf(build)}
      onClose={onClose}
      onSubmit={async () => {
        const res = await sendAction<{ deletedNamespace?: string }>(build());
        invalidateNamespace(ns);
        showToast({ kind: 'success', text: `Deleting ${ns}.` });
        onDone(res?.deletedNamespace ?? '');
      }}
    >
      <p class="alert alert-warning">
        Deleting removes the namespace with all its workflows, schedules and histories. Temporal renames it at once and deletes its data in the background. This cannot be
        undone.
      </p>
      <TypedConfirm expected={ns} value={typed} onInput={setTyped} what="the namespace name" />
    </ActionDialog>
  );
}

/** OperatorService AddSearchAttributes, one attribute at a time (as the CLI). */
export function AddSearchAttributeDialog({ ns, onClose, onDone }: { ns: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<SAType>('Keyword');
  const build = () => addSearchAttributeRequest(ns, name, type);
  return (
    <ActionDialog
      title={`Add a search attribute to ${ns}`}
      submitLabel="Add attribute"
      canSubmit={!!name.trim()}
      cli={cliOf(build)}
      onClose={onClose}
      onSubmit={async () => {
        await sendAction(build()).catch((err: unknown) => {
          throw explainAddSearchAttributeError(err);
        });
        invalidateNamespace(ns);
        showToast({ kind: 'success', text: `Search attribute ${name.trim()} added.` });
        onDone();
      }}
    >
      <label class="field">
        <span>Name</span>
        <input class="input" required value={name} autocomplete="off" spellcheck={false} onInput={input(setName)} />
      </label>
      <label class="field">
        <span>Type</span>
        <select class="select" value={type} onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value as SAType)}>
          {SEARCH_ATTRIBUTE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <p class="muted">SQL visibility stores have a fixed number of slots per type; the server refuses an attribute when they are full.</p>
    </ActionDialog>
  );
}

/** OperatorService RemoveSearchAttributes; the confirmation is the names, comma-separated. */
export function RemoveSearchAttributesDialog({ ns, names, onClose, onDone }: { ns: string; names: readonly string[]; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const expected = names.join(',');
  const build = () => removeSearchAttributesRequest(ns, names);
  return (
    <ActionDialog
      title={`Remove search attributes from ${ns}`}
      submitLabel={names.length === 1 ? 'Remove attribute' : `Remove ${names.length} attributes`}
      danger
      canSubmit={confirmed(expected, typed)}
      cli={cliOf(build)}
      onClose={onClose}
      onSubmit={async () => {
        await sendAction(build());
        invalidateNamespace(ns);
        showToast({ kind: 'success', text: `Removed ${expected}.` });
        onDone();
      }}
    >
      <p class="alert alert-warning">Workflows keep their stored values, but the attributes can no longer be queried. Queries and saved views that use them will fail.</p>
      <TypedConfirm expected={expected} value={typed} onInput={setTyped} what={names.length === 1 ? 'the attribute name' : 'the attribute names'} />
    </ActionDialog>
  );
}
