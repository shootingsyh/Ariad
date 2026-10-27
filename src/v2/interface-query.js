import { loadBoundaryContracts } from './interface-contracts.js';

// Read-only resolution of interface ids to their boundary contracts.
//
// Boundary contracts live as planner artifacts on disk; before this helper
// existed, the only way to resolve an id was to grep the filesystem for it
// (role agents did exactly that, one scan reaching `find /`). Everything
// that needs a contract by id — operators, the control plane, and role
// agents through the CLI — should go through here instead.
export function queryInterfaces(artifactRoot, { interfaceId = null } = {}) {
  if (!artifactRoot) throw new Error('artifactRoot is required');
  const entries = new Map();
  const contracts = [];
  for (const nodeType of ['feature', 'milestone']) {
    for (const contract of loadBoundaryContracts(artifactRoot, nodeType).values()) {
      contracts.push(contract);
      for (const iface of contract.interfaces ?? []) {
        if (!iface.id || entries.has(iface.id)) continue;
        entries.set(iface.id, {
          interfaceId: iface.id,
          nodeId: contract.nodeId,
          nodeType,
          kind: iface.kind ?? null,
          visibility: iface.visibility ?? null,
          contract: iface.contract ?? null,
          verificationSketch: iface.verificationSketch ?? null,
          importedBy: [],
        });
      }
    }
  }
  for (const contract of contracts) {
    for (const imp of contract.imports ?? []) {
      const entry = imp.interfaceId ? entries.get(imp.interfaceId) : null;
      if (!entry) continue;
      entry.importedBy.push({
        nodeId: contract.nodeId,
        fromNodeId: imp.fromNodeId ?? null,
        purpose: imp.purpose ?? null,
      });
    }
  }
  const all = [...entries.values()].sort((a, b) => a.interfaceId.localeCompare(b.interfaceId));
  if (interfaceId != null) {
    const found = entries.get(interfaceId);
    if (!found) throw new Error(`unknown interface id: ${interfaceId}`);
    return { count: 1, interfaces: [found] };
  }
  return { count: all.length, interfaces: all };
}
