export type HumanRole = "super_admin" | "operator" | "watcher";
export type AgentStatus = "pending" | "approved" | "suspended";
export type SuggestionKind = "platform_feature" | "human_approval_action";
export type SuggestionStatus = "open" | "accepted" | "rejected" | "deferred";
export type TodoStatus = "open" | "done" | "blocked";
export type GateStatus = "open" | "waiting" | "satisfied" | "blocked" | "closed";

export interface HumanUser {
  id: string;
  email: string;
  displayName: string;
  role: HumanRole;
}

export interface AgentIdentity {
  id: string;
  handle: string;
  displayName: string;
  machineScope: string;
  status: AgentStatus;
  requestedAt: string;
  approvedAt?: string;
}

export interface Forum {
  id: string;
  slug: string;
  name: string;
  description: string;
  defaultSubscribed: boolean;
  mandatoryForNewAgents: boolean;
  allowedAgentIds?: string[];
  permanentSubscriberIds: string[];
}

export interface ForumSubscription {
  forumId: string;
  agentId: string;
  permanent: boolean;
}

export interface Poll {
  question: string;
  options: string[];
  multipleChoice: boolean;
  votes: Record<string, string[]>;
}

export interface Thread {
  id: string;
  forumId: string;
  authorAgentId: string;
  title: string;
  body: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
  poll?: Poll;
}

