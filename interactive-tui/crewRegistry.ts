import {mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import path from "node:path";
import type {SiftCrewAgent, SiftCrewTask} from "./crewAdapter";

export type CrewScope = "builtin" | "project" | "user";
export type CrewProcess = "parallel" | "sequential";

export interface SiftCrewDefinitionFile {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  process: CrewProcess;
  agents: SiftCrewAgent[];
  tasks: SiftCrewTask[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SiftCrewDefinition extends SiftCrewDefinitionFile {
  scope: CrewScope;
  path?: string;
}

export interface CrewRegistryOptions {
  cwd: string;
  workspaceRoot?: string;
  homeDir?: string;
}

export interface CreateCrewOptions extends CrewRegistryOptions {
  id: string;
  templateId?: string;
  scope: Exclude<CrewScope, "builtin">;
  name?: string;
  description?: string;
}

const CREW_DIR = ".siftable/crews";
const CREW_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

const BUILTIN_CREWS: SiftCrewDefinition[] = [
  {
    schemaVersion: 1,
    id: "repo-investigation",
    name: "Repo Investigation",
    description: "Map a workspace question, verify the key evidence, then summarize the answer.",
    scope: "builtin",
    process: "sequential",
    agents: [
      {
        id: "mapper",
        role: "Mapper",
        goal: "Find the relevant project surfaces before reading deeply.",
        prompt: [
          "You are a Siftable crew mapper.",
          "Stay read-only. Identify likely files, commands, and search terms.",
          "Prefer concrete paths and uncertainty over broad narration.",
        ].join("\n"),
        maxToolCalls: 8,
      },
      {
        id: "verifier",
        role: "Verifier",
        goal: "Check the mapper's claims against local evidence.",
        prompt: [
          "You are a Siftable crew verifier.",
          "Stay read-only. Confirm or reject the mapper's claims with file paths, command output, or explicit gaps.",
        ].join("\n"),
        maxToolCalls: 8,
      },
      {
        id: "summarizer",
        role: "Summarizer",
        goal: "Compress the verified findings into a direct answer.",
        prompt: [
          "You are a Siftable crew summarizer.",
          "Use only the prior crew results and the user's request. Make the conclusion actionable.",
        ].join("\n"),
        maxToolCalls: 4,
      },
    ],
    tasks: [
      {
        id: "map",
        agent: "mapper",
        input: "Map the local workspace for this request:\n{{input}}\n\ncwd: {{cwd}}\nroot: {{root}}",
        expectedOutput: "A concise map of relevant files, commands, and unknowns.",
      },
      {
        id: "verify",
        agent: "verifier",
        dependsOn: ["map"],
        input: "Verify the mapper's findings for this request:\n{{input}}",
        expectedOutput: "Confirmed evidence, rejected claims, and gaps.",
      },
      {
        id: "summarize",
        agent: "summarizer",
        dependsOn: ["map", "verify"],
        input: "Summarize the verified answer for this request:\n{{input}}",
        expectedOutput: "A short final answer with evidence references.",
      },
    ],
  },
];

export function listBuiltInCrews(): SiftCrewDefinition[] {
  return BUILTIN_CREWS.map(cloneDefinition);
}

export function listCrewDefinitions(options: CrewRegistryOptions): SiftCrewDefinition[] {
  const byId = new Map<string, SiftCrewDefinition>();
  for (const crew of BUILTIN_CREWS) byId.set(crew.id, cloneDefinition(crew));
  for (const crew of readCrewDir("user", userCrewDir(options))) byId.set(crew.id, crew);
  for (const crew of readCrewDir("project", projectCrewDir(options))) byId.set(crew.id, crew);
  return [...byId.values()].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.id.localeCompare(b.id));
}

export function getCrewDefinition(id: string, options: CrewRegistryOptions): SiftCrewDefinition | null {
  const normalized = normalizeCrewId(id);
  return listCrewDefinitions(options).find((crew) => crew.id === normalized) ?? null;
}

export function createCrewFromTemplate(options: CreateCrewOptions): SiftCrewDefinition {
  const id = normalizeCrewId(options.id);
  assertCrewId(id);
  const template = getCrewDefinition(options.templateId ?? "repo-investigation", options);
  if (!template) throw new Error(`unknown crew template: ${options.templateId ?? "repo-investigation"}`);
  const now = new Date().toISOString();
  const crew: SiftCrewDefinitionFile = {
    schemaVersion: 1,
    id,
    name: options.name?.trim() || titleFromId(id),
    description: options.description?.trim() || template.description,
    process: template.process,
    agents: template.agents.map((agent) => ({...agent})),
    tasks: template.tasks.map((task) => ({...task, dependsOn: task.dependsOn ? [...task.dependsOn] : undefined})),
    createdAt: now,
    updatedAt: now,
  };
  return saveCrewDefinition(crew, options.scope, options);
}

export function saveCrewDefinition(
  crew: SiftCrewDefinitionFile,
  scope: Exclude<CrewScope, "builtin">,
  options: CrewRegistryOptions,
): SiftCrewDefinition {
  const normalized = {...crew, id: normalizeCrewId(crew.id), updatedAt: new Date().toISOString()};
  validateCrewDefinition(normalized);
  const dir = scope === "project" ? projectCrewDir(options) : userCrewDir(options);
  mkdirSync(dir, {recursive: true});
  const filePath = path.join(dir, `${normalized.id}.json`);
  writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return {...normalized, scope, path: filePath};
}

export function crewStoragePath(scope: Exclude<CrewScope, "builtin">, options: CrewRegistryOptions): string {
  return scope === "project" ? projectCrewDir(options) : userCrewDir(options);
}

export function validateCrewDefinition(crew: SiftCrewDefinitionFile): void {
  if (crew.schemaVersion !== 1) throw new Error("crew schemaVersion must be 1");
  assertCrewId(crew.id);
  if (!crew.name.trim()) throw new Error("crew name is required");
  if (!crew.description.trim()) throw new Error("crew description is required");
  if (crew.process !== "parallel" && crew.process !== "sequential") throw new Error("crew process must be parallel or sequential");
  if (!crew.agents.length) throw new Error("crew must define at least one agent");
  if (!crew.tasks.length) throw new Error("crew must define at least one task");
  const agentIds = new Set<string>();
  for (const agent of crew.agents) {
    assertCrewId(agent.id);
    if (agentIds.has(agent.id)) throw new Error(`duplicate crew agent: ${agent.id}`);
    agentIds.add(agent.id);
    if (!agent.role.trim()) throw new Error(`agent ${agent.id} role is required`);
    if (!agent.prompt.trim()) throw new Error(`agent ${agent.id} prompt is required`);
  }
  const taskIds = new Set<string>();
  for (const task of crew.tasks) {
    assertCrewId(task.id);
    if (taskIds.has(task.id)) throw new Error(`duplicate crew task: ${task.id}`);
    taskIds.add(task.id);
    if (!agentIds.has(task.agent)) throw new Error(`task ${task.id} references unknown agent ${task.agent}`);
    if (!task.input.trim()) throw new Error(`task ${task.id} input is required`);
  }
  for (const task of crew.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!taskIds.has(dependency)) throw new Error(`task ${task.id} references unknown dependency ${dependency}`);
    }
  }
}

