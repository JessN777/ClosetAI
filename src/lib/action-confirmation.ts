/** A confirmation is valid only for the exact action proposal currently pending. */
export type PendingAction = { id: string; kind: "share" | "purchase"; resourceId: string };

export function confirmationMatches(pending: PendingAction | null, confirmationId: string, resourceId: string) {
  return !!pending && pending.id === confirmationId && pending.resourceId === resourceId;
}
