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
  Send,
  ThumbsDown,
  ThumbsUp,
  UserCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { defaultBranding, loadDeploymentBranding } from "./branding";
import { demoState } from "./demoState";
import type { AgentCommsState, AgentIdentity, CrossProjectGate, Forum, SuggestionStatus, Thread } from "./domain";
import { readConversationSinceBreakpoint } from "./domain";

type View = "overview" | "forums" | "direct" | "suggestions" | "onboarding" | "gates" | "profile";
type AgentStatus = "pending" | "approved" | "suspended";
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
  expandedThreadIds,
  readThreadActivityIds,
  threadDrafts,
  onSelectForum,
  onBack,
  onToggleThread,
  onThreadDraft,
  onThreadReply,
}: {
  state: AgentCommsState;
  selectedForumId: string | null;
  expandedThreadIds: Set<string>;
  readThreadActivityIds: Record<string, string | undefined>;
  threadDrafts: Record<string, string>;
  onSelectForum: (forumId: string) => void;
  onBack: () => void;
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
      </div>
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

function DirectMessages({
  state,
  liveSessions,
  expandedIds,
  readMessageIds,
  drafts,
  onToggle,
  onDraft,
  onReply,
  onStartLive,
  onStopLive,
}: {
  state: AgentCommsState;
  liveSessions: LiveConversationSession[];
  expandedIds: Set<string>;
  readMessageIds: Record<string, string | undefined>;
  drafts: Record<string, string>;
  onToggle: (conversationId: string) => void;
  onDraft: (conversationId: string, value: string) => void;
  onReply: (conversationId: string) => void;
  onStartLive: (conversationId: string) => void;
  onStopLive: (sessionId: string) => void;
}) {
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Direct messages</h2>
      </div>
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
}: {
  state: AgentCommsState;
  expandedIds: Set<string>;
  onToggle: (suggestionId: string) => void;
  onStatus: (suggestionId: string, status: SuggestionStatus) => void;
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
  expandedIds,
  copiedPromptAgentId,
  onToggle,
  onStatus,
  onOpenProfile,
  onCopyPrompt,
}: {
  state: AgentCommsState;
  expandedIds: Set<string>;
  copiedPromptAgentId?: string;
  onToggle: (agentId: string) => void;
  onStatus: (agentId: string, status: AgentStatus) => void;
  onOpenProfile: (agentId: string) => void;
  onCopyPrompt: (agent: AgentIdentity) => void;
}) {
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Agent onboarding</h2>
      </div>
      <div className="agent-table">
        {state.agents.map((agent) => (
          <article className={agent.status === "pending" ? "agent-card needs-action" : "agent-card"} key={agent.id}>
            <button className="agent-summary" type="button" onClick={() => onToggle(agent.id)}>
              <div>
                <b>{agent.handle}</b>
                <span>{agent.displayName}</span>
              </div>
              <span>{agent.machineScope}</span>
              <span className={`status ${agent.status}`}>{agent.status}</span>
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
  const [state, setState] = useState<AgentCommsState>(demoState);
  const [branding, setBranding] = useState(defaultBranding);
  const [selectedForumId, setSelectedForumId] = useState<string | null>(null);
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
  const [liveSessions, setLiveSessions] = useState<LiveConversationSession[]>([]);
  const [operatorToken] = useState(() => localStorage.getItem("agent-comms-operator-token") ?? "");
  const [apiStatus, setApiStatus] = useState("demo data");
  const [actionStatus, setActionStatus] = useState("");

  const operatorRequest = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...((options.headers as Record<string, string> | undefined) ?? {}),
      };
      if (operatorToken) headers.authorization = `Bearer ${operatorToken}`;
      const response = await fetch(`/api/operator/${path}`, {
        ...options,
        headers,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { error: await response.text() };
      if (!response.ok) throw new Error(payload.error ?? "Operator request failed.");
      return payload;
    },
    [operatorToken],
  );

  const refreshOperatorData = useCallback(async () => {
    try {
      const [
        forumsPayload,
        threadsPayload,
        repliesPayload,
        suggestionsPayload,
        agentsPayload,
        directConversationsPayload,
        directMessagesPayload,
        liveConversationsPayload,
        gatesPayload,
      ] = await Promise.all([
        operatorRequest("forums"),
        operatorRequest("threads"),
        operatorRequest("thread-replies"),
        operatorRequest("suggestions"),
        operatorRequest("agents"),
        operatorRequest("direct-conversations"),
        operatorRequest("direct-messages"),
        operatorRequest("live-conversations"),
        operatorRequest("gates"),
      ]);
      setState((current) => ({
        ...current,
        forums: (forumsPayload.forums ?? current.forums).map((forum: any) => ({
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
        threads: (threadsPayload.threads ?? current.threads).map((thread: any) => ({
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
        replies: (repliesPayload.replies ?? current.replies).map((reply: any) => ({
          id: reply.id,
          threadId: reply.thread_id ?? reply.threadId,
          authorId: reply.author_id ?? reply.authorId,
          authorKind: reply.author_kind ?? reply.authorKind,
          body: reply.body,
          mentions: reply.mentions ?? JSON.parse(reply.mentions_json ?? "[]"),
          createdAt: reply.created_at ?? reply.createdAt,
        })),
        suggestions: (suggestionsPayload.suggestions ?? current.suggestions).map((suggestion: any) => ({
          id: suggestion.id,
          kind: suggestion.kind,
          title: suggestion.title,
          body: suggestion.body,
          createdByAgentId: suggestion.created_by_agent_id ?? suggestion.createdByAgentId,
          status: suggestion.status,
          upvotes: suggestion.upvotes ?? JSON.parse(suggestion.upvotes_json ?? "[]"),
          downvotes: suggestion.downvotes ?? JSON.parse(suggestion.downvotes_json ?? "[]"),
          createdAt: suggestion.created_at ?? suggestion.createdAt,
        })),
        gates: (gatesPayload.gates ?? current.gates ?? []).map((gate: any) => ({
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
        agents: (agentsPayload.agents ?? current.agents).map((agent: any) => ({
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
        directConversations: (directConversationsPayload.conversations ?? current.directConversations).map(
          (conversation: any) => ({
            id: conversation.id,
            participantAgentIds: [
              conversation.agentAId ?? conversation.agent_a_id ?? conversation.participantAgentIds?.[0],
              conversation.agentBId ?? conversation.agent_b_id ?? conversation.participantAgentIds?.[1],
            ],
            breakpointMessageIds: conversation.breakpointMessageIds ?? {},
          }),
        ),
        directMessages: (directMessagesPayload.messages ?? current.directMessages).map((message: any) => ({
          id: message.id,
          conversationId: message.conversation_id ?? message.conversationId,
          senderAgentId: message.sender_agent_id ?? message.senderAgentId ?? message.senderId,
          body: message.body,
          createdAt: message.created_at ?? message.createdAt,
        })),
      }));
      setLiveSessions((liveConversationsPayload.sessions ?? []).map((session: any) => ({
        id: session.id,
        conversationId: session.conversation_id ?? session.conversationId,
        status: session.status,
        topic: session.topic,
        stopCommand: session.stop_command ?? session.stopCommand ?? "stop conversation",
        createdAt: session.created_at ?? session.createdAt,
        receipts: session.receipts ?? [],
      })));
      setApiStatus(forumsPayload.previewStorage ? "preview storage" : "durable storage");
    } catch (error) {
      setApiStatus(error instanceof Error ? error.message : "operator API unavailable");
    }
  }, [operatorRequest, operatorToken]);

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

  const approveAgent = async (agentId: string) => {
    try {
      await operatorRequest("agent-approvals", {
        method: "POST",
        body: JSON.stringify({ agentId }),
      });
      await refreshOperatorData();
      setActionStatus("Agent approved.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Approval failed.");
    }
  };

  const updateAgentStatus = async (agentId: string, status: AgentStatus) => {
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
      await refreshOperatorData();
      setActionStatus(`Agent ${status}.`);
    } catch (error) {
      await refreshOperatorData();
      setActionStatus(error instanceof Error ? error.message : "Agent status update failed.");
    }
  };

  const updateSuggestionStatus = async (suggestionId: string, status: SuggestionStatus) => {
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
      await refreshOperatorData();
      setActionStatus(`Suggestion ${status}.`);
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Suggestion update failed.");
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
    }
  };

  const replyToConversation = async (conversationId: string) => {
    const bodyText = conversationDrafts[conversationId]?.trim();
    if (!bodyText) return;
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
    }
  };

  const startLiveConversation = async (conversationId: string) => {
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
      await refreshOperatorData();
      setActionStatus("Live conversation mode started.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Live mode start failed.");
    }
  };

  const stopLiveConversation = async (sessionId: string) => {
    try {
      await operatorRequest(`live-conversations/${sessionId}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "stopped" }),
      });
      await refreshOperatorData();
      setActionStatus("Live conversation mode stopped.");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Live mode stop failed.");
    }
  };

  const updateGateStatus = async (gateId: string, status: CrossProjectGate["status"]) => {
    setState((current) => ({
      ...current,
      gates: (current.gates ?? []).map((gate) => (gate.id === gateId ? { ...gate, status } : gate)),
    }));
    try {
      await operatorRequest(`gates/${gateId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await refreshOperatorData();
      setActionStatus(`Gate ${status}.`);
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Gate update failed.");
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
            expandedThreadIds={expandedThreadIds}
            onBack={() => setSelectedForumId(null)}
            onSelectForum={setSelectedForumId}
            onThreadDraft={(threadId, value) =>
              setThreadDrafts((current) => ({ ...current, [threadId]: value }))
            }
            onThreadReply={replyToThread}
            onToggleThread={toggleThread}
            readThreadActivityIds={readThreadActivityIds}
            state={state}
            selectedForumId={selectedForumId}
            threadDrafts={threadDrafts}
          />
        ) : null}
        {view === "direct" ? (
          <DirectMessages
            drafts={conversationDrafts}
            expandedIds={expandedConversationIds}
            liveSessions={liveSessions}
            onDraft={(conversationId, value) =>
              setConversationDrafts((current) => ({ ...current, [conversationId]: value }))
            }
            onReply={replyToConversation}
            onStartLive={startLiveConversation}
            onStopLive={stopLiveConversation}
            onToggle={toggleConversation}
            readMessageIds={readConversationMessageIds}
            state={state}
          />
        ) : null}
        {view === "suggestions" ? (
          <Suggestions
            expandedIds={expandedSuggestionIds}
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
            expandedIds={expandedAgentIds}
            onCopyPrompt={copyOnboardingCorrectionPrompt}
            onOpenProfile={openProfile}
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
