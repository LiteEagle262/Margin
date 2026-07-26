// Recipes: saved, replayable step sequences stored as workspace files under
// recipes/<hostname>/<slug>.json. Saving rides the existing workspace, so
// recipes appear in file cards, search_files, and workspace export for free.
// Replay re-enters executeTool per step — the browser_batch pattern — so tool
// access gates and the per-run tool budget apply to every step.

import {
  executeTool,
  guardToolCallBeforeExecution,
  evaluateToolLoopGuard,
  parseToolResultObject
} from "./execute.js";
import { BATCHABLE_TOOL_NAMES, SETTLE_AFTER_TOOLS, SETTLE_MS } from "./batch.js";
import { executeWorkspaceTool, getWorkspaceFile, getAllWorkspaceFiles } from "../features/workspace.js";

export const RECIPE_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "save_recipe",
      description: "Save a repeatable browser recipe for the active tab's site so any future chat can replay it with run_recipe. Omit steps to save the successful browser actions recorded during this run; pass steps to author or edit a recipe explicitly. String argument values may embed {{placeholder}} tokens that run_recipe fills from its values object. Saving with the same name updates the existing recipe.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Recipe name, e.g. \"login\" or \"export monthly report\"." },
          description: { type: "string", description: "One-line summary of what the recipe does." },
          steps: {
            type: "array",
            description: "Optional explicit steps. Omit to use the steps recorded from this run.",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", description: "Step tool: navigate, click_element, fill_element, fill_form, type_text, hover_element, press_key, scroll_page, wait_for, or fill_secret." },
                args: { type: "object", description: "Arguments for that tool, exactly as its own schema defines them. String values may contain {{placeholder}} tokens." },
                element: { type: "object", description: "Optional target descriptor {role, name, tag} used to re-resolve a stale uid at replay time." }
              },
              required: ["tool"]
            }
          }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_recipe",
      description: "List saved recipes matching a host, defaulting to the active tab's hostname. A recipe saved for example.com matches login.example.com. Call this at the start of a task on a site. Returns metadata only; run_recipe executes one by path.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "Hostname to match. Defaults to the active tab's hostname." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_recipe",
      description: "Execute a saved recipe step by step. Each step runs through the normal tools, so tool access settings and the tool budget apply per step. Pass values to fill the recipe's {{placeholder}} tokens. If a step cannot be completed deterministically the run aborts and returns the remaining steps so you can finish with normal tools.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Recipe path from find_recipe, e.g. recipes/example.com/login.json." },
          values: { type: "object", description: "Values for the recipe's {{placeholder}} tokens, e.g. {\"query\": \"Q2 report\"}." }
        },
        required: ["path"]
      }
    }
  }
];

export const RECIPE_TOOL_NAMES = new Set(RECIPE_TOOL_SCHEMAS.map((tool) => tool.function.name));

// Allowed step tools: the batchable ACTION set (observation and script tools
// excluded). Computed lazily because batch.js and execute.js form an import
// cycle with this module, so BATCHABLE_TOOL_NAMES may not exist at eval time.
const NON_STEP_BATCHABLE = new Set([
  "take_snapshot", "get_dom", "get_active_tab", "list_tabs", "run_js", "evaluate_script"
]);
let stepToolsCache = null;
function recipeStepTools() {
  if (!stepToolsCache) {
    stepToolsCache = new Set([...BATCHABLE_TOOL_NAMES].filter((name) => !NON_STEP_BATCHABLE.has(name)));
    stepToolsCache.add("fill_secret");
  }
  return stepToolsCache;
}

// ---- Recorder (Task 2) -----------------------------------------------------
// The run loop feeds every successful tool result through recordStep; only
// allowed step tools are kept. save_recipe with no explicit steps saves these.

const MAX_RECORDED_STEPS = 40;
let recordedSteps = [];
let recordingTruncated = false;

export function resetRecording() {
  recordedSteps = [];
  recordingTruncated = false;
}

export function recordStep(tool, args, resultText) {
  if (!recipeStepTools().has(tool)) return;
  const parsed = parseToolResultObject(resultText);
  if (parsed && parsed.ok === false) return;
  if (recordedSteps.length >= MAX_RECORDED_STEPS) {
    // Drop-newest, not drop-oldest: a recipe missing its opening steps is useless.
    recordingTruncated = true;
    return;
  }
  const cleanArgs = args && typeof args === "object" ? { ...args } : {};
  // Replayed steps should not each drag a snapshot along.
  delete cleanArgs.include_snapshot;
  const element = parsed?.element || parsed?.data?.element || null;
  recordedSteps.push({
    tool,
    args: cleanArgs,
    element: element && typeof element === "object"
      ? { role: String(element.role ?? ""), name: String(element.name ?? ""), tag: String(element.tag ?? "") }
      : null
  });
}

// ---- Shared helpers --------------------------------------------------------

function recipeError(tool, errorCode, message, extra = {}) {
  const { recoverable = true, ...rest } = extra;
  return JSON.stringify({ ok: false, tool, error_code: errorCode, recoverable, message, ...rest }, null, 2);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function getActiveTabLocation() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = String(tab?.url || "");
    return { host: url ? new URL(url).hostname.toLowerCase() : "", url };
  } catch {
    return { host: "", url: "" };
  }
}

