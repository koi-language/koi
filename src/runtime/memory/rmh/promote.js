import {
  classifyNoteType,
  detectProjects
} from "./classify.js";
import {
  detectLinks,
  applyLinks,
  suggestLinks
} from "./linkdetect.js";
const AUTO_APPLY_THRESHOLD = 0.8;
const FOOTER_HEADINGS = ["Relevant Notes", "Areas"];
const TEMPLATE_PLACEHOLDER = /\{Content\s*[-—]/;
function isTemplatePlaceholder(body) {
  return TEMPLATE_PLACEHOLDER.test(body);
}
function parseFooter(body, heading) {
  const patterns = [
    new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "m"),
    new RegExp(`^${escapeRegex(heading)}:\\s*$`, "m")
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) continue;
    const startIdx = match.index + match[0].length;
    const items = [];
    const remaining = body.slice(startIdx);
    const lines = remaining.split("\n");
    const knownHeadings = FOOTER_HEADINGS;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        const linkMatch = trimmed.match(/^-\s+\[\[([^\]]+)\]\]/);
        if (linkMatch) {
          items.push(linkMatch[1]);
        }
      } else if (trimmed.length === 0) {
        continue;
      } else if (trimmed.startsWith("#") || trimmed.startsWith("---") || knownHeadings.some((h) => trimmed === `${h}:` || trimmed === `## ${h}`)) {
        break;
      }
    }
    return items;
  }
  return [];
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripFooters(body) {
  const headings = FOOTER_HEADINGS;
  const lines = body.split("\n");
  const kept = [];
  let inFooterSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading = headings.some(
      (h) => trimmed === `${h}:` || trimmed === `## ${h}` || trimmed.startsWith(`${h}:`)
    );
    if (isHeading) {
      inFooterSection = true;
      continue;
    }
    if (inFooterSection) {
      if (trimmed.startsWith("- ") || trimmed === "") {
        continue;
      }
      inFooterSection = false;
    }
    kept.push(line);
  }
  return kept.join("\n").trimEnd();
}
function formatFooters(areas, links) {
  let footer = "";
  if (links.length > 0) {
    footer += "\n\nRelevant Notes:";
    for (const link of links) {
      footer += `
- [[${link}]]`;
    }
  }
  if (areas.length > 0) {
    footer += "\n\nAreas:";
    for (const area of areas) {
      footer += `
- [[${area}]]`;
    }
  }
  return footer + "\n";
}
function injectFooters(body, areas, links) {
  const existingAreas = parseFooter(body, "Areas");
  const existingLinks = parseFooter(body, "Relevant Notes");
  const mergedAreas = [.../* @__PURE__ */ new Set([...existingAreas, ...areas])];
  const mergedLinks = [.../* @__PURE__ */ new Set([...existingLinks, ...links])];
  const cleanBody = stripFooters(body);
  if (mergedAreas.length === 0 && mergedLinks.length === 0) {
    return cleanBody + "\n";
  }
  return cleanBody + formatFooters(mergedAreas, mergedLinks);
}
function resolveAreas(projects, mapRouting, existingTitles, defaultArea) {
  const areas = [];
  for (const project of projects) {
    if (mapRouting[project]) {
      areas.push(mapRouting[project]);
      continue;
    }
    const mapTitle = existingTitles.find(
      (t) => t.toLowerCase().includes(project.toLowerCase()) && t.toLowerCase().includes("map")
    );
    if (mapTitle) {
      areas.push(mapTitle);
    }
  }
  if (areas.length === 0) {
    areas.push(defaultArea);
  }
  return [...new Set(areas)];
}
function computePromotion(input) {
  const {
    inboxPath,
    frontmatter,
    body,
    existingTitles,
    vaultIndex,
    overrides,
    projectConfig,
    mapRouting,
    defaultArea
  } = input;
  const changes = [];
  const warnings = [];
  const classification = classifyNoteType(
    titleFromPath(inboxPath),
    body,
    overrides.type ?? frontmatter.type
  );
  if (classification.confidence === "low" && !overrides.type) {
    warnings.push(
      `Low-confidence type classification: ${classification.type} (${classification.reason}). Use --type to override.`
    );
  }
  if (overrides.type && overrides.type !== frontmatter.type) {
    changes.push(`type: ${frontmatter.type ?? "unset"} \u2192 ${overrides.type}`);
  } else if (classification.type !== frontmatter.type) {
    changes.push(
      `type classified as ${classification.type} (${classification.confidence} confidence)`
    );
  }
  let projects;
  if (overrides.project && overrides.project.length > 0) {
    projects = overrides.project;
    changes.push(`project set to: ${projects.join(", ")}`);
  } else if (Array.isArray(frontmatter.project) && frontmatter.project.length > 0) {
    projects = frontmatter.project;
  } else {
    projects = detectProjects(
      titleFromPath(inboxPath),
      body,
      projectConfig
    );
    if (projects.length > 0) {
      changes.push(`project detected: ${projects.join(", ")}`);
    } else {
      warnings.push("No project detected. Consider adding --project.");
    }
  }
  const detectedLinks = detectLinks(body, existingTitles);
  const unlinked = detectedLinks.filter((l) => !l.alreadyLinked);
  if (unlinked.length > 0) {
    changes.push(`auto-linked ${unlinked.length} mention(s) in body`);
  }
  const allSuggested = suggestLinks(
    { ...frontmatter, project: projects },
    body,
    vaultIndex
  );
  const autoApplied = allSuggested.filter(
    (s) => s.confidence >= AUTO_APPLY_THRESHOLD
  );
  const manualSuggestions = allSuggested.filter(
    (s) => s.confidence < AUTO_APPLY_THRESHOLD
  );
  if (manualSuggestions.length > 0) {
    changes.push(
      `suggested ${manualSuggestions.length} connection(s): ${manualSuggestions.map((s) => s.title).join(", ")}`
    );
  }
  let updatedBody = applyLinks(body, detectedLinks);
  if (overrides.links && overrides.links.length > 0) {
    changes.push(
      `added ${overrides.links.length} explicit link(s): ${overrides.links.join(", ")}`
    );
  }
  const suggestedAreas = resolveAreas(
    projects,
    mapRouting,
    existingTitles,
    defaultArea
  );
  changes.push(`assigned to area(s): ${suggestedAreas.join(", ")}`);
  const allLinks = [
    ...autoApplied.map((s) => s.title),
    ...overrides.links ?? []
  ];
  updatedBody = injectFooters(updatedBody, suggestedAreas, allLinks);
  const updatedFrontmatter = {
    ...frontmatter,
    status: "active",
    type: classification.type,
    project: projects.length > 0 ? projects : frontmatter.project,
    last_accessed: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
    access_count: (typeof frontmatter.access_count === "number" ? frontmatter.access_count : 0) + 1
  };
  if (overrides.description) {
    updatedFrontmatter.description = overrides.description;
    changes.push("description updated via override");
  } else if (!frontmatter.description || typeof frontmatter.description === "string" && frontmatter.description.trim().length === 0) {
    warnings.push(
      'No description found. Add with --description "..." or configure LLM.'
    );
  }
  changes.push("status: inbox \u2192 active");
  const filename = inboxPath.split(/[/\\]/).pop() ?? "note.md";
  const destinationFilename = filename.endsWith(".md") ? filename : `${filename}.md`;
  return {
    updatedFrontmatter,
    updatedBody,
    destinationFilename,
    classification,
    detectedLinks,
    suggestedLinks: allSuggested,
    suggestedAreas,
    changes,
    warnings
  };
}
function titleFromPath(filePath) {
  const filename = filePath.split(/[/\\]/).pop() ?? "";
  return filename.replace(/\.md$/, "").replace(/-/g, " ");
}
export {
  computePromotion,
  injectFooters,
  isTemplatePlaceholder
};
