/**
 * Phase accessor — exposes the agent's current phase to compose templates.
 *
 * Consistent with the reaction-block syntax where `phase(X)` refers to a
 * specific phase, the template accessor works the same way:
 *
 *   phase               → the CURRENT phase (callable object)
 *   phase.name          → name of the current phase (string)
 *   phase(exploring)    → the phase named "exploring" (a phase reference)
 *   phase == phase(exploring)   → true when the current phase is exploring
 *
 * No `.is()`, `.in()`, `.not()` — comparisons are done with `==` which
 * coerces the `phase` object to the current phase name via valueOf, and
 * `phase(exploring)` resolves to the string "exploring" (validated
 * against the agent's declared `phases { }` block at compile time).
 *
 * Implementation notes
 * --------------------
 * - The template transpiler rewrites bare-identifier calls
 *   `phase(exploring)` into string literal calls `phase('exploring')`
 *   so authors never write quotes.
 * - `phase` itself is a function (so `phase(X)` works) whose
 *   `.name`, `.valueOf()`, `.toString()` all return the CURRENT phase
 *   name. This makes `phase == phase(exploring)` equivalent to
 *   `'<current>' == 'exploring'` after JS string coercion.
 * - Unknown phase names throw a clear error listing declared phases.
 */

/**
 * Create a phase accessor for a given agent instance.
 *
 * @param {import('./agent.js').Agent} agent
 * @returns {Function & { name: string, valid: string[] }}
 */
export function createPhaseAccessor(agent) {
  const validPhases = Array.isArray(agent?.phases?._validPhases)
    ? agent.phases._validPhases
    : [];

  const assertValid = (name) => {
    // No declared phases → accept anything (legacy agents without phases).
    if (validPhases.length === 0) return;
    if (!validPhases.includes(name)) {
      throw new Error(
        `Unknown phase "${name}" in agent "${agent?.name || 'unknown'}". ` +
        `Declared phases: ${validPhases.join(', ') || '(none)'}`
      );
    }
  };

  const current = () => agent?.state?.statusPhase || null;

  // `phase` is a callable function. `phase('exploring')` validates the name
  // and returns it as a plain string, so comparisons like
  //     phase == phase('exploring')
  // work via JavaScript's object-to-primitive coercion (the left-hand
  // `phase` object is coerced to its current-phase name via valueOf, the
  // right-hand string is compared directly).
  const phase = function (name) {
    assertValid(name);
    return name;
  };

  // Override the built-in Function.name with a getter that returns the
  // CURRENT phase name. Function.name is configurable:true in ES2015+,
  // so we can redefine it safely.
  Object.defineProperty(phase, 'name', {
    get: () => current(),
    configurable: true,
  });

  // Coercion hooks used by `==` comparisons and string interpolation.
  phase.valueOf = () => current();
  phase.toString = () => current() || '';

  // List of declared phase names for debugging / introspection.
  Object.defineProperty(phase, 'valid', {
    get: () => validPhases.slice(),
    configurable: true,
  });

  return phase;
}
