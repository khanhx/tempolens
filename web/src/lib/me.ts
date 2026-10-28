import { signal } from '@preact/signals';
import type { ApiError } from './api';
import { api } from './api';

/** Actions the server can disable, in contract order (§3.1). */
export const WRITE_ACTIONS = [
  'terminate',
  'cancel',
  'signal',
  'update',
  'reset',
  'pause',
  'batch',
  'start',
  'schedule',
  'nexus',
  'delete',
  'activity',
  'namespace',
  'searchAttribute',
  'batchDelete',
] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type Role = 'read' | 'write' | 'admin';

/** Actions only the admin role may run; the server lists them as disabled for writers. */
export const ADMIN_ACTIONS: readonly WriteAction[] = ['namespace', 'searchAttribute', 'batchDelete'];

const canWriteRole = (role: Role) => role === 'write' || role === 'admin';

export interface MeUser {
  sub: string;
  email: string;
  name: string;
}

export interface CodecSettings {
  endpoint: string;
  includeCredentials: boolean;
  defaultErrorMessage: string;
  defaultErrorLink: string;
}

export interface Limits {
  scanMaxWorkflows: number;
  fanoutMaxNamespaces: number;
  pageSizeMax: number;
  graphDepthMax: number;
}

export interface Me {
  user: MeUser | null;
  role: Role;
  authEnabled: boolean;
  settings: {
    defaultNamespace: string;
    showSystemNamespace: boolean;
    disabledActions: WriteAction[];
    codec: CodecSettings;
    limits: Limits;
    version: string;
    /** Namespaces the server refuses to delete, when it reports them. */
    protectedNamespaces?: string[];
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string, fallback = ''): string => (typeof o[k] === 'string' ? (o[k] as string) : fallback);
const bool = (o: Obj, k: string): boolean => o[k] === true;
const num = (o: Obj, k: string, fallback: number): number =>
  typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : fallback;

/**
 * Validates the `/api/x/me` body. The role must be present and known, and the
 * user fails closed: anything unexpected in `disabledActions` is ignored, but
 * an unknown role is rejected rather than guessed.
 */
export function parseMe(raw: unknown): Me {
  if (!isObj(raw)) throw new Error('me: body is not an object');
  const role = raw.role;
  if (role !== 'read' && role !== 'write' && role !== 'admin') throw new Error('me: unknown role');
  const settings = isObj(raw.settings) ? raw.settings : {};
  const codec = isObj(settings.codec) ? settings.codec : {};
  const limits = isObj(settings.limits) ? settings.limits : {};
  const disabled = Array.isArray(settings.disabledActions) ? settings.disabledActions : [];
  const user = isObj(raw.user) ? { sub: str(raw.user, 'sub'), email: str(raw.user, 'email'), name: str(raw.user, 'name') } : null;

  return {
    user,
    role,
    authEnabled: bool(raw, 'authEnabled'),
    settings: {
      defaultNamespace: str(settings, 'defaultNamespace', 'default') || 'default',
      showSystemNamespace: bool(settings, 'showSystemNamespace'),
      disabledActions: WRITE_ACTIONS.filter((a) => disabled.includes(a)),
      codec: {
        endpoint: str(codec, 'endpoint'),
        includeCredentials: bool(codec, 'includeCredentials'),
        defaultErrorMessage: str(codec, 'defaultErrorMessage'),
        defaultErrorLink: str(codec, 'defaultErrorLink'),
      },
      limits: {
        scanMaxWorkflows: num(limits, 'scanMaxWorkflows', 200),
        fanoutMaxNamespaces: num(limits, 'fanoutMaxNamespaces', 50),
        pageSizeMax: num(limits, 'pageSizeMax', 100),
        graphDepthMax: num(limits, 'graphDepthMax', 3),
      },
      version: str(settings, 'version'),
      ...(Array.isArray(settings.protectedNamespaces)
        ? { protectedNamespaces: settings.protectedNamespaces.filter((n): n is string => typeof n === 'string') }
        : {}),
    },
  };
}

export const me = signal<Me | null>(null);
export const meError = signal<ApiError | Error | null>(null);

/** Loads `/api/x/me` into the `me` signal; failures land in `meError`. */
export async function loadMe(): Promise<void> {
  meError.value = null;
  try {
    me.value = parseMe(await api.get<unknown>('/api/x/me'));
  } catch (err) {
    meError.value = err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * True when the current user may perform `action`. Hiding is a convenience:
 * the server enforces the same rules (contract §2 rule 4).
 */
export function canWrite(action: WriteAction, current: Me | null = me.value): boolean {
  return current !== null && canWriteRole(current.role) && !current.settings.disabledActions.includes(action);
}

/**
 * True when the user has the write role and none of `actions` is disabled.
 * With no actions it checks the role only (Nexus endpoints have no flag).
 */
export function canAll(actions: readonly WriteAction[], current: Me | null = me.value): boolean {
  return current !== null && canWriteRole(current.role) && actions.every((a) => !current.settings.disabledActions.includes(a));
}

/** Why `actions` are not allowed, for a tooltip; null when they are. */
export function deniedReason(actions: readonly WriteAction[], current: Me | null = me.value): string | null {
  if (!current) return 'Loading your permissions…';
  if (!canWriteRole(current.role)) return 'This action needs write access: sign in with a user in a write group.';
  const off = actions.filter((a) => current.settings.disabledActions.includes(a));
  if (current.role === 'write' && off.some((a) => ADMIN_ACTIONS.includes(a))) return 'This action needs admin access: sign in with a user in an admin group.';
  return off.length ? `Disabled on this server (${off.join(', ')}).` : null;
}

/** Action keys per schedule write, mirroring the server's flag mapping. */
export const SCHEDULE_GATES = {
  create: ['schedule', 'start'],
  edit: ['schedule', 'start'],
  trigger: ['schedule', 'start'],
  backfill: ['schedule', 'start'],
  pause: ['schedule'],
  delete: ['schedule'],
} as const satisfies Record<string, readonly WriteAction[]>;
