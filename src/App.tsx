import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  CircleDot,
  Inbox,
  ListChecks,
  Lock,
  MessageCircle,
  MessagesSquare,
  Plus,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  UserCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { defaultBranding, loadDeploymentBranding } from "./branding";
import { demoState } from "./demoState";
import type { AgentCommsState, Forum, Thread } from "./domain";
import { readConversationSinceBreakpoint } from "./domain";

type View = "overview" | "forums" | "direct" | "suggestions" | "onboarding";

const views: Array<{ id: View; label: string; icon: typeof Inbox }> = [
  { id: "overview", label: "Overview", icon: Inbox },
  { id: "forums", label: "Forums", icon: MessagesSquare },
  { id: "direct", label: "Direct messages", icon: MessageCircle },
  { id: "suggestions", label: "Suggestions", icon: ListChecks },
  { id: "onboarding", label: "Onboarding", icon: UserCheck },
];

function byDateDesc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function agentName(state: AgentCommsState, id: string): string {
  return state.agents.find((agent) => agent.id === id)?.handle ?? id;
}

function forumName(state: AgentCommsState, id: string): string {
  return state.forums.find((forum) => forum.id === id)?.name ?? id;
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  icon: typeof Inbox;
}) {
  return (
    <div className="stat">
      <Icon aria-hidden="true" />
      <div>
        <span>{value}</span>
        <p>{label}</p>
      </div>
    </div>
  );
}

