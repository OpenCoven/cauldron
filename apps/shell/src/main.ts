import { agent, type Command } from "@opencoven/cauldron";
import { Shell } from "./shell.ts";

const shell = new Shell(document.getElementById("desktop")!, document.getElementById("menubar")!);
shell.boot();

// Dev harness: lets a familiar (or a test) act through the same command bus Cave will use.
declare global {
  interface Window {
    cauldron: {
      shell: Shell;
      as(id: string): { exec(op: string, args?: Record<string, unknown>): Promise<unknown> };
    };
  }
}
window.cauldron = {
  shell,
  as: (id) => ({
    exec: (op, args = {}) =>
      shell.kernel.commands.execute({ id: crypto.randomUUID(), actor: agent(id), op, args } satisfies Command),
  }),
};
