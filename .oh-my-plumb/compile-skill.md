---
name: oh-my-plumb-compile
description: Compile a repository's instruction files (AGENTS.md, CLAUDE.md and friends) into an oh-my-plumb rubric, then validate and calibrate it.
---

# Compile an oh-my-plumb rubric

You are turning the rules a person wrote for coding agents into a rubric that a checker outside your context window can enforce on every edit. The checker sees one rule and one diff, or one recorded tool call, at a time. Nothing else. Every decision below follows from that.

Two facts before you start:

- Rules come only from the user's own files. Never add a rule you think they should have. If a file holds zero rules, the rubric holds zero rules and you say so.
- The rubric is a committed, hand-editable file. A person will read it, and a verdict must trace to a rule they can point at. Quote their wording.

## Step 1. Read the sources

The hook that sent you here listed the instruction files it found and where the rubric goes. Read every listed file in full. Then:

- Follow pointer files. A file whose whole content is "Read instructions from X" or "Read ./AGENTS.md" is a pointer. Read X and treat X as a source in its own right: list it under `sources` with its own path so it gets its own hash.
- Files under a subdirectory apply only there. The hook gave each one a scope glob. Rules from that file carry that glob.
- A source listed as MCP server instructions is not a file: its text is quoted in the list the hook gave you. Its rules are about that server's tools, so they are tool-call rules (step 3, question 1) scoped to the glob the list names, such as `["mcp__postgres__*"]`. List the source with `"kind": "mcp"`, and leave `source.line` out of its rules: the text has no lines to point at.
- Read `CONTRIBUTING.md` only when it was listed, and keep only sentences that give an instruction. Prose about how to open a pull request is not a rule.
- If a lint config was listed (`eslint.config.*`, `.eslintrc*`, `biome.json`, stylelint config), skim it for rule names. When a rule you extract is already enforced there, keep the rule and record the lint rule name in `check.overlaps`. It stays in the rubric because lint runs later than an edit and the convention still binds; the label keeps it from being reported as a new finding.

## Step 2. Extract every statement that instructs

Go through each file top to bottom. A rule is any sentence that tells the agent to do or not do something about code. Headings, background, and rationale are not rules, but they often say what a rule is for and belong in the wording of its question.

For each rule capture:

- `text`: the user's own words, trimmed to one or two sentences. Do not paraphrase into something more general.
- `source.path` and `source.line`: where it came from. Line numbers matter; they are how the person finds it.
- Any code block next to it. A worked example or counterexample carries more signal than the prose, and belongs in the question's criteria (see step 4).

Do not merge two rules into one because they sit under one heading. Do not split a rule that is one idea.

## Step 3. Classify each rule into exactly one bucket

Ask the questions in this order and stop at the first yes.

1. Is the rule about how you call a tool: which command you run, with which arguments, rather than anything written in a file? Then `check.type` is `model`, `target` is `toolCall`, and `scope` holds tool names instead of file globs, for example `["Bash"]`. Tool names match without regard to case, so `Bash` also covers the `bash` that pi and OpenCode send; add any other name a host gives the same tool. The judge reads one recorded call: the tool's name plus the input it was called with. Worked examples: "Always prefix shell commands with `rtk`" is a tool-call rule scoped to `["Bash"]`, and "Use pnpm, not npm" is a tool-call rule scoped to `["Bash"]`. A rule about what a file contains ("no `npm install` in package.json scripts") is not this bucket; it keeps going down the list.
2. Can a linter enforce it exactly? Then `check.type` is `lint`. Examples: `interface Foo` when the rule says use `type`; `as` casts; `fetch(`; `process.env.`; `Date.now()`; `console.log`; `npm install`. Put the linter rule that enforces it in `how` (`@typescript-eslint/consistent-type-definitions`, `no-restricted-syntax`, a stylelint rule) or, failing that, the AST or grep shape, and a `pattern` as a hint when one is obvious. oh-my-plumb records these and reports them for the user's own linter; it never runs them and never sends them to the model. The judge is for what a linter cannot express.
3. Does the rule need counting or measuring: line lengths, line counts, selector counts, nesting depth, alphabetical or length order (imports or props ordered by line length is the common one)? That is mechanical work, and the judge cannot count. Do not turn it into a model question; it will score about 0.4 on everything. Write it as a `code` check instead (next section).
4. Can a judge answer it by looking at a change and nothing else? Then `check.type` is `model`. Most style, structure, comment, error handling, naming, and "do not do X" rules land here.
5. Does answering need the rest of the repository? "Reuse existing error codes", "follow existing patterns", "any visual pattern in two places becomes a shared component", "check whether a helper already exists". Then `check.type` is `deferred` with a one line `reason`. These are real rules that this version cannot check on a diff, and the report says so.
6. Is it about the conversation or the process rather than the code? "Ask when unsure", "state a plan", "run the tests before you finish", "clean up processes you started". Then `check.type` is `unenforceable` with a `reason`. These rules govern how a whole session is run, and no single diff or recorded call settles them. "Ask when unsure" is about the conversation itself, so there is nothing in front of the checker to score.

