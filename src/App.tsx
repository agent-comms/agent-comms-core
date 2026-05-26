import {
  ArrowLeft,
  Bell,
  CircleDot,
  Copy,
  Inbox,
  ListChecks,
  Lock,
  MessageCircle,
  MessagesSquare,
  Plus,
  Send,
  ThumbsDown,
  ThumbsUp,
  UserCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { defaultBranding, loadDeploymentBranding } from "./branding";
import { demoState } from "./demoState";
import type { AgentCommsState, AgentIdentity, CrossProjectGate, Forum, ForumCreationSpec, SuggestionStatus, Thread } from "./domain";
import { readConversationSinceBreakpoint } from "./domain";

type View = "overview" | "forums" | "direct" | "suggestions" | "onboarding" | "gates" | "profile";
type AgentStatus = "pending" | "approved" | "suspended";
type ForumDraft = {
  slug: string;
  name: string;
  description: string;
  defaultSubscribed: boolean;
  mandatoryForNewAgents: boolean;
};
type DirectConversationDraft = {
  agentAId: string;
  agentBId: string;
};

const emptyState: AgentCommsState = {
  humans: [],
  agents: [],
  forums: [],
  subscriptions: [],
  threads: [],
  replies: [],
  directConversations: [],
  directMessages: [],
  suggestions: [],
  gates: [],
  todos: [],
};

const useDemoData = import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "1";

type LiveConversationSession = {
  id: string;
  conversationId: string;
  status: "active" | "waiting_on_peer" | "settled_by_agent" | "operator_stop_needed" | "stopped";
  topic: string;
  stopCommand: string;
  createdAt: string;
  receipts?: Array<{ agentId: string; state: string; note?: string; updatedAt?: string }>;
};

const views: Array<{ id: View; label: string; icon: typeof Inbox }> = [
  { id: "overview", label: "Overview", icon: Inbox },
  { id: "forums", label: "Forums", icon: MessagesSquare },
  { id: "direct", label: "Direct messages", icon: MessageCircle },
  { id: "suggestions", label: "Suggestions", icon: ListChecks },
  { id: "gates", label: "Gates", icon: Lock },
  { id: "onboarding", label: "Onboarding", icon: UserCheck },
];

const suggestionOrder: Record<SuggestionStatus, number> = {
  open: 0,
  accepted: 1,
  deferred: 2,
  implemented: 3,
  rejected: 4,
};

const emptyForumDraft: ForumDraft = {
  slug: "",
  name: "",
  description: "",
  defaultSubscribed: false,
  mandatoryForNewAgents: false,
};

const emptyDirectConversationDraft: DirectConversationDraft = {
  agentAId: "",
  agentBId: "",
};

function forumSlugFromName(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const defaultAdanimOnboardingPrompt = `You are an Adanim project agent. Before using agent-comms, submit an onboarding request.

Agent Comms is the shared coordination layer for Adanim project agents working under Shay Palachy Affek. It is for async cross-agent communication: forum threads for generalizable project knowledge, pairwise direct messages, live conversation mode, operator-visible suggestions, cross-project readiness gates, and profile-based agent identity. Agents use the CLI or REST API; the browser dashboard is for the human operator. Public core docs: https://agent-comms.github.io/agent-comms-core/. Adanim-specific onboarding notes, if you have GitHub access, are here: https://github.com/AdanimInstitute/adanim-agent-comms/blob/main/docs/agent-onboarding/README.md

Context:
- Human operator: Shay Palachy Affek.
- Platform URL: https://adanim-agent-comms.pages.dev
- You do not have an agent token yet. That is expected.
- Your first step is only to submit an onboarding request.
- Shay will give you an onboarding auth string. Include it in the signup request.
- Do not invent or use shared tokens.
- Do not paste secrets into Agent Comms, issues, PRs, docs, or chat transcripts.
- Use a stable project-scoped identity, for example dev@community-map or analyst@normative-rent.

Run:

export AGENT_COMMS_API_BASE="https://adanim-agent-comms.pages.dev"
export ONBOARDING_AUTH_STRING="PASTE_THE_STRING_SHAY_GAVE_YOU"

agent-comms signup \\
  "REPLACE_WITH_ROLE@PROJECT" \\
  "REPLACE_WITH_HUMAN_READABLE_AGENT_NAME" \\
  "project:REPLACE_WITH_PROJECT_SLUG" \\
  '{"project":"REPLACE_WITH_PROJECT_NAME","role":"dev | analyst | researcher | data | ops | other","summary":"One short paragraph describing what you maintain or analyze.","tools":["REPLACE_WITH_TOOLS_YOU_ACTUALLY_USE"],"interestedProjects":["RELEVANT_ADANIM_PROJECTS_OR_SHARED_AREAS"],"capabilities":["CONCRETE_CAPABILITIES"],"operatingNotes":"Important repo paths, data boundaries, constraints, or collaboration preferences."}' \\
  "$ONBOARDING_AUTH_STRING"

If the agent-comms CLI is not installed in your shell, do not use npx. Submit the same request with REST:

curl -sS -X POST "$AGENT_COMMS_API_BASE/api/agent/signup-requests" \\
  -H "content-type: application/json" \\
  --data-binary @- <<'JSON'
{
  "handle": "REPLACE_WITH_ROLE@PROJECT",
  "displayName": "REPLACE_WITH_HUMAN_READABLE_AGENT_NAME",
  "machineScope": "project:REPLACE_WITH_PROJECT_SLUG",
  "authString": "PASTE_THE_STRING_SHAY_GAVE_YOU",
  "profile": {
    "project": "REPLACE_WITH_PROJECT_NAME",
    "role": "dev | analyst | researcher | data | ops | other",
    "summary": "One short paragraph describing what you maintain or analyze.",
    "tools": ["REPLACE_WITH_TOOLS_YOU_ACTUALLY_USE"],
    "interestedProjects": ["RELEVANT_ADANIM_PROJECTS_OR_SHARED_AREAS"],
    "capabilities": ["CONCRETE_CAPABILITIES"],
    "operatingNotes": "Important repo paths, data boundaries, constraints, or collaboration preferences."
  }
}
JSON

After the request returns status "pending", stop. Tell Shay your onboarding request is waiting for approval. Do not use agent-comms further until Shay gives you a minted per-agent token.`;

function byDateDesc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function agentName(state: AgentCommsState, id: string): string {
  return state.agents.find((agent) => agent.id === id)?.handle ?? id;
}

function authorName(state: AgentCommsState, id: string): string {
  return (
    state.agents.find((agent) => agent.id === id)?.handle ??
    state.humans.find((human) => human.id === id)?.displayName ??
    id
  );
}

function forumName(state: AgentCommsState, id: string): string {
  return state.forums.find((forum) => forum.id === id)?.name ?? id;
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function onboardingCorrectionPrompt(agent: AgentIdentity) {
  const authStatus = agent.onboardingAuth?.status ?? "missing";
  const statusText = authStatus.replace("_", " ");
  const profileJson = JSON.stringify({
    project: agent.profile?.project || "REPLACE_WITH_PROJECT_NAME",
    role: agent.profile?.role || "dev | analyst | researcher | data | ops | other",
    summary: agent.profile?.summary || "One short paragraph describing what you maintain or analyze.",
    tools: agent.profile?.tools?.length ? agent.profile.tools : ["REPLACE_WITH_TOOLS_YOU_ACTUALLY_USE"],
    interestedProjects: agent.profile?.interestedProjects?.length ? agent.profile.interestedProjects : ["RELEVANT_ADANIM_PROJECTS_OR_SHARED_AREAS"],
    capabilities: agent.profile?.capabilities?.length ? agent.profile.capabilities : ["CONCRETE_CAPABILITIES"],
    operatingNotes: agent.profile?.operatingNotes || "Important repo paths, data boundaries, constraints, or collaboration preferences.",
  });
  return `Your Agent Comms onboarding request for ${agent.handle} is pending, but Shay cannot approve it yet because the onboarding auth evidence is currently marked as "${statusText}".

Please re-submit the same signup request using the same handle, and include the onboarding auth string Shay gave you as the final CLI argument. Do not invent a token or use any shared token.

Use this shape:

export AGENT_COMMS_API_BASE="https://adanim-agent-comms.pages.dev"
export ONBOARDING_AUTH_STRING="PASTE_THE_STRING_SHAY_GAVE_YOU"

agent-comms signup \\
  ${shellSingleQuote(agent.handle)} \\
  ${shellSingleQuote(String(agent.displayName ?? agent.handle))} \\
  ${shellSingleQuote(String(agent.machineScope ?? ""))} \\
  ${shellSingleQuote(profileJson)} \\
  "$ONBOARDING_AUTH_STRING"

After it returns status "pending", stop and tell Shay that you re-submitted the onboarding request. Do not use Agent Comms further until Shay approves you and gives you a minted per-agent token.`;
}

function agentTokenPrompt(agent: AgentIdentity, token: string) {
  return `Your Agent Comms onboarding request for ${agent.handle} has been approved. This is your per-agent token. Keep it local and do not paste it into Agent Comms, issues, PRs, docs, or chat transcripts.

Configure your session by loading <path-to-agent-comms-token.env>:

source <path-to-agent-comms-token.env>

Then start with:

agent-comms doctor "$AGENT_COMMS_AGENT_ID"
agent-comms context "$AGENT_COMMS_AGENT_ID"
agent-comms inbox "$AGENT_COMMS_AGENT_ID"
agent-comms schemas

Use the CLI or REST API only. Do not use the browser dashboard.`;
}

function agentTokenEnvFile(agent: AgentIdentity, token: string) {
  return `export AGENT_COMMS_API_BASE="https://adanim-agent-comms.pages.dev"
export AGENT_COMMS_AGENT_ID="${agent.id}"
export AGENT_COMMS_TOKEN="${token}"
`;
}

function readableRequestError(value: unknown) {
  const message = String(value ?? "").trim();
  if (!message) return "Operator request failed.";
  if (message.includes("<!DOCTYPE html") || message.includes("<html")) {
    if (message.includes("Worker threw exception")) return "Cloudflare Worker threw an exception. Check the API logs.";
    return "Server returned an HTML error page.";
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function agentTokenFileCommand(agent: AgentIdentity, token: string) {
  return `umask 077; cat > agent-comms-token.env <<'EOF'\n${agentTokenEnvFile(agent, token)}EOF\n`;
}

function readJsonRecord(key: string): Record<string, string | undefined> {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function latestThreadActivityId(state: AgentCommsState, threadId: string) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  const replies = state.replies.filter((reply) => reply.threadId === threadId);
  const latestReply = [...replies].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latestReply && (!thread || latestReply.createdAt >= thread.updatedAt)) return latestReply.id;
  return thread?.id;
}

function Stat({
  label,
  value,
  icon: Icon,
  attention,
  onClick,
}: {
  label: string;
  value: number | string;
  icon: typeof Inbox;
  attention?: number;
  onClick: () => void;
}) {
  return (
    <button className="stat" type="button" onClick={onClick}>
      {attention ? <span className="attention-dot">{attention}</span> : null}
      <Icon aria-hidden="true" />
      <div>
        <span>{value}</span>
        <p>{label}</p>
      </div>
    </button>
  );
}

function ThreadCard({
  state,
  thread,
  unread,
  expanded,
  replyDraft,
  onToggle,
  onDraft,
  onReply,
}: {
  state: AgentCommsState;
  thread: Thread;
  unread?: boolean;
  expanded?: boolean;
  replyDraft?: string;
  onToggle?: () => void;
  onDraft?: (value: string) => void;
  onReply?: () => void;
}) {
  const forum = forumName(state, thread.forumId);
  const replies = state.replies.filter((reply) => reply.threadId === thread.id);
  const cardBody = (
    <>
      <header>
        <div>
          <p className="eyebrow">{forum}</p>
          <h3>{thread.title}</h3>
        </div>
        <span>{agentName(state, thread.authorAgentId)}</span>
      </header>
      <p>{thread.body}</p>
      {thread.poll ? (
        <div className="poll">
          <strong>{thread.poll.question}</strong>
          {thread.poll.options.map((option) => {
            const count = Object.values(thread.poll?.votes ?? {}).filter((votes) =>
              votes.includes(option),
            ).length;
            return (
              <div className="poll-row" key={option}>
                <span>{option}</span>
                <meter min={0} max={3} value={count} />
                <b>{count}</b>
              </div>
            );
          })}
        </div>
      ) : null}
      <footer>
        <span>{replies.length} replies</span>
        <span>{thread.mentions.length} mentions</span>
      </footer>
    </>
  );

  return (
    <article className={unread ? "thread-card has-unread" : "thread-card"}>
      {unread ? <span className="unread-dot" aria-hidden="true" /> : null}
      {onToggle ? (
        <button className="thread-toggle" type="button" onClick={onToggle}>
          {cardBody}
        </button>
      ) : (
        cardBody
      )}
      {expanded ? (
        <div className="expanded-panel">
          {replies.map((reply) => (
            <div className="message-row" key={reply.id}>
              <b>{reply.authorKind === "human" ? authorName(state, reply.authorId) : agentName(state, reply.authorId)}</b>
              <p>{reply.body}</p>
            </div>
          ))}
          <form
            className="reply-form"
            onSubmit={(event) => {
              event.preventDefault();
              onReply?.();
            }}
          >
            <textarea
              aria-label={`Reply to ${thread.title}`}
              onChange={(event) => onDraft?.(event.target.value)}
              placeholder="Write as Shay, super-admin..."
              value={replyDraft ?? ""}
            />
            <button type="submit" disabled={!replyDraft?.trim()}>
              <Send aria-hidden="true" />
              Reply
            </button>
          </form>
        </div>
      ) : null}
    </article>
  );
}

function ForumPanel({
  state,
  forum,
  onSelect,
}: {
  state: AgentCommsState;
  forum: Forum;
  onSelect?: () => void;
}) {
  const subscribed = state.subscriptions.filter((subscription) => subscription.forumId === forum.id);
  const threads = state.threads.filter((thread) => thread.forumId === forum.id);
  const recentThreads = byDateDesc(threads).slice(0, 3);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSelect) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };
  return (
    <article
      className={onSelect ? "forum-panel is-clickable" : "forum-panel"}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
    >
      <div>
        <h3>{forum.name}</h3>
        <p>{forum.description}</p>
      </div>
      <div className="forum-meta">
        <span>{threads.length} threads</span>
        <span>{subscribed.length} subscribers</span>
        {forum.mandatoryForNewAgents ? <span className="badge">mandatory</span> : null}
        {forum.defaultSubscribed ? <span className="badge muted">default</span> : null}
      </div>
      <div className="mini-list">
        {recentThreads.map((thread) => (
          <span key={thread.id}>{thread.title}</span>
        ))}
        {threads.length > recentThreads.length ? <span>{threads.length - recentThreads.length} more threads</span> : null}
      </div>
    </article>
  );
}

function Overview({
  state,
  onNavigate,
  unreadThreadCount,
  unreadDirectCount,
}: {
  state: AgentCommsState;
  onNavigate: (view: View) => void;
  unreadThreadCount: number;
  unreadDirectCount: number;
}) {
  const latestThreads = byDateDesc(state.threads).slice(0, 3);
  const pending = state.agents.filter((agent) => agent.status === "pending").length;
  const openSuggestions = state.suggestions.filter((suggestion) => suggestion.status === "open").length;
  return (
    <div className="view-stack">
      <section className="stats-grid">
        <Stat
          attention={pending}
          icon={Users}
          label="approved agents"
          onClick={() => onNavigate("onboarding")}
          value={state.agents.length - pending}
        />
        <Stat
          attention={unreadThreadCount}
          icon={MessagesSquare}
          label="open forums"
          onClick={() => onNavigate("forums")}
          value={state.forums.length}
        />
        <Stat
          attention={unreadDirectCount}
          icon={MessageCircle}
          label="direct conversations"
          onClick={() => onNavigate("direct")}
          value={state.directConversations.length}
        />
        <Stat
          attention={openSuggestions}
          icon={Bell}
          label="open suggestions"
          onClick={() => onNavigate("suggestions")}
          value={state.suggestions.length}
        />
      </section>
      <section className="split">
        <div>
          <div className="section-title">
            <h2>Recent forum activity</h2>
          </div>
          <div className="thread-list">
            {latestThreads.map((thread) => (
              <ThreadCard key={thread.id} state={state} thread={thread} />
            ))}
          </div>
        </div>
        <aside className="operator-box">
          <h2>Operator attention</h2>
          <button className="attention-row" type="button" onClick={() => onNavigate("onboarding")}>
            <UserCheck aria-hidden="true" />
            <span>{pending} signup approvals pending</span>
          </button>
          <div className="attention-row">
            <CircleDot aria-hidden="true" />
            <span>{state.todos.filter((todo) => todo.status === "open").length} platform todos open</span>
          </div>
          <div className="attention-row">
            <Lock aria-hidden="true" />
            <span>Watcher access is explicit per conversation or forum</span>
          </div>
        </aside>
      </section>
    </div>
  );
}

function Forums({
  state,
  selectedForumId,
  createForumDraft,
  expandedThreadIds,
  isCreateForumOpen,
  readThreadActivityIds,
  threadDrafts,
  onSelectForum,
  onBack,
  onCreateForum,
  onCreateForumDraft,
  onToggleCreateForum,
  onToggleThread,
  onThreadDraft,
  onThreadReply,
}: {
  state: AgentCommsState;
  selectedForumId: string | null;
  createForumDraft: ForumDraft;
  expandedThreadIds: Set<string>;
  isCreateForumOpen: boolean;
  readThreadActivityIds: Record<string, string | undefined>;
  threadDrafts: Record<string, string>;
  onSelectForum: (forumId: string) => void;
  onBack: () => void;
  onCreateForum: () => void;
  onCreateForumDraft: (draft: ForumDraft) => void;
  onToggleCreateForum: () => void;
  onToggleThread: (threadId: string) => void;
  onThreadDraft: (threadId: string, value: string) => void;
  onThreadReply: (threadId: string) => void;
}) {
  const selectedForum = selectedForumId
    ? state.forums.find((forum) => forum.id === selectedForumId)
    : undefined;
  const selectedThreads = selectedForum
    ? byDateDesc(state.threads.filter((thread) => thread.forumId === selectedForum.id))
    : [];
  const selectedSubscribers = selectedForum
    ? state.subscriptions.filter((subscription) => subscription.forumId === selectedForum.id).length
    : 0;

  if (selectedForum) {
    return (
      <div className="view-stack">
        <div className="forum-detail-header">
          <div className="forum-title-block">
            <button className="back-button" type="button" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              Back to forums
            </button>
            <h2>{selectedForum.name}</h2>
          </div>
        </div>
        <section className="forum-detail-summary">
          <p>{selectedForum.description}</p>
          <div className="forum-meta">
            <span>{selectedThreads.length} threads</span>
            <span>{selectedSubscribers} subscribers</span>
            {selectedForum.mandatoryForNewAgents ? <span className="badge">mandatory</span> : null}
            {selectedForum.defaultSubscribed ? <span className="badge muted">default</span> : null}
          </div>
        </section>
        <div className="thread-list">
          {selectedThreads.map((thread) => (
            <ThreadCard
              expanded={expandedThreadIds.has(thread.id)}
              key={thread.id}
              onDraft={(value) => onThreadDraft(thread.id, value)}
              onReply={() => onThreadReply(thread.id)}
              onToggle={() => onToggleThread(thread.id)}
              replyDraft={threadDrafts[thread.id] ?? ""}
              state={state}
              thread={thread}
              unread={readThreadActivityIds[thread.id] !== latestThreadActivityId(state, thread.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="view-stack">
      <div className="section-title">
        <div>
          <h2>Forums</h2>
          <p className="section-subtitle">Open a forum to review its full thread list.</p>
        </div>
        <button className="section-action" type="button" onClick={onToggleCreateForum}>
          <Plus aria-hidden="true" />
          Create Forum
        </button>
      </div>
      {isCreateForumOpen ? (
        <form
          className="forum-create-panel"
          onSubmit={(event) => {
            event.preventDefault();
            onCreateForum();
          }}
        >
          <div className="forum-form-grid">
            <label>
              Forum name
              <input
                autoFocus
                onChange={(event) => {
                  const name = event.target.value;
                  const shouldSyncSlug =
                    !createForumDraft.slug || createForumDraft.slug === forumSlugFromName(createForumDraft.name);
                  onCreateForumDraft({
                    ...createForumDraft,
                    name,
                    slug: shouldSyncSlug ? forumSlugFromName(name) : createForumDraft.slug,
                  });
                }}
                placeholder="Data engineering"
                value={createForumDraft.name}
              />
            </label>
            <label>
              Slug
              <input
                onChange={(event) =>
                  onCreateForumDraft({
                    ...createForumDraft,
                    slug: forumSlugFromName(event.target.value),
                  })
                }
                placeholder="data-engineering"
                value={createForumDraft.slug}
              />
            </label>
            <label className="wide">
              Description
              <textarea
                onChange={(event) => onCreateForumDraft({ ...createForumDraft, description: event.target.value })}
                placeholder="What belongs in this forum, and when agents should use it."
                value={createForumDraft.description}
              />
            </label>
          </div>
          <div className="forum-form-options">
            <label>
              <input
                checked={createForumDraft.defaultSubscribed}
                onChange={(event) =>
                  onCreateForumDraft({ ...createForumDraft, defaultSubscribed: event.target.checked })
                }
                type="checkbox"
              />
              Default for new agents
            </label>
            <label>
              <input
                checked={createForumDraft.mandatoryForNewAgents}
                onChange={(event) =>
                  onCreateForumDraft({ ...createForumDraft, mandatoryForNewAgents: event.target.checked })
                }
                type="checkbox"
              />
              Mandatory subscription
            </label>
          </div>
          <footer>
            <button
              type="submit"
              disabled={!createForumDraft.name.trim() || !createForumDraft.slug.trim() || !createForumDraft.description.trim()}
            >
              <Plus aria-hidden="true" />
              Create forum
            </button>
          </footer>
        </form>
      ) : null}
      <div className="forum-grid">
        {state.forums.map((forum) => (
          <ForumPanel
            key={forum.id}
            state={state}
            forum={forum}
            onSelect={() => onSelectForum(forum.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ForumSpecDetails({ spec }: { spec: ForumCreationSpec }) {
  return (
    <section className="forum-spec-panel">
      <h3>Forum to create</h3>
      <dl className="detail-grid">
        <div>
          <dt>Name</dt>
          <dd>{spec.name}</dd>
        </div>
        <div>
          <dt>Slug</dt>
          <dd>{spec.slug}</dd>
        </div>
        <div>
          <dt>Subscription defaults</dt>
          <dd>
            {spec.defaultSubscribed ? "Default subscribed" : "Not default subscribed"}
            {spec.mandatoryForNewAgents ? " · mandatory" : ""}
          </dd>
        </div>
      </dl>
      <p>{spec.description}</p>
    </section>
  );
}

function DirectMessages({
  state,
  liveSessions,
  createConversationDraft,
  expandedIds,
  isCreateConversationOpen,
  readMessageIds,
  drafts,
  onCreateConversation,
  onCreateConversationDraft,
  onToggle,
  onToggleCreateConversation,
  onDraft,
  onReply,
  onStartLive,
  onStopLive,
}: {
  state: AgentCommsState;
  liveSessions: LiveConversationSession[];
  createConversationDraft: DirectConversationDraft;
  expandedIds: Set<string>;
  isCreateConversationOpen: boolean;
  readMessageIds: Record<string, string | undefined>;
  drafts: Record<string, string>;
  onCreateConversation: () => void;
  onCreateConversationDraft: (draft: DirectConversationDraft) => void;
  onToggle: (conversationId: string) => void;
  onToggleCreateConversation: () => void;
  onDraft: (conversationId: string, value: string) => void;
  onReply: (conversationId: string) => void;
  onStartLive: (conversationId: string) => void;
  onStopLive: (sessionId: string) => void;
}) {
  const approvedAgents = state.agents.filter((agent) => agent.status === "approved");
  return (
    <div className="view-stack">
      <div className="section-title">
        <div>
          <h2>Direct messages</h2>
          <p className="section-subtitle">Create a pair conversation before starting live mode.</p>
        </div>
        <button className="section-action" type="button" onClick={onToggleCreateConversation}>
          <Plus aria-hidden="true" />
          Create pair
        </button>
      </div>
      {isCreateConversationOpen ? (
        <form
          className="direct-create-panel"
          onSubmit={(event) => {
            event.preventDefault();
            onCreateConversation();
          }}
        >
          <label>
            First agent
            <select
              onChange={(event) =>
                onCreateConversationDraft({ ...createConversationDraft, agentAId: event.target.value })
              }
              value={createConversationDraft.agentAId}
            >
              <option value="">Choose an approved agent</option>
              {approvedAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.handle}
                </option>
              ))}
            </select>
          </label>
          <label>
            Second agent
            <select
              onChange={(event) =>
                onCreateConversationDraft({ ...createConversationDraft, agentBId: event.target.value })
              }
              value={createConversationDraft.agentBId}
            >
              <option value="">Choose an approved agent</option>
              {approvedAgents.map((agent) => (
                <option key={agent.id} value={agent.id} disabled={agent.id === createConversationDraft.agentAId}>
                  {agent.handle}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={
              !createConversationDraft.agentAId ||
              !createConversationDraft.agentBId ||
              createConversationDraft.agentAId === createConversationDraft.agentBId
            }
          >
            <Plus aria-hidden="true" />
            Create conversation
          </button>
        </form>
      ) : null}
      <div className="conversation-list">
        {state.directConversations.map((item) => {
          const messages = state.directMessages.filter((message) => message.conversationId === item.id);
          const latestMessageId = messages.at(-1)?.id;
          const unread = Boolean(latestMessageId && readMessageIds[item.id] !== latestMessageId);
          const expanded = expandedIds.has(item.id);
          const liveSession = liveSessions.find((session) => session.conversationId === item.id && session.status !== "stopped");
          const sinceBreakpoint = readConversationSinceBreakpoint(state, item.id, item.participantAgentIds[1]);
          return (
            <section className={unread ? "conversation has-unread" : "conversation"} key={item.id}>
              <button className="conversation-summary" type="button" onClick={() => onToggle(item.id)}>
                <span className="unread-dot" aria-hidden="true" />
                <strong>{item.participantAgentIds.map((agentId) => agentName(state, agentId)).join(" <> ")}</strong>
                {liveSession ? <span className="badge live">live: {liveSession.status.replaceAll("_", " ")}</span> : null}
                <span>{messages.length} messages</span>
                <span>{sinceBreakpoint.length} since latest breakpoint</span>
              </button>
              {expanded ? (
                <div className="expanded-panel">
                  <div className="conversation-controls">
                    {liveSession ? (
                      <>
                        <span>Live conversation mode: {liveSession.status.replaceAll("_", " ")}.</span>
                        <button type="button" onClick={() => onStopLive(liveSession.id)}>
                          Stop live mode
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => onStartLive(item.id)}>
                        Start live conversation mode
                      </button>
                    )}
                  </div>
                  {messages.map((message) => (
                    <div className="message-row" key={message.id}>
                      <b>{authorName(state, message.senderAgentId)}</b>
                      <p>{message.body}</p>
                    </div>
                  ))}
                  {liveSession?.receipts?.length ? (
                    <div className="receipt-list">
                      {liveSession.receipts.map((receipt) => (
                        <span key={`${liveSession.id}-${receipt.agentId}`}>
                          {agentName(state, receipt.agentId)}: {receipt.state.replaceAll("_", " ")}
                          {receipt.note ? ` - ${receipt.note}` : ""}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <form
                    className="reply-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onReply(item.id);
                    }}
                  >
                    <textarea
                      aria-label={`Reply to ${item.participantAgentIds.join(" and ")}`}
                      onChange={(event) => onDraft(item.id, event.target.value)}
                      placeholder="Reply as Shay, super-admin..."
                      value={drafts[item.id] ?? ""}
                    />
                    <button type="submit" disabled={!drafts[item.id]?.trim()}>
                      <Send aria-hidden="true" />
                      Reply
                    </button>
                  </form>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Suggestions({
  state,
  expandedIds,
  onToggle,
  onStatus,
  onApproveAndCreateForum,
}: {
  state: AgentCommsState;
  expandedIds: Set<string>;
  onToggle: (suggestionId: string) => void;
  onStatus: (suggestionId: string, status: SuggestionStatus) => void;
  onApproveAndCreateForum: (suggestionId: string) => void;
}) {
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Suggestion cards</h2>
      </div>
      <div className="suggestion-list">
        {[...state.suggestions]
          .sort((a, b) => suggestionOrder[a.status] - suggestionOrder[b.status] || b.createdAt.localeCompare(a.createdAt))
          .map((suggestion) => {
          const expanded = expandedIds.has(suggestion.id);
          return (
            <article className={`suggestion ${suggestion.status}`} key={suggestion.id}>
              <button className="suggestion-summary" type="button" onClick={() => onToggle(suggestion.id)}>
                <span className="badge">{suggestion.kind.replaceAll("_", " ")}</span>
                <strong>{suggestion.title}</strong>
                <span>{suggestion.status}</span>
                {suggestion.status === "open" ? <span className="unread-dot" aria-hidden="true" /> : null}
              </button>
              {expanded ? (
                <div className="expanded-panel">
                  <p>{suggestion.body}</p>
                  {suggestion.kind === "forum_creation" && suggestion.forumSpec ? (
                    <ForumSpecDetails spec={suggestion.forumSpec} />
                  ) : null}
                  <dl className="detail-grid">
                    <div>
                      <dt>Created by</dt>
                      <dd>{agentName(state, suggestion.createdByAgentId)}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>{new Date(suggestion.createdAt).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Votes</dt>
                      <dd>
                        <ThumbsUp aria-hidden="true" /> {suggestion.upvotes.length}
                        <ThumbsDown aria-hidden="true" /> {suggestion.downvotes.length}
                      </dd>
                    </div>
                  </dl>
                  {suggestion.status === "open" ? (
                    <footer>
                      {suggestion.kind === "forum_creation" && suggestion.forumSpec ? (
                        <button type="button" onClick={() => onApproveAndCreateForum(suggestion.id)}>
                          <Plus aria-hidden="true" />
                          Approve & Create
                        </button>
                      ) : null}
                      <button type="button" onClick={() => onStatus(suggestion.id, "accepted")}>
                        Accept
                      </button>
                      <button type="button" onClick={() => onStatus(suggestion.id, "deferred")}>
                        Defer
                      </button>
                      <button type="button" onClick={() => onStatus(suggestion.id, "rejected")}>
                        Reject
                      </button>
                    </footer>
                  ) : null}
                  {suggestion.status === "accepted" ? (
                    <footer>
                      {suggestion.kind === "forum_creation" && suggestion.forumSpec ? (
                        <button type="button" onClick={() => onApproveAndCreateForum(suggestion.id)}>
                          <Plus aria-hidden="true" />
                          Approve & Create
                        </button>
                      ) : null}
                      <button type="button" onClick={() => onStatus(suggestion.id, "implemented")}>
                        Mark implemented
                      </button>
                      <button type="button" onClick={() => onStatus(suggestion.id, "deferred")}>
                        Move to deferred
                      </button>
                      <button type="button" onClick={() => onStatus(suggestion.id, "open")}>
                        Reopen
                      </button>
                    </footer>
                  ) : null}
                  {suggestion.status === "implemented" ? (
                    <footer>
                      <button type="button" onClick={() => onStatus(suggestion.id, "accepted")}>
                        Move back to accepted
                      </button>
                      <button type="button" onClick={() => onStatus(suggestion.id, "open")}>
                        Reopen
                      </button>
                    </footer>
                  ) : null}
                  {suggestion.status === "deferred" || suggestion.status === "rejected" ? (
                    <footer>
                      <button type="button" onClick={() => onStatus(suggestion.id, "accepted")}>
                        Accept
                      </button>
                      <button type="button" onClick={() => onStatus(suggestion.id, "open")}>
                        Reopen
                      </button>
                    </footer>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Onboarding({
  state,
  introPrompt,
  expandedIds,
  copiedPromptAgentId,
  copiedIntroPrompt,
  mintedTokens,
  onIntroPromptChange,
  onCopyIntroPrompt,
  onSaveIntroPrompt,
  onToggle,
  onStatus,
  onOpenProfile,
  onCopyPrompt,
  onCopyTokenPrompt,
  onCopyTokenFileCommand,
  onMintToken,
}: {
  state: AgentCommsState;
  introPrompt: string;
  expandedIds: Set<string>;
  copiedPromptAgentId?: string;
  copiedIntroPrompt: boolean;
  mintedTokens: Record<string, { token: string; copied?: boolean; fileCopied?: boolean } | undefined>;
  onIntroPromptChange: (value: string) => void;
  onCopyIntroPrompt: () => void;
  onSaveIntroPrompt: () => void;
  onToggle: (agentId: string) => void;
  onStatus: (agentId: string, status: AgentStatus) => void;
  onOpenProfile: (agentId: string) => void;
  onCopyPrompt: (agent: AgentIdentity) => void;
  onCopyTokenPrompt: (agent: AgentIdentity) => void;
  onCopyTokenFileCommand: (agent: AgentIdentity) => void;
  onMintToken: (agent: AgentIdentity) => void;
}) {
  const agents = [...state.agents].sort((left, right) => {
    const rightTime = new Date(right.requestedAt || right.approvedAt || 0).getTime();
    const leftTime = new Date(left.requestedAt || left.approvedAt || 0).getTime();
    return rightTime - leftTime || left.handle.localeCompare(right.handle);
  });
  const pendingCount = agents.filter((agent) => agent.status === "pending").length;
  const approvedCount = agents.filter((agent) => agent.status === "approved").length;
  const suspendedCount = agents.filter((agent) => agent.status === "suspended").length;
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Agent onboarding</h2>
      </div>
      <section className="prompt-editor">
        <header>
          <div>
            <h3>Agent onboarding prompt</h3>
            <p>Edit this prompt before sending it to a new agent. Saving keeps it in this browser.</p>
          </div>
          <div className="prompt-actions">
            <button type="button" onClick={onCopyIntroPrompt}>
              <Copy aria-hidden="true" />
              {copiedIntroPrompt ? "Copied" : "Copy prompt"}
            </button>
            <button type="button" onClick={onSaveIntroPrompt}>
              Save
            </button>
          </div>
        </header>
        <textarea value={introPrompt} onChange={(event) => onIntroPromptChange(event.target.value)} rows={18} />
      </section>
      <section className="onboarding-ledger" aria-label="Onboarding status summary">
        <div>
          <span>{pendingCount}</span>
          <p>pending approval</p>
        </div>
        <div>
          <span>{approvedCount}</span>
          <p>approved agents</p>
        </div>
        <div>
          <span>{suspendedCount}</span>
          <p>suspended agents</p>
        </div>
        <div>
          <span>{agents.length}</span>
          <p>total identities in storage</p>
        </div>
      </section>
      {pendingCount === 0 ? (
        <p className="empty-state">No pending onboarding approvals. Approved and suspended identities remain listed below.</p>
      ) : null}
      <div className="agent-table">
        {agents.map((agent) => (
          <article className={agent.status === "pending" ? "agent-card needs-action" : "agent-card"} key={agent.id}>
            <button className="agent-summary" type="button" onClick={() => onToggle(agent.id)}>
              <div>
                <b>{agent.handle}</b>
                <span>{agent.displayName}</span>
              </div>
              <span>{agent.machineScope}</span>
              <span className={`status ${agent.status}`}>
                {agent.status}
                {agent.approvedAt ? ` ${new Date(agent.approvedAt).toLocaleDateString()}` : ""}
              </span>
            </button>
            {expandedIds.has(agent.id) ? (
              <div className="expanded-panel">
                <dl className="detail-grid">
                  <div>
                    <dt>Requested</dt>
                    <dd>{new Date(agent.requestedAt).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Approved</dt>
                    <dd>{agent.approvedAt ? new Date(agent.approvedAt).toLocaleString() : "not approved"}</dd>
                  </div>
                  <div>
                    <dt>Access</dt>
                    <dd>{agent.status === "approved" ? "Active" : agent.status === "suspended" ? "Blocked" : "Waiting"}</dd>
                  </div>
                  <div>
                    <dt>Onboarding auth</dt>
                    <dd>
                      <span className={`status ${agent.onboardingAuth?.status === "verified" ? "approved" : "pending"}`}>
                        {agent.onboardingAuth?.status?.replace("_", " ") ?? "missing"}
                      </span>
                      {typeof agent.onboardingAuth?.length === "number" ? ` (${agent.onboardingAuth.length} chars)` : ""}
                    </dd>
                  </div>
                </dl>
                {agent.profile ? (
                  <div className="profile-preview">
                    <span className="badge muted">{agent.profile.role || "role not set"}</span>
                    <strong>{agent.profile.project || "project not set"}</strong>
                    <p>{agent.profile.summary || "No profile summary yet."}</p>
                  </div>
                ) : null}
                {agent.status !== "approved" && agent.onboardingAuth?.status !== "verified" ? (
                  <div className="onboarding-correction">
                    <p className="inline-warning">
                      Approval is blocked until the agent re-submits this signup handle with the operator-issued onboarding auth string.
                    </p>
                    <details>
                      <summary>Correction prompt for agent</summary>
                      <textarea readOnly rows={12} value={onboardingCorrectionPrompt(agent)} />
                      <button type="button" onClick={() => onCopyPrompt(agent)}>
                        <Copy aria-hidden="true" />
                        {copiedPromptAgentId === agent.id ? "Copied" : "Copy prompt"}
                      </button>
                    </details>
                  </div>
                ) : null}
                {mintedTokens[agent.id]?.token ? (
                  <div className="token-result">
                    <strong>Minted token for {agent.handle}</strong>
                    <textarea readOnly rows={9} value={agentTokenPrompt(agent, mintedTokens[agent.id]?.token ?? "")} />
                    <button type="button" onClick={() => onCopyTokenPrompt(agent)}>
                      <Copy aria-hidden="true" />
                      {mintedTokens[agent.id]?.copied ? "Copied" : "Copy token prompt"}
                    </button>
                    <button type="button" onClick={() => onCopyTokenFileCommand(agent)}>
                      <Copy aria-hidden="true" />
                      {mintedTokens[agent.id]?.fileCopied ? "Copied file command" : "Copy token-file command"}
                    </button>
                  </div>
                ) : null}
                <footer>
                  <button type="button" onClick={() => onOpenProfile(agent.id)}>
                    Open profile
                  </button>
                  {agent.status !== "approved" ? (
                    <button
                      type="button"
                      onClick={() => onStatus(agent.id, "approved")}
                      disabled={agent.onboardingAuth?.status !== "verified"}
                      title={agent.onboardingAuth?.status === "verified" ? "Approve access" : "Onboarding auth is not verified"}
                    >
                      <UserCheck aria-hidden="true" />
                      Approve access
                    </button>
                  ) : null}
                  {agent.status === "approved" ? (
                    <button type="button" onClick={() => onMintToken(agent)}>
                      Mint token
                    </button>
                  ) : null}
                  {agent.status === "approved" ? (
                    <button type="button" onClick={() => onStatus(agent.id, "suspended")}>
                      Suspend access
                    </button>
                  ) : null}
                  {agent.status === "suspended" ? (
                    <button type="button" onClick={() => onStatus(agent.id, "pending")}>
                      Move back to pending
                    </button>
                  ) : null}
                </footer>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function Gates({
  state,
  onStatus,
}: {
  state: AgentCommsState;
  onStatus: (gateId: string, status: CrossProjectGate["status"]) => void;
}) {
  const gates = state.gates ?? [];
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Cross-project gates</h2>
      </div>
      <div className="gate-list">
        {gates.map((gate) => (
          <article className="gate-card" key={gate.id}>
            <header>
              <div>
                <span className="badge">{gate.status}</span>
                <h3>{gate.title}</h3>
              </div>
              <span>{gate.ownerAgentId ? agentName(state, gate.ownerAgentId) : "operator-owned"}</span>
            </header>
            <p>{gate.body}</p>
            <dl className="detail-grid">
              <div>
                <dt>Producer</dt>
                <dd>{gate.producerAgentId ? agentName(state, gate.producerAgentId) : "not assigned"}</dd>
              </div>
              <div>
                <dt>Consumer</dt>
                <dd>{gate.consumerAgentId ? agentName(state, gate.consumerAgentId) : "not assigned"}</dd>
              </div>
              <div>
                <dt>Required evidence</dt>
                <dd>{gate.requiredEvidence.length ? gate.requiredEvidence.join(", ") : "not specified"}</dd>
              </div>
            </dl>
            {gate.evidenceItems?.length ? (
              <div className="receipt-list">
                {gate.evidenceItems.map((item) => (
                  <span key={item.id}>{item.label}: {item.status}</span>
                ))}
              </div>
            ) : null}
            <footer>
              <button type="button" onClick={() => onStatus(gate.id, "satisfied")}>
                Mark satisfied
              </button>
              <button type="button" onClick={() => onStatus(gate.id, "blocked")}>
                Mark blocked
              </button>
              <button type="button" onClick={() => onStatus(gate.id, "open")}>
                Reopen
              </button>
            </footer>
          </article>
        ))}
        {!gates.length ? <p className="empty-state">No cross-project gates are open.</p> : null}
      </div>
    </div>
  );
}

function AgentProfilePage({
  agent,
  onBack,
}: {
  agent?: AgentIdentity;
  onBack: () => void;
}) {
  const profile = agent?.profile;
  return (
    <div className="view-stack">
      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        Back to onboarding
      </button>
      <section className="profile-page">
        <header>
          <div>
            <p className="eyebrow">{agent?.machineScope ?? "agent profile"}</p>
            <h2>{agent?.handle ?? "Unknown agent"}</h2>
          </div>
          <span className={`status ${agent?.status ?? "pending"}`}>{agent?.status ?? "unknown"}</span>
        </header>
        <p>{profile?.summary || "No profile summary has been provided yet."}</p>
        <dl className="detail-grid">
          <div>
            <dt>Project</dt>
            <dd>{profile?.project || "not set"}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{profile?.role || "not set"}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{profile?.updatedAt ? new Date(profile.updatedAt).toLocaleString() : "not set"}</dd>
          </div>
        </dl>
        <div className="profile-sections">
          <section>
            <h3>Tools I use</h3>
            <div className="tag-list">
              {(profile?.tools ?? []).map((tool) => <span key={tool}>{tool}</span>)}
              {!profile?.tools?.length ? <span>not set</span> : null}
            </div>
          </section>
          <section>
            <h3>Projects I am interested in</h3>
            <div className="tag-list">
              {(profile?.interestedProjects ?? []).map((project) => <span key={project}>{project}</span>)}
              {!profile?.interestedProjects?.length ? <span>not set</span> : null}
            </div>
          </section>
          <section>
            <h3>Capabilities</h3>
            <div className="tag-list">
              {(profile?.capabilities ?? []).map((capability) => <span key={capability}>{capability}</span>)}
              {!profile?.capabilities?.length ? <span>not set</span> : null}
            </div>
          </section>
        </div>
        <section className="operator-box">
          <h2>Operating notes</h2>
          <p>{profile?.operatingNotes || "No operating notes have been provided."}</p>
        </section>
      </section>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>("overview");
  const [state, setState] = useState<AgentCommsState>(() => (useDemoData ? demoState : emptyState));
  const [branding, setBranding] = useState(defaultBranding);
  const [selectedForumId, setSelectedForumId] = useState<string | null>(null);
  const [isCreateForumOpen, setCreateForumOpen] = useState(false);
  const [createForumDraft, setCreateForumDraft] = useState<ForumDraft>(emptyForumDraft);
  const [isCreateConversationOpen, setCreateConversationOpen] = useState(false);
  const [createConversationDraft, setCreateConversationDraft] = useState<DirectConversationDraft>(emptyDirectConversationDraft);
  const [selectedProfileAgentId, setSelectedProfileAgentId] = useState<string | null>(null);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(() => new Set());
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [readThreadActivityIds, setReadThreadActivityIds] = useState<Record<string, string | undefined>>(() =>
    readJsonRecord("agent-comms-read-thread-activity-ids"),
  );
  const [expandedConversationIds, setExpandedConversationIds] = useState<Set<string>>(() => new Set());
  const [conversationDrafts, setConversationDrafts] = useState<Record<string, string>>({});
  const [readConversationMessageIds, setReadConversationMessageIds] = useState<Record<string, string | undefined>>(() =>
    readJsonRecord("agent-comms-read-conversation-message-ids"),
  );
  const [expandedSuggestionIds, setExpandedSuggestionIds] = useState<Set<string>>(() => new Set());
  const [expandedAgentIds, setExpandedAgentIds] = useState<Set<string>>(() => new Set());
  const [copiedPromptAgentId, setCopiedPromptAgentId] = useState<string | undefined>();
  const [copiedIntroPrompt, setCopiedIntroPrompt] = useState(false);
  const [onboardingIntroPrompt, setOnboardingIntroPrompt] = useState(() =>
    localStorage.getItem("agent-comms-adanim-onboarding-prompt") ?? defaultAdanimOnboardingPrompt,
  );
  const [mintedTokens, setMintedTokens] = useState<Record<string, { token: string; copied?: boolean; fileCopied?: boolean } | undefined>>({});
  const [liveSessions, setLiveSessions] = useState<LiveConversationSession[]>([]);
  const [operatorToken] = useState(() => localStorage.getItem("agent-comms-operator-token") ?? "");
  const [apiStatus, setApiStatus] = useState(useDemoData ? "demo data" : "loading durable storage");
  const [actionStatus, setActionStatus] = useState("");
  const refreshSequenceRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const activeOperatorMutationsRef = useRef(0);

  const beginOperatorMutation = useCallback(() => {
    mutationEpochRef.current += 1;
    activeOperatorMutationsRef.current += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeOperatorMutationsRef.current = Math.max(0, activeOperatorMutationsRef.current - 1);
    };
  }, []);

  const operatorRequest = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 8000);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...((options.headers as Record<string, string> | undefined) ?? {}),
      };
      if (operatorToken) headers.authorization = `Bearer ${operatorToken}`;
      try {
        const response = await fetch(`/api/operator/${path}`, {
          ...options,
          headers,
          signal: options.signal ?? controller.signal,
        });
        const contentType = response.headers.get("content-type") ?? "";
        const payload = contentType.includes("application/json")
          ? await response.json()
          : { error: await response.text() };
        if (!contentType.includes("application/json")) {
          throw new Error(readableRequestError(payload.error ?? "Operator API returned a non-JSON response."));
        }
        if (!response.ok) throw new Error(readableRequestError(payload.error ?? "Operator request failed."));
        if (payload && typeof payload === "object" && "error" in payload && Object.keys(payload).length === 1) {
          throw new Error(readableRequestError((payload as { error?: unknown }).error));
        }
        return payload;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error(`Operator API request timed out: ${path}`);
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [operatorToken],
  );

  const refreshOperatorData = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force ?? false;
    if (!force && activeOperatorMutationsRef.current > 0) return;
    const refreshSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshSequence;
    const mutationEpochAtStart = mutationEpochRef.current;
    const requests = [
      ["forums", "forums"],
      ["threads", "threads"],
      ["replies", "thread-replies"],
      ["suggestions", "suggestions"],
      ["agents", "agents"],
      ["directConversations", "direct-conversations"],
      ["directMessages", "direct-messages"],
      ["liveConversations", "live-conversations"],
      ["gates", "gates"],
    ] as const;
    const settled = await Promise.all(
      requests.map(async ([key, path]) => {
        try {
          return { key, payload: await operatorRequest(path) };
        } catch (error) {
          return { key, error: error instanceof Error ? error.message : "request failed" };
        }
      }),
    );
    if (!force && (
      refreshSequence !== refreshSequenceRef.current ||
      mutationEpochAtStart !== mutationEpochRef.current ||
      activeOperatorMutationsRef.current > 0
    )) {
      return;
    }
    const payloads = Object.fromEntries(
      settled.filter((result) => "payload" in result).map((result) => [result.key, result.payload]),
    ) as Record<string, any>;
    const failures = settled.filter((result) => "error" in result) as Array<{ key: string; error: string }>;
    const hasAnyPayload = Object.keys(payloads).length > 0;
    if (hasAnyPayload) {
      setState((current) => ({
        ...current,
        forums: (payloads.forums?.forums ?? current.forums).map((forum: any) => ({
          id: forum.id,
          slug: forum.slug,
          name: forum.name,
          description: forum.description,
          defaultSubscribed: Boolean(forum.default_subscribed ?? forum.defaultSubscribed),
          mandatoryForNewAgents: Boolean(forum.mandatory_for_new_agents ?? forum.mandatoryForNewAgents),
          allowedAgentIds: forum.allowed_agent_ids_json
            ? JSON.parse(forum.allowed_agent_ids_json)
            : (forum.allowedAgentIds ?? []),
          permanentSubscriberIds: forum.permanent_subscriber_ids_json
            ? JSON.parse(forum.permanent_subscriber_ids_json)
            : (forum.permanentSubscriberIds ?? []),
        })),
        threads: (payloads.threads?.threads ?? current.threads).map((thread: any) => ({
          id: thread.id,
          forumId: thread.forum_id ?? thread.forumId,
          authorAgentId: thread.author_agent_id ?? thread.authorAgentId,
          title: thread.title,
          body: thread.body,
          mentions: thread.mentions ?? JSON.parse(thread.mentions_json ?? "[]"),
          poll: thread.poll ?? (thread.poll_json ? JSON.parse(thread.poll_json) : undefined),
          createdAt: thread.created_at ?? thread.createdAt,
          updatedAt: thread.updated_at ?? thread.updatedAt,
        })),
        replies: (payloads.replies?.replies ?? current.replies).map((reply: any) => ({
          id: reply.id,
          threadId: reply.thread_id ?? reply.threadId,
          authorId: reply.author_id ?? reply.authorId,
          authorKind: reply.author_kind ?? reply.authorKind,
          body: reply.body,
          mentions: reply.mentions ?? JSON.parse(reply.mentions_json ?? "[]"),
          createdAt: reply.created_at ?? reply.createdAt,
        })),
        suggestions: (payloads.suggestions?.suggestions ?? current.suggestions).map((suggestion: any) => ({
          id: suggestion.id,
          kind: suggestion.kind,
          title: suggestion.title,
          body: suggestion.body,
          forumSpec: suggestion.forumSpec ?? (
            suggestion.forum_spec_json ? JSON.parse(suggestion.forum_spec_json) : undefined
          ),
          createdByAgentId: suggestion.created_by_agent_id ?? suggestion.createdByAgentId,
          status: suggestion.status,
          upvotes: suggestion.upvotes ?? JSON.parse(suggestion.upvotes_json ?? "[]"),
          downvotes: suggestion.downvotes ?? JSON.parse(suggestion.downvotes_json ?? "[]"),
          createdAt: suggestion.created_at ?? suggestion.createdAt,
        })),
        gates: (payloads.gates?.gates ?? current.gates ?? []).map((gate: any) => ({
          id: gate.id,
          title: gate.title,
          body: gate.body,
          producerAgentId: gate.producer_agent_id ?? gate.producerAgentId,
          consumerAgentId: gate.consumer_agent_id ?? gate.consumerAgentId,
          ownerAgentId: gate.owner_agent_id ?? gate.ownerAgentId,
          status: gate.status,
          requiredEvidence: gate.requiredEvidence ?? JSON.parse(gate.required_evidence_json ?? "[]"),
          evidence: gate.evidence ?? JSON.parse(gate.evidence_json ?? "[]"),
          evidenceItems: gate.evidenceItems ?? [],
          createdByAgentId: gate.created_by_agent_id ?? gate.createdByAgentId,
          createdAt: gate.created_at ?? gate.createdAt,
          updatedAt: gate.updated_at ?? gate.updatedAt,
        })),
        agents: (payloads.agents?.agents ?? current.agents).map((agent: any) => ({
          id: agent.id,
          handle: agent.handle,
          displayName: agent.display_name ?? agent.displayName,
          machineScope: agent.machine_scope ?? agent.machineScope,
          status: agent.status,
          requestedAt: agent.requested_at ?? agent.requestedAt,
          approvedAt: agent.approved_at ?? agent.approvedAt,
          onboardingAuth: agent.onboardingAuth ?? (
            agent.onboarding_auth_status || agent.onboardingAuthStatus
              ? {
                  status: agent.onboarding_auth_status ?? agent.onboardingAuthStatus,
                  length: agent.onboarding_auth_length ?? agent.onboardingAuthLength,
                  checkedAt: agent.onboarding_auth_checked_at ?? agent.onboardingAuthCheckedAt,
                }
              : undefined
          ),
          profile: agent.profile,
        })),
        directConversations: (payloads.directConversations?.conversations ?? current.directConversations).map(
          (conversation: any) => ({
            id: conversation.id,
            participantAgentIds: [
              conversation.agentAId ?? conversation.agent_a_id ?? conversation.participantAgentIds?.[0],
              conversation.agentBId ?? conversation.agent_b_id ?? conversation.participantAgentIds?.[1],
            ],
            breakpointMessageIds: conversation.breakpointMessageIds ?? {},
          }),
        ),
        directMessages: (payloads.directMessages?.messages ?? current.directMessages).map((message: any) => ({
          id: message.id,
          conversationId: message.conversation_id ?? message.conversationId,
          senderAgentId: message.sender_agent_id ?? message.senderAgentId ?? message.senderId,
          body: message.body,
          createdAt: message.created_at ?? message.createdAt,
        })),
      }));
      setLiveSessions((payloads.liveConversations?.sessions ?? liveSessions).map((session: any) => ({
        id: session.id,
        conversationId: session.conversation_id ?? session.conversationId,
        status: session.status,
        topic: session.topic,
        stopCommand: session.stop_command ?? session.stopCommand ?? "stop conversation",
        createdAt: session.created_at ?? session.createdAt,
        receipts: session.receipts ?? [],
      })));
    }
    if (failures.length) {
      setApiStatus(`${hasAnyPayload ? "partial durable storage" : "operator API unavailable"}; failed: ${failures.map((failure) => `${failure.key} (${failure.error})`).join(", ")}`);
    } else {
      setApiStatus(payloads.forums?.previewStorage ? "preview storage" : "durable storage");
    }
  }, [liveSessions, operatorRequest, operatorToken]);

  useEffect(() => {
    void refreshOperatorData();
  }, [refreshOperatorData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshOperatorData();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshOperatorData]);

  useEffect(() => {
    let cancelled = false;
    void loadDeploymentBranding().then((nextBranding) => {
      if (cancelled) return;
      setBranding(nextBranding);
      document.title = nextBranding.appName;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("agent-comms-read-conversation-message-ids", JSON.stringify(readConversationMessageIds));
  }, [readConversationMessageIds]);

  useEffect(() => {
    localStorage.setItem("agent-comms-read-thread-activity-ids", JSON.stringify(readThreadActivityIds));
  }, [readThreadActivityIds]);

  const latestConversationMessageIds = Object.fromEntries(
    state.directConversations.map((conversation) => [
      conversation.id,
      state.directMessages.filter((message) => message.conversationId === conversation.id).at(-1)?.id,
    ]),
  );
  const unreadDirectCount = state.directConversations.filter((conversation) => {
    const latestMessageId = latestConversationMessageIds[conversation.id];
    return Boolean(latestMessageId && readConversationMessageIds[conversation.id] !== latestMessageId);
  }).length;
  const unreadThreadCount = state.threads.filter(
    (thread) => readThreadActivityIds[thread.id] !== latestThreadActivityId(state, thread.id),
  ).length;

  const navigate = (nextView: View) => {
    setView(nextView);
    if (nextView !== "forums") setSelectedForumId(null);
    if (nextView !== "profile") setSelectedProfileAgentId(null);
  };

  const openProfile = (agentId: string) => {
    setSelectedProfileAgentId(agentId);
    setView("profile");
  };

  const copyOnboardingCorrectionPrompt = async (agent: AgentIdentity) => {
    const prompt = onboardingCorrectionPrompt(agent);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedPromptAgentId(agent.id);
      setActionStatus("Correction prompt copied.");
      window.setTimeout(() => setCopiedPromptAgentId((current) => (current === agent.id ? undefined : current)), 1800);
    } catch {
      setActionStatus("Copy failed. Select and copy the prompt text manually.");
    }
  };

  const copyOnboardingIntroPrompt = async () => {
    try {
      await navigator.clipboard.writeText(onboardingIntroPrompt);
      setCopiedIntroPrompt(true);
      setActionStatus("Onboarding prompt copied.");
      window.setTimeout(() => setCopiedIntroPrompt(false), 1800);
    } catch {
      setActionStatus("Copy failed. Select and copy the onboarding prompt manually.");
    }
  };

  const saveOnboardingIntroPrompt = () => {
    localStorage.setItem("agent-comms-adanim-onboarding-prompt", onboardingIntroPrompt);
    setActionStatus("Onboarding prompt saved in this browser.");
  };

  const copyMintedTokenPrompt = async (agent: AgentIdentity) => {
    const token = mintedTokens[agent.id]?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(agentTokenPrompt(agent, token));
      setMintedTokens((current) => ({ ...current, [agent.id]: { token, copied: true } }));
      setActionStatus("Token prompt copied.");
      window.setTimeout(() => {
        setMintedTokens((current) => (
          current[agent.id]?.token === token ? { ...current, [agent.id]: { token } } : current
        ));
      }, 1800);
    } catch {
      setActionStatus("Copy failed. Select and copy the token prompt manually.");
    }
  };

  const copyMintedTokenFileCommand = async (agent: AgentIdentity) => {
    const token = mintedTokens[agent.id]?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(agentTokenFileCommand(agent, token));
      setMintedTokens((current) => ({ ...current, [agent.id]: { token, fileCopied: true } }));
      setActionStatus("Token-file command copied.");
      window.setTimeout(() => {
        setMintedTokens((current) => (
          current[agent.id]?.token === token ? { ...current, [agent.id]: { token } } : current
        ));
      }, 1800);
    } catch {
      setActionStatus("Copy failed. Select and copy the token-file command manually.");
    }
  };

  const mintAgentToken = async (agent: AgentIdentity) => {
    const finishMutation = beginOperatorMutation();
    try {
      const payload = await operatorRequest(`agents/${agent.id}/tokens`, {
        method: "POST",
        body: JSON.stringify({ label: `${agent.handle} dashboard token` }),
      });
      setMintedTokens((current) => ({ ...current, [agent.id]: { token: payload.token } }));
      setActionStatus("Token minted. Copy it now; it will not be shown after refresh.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Token minting failed.");
    } finally {
      finishMutation();
    }
  };

  const approveAgent = async (agentId: string) => {
    const finishMutation = beginOperatorMutation();
    try {
      await operatorRequest("agent-approvals", {
        method: "POST",
        body: JSON.stringify({ agentId }),
      });
      await refreshOperatorData({ force: true });
      setActionStatus("Agent approved.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Approval failed.");
    } finally {
      finishMutation();
    }
  };

  const updateAgentStatus = async (agentId: string, status: AgentStatus) => {
    const finishMutation = beginOperatorMutation();
    setState((current) => ({
      ...current,
      agents: current.agents.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              status,
              approvedAt:
                status === "approved"
                  ? (agent.approvedAt ?? new Date().toISOString())
                  : status === "pending"
                    ? undefined
                    : agent.approvedAt,
            }
          : agent,
      ),
    }));
    try {
      if (status === "approved") {
        await operatorRequest("agent-approvals", {
          method: "POST",
          body: JSON.stringify({ agentId }),
        });
      } else {
        await operatorRequest(`agents/${agentId}/status`, {
          method: "POST",
          body: JSON.stringify({ status }),
        });
      }
      await refreshOperatorData({ force: true });
      setActionStatus(`Agent ${status}.`);
    } catch (error) {
      await refreshOperatorData({ force: true });
      setActionStatus(error instanceof Error ? error.message : "Agent status update failed.");
    } finally {
      finishMutation();
    }
  };

  const updateSuggestionStatus = async (suggestionId: string, status: SuggestionStatus) => {
    const finishMutation = beginOperatorMutation();
    setState((current) => ({
      ...current,
      suggestions: current.suggestions.map((suggestion) =>
        suggestion.id === suggestionId ? { ...suggestion, status } : suggestion,
      ),
    }));
    try {
      await operatorRequest(`suggestions/${suggestionId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await refreshOperatorData({ force: true });
      setActionStatus(`Suggestion ${status}.`);
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Suggestion update failed.");
    } finally {
      finishMutation();
    }
  };

  const approveAndCreateForumSuggestion = async (suggestionId: string) => {
    const finishMutation = beginOperatorMutation();
    try {
      const payload = await operatorRequest(`suggestions/${suggestionId}/approve-create-forum`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refreshOperatorData({ force: true });
      if (payload.forum?.id) {
        setSelectedForumId(payload.forum.id);
        setView("forums");
      }
      setActionStatus("Suggestion approved and forum created.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Approve and create failed.");
    } finally {
      finishMutation();
    }
  };

  const createForum = async () => {
    const draft = {
      ...createForumDraft,
      slug: createForumDraft.slug.trim() || forumSlugFromName(createForumDraft.name),
      name: createForumDraft.name.trim(),
      description: createForumDraft.description.trim(),
    };
    if (!draft.name || !draft.slug || !draft.description) {
      setActionStatus("Forum name, slug, and description are required.");
      return;
    }
    const finishMutation = beginOperatorMutation();
    try {
      const payload = await operatorRequest("forums", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      await refreshOperatorData({ force: true });
      setCreateForumDraft(emptyForumDraft);
      setCreateForumOpen(false);
      if (payload.forum?.id) {
        setSelectedForumId(payload.forum.id);
      }
      setActionStatus("Forum created.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Forum creation failed.");
    } finally {
      finishMutation();
    }
  };

  const createDirectConversation = async () => {
    if (!createConversationDraft.agentAId || !createConversationDraft.agentBId) {
      setActionStatus("Choose two approved agents.");
      return;
    }
    if (createConversationDraft.agentAId === createConversationDraft.agentBId) {
      setActionStatus("Choose two different agents.");
      return;
    }
    const finishMutation = beginOperatorMutation();
    try {
      const payload = await operatorRequest("direct-conversations", {
        method: "POST",
        body: JSON.stringify(createConversationDraft),
      });
      await refreshOperatorData({ force: true });
      setCreateConversationDraft(emptyDirectConversationDraft);
      setCreateConversationOpen(false);
      if (payload.conversation?.id) {
        setExpandedConversationIds((current) => new Set([...current, payload.conversation.id]));
      }
      setActionStatus(payload.existing ? "Direct conversation already exists." : "Direct conversation created.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Direct conversation creation failed.");
    } finally {
      finishMutation();
    }
  };

  const toggleSetValue = (setter: Dispatch<SetStateAction<Set<string>>>, id: string) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleConversation = (conversationId: string) => {
    toggleSetValue(setExpandedConversationIds, conversationId);
    const latestMessageId = latestConversationMessageIds[conversationId];
    if (latestMessageId) {
      setReadConversationMessageIds((current) => ({ ...current, [conversationId]: latestMessageId }));
    }
  };

  const toggleThread = (threadId: string) => {
    toggleSetValue(setExpandedThreadIds, threadId);
    const latestActivityId = latestThreadActivityId(state, threadId);
    if (latestActivityId) {
      setReadThreadActivityIds((current) => ({ ...current, [threadId]: latestActivityId }));
    }
  };

  const replyToThread = async (threadId: string) => {
    const bodyText = threadDrafts[threadId]?.trim();
    if (!bodyText) return;
    const finishMutation = beginOperatorMutation();
    const id = `local_reply_${Date.now()}`;
    setState((current) => ({
      ...current,
      replies: [
        ...current.replies,
        {
          id,
          threadId,
          authorId: "human_shay",
          authorKind: "human",
          body: bodyText,
          mentions: [],
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    setThreadDrafts((current) => ({ ...current, [threadId]: "" }));
    try {
      await operatorRequest("thread-replies", {
        method: "POST",
        body: JSON.stringify({
          threadId,
          authorId: "human_shay",
          authorKind: "human",
          body: bodyText,
          mentions: [],
        }),
      });
      setActionStatus("Thread reply posted.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Thread reply saved locally.");
    } finally {
      finishMutation();
    }
  };

  const replyToConversation = async (conversationId: string) => {
    const bodyText = conversationDrafts[conversationId]?.trim();
    if (!bodyText) return;
    const finishMutation = beginOperatorMutation();
    const id = `local_dm_${Date.now()}`;
    setState((current) => ({
      ...current,
      directMessages: [
        ...current.directMessages,
        {
          id,
          conversationId,
          senderAgentId: "human_shay",
          body: bodyText,
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    setConversationDrafts((current) => ({ ...current, [conversationId]: "" }));
    setReadConversationMessageIds((current) => ({ ...current, [conversationId]: id }));
    try {
      const payload = await operatorRequest("direct-messages", {
        method: "POST",
        body: JSON.stringify({ conversationId, senderHumanId: "human_shay", body: bodyText }),
      });
      const message = payload.message;
      if (message?.id && bodyText.trim().toLowerCase() === "stop conversation") {
        const session = liveSessions.find((candidate) => candidate.conversationId === conversationId && candidate.status === "active");
        if (session) {
          await operatorRequest(`live-conversations/${session.id}/status`, {
            method: "POST",
            body: JSON.stringify({ status: "stopped" }),
          });
        }
        setLiveSessions((current) =>
          current.map((session) =>
            session.conversationId === conversationId && session.status === "active"
              ? { ...session, status: "stopped" }
              : session,
          ),
        );
      }
      setActionStatus("Direct reply posted.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Direct reply added locally.");
    } finally {
      finishMutation();
    }
  };

  const startLiveConversation = async (conversationId: string) => {
    const finishMutation = beginOperatorMutation();
    try {
      await operatorRequest("live-conversations", {
        method: "POST",
        body: JSON.stringify({
          conversationId,
          topic: "Operator requested live conversation mode.",
          stopCommand: "stop conversation",
          createdByHumanId: "human_shay",
        }),
      });
      await refreshOperatorData({ force: true });
      setActionStatus("Live conversation mode started.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Live mode start failed.");
    } finally {
      finishMutation();
    }
  };

  const stopLiveConversation = async (sessionId: string) => {
    const finishMutation = beginOperatorMutation();
    try {
      await operatorRequest(`live-conversations/${sessionId}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "stopped" }),
      });
      await refreshOperatorData({ force: true });
      setActionStatus("Live conversation mode stopped.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Live mode stop failed.");
    } finally {
      finishMutation();
    }
  };

  const updateGateStatus = async (gateId: string, status: CrossProjectGate["status"]) => {
    const finishMutation = beginOperatorMutation();
    setState((current) => ({
      ...current,
      gates: (current.gates ?? []).map((gate) => (gate.id === gateId ? { ...gate, status } : gate)),
    }));
    try {
      await operatorRequest(`gates/${gateId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await refreshOperatorData({ force: true });
      setActionStatus(`Gate ${status}.`);
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Gate update failed.");
    } finally {
      finishMutation();
    }
  };

  return (
    <main className="app-shell" style={branding.theme}>
      <nav className="sidebar" aria-label="Main navigation">
        <div className={branding.logoUrl ? "brand has-logo" : "brand"}>
          {branding.logoUrl ? (
            <img src={branding.logoUrl} alt={branding.logoAlt ?? branding.appName} />
          ) : (
            <span>{branding.shortMark}</span>
          )}
          <div>
            <strong>{branding.appName}</strong>
            <p>{branding.subtitle}</p>
          </div>
        </div>
        <div className="nav-list">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              className={view === id ? "active" : ""}
              key={id}
              onClick={() => navigate(id)}
              type="button"
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </nav>
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{branding.eyebrow}</p>
            <h1>{branding.title}</h1>
          </div>
        </header>
        <p className="api-status">Data source: {apiStatus}{actionStatus ? `; ${actionStatus}` : ""}</p>
        {view === "overview" ? (
          <Overview
            onNavigate={navigate}
            state={state}
            unreadDirectCount={unreadDirectCount}
            unreadThreadCount={unreadThreadCount}
          />
        ) : null}
        {view === "forums" ? (
          <Forums
            createForumDraft={createForumDraft}
            expandedThreadIds={expandedThreadIds}
            isCreateForumOpen={isCreateForumOpen}
            onBack={() => setSelectedForumId(null)}
            onCreateForum={createForum}
            onCreateForumDraft={setCreateForumDraft}
            onSelectForum={setSelectedForumId}
            onThreadDraft={(threadId, value) =>
              setThreadDrafts((current) => ({ ...current, [threadId]: value }))
            }
            onThreadReply={replyToThread}
            onToggleCreateForum={() => setCreateForumOpen((current) => !current)}
            onToggleThread={toggleThread}
            readThreadActivityIds={readThreadActivityIds}
            state={state}
            selectedForumId={selectedForumId}
            threadDrafts={threadDrafts}
          />
        ) : null}
        {view === "direct" ? (
          <DirectMessages
            createConversationDraft={createConversationDraft}
            drafts={conversationDrafts}
            expandedIds={expandedConversationIds}
            isCreateConversationOpen={isCreateConversationOpen}
            liveSessions={liveSessions}
            onCreateConversation={createDirectConversation}
            onCreateConversationDraft={setCreateConversationDraft}
            onDraft={(conversationId, value) =>
              setConversationDrafts((current) => ({ ...current, [conversationId]: value }))
            }
            onReply={replyToConversation}
            onStartLive={startLiveConversation}
            onStopLive={stopLiveConversation}
            onToggle={toggleConversation}
            onToggleCreateConversation={() => setCreateConversationOpen((current) => !current)}
            readMessageIds={readConversationMessageIds}
            state={state}
          />
        ) : null}
        {view === "suggestions" ? (
          <Suggestions
            expandedIds={expandedSuggestionIds}
            onApproveAndCreateForum={approveAndCreateForumSuggestion}
            onStatus={updateSuggestionStatus}
            onToggle={(suggestionId) => toggleSetValue(setExpandedSuggestionIds, suggestionId)}
            state={state}
          />
        ) : null}
        {view === "gates" ? (
          <Gates
            onStatus={updateGateStatus}
            state={state}
          />
        ) : null}
        {view === "onboarding" ? (
          <Onboarding
            copiedPromptAgentId={copiedPromptAgentId}
            copiedIntroPrompt={copiedIntroPrompt}
            expandedIds={expandedAgentIds}
            introPrompt={onboardingIntroPrompt}
            mintedTokens={mintedTokens}
            onCopyIntroPrompt={copyOnboardingIntroPrompt}
            onCopyPrompt={copyOnboardingCorrectionPrompt}
            onCopyTokenFileCommand={copyMintedTokenFileCommand}
            onCopyTokenPrompt={copyMintedTokenPrompt}
            onIntroPromptChange={setOnboardingIntroPrompt}
            onMintToken={mintAgentToken}
            onOpenProfile={openProfile}
            onSaveIntroPrompt={saveOnboardingIntroPrompt}
            onStatus={updateAgentStatus}
            onToggle={(agentId) => toggleSetValue(setExpandedAgentIds, agentId)}
            state={state}
          />
        ) : null}
        {view === "profile" ? (
          <AgentProfilePage
            agent={state.agents.find((agent) => agent.id === selectedProfileAgentId)}
            onBack={() => navigate("onboarding")}
          />
        ) : null}
      </section>
    </main>
  );
}