export function renderCrewTaskTemplate(raw: string, values: {input: string; cwd: string; root: string}): string {
  return raw
    .split("{{input}}").join(values.input)
    .split("{{cwd}}").join(values.cwd)
    .split("{{root}}").join(values.root);
}

function readCrewDir(scope: Exclude<CrewScope, "builtin">, dir: string): SiftCrewDefinition[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  const crews: SiftCrewDefinition[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as SiftCrewDefinitionFile;
      validateCrewDefinition(parsed);
      crews.push({...parsed, scope, path: filePath});
    } catch {
      // Invalid local crew files should not break the whole interactive command surface.
    }
  }
  return crews;
}

function projectCrewDir(options: CrewRegistryOptions): string {
  return path.join(options.workspaceRoot || options.cwd, CREW_DIR);
}

function userCrewDir(options: CrewRegistryOptions): string {
  return path.join(options.homeDir || homedir(), CREW_DIR);
}

function normalizeCrewId(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, "-");
}

function assertCrewId(id: string): void {
  if (!CREW_ID_RE.test(id)) throw new Error(`invalid crew id "${id}" (use lowercase letters, numbers, and hyphens)`);
}

function titleFromId(id: string): string {
  return id.split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}

function scopeRank(scope: CrewScope): number {
  if (scope === "project") return 0;
  if (scope === "user") return 1;
  return 2;
}

function cloneDefinition(definition: SiftCrewDefinition): SiftCrewDefinition {
  return {
    ...definition,
    agents: definition.agents.map((agent) => ({...agent})),
    tasks: definition.tasks.map((task) => ({...task, dependsOn: task.dependsOn ? [...task.dependsOn] : undefined})),
  };
}