Every statement lands somewhere. Count them: the summary you give the user is the bucket counts `validate` prints, where tool-call rules count under "checked by Jev" with the other model rules.

### Writing a code check

A `code` check is a small predicate the hook runs itself: exact, free, and portable. (An executable guard script needs a shebang and an executable bit and only runs on macOS and Linux; a code check runs wherever the hook runs.) The `script` field is the body of a function the hook calls as `fn(path, contents)` — the edited file's repo-relative path and its new text, both strings. There is nothing else in reach: no imports, no filesystem, no network. String and array methods are enough.

- Return `{ "isError": true, "content": "..." }` to block. The content is what the agent reads, so make it an instruction: name the offending lines.
- Anything else — `undefined`, nothing, `{ "isError": false }` — passes the file.
- A thrown error, a 0.5 s overrun, or a returned shape you did not intend counts as a pass, never as a violation. Write the script so the clean path is the obvious one.
- Keep it under about 25 lines. Quote the rule in `check.text`, and put the file glob in `check.scope`: a code check never uses the rule-level `scope`.

```json
{
  "id": "max-line-length",
  "text": "Keep lines under 120 characters.",
  "source": { "path": "AGENTS.md", "line": 7 },
  "check": {
    "type": "code",
    "scope": "**/*.{ts,tsx}",
    "text": "Keep lines under 120 characters.",
    "script": "const long = contents.split(\"\\n\").map((line, i) => [line.length, i + 1]).filter(([n]) => n > 120);\nreturn long.length === 0 ? { isError: false } : { isError: true, content: `Lines over 120 chars: ${long.map(([, n]) => n).join(", ")}. Break them up.` };"
  }
}
```

If the rule needs information the file alone cannot give — the list of codes that already exist, a sibling module's shape — a script cannot have it either. That is the `deferred` bucket (question 5), not a code check.

## Step 4. Write the question for each model rule

The judge is a small, fast model that answers typed questions with a probability. It is good at narrow, concrete questions and bad at vague ones. A vague question scores about 0.4 on everything and never fires, and the user reads that silence as good news. Write every question so that a violating diff or call scores near 1 and a clean one scores near 0.