// Returns "" when steps are valid, otherwise the reason they are not.
function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'needs a non-empty "steps" array';
  const allowed = recipeStepTools();
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step !== "object") return `step ${i + 1} is not an object`;
    const tool = String(step.tool || "");
    if (!allowed.has(tool)) {
      return `step ${i + 1} uses "${tool || "(missing tool)"}" — allowed step tools: ${[...allowed].join(", ")}`;
    }
    if (step.args !== undefined && (typeof step.args !== "object" || step.args === null || Array.isArray(step.args))) {
      return `step ${i + 1} "args" must be an object`;
    }
  }
  return "";
}

function normalizeStep(step) {
  const element = step.element && typeof step.element === "object" ? step.element : null;
  return {
    tool: String(step.tool),
    args: step.args && typeof step.args === "object" ? step.args : {},
    element: element
      ? { role: String(element.role ?? ""), name: String(element.name ?? ""), tag: String(element.tag ?? "") }
      : null
  };
}

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

function collectPlaceholders(value, keys) {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER_RE)) keys.add(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectPlaceholders(item, keys));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectPlaceholders(item, keys));
  }
}

function substitutePlaceholders(value, values) {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_RE, (_, key) => String(values[key]));
  }
  if (Array.isArray(value)) return value.map((item) => substitutePlaceholders(item, values));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = substitutePlaceholders(item, values);
    return out;
  }
  return value;
}

// ---- save_recipe -----------------------------------------------------------

async function saveRecipe(args) {
  const name = String(args.name || "").trim();
  if (!name) return recipeError("save_recipe", "invalid_arguments", 'save_recipe requires "name".');
  const slug = slugify(name);
  if (!slug) return recipeError("save_recipe", "invalid_arguments", `"${name}" does not produce a usable file name. Use letters or digits.`);

  let steps;
  let warning = "";
  if (args.steps !== undefined) {
    const invalid = validateSteps(args.steps);
    if (invalid) return recipeError("save_recipe", "invalid_steps", `Provided steps are invalid: ${invalid}.`);
    steps = args.steps.map(normalizeStep);
  } else {
    if (recordedSteps.length === 0) {
      return recipeError("save_recipe", "nothing_recorded", "No browser steps were recorded during this run. Perform the flow first, or pass explicit steps.");
    }
    steps = recordedSteps.map((step) => ({ ...step, args: { ...step.args } }));
    if (recordingTruncated) {
      warning = `Recording stopped at ${MAX_RECORDED_STEPS} steps; later steps were not captured. Verify the recipe is complete.`;
    }
  }

  const { host, url } = await getActiveTabLocation();
  if (!host) return recipeError("save_recipe", "no_active_tab", "Could not determine the active tab's hostname to scope the recipe.");

  const description = String(args.description || "").trim();
  const path = `recipes/${host}/${slug}.json`;
  const content = JSON.stringify({ name, host, description, created_url: url, steps, version: 1 }, null, 2);
  const written = await executeWorkspaceTool("write_file", {
    path,
    content,
    language: "json",
    description: description || `Recipe: ${name}`,
    tags: ["recipe", host]
  });
  if (typeof written === "string") return recipeError("save_recipe", "write_failed", written);

  return JSON.stringify({
    ok: true,
    tool: "save_recipe",
    path,
    step_count: steps.length,
    ...(warning ? { warning } : {}),
    message: `Saved recipe "${name}" (${steps.length} steps) for ${host}.`
  }, null, 2);
}

// ---- find_recipe -----------------------------------------------------------

async function findRecipe(args) {
  let host = String(args.host || "").trim().toLowerCase();
  if (!host) {
    host = (await getActiveTabLocation()).host;
    if (!host) return recipeError("find_recipe", "no_active_tab", "No host given and the active tab has no hostname.");
  }

  const recipes = [];
  for (const file of Object.values(getAllWorkspaceFiles())) {
    if (!String(file.path || "").startsWith("recipes/")) continue;
    let recipe;
    try {
      recipe = JSON.parse(file.content);
    } catch {
      continue;
    }
    const recipeHost = String(recipe?.host || "").toLowerCase();
    if (!recipeHost || !Array.isArray(recipe.steps)) continue;
    // Suffix match: a recipe saved for example.com applies on login.example.com.
    if (host !== recipeHost && !host.endsWith(`.${recipeHost}`)) continue;
    recipes.push({
      name: String(recipe.name || file.path),
      path: file.path,
      host: recipeHost,
      description: String(recipe.description || file.description || ""),
      step_count: recipe.steps.length,
      updatedAt: file.updatedAt || null
    });
  }
  recipes.sort((a, b) => b.host.length - a.host.length || (b.updatedAt || 0) - (a.updatedAt || 0));

  return JSON.stringify({
    ok: true,
    tool: "find_recipe",
    host,
    recipes,
    message: recipes.length
      ? `${recipes.length} recipe(s) match ${host}. Use run_recipe with a path to execute one.`
      : `No saved recipes match ${host}.`
  }, null, 2);
}

