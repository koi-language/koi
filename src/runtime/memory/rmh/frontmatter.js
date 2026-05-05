import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";
const FRONTMATTER_BOUNDARY = "---";
function parseFrontmatter(content) {
  const errors = [];
  const lines = content.split(/\r?\n/);
  if (lines[0] !== FRONTMATTER_BOUNDARY) {
    return { data: null, body: content, errors };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FRONTMATTER_BOUNDARY) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { data: null, body: content, errors: ["Unterminated frontmatter"] };
  }
  const raw = lines.slice(1, endIndex).join("\n");
  let data = null;
  try {
    const parsed = yaml.parse(raw);
    if (parsed && typeof parsed === "object") {
      data = parsed;
    } else {
      data = {};
    }
  } catch (err) {
    errors.push(`Invalid YAML frontmatter: ${err.message}`);
  }
  const body = lines.slice(endIndex + 1).join("\n");
  return { data, body, errors };
}
function stringifyFrontmatter(data, body) {
  const doc = yaml.stringify(data).trimEnd();
  if (doc.length === 0) {
    return body;
  }
  const normalizedBody = body.startsWith("\n") ? body.slice(1) : body;
  return `${FRONTMATTER_BOUNDARY}
${doc}
${FRONTMATTER_BOUNDARY}
${normalizedBody}`;
}
async function readFrontmatterFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return parseFrontmatter(content);
}
async function writeFrontmatterFile(filePath, data, body) {
  const content = stringifyFrontmatter(data, body);
  await fs.writeFile(filePath, content, "utf8");
}
async function writeTempFrontmatter(data, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-frontmatter-"));
  const filePath = path.join(dir, "note.md");
  await writeFrontmatterFile(filePath, data, body);
  return filePath;
}
export {
  parseFrontmatter,
  readFrontmatterFile,
  stringifyFrontmatter,
  writeFrontmatterFile,
  writeTempFrontmatter
};
