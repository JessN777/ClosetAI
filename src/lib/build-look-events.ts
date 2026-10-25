export type BuildLookRequestDetail = {
  lookName: string;
  occasion?: string;
  signal: AbortSignal;
  handled: boolean;
  resolve: (summary: string) => void;
};

export type BuildLookChoice = { id: string; label: string; category: string; closetItemId?: string };
export type BuildLookVoiceContext = {
  lookName: string;
  choices: BuildLookChoice[];
  selectedIds: string[];
  selectionPending: boolean;
};

export type BuildLookSelectionDetail = {
  selectionIds: string[];
  handled: boolean;
  resolve: (added: string[]) => void;
};

export const BUILD_LOOK_REQUEST_EVENT = "closetai:build-look-request";
export const BUILD_LOOK_SELECT_EVENT = "closetai:build-look-select";

/** Request that the mounted build-look panel load a look, usually from voice. */
export function requestBuildThisLook(lookName: string, signal: AbortSignal, occasion?: string) {
  return new Promise<string>((resolve) => {
    if (signal.aborted || typeof window === "undefined") { resolve("That request was cancelled."); return; }
    const detail: BuildLookRequestDetail = { lookName, occasion, signal, handled: false, resolve };
    const abort = () => resolve("That request was cancelled.");
    signal.addEventListener("abort", abort, { once: true });
    window.dispatchEvent(new CustomEvent(BUILD_LOOK_REQUEST_EVENT, { detail }));
    if (!detail.handled) {
      signal.removeEventListener("abort", abort);
      resolve("Open Shop and use Build this look to start a style profile.");
    }
  });
}

/** Add voice-selected pieces to the visible checklist; this never starts a render. */
export function addBuildLookSelection(selectionIds: string[]) {
  if (typeof window === "undefined") return Promise.resolve<string[]>([]);
  return new Promise<string[]>((resolve) => {
    const detail: BuildLookSelectionDetail = { selectionIds, handled: false, resolve };
    window.dispatchEvent(new CustomEvent(BUILD_LOOK_SELECT_EVENT, { detail }));
    resolve(detail.handled ? detail.selectionIds : []);
  });
}
