/**
 * The /work hub's command-layer helpers (commands.ts): loadWorkBoard (board data
 * shared with /queue + the overlay), workItemEvidence (the `v` action's query),
 * and createHandoffWorkItem (the payload shared with /handoff). The pure reducer
 * is covered in ../workHubOverlay.test.ts; these tests cover the data shaping +
 * API plumbing against the mocked client.
 */
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  AGENT_WORK_EDITABLE_FIELDS as SHARED_AGENT_WORK_EDITABLE_FIELDS,
  AGENT_WORK_EDIT_CAPABILITY as SHARED_AGENT_WORK_EDIT_CAPABILITY,
} from "@execufunction/shared";
import {loadWorkBoard, workItemEvidence, createHandoffWorkItem, interactiveCommands} from "../../interactive-tui/commands";
import {
  AGENT_WORK_EDITABLE_FIELDS,
  AGENT_WORK_EDIT_CAPABILITY,
} from "../../src/lib/work-edit-contract";
import type {WorkBoardItem} from "../../interactive-tui/workHubOverlay";
import {installIsolatedConfigDirHooks} from "../helpers/config-env";
import {buildCommandContext, response} from "../helpers/interactive-command-context";
import {mockFetch, restoreFetch, runCommand} from "../helpers/mock-api";

installIsolatedConfigDirHooks("sift-cli-work-test-");

afterEach(() => {
  restoreFetch();
});

describe("loadWorkBoard", () => {
  it("normalizes agents + work items (snake/camel, scope, criteria)", async () => {
    const {ctx} = buildCommandContext();
    (ctx.apiClient.listWorkItems as jest.Mock).mockReturnValue(
      response({
        workItems: [
          {
            id: "11111111-2222-3333-4444-555555555555",
            title: "Fix paste",
            status: "running",
            assigned_alias: "codex",
            claim_owner: "codex@tty1",
            prompt: "fix the composer",
            write_scope: {include: ["src/composer/**", "src/x.ts"]},
            verification_commands: ["npm test -- composer"],
            acceptance_criteria: [{text: "paste preserved", met: false}],
            blocked_reason: "waiting on #other",
          },
        ],
      }),
    );
    const board = await loadWorkBoard(ctx);
    expect(board.agents).toEqual([{alias: "codex", status: "active"}]);
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toEqual({
      id: "11111111-2222-3333-4444-555555555555",
      title: "Fix paste",
      status: "running",
      agent: "codex",
      owner: "codex@tty1",
      prompt: "fix the composer",
      writeScope: ["src/composer/**", "src/x.ts"],
      verification: ["npm test -- composer"],
      acceptance: ["paste preserved"],
      blockers: ["waiting on #other"],
    });
  });

  it("falls back gracefully on sparse rows", async () => {
    const {ctx} = buildCommandContext();
    (ctx.apiClient.listWorkItems as jest.Mock).mockReturnValue(response({workItems: [{id: "x"}]}));
    const board = await loadWorkBoard(ctx);
    expect(board.items[0]).toMatchObject({
      id: "x",
      title: "(untitled)",
      status: "unknown",
      agent: "-",
      owner: null,
      writeScope: [],
      acceptance: [],
      blockers: [],
    });
  });
});

describe("workItemEvidence", () => {
  it("builds a query from title + acceptance + prompt and searches code", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sift-work-evidence-"));
    try {
      await mkdir(join(workspace, "src"));
      await writeFile(
        join(workspace, "src", "title.ts"),
        'export const titleMarker = "Fix";\n',
      );
      await writeFile(
        join(workspace, "src", "acceptance.ts"),
        'export const acceptanceMarker = "preserved";\n',
      );
      await writeFile(
        join(workspace, "src", "prompt.test.ts"),
        'it("finds the prompt marker", () => expect("composer").toBe("composer"));\n',
      );
      const {ctx, apiClient} = buildCommandContext({
        cwd: () => workspace,
        workspaceRoot: () => workspace,
      });
      const item: WorkBoardItem = {
        id: "i1",
        title: "Fix paste",
        status: "queued",
        agent: "codex",
        owner: null,
        prompt: "the composer drops the first line",
        writeScope: ["src/**"],
        verification: ["npm test"],
        acceptance: ["paste preserved"],
        blockers: [],
      };
      const text = await workItemEvidence(ctx, item);
      expect(apiClient.searchCode).not.toHaveBeenCalled();
      expect(text).toContain("Evidence: Fix paste");
      expect(text).toContain("src/title.ts:1");
      expect(text).toContain("src/acceptance.ts:1");
      expect(text).toContain("src/prompt.test.ts:1");
      expect(text).toContain("Test evidence:");
      expect(text).toContain("src/prompt.test.ts");
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });
});