- One idea per question. If the rule has two parts, make two rules.
- Ask about the diff: "Does this change add ...", "Does this change put ...". Name the concrete shape you want caught: the identifier, the call, the syntax, the position. "Does this change add a comment that restates what the line below it does?" beats "Are comments sparing?".
- A rule with `target: "toolCall"` gets a question about the command and its arguments, never about the conversation or the agent's reasoning. "Does this command run without the `rtk` prefix?" is answerable from the recorded call; "Did you explain what you were about to run?" asks about a conversation the judge cannot see. The judge sees the tool's name and its input as JSON, and that is all.
- Never put scope in the text. "For a file under apps/web/src/server" belongs in the `scope` field, not in the question. Scope is a list of globs relative to the repo root for a diff rule, for example `["apps/web/src/server/**/*.service.ts"]`, or the tool names a tool-call rule applies to, for example `["Bash"]`. Omit it when a diff rule applies to every file. A tool-call rule always names its tools: without a scope it would be sent, and billed, for every call the agent makes.
- Keep instructions under about 60 words. Every word is billed on every edit whether or not the rule fires.
- Ask for existence, not for a judgment of the whole: "Among the added lines, is there at least one comment whose content a reader could reconstruct from the code directly below it?" fires on the first offending line, while "Are the comments appropriate?" averages over the hunk and never leaves the middle.
- A rule about volume or restraint ("comment sparingly", "keep it short", "minimal code") needs two questions: an existence question for the concrete offence, and a `score` question for the amount, with levels the judge can point at ("no such comments", "one or two", "several, or a multi-line block", "most lines"). Do not collapse "sparingly" into a single narrow case and lose the volume.
- A rule that requires a tool or skill ("use context7 for library docs", "use the brainstorming skill before building a feature") is answered from what the turn ran, not what it changed. Write it as a tool-call rule with `when: "turn"` and no scope; the judge gets the turn's tool-call log (`order`, `name`, `summary` in call order) and nothing else. A turn that called no tools has no log, and these rules do not run for it. In Claude Code a skill appears as a call named `Skill` whose summary names the skill. Ask only about what the log shows: a call's name, its position, the shape in its summary. Never ask about the agent's intent or the conversation; the judge cannot see them and such a question scores about 0.4 on everything. Say where the answer comes from ("Answer only from the turn's tool-call log"). These rules are easy to misjudge, so keep them in the flag band: only a clear miss under the user's absolute wording ("always", "never") should reach act.
- Use `criteria` for a worked example: `"criteria": { "true": "a `retry`loop written by hand when Radash`retry` is installed", "false": "calling an installed utility" }`. Put the user's own code block here when they gave one.
- Question types:
  - `boolean` for almost everything. The answer is a probability that the rule is broken.
  - `choice` when the rule names a closed set of shapes and only some are wrong: `criteria` maps each option to a description, `violating` lists the wrong ones. Example: a service must be a class with static methods, so options are `class-static`, `loose-functions`, `eager-init` and `violating` is the last two.
  - `score` when the rule is a matter of degree: `criteria` is an ordered list of levels from compliant (index 0) to worst, and `violatingFrom` is the first level that counts as broken. Example for "minimum code that solves the problem": levels "as short as it can be", "somewhat longer than needed", "about twice as long", "several times longer", with `violatingFrom: 2`.

### A rule about a tool call, not a change

Some rules judge what a call does rather than what a diff looks like: "never `DROP` or `TRUNCATE` through the postgres MCP", "read-only queries in production", "don't post to Slack without asking". For those set `"target": "toolCall"`, put tool names in `scope` instead of file globs, and use `"when": "edit"`: the judge sees the call before it runs, and stops it only in the act band. (A rule about which tools a whole turn used is the `"turn"` kind described above.)

```json
{
  "id": "no-drop-through-postgres",
  "text": "Never DROP or TRUNCATE a table through the postgres MCP.",
  "source": { "path": "AGENTS.md", "line": 42 },
  "target": "toolCall",
  "scope": ["mcp__postgres__*"],
  "when": "edit",
  "check": {
    "type": "model",
    "question": {
      "type": "boolean",
      "instructions": "Does this call's SQL text contain a DROP or TRUNCATE statement?",
      "criteria": {
        "true": "DROP TABLE users",
        "false": "SELECT id FROM users LIMIT 10"
      }
    }
  }
}
```

