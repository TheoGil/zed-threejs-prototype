// The status line at the bottom-left: connection, scene loading, video fps, hints.
export class Status {
  private readonly el = document.getElementById("status")!;

  set(text: string) {
    this.el.textContent = text;
  }
}
