# What the commands answer with

With `--json`, stdout is one JSON object and nothing else. Progress goes to stderr.

- Success: `{ "ok": true, ... }`, the fields `opensourcebook <thing> <action> help` lists.
- A problem: `{ "ok": false, "error": { "code": "...", "message": "..." } }` and exit code 1. `message` is one plain sentence saying what is wrong and what to do; `code` is stable.

The exit code is 0 on success. A few successes carry a 1 as well, when the answer itself is bad news a script should notice: a source that could not be read, a reply that failed, a plan or an item that failed, a status with a program down.

## Error codes the command adds

| code | means |
| --- | --- |
| `not_running` | Open Sourcebook is not running here; `opensourcebook start --background` |
| `engine_unreachable` | Open Sourcebook's engine did not answer; `opensourcebook status` |
| `bad_arguments` | the command line is not right; the message says how |
| `unknown_command` | no such thing or action; `opensourcebook help` |
| `no_project` | no project named and none used before |
| `file_not_found` | a file named is not there |
| `not_made` | the item is not made yet (the message says its state) |
| `timeout` | a wait gave up; the work goes on inside Open Sourcebook |

Any other code is the engine's own, passed on as it is (`not_found`, `plan_invalid`, `project_archived`, ...).

## A reply (`opensourcebook chat ask`, `opensourcebook chat pick`, in `opensourcebook plan make` as `reply`)

```json
{
  "chatId": "…", "messageId": "…",
  "answer": "Text of the reply, each claim ending in its cite marks [1][2].",
  "cites": [{ "n": 1, "sourceId": "…", "source": "Title of the source", "quote": "the words it came from" }],
  "covered": true,
  "planIds": [],
  "questions": [{ "id": "q1", "text": "…", "multiple": false, "options": [{ "id": "o1", "label": "…" }] }],
  "failed": "agentSignedOut"
}
```

`covered` is false when the sources did not hold the answer, and left out when the reply makes no claim from them. `failed` is there only when the reply could not be written.

## A plan (`opensourcebook plan make` as `plans[]`, `opensourcebook plan show`, `start`, `wait`, `stop`)

```json
{
  "plan": { "id": "…", "title": "…", "status": "draft|approved|running|done|failed|cancelled|discarded" },
  "items": [ Item ],
  "counts": { "total": 3, "done": 1 },
  "issues": ["plain sentences on what stops it starting"]
}
```

## An item

```json
{
  "id": "…", "type": "video|flashcards|quiz|audio|guide", "title": "…", "level": 1,
  "prompt": "the brief the maker is given",
  "settings": { "questions": 5 },
  "enabled": true,
  "status": "pending|queued|running|done|failed|skipped|cancelled",
  "job": { "step": "what it is doing now, while it runs" },
  "errorMessage": "why it failed, when it did",
  "outputId": "…",
  "done": false,
  "result": { "score": 0.8 }
}
```

`status: "done"` means made. `done: true` is the person's own tick (set by `opensourcebook item done`, or by `opensourcebook quiz answer` with the quiz's result).

## What `opensourcebook item get` gives

`{ item, output: { id, type, title, summary? }, file?, payload? }`: `file` for a video (the path it was saved to), `payload` for a set of flashcards (its cards) or a quiz (its questions, with the answers and feedback).