- Scope matches the tool's name, ignoring case: `["mcp__postgres__*"]` covers that one server's tools (`mcp__postgres__query`), and a server boundary is exact, so it does not cover `mcp__postgres-inspector__query`. `["Bash"]` covers the shell. OpenCode names MCP tools `<server>_<tool>` (`postgres_query`), so add that spelling when the repo uses OpenCode.
- Ask about the command and the arguments, never the output or the conversation. The judge sees only what the call is about to do: "Does this call's SQL text contain an INSERT, UPDATE, DELETE, DROP or TRUNCATE statement?" A question that needs the result or the chat to answer can only land midrange, and midrange never fires.
- Flag by default, act only for absolute wording. "Read-only queries in production" is absolute, so a question on the statement text may stop the call outright. "Don't post to Slack without asking" hinges on what happened outside the arguments, so write it to flag ("Do this call's arguments post a new message?") and let the note reach the person.

## Step 5. Decide when each model rule runs

Every model rule carries `when`: `"edit"` or `"turn"`. Get this right; the wrong phase produces false violations and each one costs the agent a repair turn.

- `"edit"` runs after every edit, against that one hunk. Use it when the lines in front of the judge are enough: raw error text reaching a user, a narrating comment, a hand rolled utility, a type cast, an if/else chain over a discriminated union, an inline style, a hardcoded color.
- `"turn"` runs once when the agent finishes its turn, against the full diff of everything it changed. Use it for any question about the change as a whole: scope creep, changes outside what was asked, an abstraction with a single caller, overall length, whether a file grew past a cap, whether a new module was needed at all, whether a helper should have been extracted. After edit 1 of 12 these questions have no answer; a helper with one caller now may have three by the end.

The test: if a careful reviewer would want to see the whole change before answering, it is `"turn"`.

Lint rules always run per edit and do not need `when`.

A tool-call rule carries `when` like any model rule. `"edit"` judges each call as it happens: the tool's name and its input, for rules about one command ("never run npm"). `"turn"` judges the whole turn's tool-call log once at the end: entries of `order`, `name` and `summary`, edits included, for rules about which tools a turn used and in what order ("look up docs with context7 before changing a dependency"). A turn rule sees the log, not the diff. Give it a scope only when it concerns calls to particular tools; a rule that requires a tool the turn may never have called has no scope.

## Step 6. Write the rubric file

Write the file the hook named (`.oh-my-plumb/rubric.json` for the project, `~/.oh-my-plumb/global.json` for global instruction files). Global files get their own rubric because they apply in every repository.

