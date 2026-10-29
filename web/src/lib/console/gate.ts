// Role gating for console calls. Hiding is a convenience: the server runs
// the same checks on every invoke.
import type { Me, WriteAction } from '../me';
import { ADMIN_ACTIONS, deniedReason } from '../me';

/**
 * Why the current user cannot send a call, or null when they can. Reads are
 * always allowed; a mutating call needs the write role and none of its
 * actions disabled; `admin` (an ADMIN-class method) needs the admin role.
 */
export function callDenied(mutating: boolean, actions: readonly WriteAction[], current: Me | null, admin = false): string | null {
  if (!mutating && actions.length === 0) return null;
  const reason = deniedReason(actions, current);
  if (reason) return reason;
  const needsAdmin = admin || actions.some((a) => ADMIN_ACTIONS.includes(a));
  if (needsAdmin && current?.role !== 'admin') return 'This action needs admin access: sign in with a user in an admin group.';
  return null;
}
