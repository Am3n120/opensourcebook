/** `agent_turns` and `agent_steps` (migrations/0010): chat turns answered by the person's own agent. */
import type { JsonValue } from "../types";
import { all, compact, first, fromJson, oneOf, opt, run, toJson, type RepositoryContext } from "./shared";

export const AGENT_TURN_STATES = ["running", "done", "failed", "stopped"] as const;
export type AgentTurnState = (typeof AGENT_TURN_STATES)[number];

export const AGENT_STEP_STATES = ["running", "done", "failed"] as const;
export type AgentStepState = (typeof AGENT_STEP_STATES)[number];

export interface AgentTurn {
  id: string;
  sessionId: string;
  messageId: string;
  ownerId: string;
  projectId: string;
  agent: string;
  tokenHash: string;
  state: AgentTurnState;
  request: JsonValue;
  /**
   * The model and effort the turn was sent to the connector with (migrations/0022), each absent when none was
   * sent; the agent is `agent`. Undefined for a turn begun before it was kept.
   */
  pick?: { model?: string; effort?: string };
  startedAt: string;
  finishedAt?: string;
}

export interface AgentStep {
  id: string;
  turnId: string;
  seq: number;
  tool: string;
  label: string;
  state: AgentStepState;
  result?: JsonValue;
  startedAt: string;
  endedAt?: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  message_id: string;
  owner_id: string;
  project_id: string;
  agent: string;
  token_hash: string;
  state: string;
  request_json: string;
  pick_json?: string | null;
  started_at: string;
  finished_at: string | null;
}

interface StepRow {
  id: string;
  turn_id: string;
  seq: number;
  tool: string;
  label: string;
  state: string;
  result_json: string | null;
  started_at: string;
  ended_at: string | null;
}

export class AgentTurnRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(input: Omit<AgentTurn, "id" | "state" | "startedAt" | "finishedAt">): Promise<AgentTurn> {
    const id = this.ctx.newId();
    await run(
      this.ctx.db,
      "INSERT INTO agent_turns (id, session_id, message_id, owner_id, project_id, agent, token_hash, state, request_json, pick_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)",
      id,
      input.sessionId,
      input.messageId,
      input.ownerId,
      input.projectId,
      input.agent,
      input.tokenHash,
      toJson(input.request),
      input.pick ? toJson(input.pick) : null,
      this.ctx.now(),
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<AgentTurn | undefined> {
    const row = await first<TurnRow>(this.ctx.db, "SELECT * FROM agent_turns WHERE id = ?", id);
    return row ? turnFromRow(row) : undefined;
  }

  async byMessage(messageId: string): Promise<AgentTurn | undefined> {
    const row = await first<TurnRow>(this.ctx.db, "SELECT * FROM agent_turns WHERE message_id = ?", messageId);
    return row ? turnFromRow(row) : undefined;
  }

  /** The chat's turns still running, oldest first. */
  async running(sessionId: string): Promise<AgentTurn[]> {
    return (await all<TurnRow>(this.ctx.db, "SELECT * FROM agent_turns WHERE session_id = ? AND state = 'running' ORDER BY started_at", sessionId)).map(turnFromRow);
  }

  /**
   * Ends a running turn, in one statement. Answers whether this caller ended
   * it: a turn already ended (stopped, timed out, finished) stays as it is.
   */
  async finish(id: string, state: Exclude<AgentTurnState, "running">): Promise<boolean> {
    const row = await first<{ id: string }>(
      this.ctx.db,
      "UPDATE agent_turns SET state = ?, finished_at = ? WHERE id = ? AND state = 'running' RETURNING id",
      state,
      this.ctx.now(),
      id,
    );
    return row !== undefined;
  }

  /** Records which agent the connector runs the turn with, once it says. */
  async setAgent(id: string, agent: string): Promise<void> {
    await run(this.ctx.db, "UPDATE agent_turns SET agent = ? WHERE id = ?", agent, id);
  }

  /** Keeps what the agent has written so far of a call still being written (migrations/0012); only while the turn runs. */
  async setDraft(id: string, draft: JsonValue): Promise<void> {
    await run(this.ctx.db, "UPDATE agent_turns SET draft_json = ? WHERE id = ? AND state = 'running'", toJson(draft), id);
  }

  async draft(id: string): Promise<JsonValue | undefined> {
    const row = await first<{ draft_json: string | null }>(this.ctx.db, "SELECT draft_json FROM agent_turns WHERE id = ?", id);
    return row?.draft_json ? fromJson<JsonValue>(row.draft_json, null) : undefined;
  }

  /** Adds a running step at the next position (a race on one position tries the next). */
  async addStep(turnId: string, step: { tool: string; label: string }): Promise<AgentStep> {
    for (let tries = 0; tries < 8; tries += 1) {
      const id = this.ctx.newId();
      try {
        const row = await this.ctx.db
          .prepare(
            "INSERT INTO agent_steps (id, turn_id, seq, tool, label, state, started_at) SELECT ?, ?, COALESCE(MAX(seq), -1) + 1, ?, ?, 'running', ? FROM agent_steps WHERE turn_id = ? RETURNING *",
          )
          .bind(id, turnId, step.tool, step.label, this.ctx.now(), turnId)
          .first<StepRow>();
        return stepFromRow(row!);
      } catch (error) {
        if (!/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    throw new Error(`Could not add a step to turn ${turnId}: positions kept colliding.`);
  }

  async endStep(id: string, state: Exclude<AgentStepState, "running">, result?: JsonValue): Promise<void> {
    await run(this.ctx.db, "UPDATE agent_steps SET state = ?, result_json = ?, ended_at = ? WHERE id = ?", state, result === undefined ? null : toJson(result), this.ctx.now(), id);
  }

  /** A turn's steps in order. */
  async steps(turnId: string): Promise<AgentStep[]> {
    return (await all<StepRow>(this.ctx.db, "SELECT * FROM agent_steps WHERE turn_id = ? ORDER BY seq", turnId)).map(stepFromRow);
  }
}

function turnFromRow(row: TurnRow): AgentTurn {
  return compact({
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    agent: row.agent,
    tokenHash: row.token_hash,
    state: oneOf(row.state, AGENT_TURN_STATES, "state"),
    request: fromJson<JsonValue>(row.request_json, null),
    pick: row.pick_json ? pickFrom(fromJson<JsonValue>(row.pick_json, null)) : undefined,
    startedAt: row.started_at,
    finishedAt: opt(row.finished_at),
  });
}

function pickFrom(value: JsonValue): { model?: string; effort?: string } {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...(typeof record.model === "string" && record.model ? { model: record.model } : {}),
    ...(typeof record.effort === "string" && record.effort ? { effort: record.effort } : {}),
  };
}

function stepFromRow(row: StepRow): AgentStep {
  return compact({
    id: row.id,
    turnId: row.turn_id,
    seq: row.seq,
    tool: row.tool,
    label: row.label,
    state: oneOf(row.state, AGENT_STEP_STATES, "state"),
    result: row.result_json === null ? undefined : fromJson<JsonValue>(row.result_json, null),
    startedAt: row.started_at,
    endedAt: opt(row.ended_at),
  });
}
