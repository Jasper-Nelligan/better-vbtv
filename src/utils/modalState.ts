// Module-level flag mirroring the `toast.ts` bus idiom: a single boolean the two
// independent keydown listeners can both consult.
//
// This exists because the listeners live in different modules — `content.ts`
// listens on `window` and `VideoController` on `document`, both in the capture
// phase — and their target guards only cover INPUT/TEXTAREA/contenteditable.
// A modal contains buttons and chips too, and a focused *button* would still
// leak `space` / `f` / `j` through to the player underneath.
let open = false;

export function setModalOpen(value: boolean): void {
  open = value;
}

export function isModalOpen(): boolean {
  return open;
}
