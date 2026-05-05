import { promises as fs } from "node:fs";
import { parseFrontmatter } from "./frontmatter.js";
function isBlank(value) {
  if (value === null || value === void 0) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
async function loadTemplateSchema(templatePath) {
  const content = await fs.readFile(templatePath, "utf8");
  const parsed = parseFrontmatter(content);
  if (!parsed.data || typeof parsed.data !== "object") {
    return {};
  }
  const schema = parsed.data["_schema"];
  return schema ?? {};
}
async function validateNoteAgainstSchema(notePath, templatePath) {
  const errors = [];
  const warnings = [];
  const noteContent = await fs.readFile(notePath, "utf8");
  const noteParsed = parseFrontmatter(noteContent);
  if (!noteParsed.data) {
    return {
      valid: false,
      errors: ["Missing YAML frontmatter"],
      warnings
    };
  }
  const schema = await loadTemplateSchema(templatePath);
  const noteData = noteParsed.data;
  const required = schema.required ?? [];
  for (const field of required) {
    if (!(field in noteData) || isBlank(noteData[field])) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  const enums = schema.enums ?? {};
  for (const [field, allowed] of Object.entries(enums)) {
    if (field in noteData && !isBlank(noteData[field])) {
      const value = noteData[field];
      if (Array.isArray(value)) {
        const invalid = value.filter(
          (entry) => typeof entry === "string" && !allowed.includes(entry)
        );
        if (invalid.length > 0) {
          errors.push(`Invalid ${field} values: ${invalid.join(", ")}`);
        }
      } else if (typeof value === "string") {
        if (!allowed.includes(value)) {
          errors.push(`Invalid ${field} value: ${value}`);
        }
      }
    }
  }
  const constraints = schema.constraints ?? {};
  const descriptionConstraint = constraints["description"];
  const description = noteData["description"];
  if (typeof description === "string") {
    const maxLen = descriptionConstraint?.["max_length"];
    if (typeof maxLen === "number" && description.length > maxLen) {
      errors.push(`Description exceeds max length (${maxLen})`);
    }
    if (description.trim().endsWith(".")) {
      warnings.push("Description should not end with a period");
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
export {
  loadTemplateSchema,
  validateNoteAgainstSchema
};