// ---- run_recipe ------------------------------------------------------------

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep(tool, toolArgs, surface) {
  let result;
  try {
    result = await executeTool(tool, toolArgs, surface);
  } catch (err) {
    result = {
      ok: false,
      tool,
      error_code: "tool_threw",
      recoverable: true,
      message: err?.message || String(err)
    };
  }
  return evaluateToolLoopGuard(tool, toolArgs, result) || result;
}

// uids are content hashes, so page changes shift them. When the stored uid
// misses and the failure lists EXACTLY ONE candidate whose role and name match
// the recorded element descriptor, that candidate is the same control and one
// retry is deterministic. Anything else (0 or 2+ matches, second failure)
// aborts — determinism-or-handoff is the contract.
function resolveRetryUid(parsed, step) {
  if (parsed?.error_code !== "target_not_found") return "";
  if (!step.element) return "";
  if (typeof step.args?.uid !== "string" || !step.args.uid) return "";
  const candidates = Array.isArray(parsed?.data?.candidates)
    ? parsed.data.candidates
    : Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const matches = candidates.filter((c) => c && c.role === step.element.role && c.name === step.element.name);
  return matches.length === 1 && typeof matches[0].uid === "string" ? matches[0].uid : "";
}

function stepFailure(steps, index, reason) {
  return recipeError("run_recipe", "recipe_step_failed", `Recipe aborted at step ${index + 1}; finish the task with normal tools.`, {
    completed: index,
    failed_step: { index, tool: steps[index].tool, reason },
    // From the failed step onward, so the model has an executable plan to continue.
    remaining_steps: steps.slice(index)
  });
}

async function runRecipe(args, surface) {
  const path = String(args.path || "").trim();
  if (!path) return recipeError("run_recipe", "invalid_arguments", 'run_recipe requires "path".');
  const file = getWorkspaceFile(path);
  if (!file) return recipeError("run_recipe", "recipe_not_found", `No workspace file at "${path}". Use find_recipe to list saved recipes.`);

  let recipe = null;
  try {
    recipe = JSON.parse(file.content);
  } catch {}
  const invalid = recipe && typeof recipe === "object" ? validateSteps(recipe.steps) : "not valid recipe JSON";
  if (invalid) return recipeError("run_recipe", "recipe_invalid", `"${path}" is not a runnable recipe: ${invalid}.`);

  const values = args.values && typeof args.values === "object" ? args.values : {};
  const required = new Set();
  recipe.steps.forEach((step) => collectPlaceholders(step.args, required));
  const missing = [...required].filter((key) => !(key in values));
  if (missing.length > 0) {
    return recipeError("run_recipe", "missing_values", `Recipe "${recipe.name}" needs values for: ${missing.join(", ")}. Re-call run_recipe with a "values" object supplying them.`, {
      required: [...required],
      missing
    });
  }

  const steps = recipe.steps.map((step) => {
    const normalized = normalizeStep(step);
    normalized.args = substitutePlaceholders(normalized.args, values);
    return normalized;
  });

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];

    // Every step spends one call from the run's budget, like a batch action.
    const guard = guardToolCallBeforeExecution(step.tool);
    if (guard) return stepFailure(steps, index, guard.message || "Tool call limit reached.");

    let result = await runStep(step.tool, step.args, surface);
    let parsed = parseToolResultObject(result);
    if (parsed?.ok === false) {
      const retryUid = resolveRetryUid(parsed, step);
      if (!retryUid) {
        return stepFailure(steps, index, parsed.message || parsed.error_code || "step failed");
      }
      const retryGuard = guardToolCallBeforeExecution(step.tool);
      if (retryGuard) return stepFailure(steps, index, retryGuard.message || "Tool call limit reached.");
      result = await runStep(step.tool, { ...step.args, uid: retryUid }, surface);
      parsed = parseToolResultObject(result);
      if (parsed?.ok === false) {
        return stepFailure(steps, index, `retry with re-resolved uid failed: ${parsed.message || parsed.error_code}`);
      }
    }

    if (SETTLE_AFTER_TOOLS.has(step.tool) && index < steps.length - 1) {
      await settle(SETTLE_MS);
    }
  }

  return JSON.stringify({
    ok: true,
    tool: "run_recipe",
    recipe: String(recipe.name || path),
    completed: steps.length,
    message: `Recipe "${recipe.name || path}" completed: ${steps.length}/${steps.length} steps.`
  }, null, 2);
}

// ---- Dispatch --------------------------------------------------------------

export async function executeRecipeTool(name, args = {}, surface = "panel") {
  try {
    if (name === "save_recipe") return await saveRecipe(args);
    if (name === "find_recipe") return await findRecipe(args);
    if (name === "run_recipe") return await runRecipe(args, surface);
    return recipeError(name, "unknown_tool", `Unknown recipe tool "${name}".`, { recoverable: false });
  } catch (err) {
    return recipeError(name, "recipe_tool_failed", err?.message || String(err));
  }
}
