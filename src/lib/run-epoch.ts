/** Invalidates stale async completions when a newer UI selection or run takes over. */
export class RunEpoch {
  private value = 0;

  begin() { return ++this.value; }
  invalidate() { this.value++; }
  isCurrent(token: number) { return token === this.value; }
}