describe("createHandoffWorkItem", () => {
  it("builds the work-item payload (acceptance as {text,met}) and returns the confirmation", async () => {
    const {ctx, createdWork} = buildCommandContext();
    const msg = await createHandoffWorkItem(ctx, {
      title: "Do the thing",
      agent: "claude",
      files: ["src/a.ts", "src/b.ts"],
      acceptance: ["compiles", "tests pass"],
      verify: ["npm test"],
    });
    expect(ctx.apiClient.createWorkItem).toHaveBeenCalledTimes(1);
    const payload = createdWork[0] as Record<string, any>;
    expect(payload.title).toBe("Do the thing");
    expect(payload.assignedAlias).toBe("claude");
    expect(payload.inputContext.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(payload.acceptanceCriteria).toEqual([
      {text: "compiles", met: false},
      {text: "tests pass", met: false},
    ]);
    expect(payload.verificationCommands).toEqual(["npm test"]);
    expect(msg).toBe("Work item created: work-new · Do the thing");
  });
});

describe("/work command registration", () => {
  it("registers /work (alias w) visible and hides the folded inspect verbs", () => {
    const byName = new Map(interactiveCommands.map((c) => [c.name, c]));
    const work = byName.get("work");
    expect(work).toBeDefined();
    expect(work?.hidden).toBeFalsy();
    expect(work?.aliases).toContain("w");
    for (const folded of ["queue", "focus", "recap", "ship"]) {
      expect(byName.get(folded)?.hidden).toBe(true);
    }
    // The rich-arg commands stay visible (faster typed than menu-driven).
    for (const visible of ["plan", "handoff", "proof"]) {
      expect(byName.get(visible)?.hidden).toBeFalsy();
    }
  });

  it("text fallback prints the board grouped by status", async () => {
    const {ctx, messages} = buildCommandContext();
    const work = interactiveCommands.find((c) => c.name === "work");
    await work!.run(ctx, []);
    const text = messages.at(-1)?.text ?? "";
    expect(text).toContain("Work");
    expect(text).toContain("codex (active)");
    expect(text).toContain("Fix composer");
    expect(text).toContain("needs_review");
  });
});

describe("sift work edit", () => {
  const workId = "22222222-2222-4222-8222-222222222222";

  it("keeps the package-local discovery contract aligned with the authoritative shared contract", () => {
    expect(AGENT_WORK_EDITABLE_FIELDS).toEqual(SHARED_AGENT_WORK_EDITABLE_FIELDS);
    expect(AGENT_WORK_EDIT_CAPABILITY).toEqual(SHARED_AGENT_WORK_EDIT_CAPABILITY);
  });

  it("edits queued work in place with optimistic concurrency and a stable retry key", async () => {
    mockFetch()
      .on("PATCH", `/api/v1/work-items/${workId}`)
      .body((body) => {
        const input = body as Record<string, unknown>;
        return input.expectedRevision === 7
          && input.reason === "Clarify REL grounding"
          && input.title === "Ground REL actions in API support"
          && input.queueRank === 9000
          && input.dryRun === true;
      })
      .reply(200, {
        workItem: {id: workId, revision: 7, title: "Original work"},
        receipt: {
          previousRevision: 7,
          revision: 8,
          changedFields: ["title", "queueRank"],
          verificationInvalidated: true,
        },
        diff: {
          title: {before: "Original work", after: "Ground REL actions in API support"},
          queueRank: {before: 0, after: 9000},
        },
        preservation: {
          identity: {
            workItemIdUnchanged: true,
            projectIdUnchanged: true,
            taskIdUnchanged: true,
            assignedAliasIdUnchanged: true,
            createdAtUnchanged: true,
          },
          lifecycle: {statusUnchanged: true, claimUnchanged: true},
          dependencies: {incomingEdgesUnchanged: true, outgoingEdgesUnchanged: true},
        },
        dryRun: true,
        replayed: false,
      })
      .install();

    const result = await runCommand([
      "work", "edit", workId,
      "--expected-revision", "7",
      "--reason", "Clarify REL grounding",
      "--patch", '{"title":"Ground REL actions in API support","queueRank":9000}',
      "--dry-run",
      "--idempotency-key", "rel-edit-7",
      "--token", "sift_pat_test",
      "--json",
    ]);

    const json = JSON.parse(result.stdout);
    expect(json.receipt.changedFields).toEqual(["title", "queueRank"]);
    expect(json.receipt.verificationInvalidated).toBe(true);
    expect(json.preservation.dependencies).toEqual({
      incomingEdgesUnchanged: true,
      outgoingEdgesUnchanged: true,
    });
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(request.method).toBe("PATCH");
    expect(request.headers["Idempotency-Key"]).toBe("rel-edit-7");
  });

  it("requires a caller-stable idempotency key before sending the edit", async () => {
    mockFetch().install();
    const result = await runCommand([
      "work", "edit", workId,
      "--expected-revision", "1",
      "--reason", "Retry-safe edit",
      "--title", "Clarified work",
      "--token", "sift_pat_test",
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Missing required flag idempotency-key");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("makes preservation guarantees visible in human dry-run output", async () => {
    mockFetch()
      .on("PATCH", `/api/v1/work-items/${workId}`)
      .reply(200, {
        workItem: {id: workId, revision: 7, title: "Original work"},
        receipt: {
          previousRevision: 7,
          revision: 8,
          changedFields: ["title"],
          verificationInvalidated: true,
        },
        diff: {title: {before: "Original work", after: "Clarified work"}},
        preservation: {
          identity: {
            workItemIdUnchanged: true,
            projectIdUnchanged: true,
            taskIdUnchanged: true,
            assignedAliasIdUnchanged: true,
            createdAtUnchanged: true,
          },
          lifecycle: {statusUnchanged: true, claimUnchanged: true},
          dependencies: {incomingEdgesUnchanged: true, outgoingEdgesUnchanged: true},
        },
        dryRun: true,
        replayed: false,
      })
      .install();

    const result = await runCommand([
      "work", "edit", workId,
      "--expected-revision", "7",
      "--reason", "Preview preserved state",
      "--title", "Clarified work",
      "--dry-run",
      "--idempotency-key", "preservation-preview-7",
      "--token", "sift_pat_test",
    ]);

    expect(result.stdout).toContain("Dry run:");
    expect(result.stdout).toContain("Preserved: identity, lifecycle and incoming/outgoing dependency edges");
  });

  it("preserves the API's structured recovery when forbidden fields are rejected", async () => {
    mockFetch()
      .on("PATCH", `/api/v1/work-items/${workId}`)
      .reply(400, {
        error: {
          code: "work_edit_forbidden_fields",
          message: "Work edit contains forbidden fields.",
          forbiddenFields: ["status", "dependsOn"],
          editableFields: AGENT_WORK_EDITABLE_FIELDS,
          recovery: "Re-read the work item, then retry with editable fields only.",
        },
      })
      .install();
    const result = await runCommand([
      "work", "edit", workId,
      "--expected-revision", "1",
      "--reason", "Illegal lifecycle rewrite",
      "--idempotency-key", "forbidden-edit-1",
      "--patch", '{"status":"done","dependsOn":[]}',
      "--token", "sift_pat_test",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.error.api).toEqual(expect.objectContaining({
      code: "work_edit_forbidden_fields",
      forbiddenFields: ["status", "dependsOn"],
      editableFields: AGENT_WORK_EDITABLE_FIELDS,
      recovery: "Re-read the work item, then retry with editable fields only.",
    }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("honors SIFT_WORKSPACE_ID when direct API commands omit --workspace", async () => {
    const previousWorkspaceId = process.env.SIFT_WORKSPACE_ID;
    process.env.SIFT_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
    try {
      mockFetch()
        .on("PATCH", `/api/v1/work-items/${workId}`)
        .reply(200, {
          workItem: {id: workId},
          receipt: {previousRevision: 1, revision: 2, changedFields: ["title"]},
          preservation: {},
          dryRun: false,
          replayed: false,
        })
        .install();

      await runCommand([
        "work", "edit", workId,
        "--expected-revision", "1",
        "--reason", "Workspace-scoped edit",
        "--idempotency-key", "workspace-edit-1",
        "--title", "Workspace work",
        "--token", "sift_pat_test",
        "--json",
      ]);

      const request = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(request.headers["X-Workspace-Id"]).toBe("33333333-3333-4333-8333-333333333333");
    } finally {
      if (previousWorkspaceId === undefined) delete process.env.SIFT_WORKSPACE_ID;
      else process.env.SIFT_WORKSPACE_ID = previousWorkspaceId;
    }
  });

  it("does not let patch JSON override concurrency or audit control flags", async () => {
    mockFetch()
      .on("PATCH", `/api/v1/work-items/${workId}`)
      .body((body) => {
        const input = body as Record<string, unknown>;
        return input.expectedRevision === 4
          && input.reason === "Authoritative flag reason"
          && input.dryRun === true
          && input.title === "Safe patch";
      })
      .reply(200, {
        workItem: {id: workId},
        receipt: {previousRevision: 4, revision: 5, changedFields: ["title"]},
        preservation: {},
        dryRun: true,
        replayed: false,
      })
      .install();

    const result = await runCommand([
      "work", "edit", workId,
      "--expected-revision", "4",
      "--reason", "Authoritative flag reason",
      "--idempotency-key", "control-field-precedence",
      "--patch", '{"title":"Safe patch","expectedRevision":999,"reason":"Injected","dryRun":false}',
      "--dry-run",
      "--token", "sift_pat_test",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("sift work Contract V1 authoring", () => {
  const validContract = {
    version: 1,
    profile: "coding",
    outcome: {acceptanceCriteria: [{text: "Focused tests pass", met: false}]},
    authority: {
      allowedActions: {
        read: true,
        write: true,
        test: true,
        network: false,
        vault: false,
        deploy: false,
        migrate: false,
      },
    },
    boundary: {writeScope: {include: ["packages/exf-cli/src/**"], exclude: ["dist/**"]}},
    proof: {verificationCommands: ["npm test --workspace @siftable/cli"]},
  };

  it("previews a normalized coding profile without authentication or raw contract JSON", async () => {
    const result = await runCommand([
      "work", "create",
      "--title", "Bounded CLI work",
      "--profile", "coding",
      "--acceptance-criteria", "Focused tests pass;diff is scoped",
      "--scope", "./packages/exf-cli/src/**",
      "--exclude-scope", "dist/**",
      "--verify", "npm test --workspace @siftable/cli",
      "--dry-run",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ok: true, dryRun: true});
    expect(output.workItem).not.toHaveProperty("acceptanceCriteria");
    expect(output.workItem.contract).toMatchObject({
      version: 1,
      profile: "coding",
      boundary: {writeScope: {include: ["packages/exf-cli/src/**"], exclude: ["dist/**"]}},
    });
  });

  it("authors an explicit read-only profile with an empty write boundary", async () => {
    const result = await runCommand([
      "work", "create",
      "--title", "Read-only audit",
      "--profile", "read-only",
      "--acceptance-criteria", "Report cites inspected files",
      "--dry-run",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.workItem.contract).toMatchObject({
      profile: "read_only",
      authority: {allowedActions: {read: true, write: false, test: false}},
      boundary: {writeScope: {include: [], exclude: []}},
    });
  });

  it("returns stable structured violations for an incomplete noninteractive contract", async () => {
    const result = await runCommand([
      "work", "create",
      "--title", "Invalid coding work",
      "--profile", "coding",
      "--acceptance-criteria", "Has an outcome",
      "--dry-run",
      "--no-input",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const error = JSON.parse(result.stdout).error as {code?: string; api?: Record<string, any>};
    expect(error.code).toBe("work_contract_invalid");
    expect(error.api?.extra?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({path: "boundary.writeScope.include", code: "coding_scope_required"}),
      expect.objectContaining({path: "proof.verificationCommands", code: "coding_verification_required"}),
    ]));
  });

  it("returns structured violations when action overlays receive malformed JSON values", async () => {
    const result = await runCommand([
      "work", "create",
      "--title", "Malformed action overlay",
      "--profile", "coding",
      "--acceptance-criteria", "Has an outcome",
      "--allowed-actions", '"not-an-object"',
      "--allow-network",
      "--scope", "packages/exf-cli/src/**",
      "--verify", "npm run typecheck --workspace @siftable/cli",
      "--dry-run",
      "--no-input",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const error = JSON.parse(result.stdout).error as {code?: string; api?: Record<string, any>};
    expect(error.code).toBe("work_contract_invalid");
    expect(error.api?.extra?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "authority.allowedActions",
        code: "field_must_be_object",
      }),
    ]));
  });

  it("rejects profile-only scope and authority flags instead of silently creating legacy work", async () => {
    const result = await runCommand([
      "work", "create",
      "--title", "Accidentally unprofiled work",
      "--scope", "packages/exf-cli/src/**",
      "--allow-network",
      "--dry-run",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("--scope, --exclude-scope, and --allow-* require --profile");
  });

  it.each([
    {
      label: "allowed actions",
      flag: "--allowed-actions",
      path: "authority.allowedActions",
      extraFlags: ["--scope", "packages/exf-cli/src/**"],
    },
    {
      label: "write scope",
      flag: "--write-scope",
      path: "boundary.writeScope",
      extraFlags: [],
    },
  ])("treats explicit null $label as invalid rather than an omitted default", async ({flag, path, extraFlags}) => {
    const result = await runCommand([
      "work", "create",
      "--title", "Null contract component",
      "--profile", "coding",
      "--acceptance-criteria", "Has an outcome",
      flag, "null",
      ...extraFlags,
      "--verify", "npm run typecheck --workspace @siftable/cli",
      "--dry-run",
      "--no-input",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const error = JSON.parse(result.stdout).error as {code?: string; api?: Record<string, any>};
    expect(error.code).toBe("work_contract_invalid");
    expect(error.api?.extra?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({path, code: "field_must_be_object"}),
    ]));
  });

  it("loads an authoritative contract file and transmits no contradictory projections", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sift-work-contract-"));
    const contractPath = join(workspace, "contract.json");
    try {
      await writeFile(contractPath, JSON.stringify(validContract));
      mockFetch()
        .on("POST", "/api/v1/work-items")
        .body((body) => {
          const payload = body as Record<string, unknown>;
          return JSON.stringify(payload.contract) === JSON.stringify(validContract)
            && !Object.prototype.hasOwnProperty.call(payload, "acceptanceCriteria")
            && !Object.prototype.hasOwnProperty.call(payload, "writeScope");
        })
        .reply(201, {workItem: {id: "work-bounded", title: "From file"}})
        .install();

      const result = await runCommand([
        "work", "create",
        "--title", "From file",
        "--contract-file", contractPath,
        "--token", "sift_pat_test",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).workItem.id).toBe("work-bounded");
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("preserves server-originated Work Contract violations for JSON callers", async () => {
    const violations = [{
      path: "acceptanceCriteria",
      code: "unsupported_field",
      message: "acceptanceCriteria contradicts the authoritative top-level Work Contract V1 projection; remove the duplicate field.",
    }];
    mockFetch()
      .on("POST", "/api/v1/work-items")
      .reply(400, {
        type: "work_contract_invalid",
        title: "Invalid Work Contract V1",
        status: 400,
        detail: "Correct the reported Work Contract violations and retry.",
        extra: {violations},
      })
      .install();

    const result = await runCommand([
      "work", "create",
      "--title", "Server-invalid work",
      "--contract", JSON.stringify(validContract),
      "--token", "sift_pat_test",
      "--no-input",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const error = JSON.parse(result.stdout).error as {code?: string; api?: Record<string, any>};
    expect(error.code).toBe("work_contract_invalid");
    expect(error.api).toMatchObject({
      type: "work_contract_invalid",
      extra: {violations},
    });
  });

  it("checks both a local contract file and a fetched bounded work item", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sift-work-contract-check-"));
    const contractPath = join(workspace, "contract.json");
    try {
      await writeFile(contractPath, JSON.stringify(validContract));
      const fileResult = await runCommand(["work", "contract", "check", "--file", contractPath, "--json"]);
      expect(fileResult.exitCode).toBe(0);
      expect(JSON.parse(fileResult.stdout)).toMatchObject({valid: true, classification: "bounded"});

      mockFetch()
        .on("GET", "/api/v1/work-items/work-bounded")
        .reply(200, {
          workItem: {
            id: "work-bounded",
            contractSummary: {classification: "bounded", version: 1, profile: "coding"},
            acceptanceCriteria: validContract.outcome.acceptanceCriteria,
            allowedActions: validContract.authority.allowedActions,
            writeScope: validContract.boundary.writeScope,
            verificationCommands: validContract.proof.verificationCommands,
          },
        })
        .install();
      const fetchedResult = await runCommand([
        "work", "contract", "check", "work-bounded", "--token", "sift_pat_test", "--json",
      ]);
      expect(fetchedResult.exitCode).toBe(0);
      expect(JSON.parse(fetchedResult.stdout)).toMatchObject({valid: true, source: {kind: "work_item"}});
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("validates a contract file as a closed raw envelope instead of extracting a nested contract", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sift-work-contract-wrapper-"));
    const contractPath = join(workspace, "contract.json");
    try {
      await writeFile(contractPath, JSON.stringify({
        contract: validContract,
        acceptanceCriteria: [{text: "Contradictory sibling", met: false}],
      }));
      const result = await runCommand(["work", "contract", "check", "--file", contractPath, "--json"]);

      expect(result.exitCode).not.toBe(0);
      const error = JSON.parse(result.stdout).error as {code?: string; api?: Record<string, any>};
      expect(error.code).toBe("work_contract_invalid");
      expect(error.api?.extra?.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({path: "contract", code: "contract_missing"}),
      ]));
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it.each([
    ["research", ["research", "run", "extract-people", "--source-dataset", "sources-1", "--dry-run", "--json"]],
    ["evidence", ["evidence", "extract", "--source-dataset", "sources-1", "--dry-run", "--json"]],
  ])("emits an explicit compatible contract for the %s producer", async (_surface, argv) => {
    const result = await runCommand(argv);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.workItem.contract).toMatchObject({version: 1, profile: "coding"});
    expect(output.workItem).not.toHaveProperty("acceptanceCriteria");
    expect(output.workItem.contract.boundary.writeScope.include.length).toBeGreaterThan(0);
  });
});

describe("sift work revision orientation", () => {
  const workId = "22222222-2222-4222-8222-222222222222";

  it("prints the current revision in human work get output", async () => {
    mockFetch()
      .on("GET", `/api/v1/work-items/${workId}`)
      .reply(200, {
        workItem: {
          id: workId,
          title: "Grounded work",
          status: "queued",
          revision: 7,
          dependencies: [],
          claimability: {state: "ready", blockedBy: []},
        },
      })
      .install();

    const result = await runCommand(["work", "get", workId, "--token", "sift_pat_test"]);

    expect(result.stdout).toContain("Revision: 7");
  });

  it("lists attributable revision receipts", async () => {
    mockFetch()
      .on("GET", `/api/v1/work-items/${workId}/revisions`)
      .query({limit: "10"})
      .reply(200, {
        revisions: [{
          previousRevision: 6,
          revision: 7,
          actorType: "human",
          actorUserId: "user-1",
          reason: "Clarify the contract",
          changedFields: ["title"],
          verificationInvalidated: true,
          createdAt: "2026-08-03T12:00:00.000Z",
        }],
      })
      .install();

    const result = await runCommand([
      "work", "revisions", workId,
      "--limit", "10",
      "--token", "sift_pat_test",
      "--json",
    ]);

    expect(JSON.parse(result.stdout).revisions[0]).toEqual(expect.objectContaining({
      revision: 7,
      actorType: "human",
      actorUserId: "user-1",
    }));
  });
});
