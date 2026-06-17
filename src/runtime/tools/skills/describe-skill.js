/**
 * Describe Skill — read a skill's description without activating it.
 *
 * The AVAILABLE SKILLS section lists skills by NAME only (to keep the prompt
 * small). This is the analog of `get_tool_info` for skills: call it to read
 * what a skill does before deciding whether to `activate_skill`. Returns the
 * description (not the full body — that's what activate_skill loads).
 */

export default {
  type: 'describe_skill',
  intent: 'describe_skill',
  description:
    'Read the description of one or more skills by name, to decide whether to activate them. '
    + 'AVAILABLE SKILLS lists only names; call this for any name that is not self-explanatory. '
    + 'Fields: "name" (one skill) OR "names" (array of skills). '
    + '→ Returns: { skills: [{ name, description }], notFound? }',
  thinkingHint: 'Looking up skill info',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'A single skill name — the canonical id ("plugin:skill") or a bare standalone name.',
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Several skill names to describe in one call.',
      },
    },
  },

  examples: [
    { intent: 'describe_skill', name: 'logo-creator:logo-creator' },
    { intent: 'describe_skill', names: ['marketing-skills:seo-audit', 'slide-deck:slide-deck'] },
  ],

  async execute(action, agent) {
    const wanted = [];
    if (typeof action.name === 'string' && action.name.trim()) wanted.push(action.name.trim());
    if (Array.isArray(action.names)) {
      wanted.push(...action.names.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()));
    }
    if (wanted.length === 0) {
      return { success: false, error: 'Provide "name" (a skill) or "names" (an array of skills).' };
    }

    const result = await agent.callAction('list_skills', {});
    const skills = result?._fullSkills || result?.skills || [];
    if (skills.length === 0) {
      return { success: false, error: 'No skills are available.' };
    }

    const { resolveSkillRef } = await import('./list-skills.js');
    const out = [];
    const notFound = [];
    for (const q of wanted) {
      const { skill, error } = resolveSkillRef(q, skills);
      if (skill) out.push({ name: skill.id || skill.name, description: skill.description });
      else notFound.push(error || `Skill "${q}" not found.`);
    }

    return {
      success: out.length > 0,
      skills: out,
      ...(notFound.length ? { notFound } : {}),
    };
  },
};
