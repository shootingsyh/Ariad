export class ScriptedFakeExecutor {
  constructor(script = {}) {
    this.script = Object.fromEntries(Object.entries(script).map(([k,v]) => [k, [...v]]));
    this.calls = [];
  }
  async run(role, context) {
    this.calls.push({ role, context: structuredClone(context) });
    const queue = this.script[role] ?? [];
    if (queue.length === 0) throw new Error(`No scripted response for role ${role}`);
    return structuredClone(queue.shift());
  }
}
