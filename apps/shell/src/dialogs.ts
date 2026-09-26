/** Modal dialogs owned by the shell. One at a time; resolves with the chosen button id. */
export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
}

let queue: Promise<unknown> = Promise.resolve();

export function dialog(opts: { html: string; buttons: DialogButton[]; input?: { label: string; value: string }; kind?: string }): Promise<{ choice: string; value: string }> {
  const run = () =>
    new Promise<{ choice: string; value: string }>((resolve) => {
      const root = document.getElementById("modal-root")!;
      const box = document.createElement("div");
      box.className = "dialog";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      if (opts.kind) box.dataset.kind = opts.kind;
      box.innerHTML = `<p>${opts.html}</p>`;
      let input: HTMLInputElement | undefined;
      if (opts.input) {
        const label = document.createElement("label");
        label.textContent = opts.input.label;
        input = document.createElement("input");
        input.value = opts.input.value;
        label.append(input);
        box.append(label);
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      const finish = (choice: string) => {
        root.replaceChildren();
        document.removeEventListener("keydown", onKey, true);
        resolve({ choice, value: input?.value ?? "" });
      };
      for (const b of opts.buttons) {
        const el = document.createElement("button");
        el.textContent = b.label;
        el.dataset.choice = b.id;
        if (b.primary) el.className = "primary";
        el.onclick = () => finish(b.id);
        actions.append(el);
      }
      box.append(actions);
      root.replaceChildren(box);
      const primary = opts.buttons.find((b) => b.primary) ?? opts.buttons[0]!;
      const cancel = opts.buttons.find((b) => b.id === "cancel" || b.id === "deny") ?? opts.buttons[opts.buttons.length - 1]!;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(primary.id); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(cancel.id); }
      };
      document.addEventListener("keydown", onKey, true);
      (input ?? actions.querySelector<HTMLButtonElement>(".primary") ?? actions.querySelector("button"))?.focus();
      input?.select();
    });
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
