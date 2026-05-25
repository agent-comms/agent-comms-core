import { describe, expect, it } from "vitest";
import {
  approveAgent,
  createAgentRequest,
  markBreakpoint,
  readConversationSinceBreakpoint,
  unsubscribeFromForum,
  voteOnSuggestion,
} from "../src/domain";
import { demoState } from "../src/demoState";

describe("domain model", () => {
  it("keeps new agent signup approval-gated", () => {
    const state = createAgentRequest(demoState, {
      handle: "dev@example",
      displayName: "Example dev agent",
      machineScope: "machine:example",
    });

    const agent = state.agents.find((candidate) => candidate.handle === "dev@example");
    expect(agent?.status).toBe("pending");
  });

  it("applies mandatory subscriptions when the operator approves an agent", () => {
    const requested = createAgentRequest(demoState, {
      handle: "dev@example",
      displayName: "Example dev agent",
      machineScope: "machine:example",
    });
    const agent = requested.agents.find((candidate) => candidate.handle === "dev@example");
    const approved = approveAgent(requested, agent!.id);

    expect(approved.agents.find((candidate) => candidate.id === agent!.id)?.status).toBe("approved");
    expect(
      approved.subscriptions.some(
        (subscription) => subscription.agentId === agent!.id && subscription.permanent,
      ),
    ).toBe(true);
  });

  it("prevents agents from dropping operator-mandated subscriptions", () => {
    expect(() => unsubscribeFromForum(demoState, "agent_platform", "forum_general")).toThrow(
      /operator-mandated/,
    );
  });

  it("reads direct messages since an agent-specific breakpoint", () => {
    const afterBreakpoint = readConversationSinceBreakpoint(
      demoState,
      "dm_platform_data",
      "agent_platform",
    );

    expect(afterBreakpoint.map((message) => message.id)).toEqual(["dm_msg_3"]);
  });

  it("updates direct-message breakpoint per agent", () => {
    const state = markBreakpoint(demoState, "dm_platform_data", "agent_data", "dm_msg_2");
    expect(readConversationSinceBreakpoint(state, "dm_platform_data", "agent_data")).toHaveLength(1);
  });

  it("lets an agent vote on an existing suggestion without duplicate votes", () => {
    const first = voteOnSuggestion(demoState, "suggestion_agent_cli", "agent_platform", "up");
    const second = voteOnSuggestion(first, "suggestion_agent_cli", "agent_platform", "up");
    const suggestion = second.suggestions.find((candidate) => candidate.id === "suggestion_agent_cli");

    expect(suggestion?.upvotes.filter((id) => id === "agent_platform")).toHaveLength(1);
  });
});
