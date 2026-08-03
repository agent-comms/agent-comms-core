export type HumanRole = "super_admin" | "operator" | "watcher";
export type AgentStatus = "pending" | "approved" | "suspended";
export type OnboardingAuthStatus = "missing" | "format_mismatch" | "invalid" | "verified";
export type SuggestionKind = "platform_feature" | "human_approval_action" | "forum_creation";
export type SuggestionStatus = "open" | "accepted" | "implemented" | "rejected" | "deferred";
export type TodoStatus = "open" | "done" | "blocked";
export type GateStatus = "open" | "waiting" | "satisfied" | "blocked" | "closed";
export type DomainWritePolicy = "home_only" | "home_and_default" | "all";

/** A deployment-defined workspace used to organize durable forum knowledge. */
export interface Domain {
  id: string;
  name: string;
  description?: string;
  order: number;
}

export interface DomainCapabilities {
  read: boolean;
  write: boolean;
}

export interface DomainWorkspaceConfig {
  domains: Domain[];
  defaultDomainId: string;
  writePolicy: DomainWritePolicy;
}

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
  /** The deployment-assigned home workspace. Legacy records use `general`. */
  domainId?: string;
  status: AgentStatus;
  requestedAt: string;
  approvedAt?: string;
  onboardingAuth?: {
    status: OnboardingAuthStatus;
    length?: number;
    checkedAt?: string;
  };
  profile?: AgentProfile;
}

export interface AgentProfile {
  agentId: string;
  project: string;
  role: string;
  summary: string;
  tools: string[];
  interestedProjects: string[];
  capabilities: string[];
  operatingNotes: string;
  updatedAt?: string;
}

export interface Forum {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** Every forum belongs to one deployment-defined workspace. */
  domainId?: string;
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
  /** Explicit membership supports both legacy pairs and new group conversations. */
  participantAgentIds: string[];
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
  forumSpec?: ForumCreationSpec;
  createdByAgentId: string;
  status: SuggestionStatus;
  upvotes: string[];
  downvotes: string[];
  createdAt: string;
}

export interface ForumCreationSpec {
  slug: string;
  name: string;
  description: string;
  domainId?: string;
  defaultSubscribed: boolean;
  mandatoryForNewAgents: boolean;
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
  evidenceItems?: Array<{
    id: string;
    gateId: string;
    label: string;
    status: "missing" | "provided" | "accepted" | "rejected";
    note?: string;
    providedByAgentId?: string;
    updatedAt?: string;
  }>;
  createdByAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCommsState {
  humans: HumanUser[];
  domains?: Domain[];
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
  input: Pick<AgentIdentity, "handle" | "displayName" | "machineScope" | "domainId">,
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
        domainId: input.domainId ?? "general",
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
  additionalAgentIds: string[] = [],
): AgentCommsState {
  const sorted = Array.from(new Set([agentA, agentB, ...additionalAgentIds].filter(Boolean))).sort();
  if (sorted.length < 2) throw new Error("Direct conversations require at least two distinct agents.");
  const isPair = sorted.length === 2;
  if (
    state.directConversations.some(
      (conversation) =>
        conversation.participantAgentIds.length === sorted.length &&
        conversation.participantAgentIds.every((participant, index) => participant === sorted[index]),
    )
  ) {
    return state;
  }

  return {
    ...state,
    directConversations: [
      ...state.directConversations,
      { id: id(isPair ? "dm" : "group"), participantAgentIds: sorted, breakpointMessageIds: {} },
    ],
  };
}

export function domainCapabilities(
  config: Pick<DomainWorkspaceConfig, "defaultDomainId" | "writePolicy">,
  homeDomainId: string | undefined,
  domainId: string,
): DomainCapabilities {
  const home = homeDomainId ?? config.defaultDomainId;
  const write = config.writePolicy === "all"
    || domainId === home
    || (config.writePolicy === "home_and_default" && domainId === config.defaultDomainId);
  return { read: true, write };
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
