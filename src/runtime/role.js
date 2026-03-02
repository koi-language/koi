export class Role {
  constructor(name, capabilities = []) {
    this.name = name;
    this.capabilities = new Set(capabilities);
  }

  can(capability) {
    return this.capabilities.has(capability);
  }

  toString() {
    return `Role(${this.name})`;
  }
}