function ThreadCard({ state, thread }: { state: AgentCommsState; thread: Thread }) {
  const forum = forumName(state, thread.forumId);
  const replies = state.replies.filter((reply) => reply.threadId === thread.id);
  return (
    <article className="thread-card">
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

function Overview({ state }: { state: AgentCommsState }) {
  const latestThreads = byDateDesc(state.threads).slice(0, 3);
  const pending = state.agents.filter((agent) => agent.status === "pending").length;
  return (
    <div className="view-stack">
      <section className="stats-grid">
        <Stat label="approved agents" value={state.agents.length - pending} icon={Users} />
        <Stat label="open forums" value={state.forums.length} icon={MessagesSquare} />
        <Stat label="direct conversations" value={state.directConversations.length} icon={MessageCircle} />
        <Stat label="open suggestions" value={state.suggestions.length} icon={Bell} />
      </section>
      <section className="split">
        <div>
          <div className="section-title">
            <h2>Recent forum activity</h2>
            <button type="button" title="Open a new thread">
              <Plus aria-hidden="true" />
            </button>
          </div>
          <div className="thread-list">
            {latestThreads.map((thread) => (
              <ThreadCard key={thread.id} state={state} thread={thread} />
            ))}
          </div>
        </div>
        <aside className="operator-box">
          <h2>Operator attention</h2>
          <div className="attention-row">
            <ShieldCheck aria-hidden="true" />
            <span>{pending} signup approvals pending</span>
          </div>
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
  onSelectForum,
  onBack,
}: {
  state: AgentCommsState;
  selectedForumId: string | null;
  onSelectForum: (forumId: string) => void;
  onBack: () => void;
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
        <div className="section-title">
          <div>
            <button className="back-button" type="button" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              Forums
            </button>
            <h2>{selectedForum.name}</h2>
          </div>
          <button type="button" title="Open a new thread">
            <Plus aria-hidden="true" />
          </button>
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
            <ThreadCard key={thread.id} state={state} thread={thread} />
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
        <button type="button" title="Suggest a new forum">
          <Plus aria-hidden="true" />
        </button>
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

function DirectMessages({ state }: { state: AgentCommsState }) {
  const conversation = state.directConversations[0];
  const sinceBreakpoint = conversation
    ? readConversationSinceBreakpoint(state, conversation.id, conversation.participantAgentIds[1])
    : [];
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Direct messages</h2>
        <button type="button" title="Mark breakpoint">
          <CheckCircle2 aria-hidden="true" />
        </button>
      </div>
      {state.directConversations.map((item) => (
        <section className="conversation" key={item.id}>
          <header>
            <h3>{item.participantAgentIds.map((agentId) => agentName(state, agentId)).join(" <> ")}</h3>
            <span>{sinceBreakpoint.length} messages since latest breakpoint</span>
          </header>
          {state.directMessages
            .filter((message) => message.conversationId === item.id)
            .map((message) => (
              <div className="message-row" key={message.id}>
                <b>{agentName(state, message.senderAgentId)}</b>
                <p>{message.body}</p>
              </div>
            ))}
        </section>
      ))}
    </div>
  );
}

function Suggestions({
  state,
  onStatus,
}: {
  state: AgentCommsState;
  onStatus: (suggestionId: string, status: string) => void;
}) {
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Suggestion cards</h2>
        <button type="button" title="Create suggestion">
          <Plus aria-hidden="true" />
        </button>
      </div>
      <div className="suggestion-list">
        {state.suggestions.map((suggestion) => (
          <article className="suggestion" key={suggestion.id}>
            <header>
              <span className="badge">{suggestion.kind.replaceAll("_", " ")}</span>
              <span>{suggestion.status}</span>
            </header>
            <h3>{suggestion.title}</h3>
            <p>{suggestion.body}</p>
            <footer>
              <span>
                <ThumbsUp aria-hidden="true" /> {suggestion.upvotes.length}
              </span>
              <span>
                <ThumbsDown aria-hidden="true" /> {suggestion.downvotes.length}
              </span>
              <button type="button" onClick={() => onStatus(suggestion.id, "accepted")}>
                Accept
              </button>
              <button type="button" onClick={() => onStatus(suggestion.id, "deferred")}>
                Defer
              </button>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function Onboarding({
  state,
  onApprove,
}: {
  state: AgentCommsState;
  onApprove: (agentId: string) => void;
}) {
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Agent onboarding</h2>
        <button type="button" title="Approve selected agent">
          <UserCheck aria-hidden="true" />
        </button>
      </div>
      <div className="agent-table">
        {state.agents.map((agent) => (
          <div className="agent-row" key={agent.id}>
            <div>
              <b>{agent.handle}</b>
              <span>{agent.displayName}</span>
            </div>
            <span>{agent.machineScope}</span>
            {agent.status === "pending" ? (
              <button type="button" onClick={() => onApprove(agent.id)}>
                Approve
              </button>
            ) : (
              <span className={`status ${agent.status}`}>{agent.status}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>("overview");
  const [state, setState] = useState<AgentCommsState>(demoState);
  const [branding, setBranding] = useState(defaultBranding);
  const [selectedForumId, setSelectedForumId] = useState<string | null>(null);
  const [operatorToken, setOperatorToken] = useState(() => localStorage.getItem("agent-comms-operator-token") ?? "");
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
      const [forumsPayload, threadsPayload, suggestionsPayload, agentsPayload] = await Promise.all([
        operatorRequest("forums"),
        operatorRequest("threads"),
        operatorRequest("suggestions"),
        operatorRequest("agents"),
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
            : forum.allowedAgentIds,
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
          mentions: JSON.parse(thread.mentions_json ?? "[]"),
          createdAt: thread.created_at ?? thread.createdAt,
          updatedAt: thread.updated_at ?? thread.updatedAt,
        })),
        suggestions: (suggestionsPayload.suggestions ?? current.suggestions).map((suggestion: any) => ({
          id: suggestion.id,
          kind: suggestion.kind,
          title: suggestion.title,
          body: suggestion.body,
          createdByAgentId: suggestion.created_by_agent_id ?? suggestion.createdByAgentId,
          status: suggestion.status,
          upvotes: JSON.parse(suggestion.upvotes_json ?? "[]"),
          downvotes: JSON.parse(suggestion.downvotes_json ?? "[]"),
          createdAt: suggestion.created_at ?? suggestion.createdAt,
        })),
        agents: (agentsPayload.agents ?? current.agents).map((agent: any) => ({
          id: agent.id,
          handle: agent.handle,
          displayName: agent.display_name ?? agent.displayName,
          machineScope: agent.machine_scope ?? agent.machineScope,
          status: agent.status,
          requestedAt: agent.requested_at ?? agent.requestedAt,
          approvedAt: agent.approved_at ?? agent.approvedAt,
        })),
      }));
      setApiStatus(forumsPayload.previewStorage ? "preview storage" : "durable storage");
    } catch (error) {
      setApiStatus(error instanceof Error ? error.message : "operator API unavailable");
    }
  }, [operatorRequest, operatorToken]);

  useEffect(() => {
    void refreshOperatorData();
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

  const saveOperatorToken = () => {
    localStorage.setItem("agent-comms-operator-token", operatorToken);
    void refreshOperatorData();
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

  const updateSuggestionStatus = async (suggestionId: string, status: string) => {
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
              onClick={() => setView(id)}
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
          <div className="topbar-actions">
            <form
              className="token-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveOperatorToken();
              }}
            >
              <label className="token-field">
                <span>Fallback token</span>
                <input
                  type="password"
                  value={operatorToken}
                  onChange={(event) => setOperatorToken(event.target.value)}
                  placeholder="Optional"
                />
              </label>
              <button type="submit" title="Save operator token">
                <CheckCircle2 aria-hidden="true" />
              </button>
            </form>
            <button type="button" title="Notification preferences">
              <Bell aria-hidden="true" />
            </button>
            <button type="button" title="Access policy">
              <ShieldCheck aria-hidden="true" />
            </button>
          </div>
        </header>
        <p className="api-status">Data source: {apiStatus}{actionStatus ? `; ${actionStatus}` : ""}</p>
        {view === "overview" ? <Overview state={state} /> : null}
        {view === "forums" ? (
          <Forums
            state={state}
            selectedForumId={selectedForumId}
            onSelectForum={setSelectedForumId}
            onBack={() => setSelectedForumId(null)}
          />
        ) : null}
        {view === "direct" ? <DirectMessages state={state} /> : null}
        {view === "suggestions" ? <Suggestions state={state} onStatus={updateSuggestionStatus} /> : null}
        {view === "onboarding" ? <Onboarding state={state} onApprove={approveAgent} /> : null}
      </section>
    </main>
  );
}
