export class RoleRegistry {
  constructor() {
    this.roles = new Map();
  }

  register(id, definition) {
    if (!id || typeof id !== 'string') throw new Error('role id is required');
    if (!definition || typeof definition.prepare !== 'function') {
      throw new Error(`role ${id} requires prepare()`);
    }
    if (typeof definition.transition !== 'function') {
      throw new Error(`role ${id} requires transition()`);
    }
    this.roles.set(id, { sessionPolicy: 'fresh', ...definition, id });
    return this.get(id);
  }

  get(id) {
    const role = this.roles.get(id);
    if (!role) throw new Error(`unknown role: ${id}`);
    return role;
  }
}