```json
{
  "version": 1,
  "compiledAt": "2026-09-17T10:00:00.000Z",
  "compiledBy": "claude",
  "sources": [
    { "path": "AGENTS.md", "scope": "**/*" },
    { "path": "apps/web/AGENTS.md", "scope": "apps/web/**/*" }
  ],
  "rules": [
    {
      "id": "no-interface",
      "text": "Use `type`, never `interface`.",
      "source": { "path": "AGENTS.md", "line": 41 },
      "scope": ["**/*.ts", "**/*.tsx"],
      "check": {
        "type": "lint",
        "pattern": "^\\s*(export\\s+)?(declare\\s+)?interface\\s+[A-Za-z_$]",
        "how": "@typescript-eslint/consistent-type-definitions"
      }
    },
    {
      "id": "raw-error-to-user",
      "text": "Never show a user a raw error. A message reaches a user only if the code that produced it authored it for a person.",
      "source": { "path": "AGENTS.md", "line": 120 },
      "scope": ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
      "when": "edit",
      "check": {
        "type": "model",
        "overlaps": "oh-my-plumb/no-raw-error-in-response",
        "question": {
          "type": "boolean",
          "instructions": "Does this change put raw exception text where a user will see it: error.message, String(error), .toString() or a template of them reaching a response body, rendered copy, or a stored column that is displayed?",
          "criteria": {
            "true": "res.status(500).json({ message: String(error) })",
            "false": "log.error(error); res.status(500).json({ message: 'Could not load this run.' })"
          }
        }
      }
    },
    {
      "id": "scope-creep",
      "text": "No features beyond what was asked. Every changed line should trace directly to the user's request.",
      "source": { "path": "AGENTS.md", "line": 22 },
      "when": "turn",
      "check": {
        "type": "model",
        "question": {
          "type": "boolean",
          "instructions": "Does this change add functionality, files, options or abstractions that the task did not ask for?"
        }
      }
    },
    {
      "id": "shell-rtk-prefix",
      "text": "Always prefix shell commands with `rtk`.",
      "source": { "path": "AGENTS.md", "line": 88 },
      "target": "toolCall",
      "scope": ["Bash"],
      "when": "edit",
      "check": {
        "type": "model",
        "question": {
          "type": "boolean",
          "instructions": "Does this command run without the `rtk` prefix?"
        }
      }
    },
    {
      "id": "ordered-imports",
      "text": "Imports are ordered by line length.",
      "source": { "path": "AGENTS.md", "line": 30 },
      "check": {
        "type": "code",
        "scope": "**/*.{ts,tsx}",
        "text": "Imports are ordered by line length.",
        "script": "const lens = contents.split(\"\\n\").filter((l) => /^import /.test(l)).map((l) => l.length);\nfor (let i = 1; i < lens.length; i++) if (lens[i] < lens[i - 1]) return { isError: true, content: \"Imports must be ordered by line length. Sort the import block.\" };\nreturn { isError: false };"
      }
    },
    {
      "id": "reuse-error-codes",
      "text": "Reuse existing codes; don't invent near-duplicates.",
      "source": { "path": "AGENTS.md", "line": 131 },
      "check": { "type": "deferred", "reason": "needs the list of codes that already exist" }
    },
    {
      "id": "ask-when-unsure",
      "text": "State your assumptions explicitly. If uncertain, ask.",
      "source": { "path": "AGENTS.md", "line": 12 },
      "check": { "type": "unenforceable", "reason": "about the conversation, not the code" }
    }
  ]
}
```

Rules of the file:

- `id` is a short kebab-case name that says what the rule catches. Ids must be unique within the file.
- `target` defaults to `diff`. Only a tool-call rule sets `target` to `toolCall`, and then `scope` names tools (`["Bash"]`) instead of file globs.
- Leave `sha` out of `sources`; the CLI computes it in the next step.
- Every rule's `source.path` must appear in `sources`.
- No `status` field on new rules; it defaults to `active`. Do not write `calibration`; the CLI does.
- Write it as plain JSON with your file-writing tool. Nothing else goes in the file.

## Step 7. Validate, then calibrate

Run, using the CLI invocation the hook gave you:

```
oh-my-plumb rubric validate            (add --global for ~/.oh-my-plumb/global.json)
oh-my-plumb calibrate                  (same flag)
```

`validate` parses the file, fills in the source hashes, and prints the bucket table. Fix every issue it prints and run it again until it is clean.

`calibrate` runs every model rule that targets a diff against about twenty real hunks from the repository's git history and marks rules whose scores never get near 0 or near 1 as `weak`, and rules that fire on most historic hunks as `noisy`. Both are switched off until rewritten. When it reports any, rewrite those questions once using step 4 (make them more concrete, split them, add a criteria example, or move them to the other phase), run `validate` and `calibrate` again, and stop there whatever the result. Do not loop more than once. A repository with no history skips calibration; that is fine. Calibration works from hunks, so it skips `toolCall` rules. They stay active, and `oh-my-plumb check --tool-call <file>` judges a recorded call against them.

If the hook said a rule is being tuned, it attached statistics. Rewrite only the rules it named. Keep every other rule byte for byte.

## Step 8. Report and move on

Tell the user, in two or three plain sentences: how many rules, split across the buckets `validate` printed; which rules are weak or noisy and switched off, if any; and that the rubric is at `.oh-my-plumb/rubric.json` for them to read and edit. Then continue with whatever they asked for. Do not paste the rubric into the conversation.
