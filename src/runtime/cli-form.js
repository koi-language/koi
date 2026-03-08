/**
 * CLI Form - Multi-step form input with optional select menus per field.
 *
 * Uses an injectable provider pattern so the CLI bootstrap layer
 * can override it (e.g. for Ink rendering) without this module knowing.
 */

// Injectable provider: when set, cliForm delegates to this function instead
// of using the fallback readline approach.
// Signature: fn(title, fields) → Promise<{ [label]: string } | null>
let _formProvider = null;

/** Set a form provider that overrides the default readline fallback. */
export function setFormProvider(fn) {
  _formProvider = fn;
}

/**
 * Show a multi-field form.
 * @param {string} title - The form title (may already be printed by the action)
 * @param {Array<{label, question?, hint?, options?, allowFreeText?}>} fields
 * @returns {Promise<{ [label]: string } | null>}
 */
export async function cliForm(title, fields) {
  if (_formProvider) {
    return _formProvider(title, fields);
  }

  // Fallback: sequential readline prompts (non-Ink / non-TTY mode)
  const readline = (await import('readline')).default || (await import('readline'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const answers = {};
  for (const field of fields) {
    const questionText = field.question || field.label;
    const hint = field.hint ? ` (${field.hint})` : '';

    if (field.options && field.options.length > 0) {
      // Show numbered list
      process.stdout.write(`\n  ${questionText}${hint}\n`);
      const allOpts = [...field.options, ...(field.allowFreeText ? [{ title: 'Type something.' }] : [])];
      allOpts.forEach((opt, i) => {
        const rec = opt.recommended ? ' (Recommended)' : '';
        const desc = opt.description ? `\n       ${opt.description}` : '';
        process.stdout.write(`    ${i + 1}. ${opt.title}${rec}${desc}\n`);
      });
      const answer = await new Promise(resolve => {
        rl.question(`  Choice [1-${allOpts.length}]: `, resolve);
      });
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < allOpts.length) {
        const opt = allOpts[idx];
        if (opt.freeText || (field.allowFreeText && idx === allOpts.length - 1)) {
          const freeAnswer = await new Promise(resolve => {
            rl.question(`  ${field.label}: `, resolve);
          });
          answers[field.label] = (freeAnswer || '').trim();
        } else {
          answers[field.label] = opt.value ?? opt.title;
        }
      } else {
        answers[field.label] = '';
      }
    } else {
      const answer = await new Promise(resolve => {
        rl.question(`  ${questionText}${hint}: `, resolve);
      });
      answers[field.label] = (answer || '').trim();
    }
  }

  rl.close();
  return answers;
}