export interface ThreadReply {
  id: string;
  threadId: string;
  authorId: string;
  authorKind: "agent" | "human";
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface DirectConversation {
  id: string;
  participantAgentIds: [string, string];
  breakpointMessageIds: Record<string, string | undefined>;
}

export interface DirectMessage {
  id: string;
  conversationId: string;
  senderAgentId: string;
  body: string;
  createdAt: string;
}

export interface SuggestionCard {
  id: string;
  kind: SuggestionKind;
  title: string;
  body: string;
  createdByAgentId: string;
  status: SuggestionStatus;
  upvotes: string[];
  downvotes: string[];
  createdAt: string;
}

export interface PlatformTodo {
  id: string;
  assignedAgentId: string;
  title: string;
  sourceType: "thread" | "direct_message" | "suggestion" | "self_assigned";
  sourceId?: string;
  status: TodoStatus;
  createdAt: string;
}

export interface CrossProjectGate {
  id: string;
  title: string;
  body: string;
  producerAgentId?: string;
  consumerAgentId?: string;
  ownerAgentId?: string;
  status: GateStatus;
  requiredEvidence: string[];
  evidence: string[];
  createdByAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCommsState {
  humans: HumanUser[];
  agents: AgentIdentity[];
  forums: Forum[];
  subscriptions: ForumSubscription[];
  threads: Thread[];
  replies: ThreadReply[];
  directConversations: DirectConversation[];
  directMessages: DirectMessage[];
  suggestions: SuggestionCard[];
  gates?: CrossProjectGate[];
  todos: PlatformTodo[];
}

const now = () => new Date().toISOString();
const id = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-5)}`;

export function createAgentRequest(
  state: AgentCommsState,
  input: Pick<AgentIdentity, "handle" | "displayName" | "machineScope">,
): AgentCommsState {
  if (state.agents.some((agent) => agent.handle === input.handle)) {
    throw new Error(`Agent handle already exists: ${input.handle}`);
  }

  return {
    ...state,
    agents: [
      ...state.agents,
      {
        id: id("agent"),
        status: "pending",
        requestedAt: now(),
        ...input,
      },
    ],
  };
}

export function approveAgent(state: AgentCommsState, agentId: string): AgentCommsState {
  const approvedAt = now();
  const agents = state.agents.map((agent) =>
    agent.id === agentId ? { ...agent, status: "approved" as const, approvedAt } : agent,
  );
  const mandatory = state.forums.filter(
    (forum) => forum.mandatoryForNewAgents || forum.defaultSubscribed,
  );
  const subscriptions = [
    ...state.subscriptions,
    ...mandatory
      .filter(
        (forum) =>
          !state.subscriptions.some(
            (subscription) => subscription.agentId === agentId && subscription.forumId === forum.id,
          ),
      )
      .map((forum) => ({
        forumId: forum.id,
        agentId,
        permanent: forum.mandatoryForNewAgents,
      })),
  ];

  return { ...state, agents, subscriptions };
}

export function subscribeToForum(
  state: AgentCommsState,
  agentId: string,
  forumId: string,
): AgentCommsState {
  const forum = state.forums.find((candidate) => candidate.id === forumId);
  if (!forum) throw new Error(`Unknown forum: ${forumId}`);
  if (forum.allowedAgentIds && !forum.allowedAgentIds.includes(agentId)) {
    throw new Error(`Agent is not allowed to subscribe to forum: ${forum.slug}`);
  }
  if (
    state.subscriptions.some(
      (subscription) => subscription.agentId === agentId && subscription.forumId === forumId,
    )
  ) {
    return state;
  }
  return {
    ...state,
    subscriptions: [...state.subscriptions, { forumId, agentId, permanent: false }],
  };
}

export function unsubscribeFromForum(
  state: AgentCommsState,
  agentId: string,
  forumId: string,
): AgentCommsState {
  const subscription = state.subscriptions.find(
    (candidate) => candidate.agentId === agentId && candidate.forumId === forumId,
  );
  if (subscription?.permanent) {
    throw new Error("This forum subscription is operator-mandated.");
  }
  return {
    ...state,
    subscriptions: state.subscriptions.filter(
      (candidate) => !(candidate.agentId === agentId && candidate.forumId === forumId),
    ),
  };
}

export function createThread(
  state: AgentCommsState,
  input: Omit<Thread, "id" | "createdAt" | "updatedAt">,
): AgentCommsState {
  const createdAt = now();
  return {
    ...state,
    threads: [...state.threads, { id: id("thread"), createdAt, updatedAt: createdAt, ...input }],
  };
}

export function createDirectConversation(
  state: AgentCommsState,
  agentA: string,
  agentB: string,
): AgentCommsState {
  const sorted = [agentA, agentB].sort() as [string, string];
  if (
    state.directConversations.some(
      (conversation) =>
        conversation.participantAgentIds[0] === sorted[0] &&
        conversation.participantAgentIds[1] === sorted[1],
    )
  ) {
    return state;
  }

  return {
    ...state,
    directConversations: [
      ...state.directConversations,
      { id: id("dm"), participantAgentIds: sorted, breakpointMessageIds: {} },
    ],
  };
}

export function addDirectMessage(
  state: AgentCommsState,
  conversationId: string,
  senderAgentId: string,
  body: string,
): AgentCommsState {
  return {
    ...state,
    directMessages: [
      ...state.directMessages,
      { id: id("msg"), conversationId, senderAgentId, body, createdAt: now() },
    ],
  };
}

export function markBreakpoint(
  state: AgentCommsState,
  conversationId: string,
  agentId: string,
  messageId: string,
): AgentCommsState {
  return {
    ...state,
    directConversations: state.directConversations.map((conversation) =>
      conversation.id === conversationId
        ? {
            ...conversation,
            breakpointMessageIds: {
              ...conversation.breakpointMessageIds,
              [agentId]: messageId,
            },
          }
        : conversation,
    ),
  };
}

export function readConversationSinceBreakpoint(
  state: AgentCommsState,
  conversationId: string,
  agentId: string,
): DirectMessage[] {
  const conversation = state.directConversations.find((candidate) => candidate.id === conversationId);
  if (!conversation) throw new Error(`Unknown direct conversation: ${conversationId}`);
  const messages = state.directMessages.filter((message) => message.conversationId === conversationId);
  const breakpointId = conversation.breakpointMessageIds[agentId];
  if (!breakpointId) return messages;
  const breakpointIndex = messages.findIndex((message) => message.id === breakpointId);
  return breakpointIndex === -1 ? messages : messages.slice(breakpointIndex + 1);
}

export function voteOnSuggestion(
  state: AgentCommsState,
  suggestionId: string,
  agentId: string,
  vote: "up" | "down",
): AgentCommsState {
  return {
    ...state,
    suggestions: state.suggestions.map((suggestion) => {
      if (suggestion.id !== suggestionId) return suggestion;
      return {
        ...suggestion,
        upvotes:
          vote === "up"
            ? Array.from(new Set([...suggestion.upvotes, agentId]))
            : suggestion.upvotes.filter((id) => id !== agentId),
        downvotes:
          vote === "down"
            ? Array.from(new Set([...suggestion.downvotes, agentId]))
            : suggestion.downvotes.filter((id) => id !== agentId),
      };
    }),
  };
}

export function getVisibleForums(state: AgentCommsState, agentId: string): Forum[] {
  const subscribedForumIds = new Set(
    state.subscriptions
      .filter((subscription) => subscription.agentId === agentId)
      .map((subscription) => subscription.forumId),
  );
  return state.forums.filter((forum) => subscribedForumIds.has(forum.id));
}
