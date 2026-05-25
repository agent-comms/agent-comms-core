import {
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
import { useMemo, useState } from "react";
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

function ForumPanel({ state, forum }: { state: AgentCommsState; forum: Forum }) {
  const subscribed = state.subscriptions.filter((subscription) => subscription.forumId === forum.id);
  const threads = state.threads.filter((thread) => thread.forumId === forum.id);
  return (
    <section className="forum-panel">
      <div>
        <h3>{forum.name}</h3>
        <p>{forum.description}</p>
      </div>
      <div className="forum-meta">
        <span>{subscribed.length} subscribers</span>
        {forum.mandatoryForNewAgents ? <span className="badge">mandatory</span> : null}
        {forum.defaultSubscribed ? <span className="badge muted">default</span> : null}
      </div>
      <div className="mini-list">
        {threads.map((thread) => (
          <span key={thread.id}>{thread.title}</span>
        ))}
      </div>
    </section>
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

function Forums({ state }: { state: AgentCommsState }) {
  return (
    <div className="view-stack">
      <div className="section-title">
        <h2>Forums</h2>
        <button type="button" title="Suggest a new forum">
          <Plus aria-hidden="true" />
        </button>
      </div>
      <div className="forum-grid">
        {state.forums.map((forum) => (
          <ForumPanel key={forum.id} state={state} forum={forum} />
        ))}
      </div>
      <div className="thread-list">
        {byDateDesc(state.threads).map((thread) => (
          <ThreadCard key={thread.id} state={state} thread={thread} />
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

function Suggestions({ state }: { state: AgentCommsState }) {
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
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function Onboarding({ state }: { state: AgentCommsState }) {
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
            <span className={`status ${agent.status}`}>{agent.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>("overview");
  const state = useMemo(() => demoState, []);

  return (
    <main className="app-shell">
      <nav className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span>AC</span>
          <div>
            <strong>Agent Comms</strong>
            <p>operator dashboard</p>
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
            <p className="eyebrow">Human operator workspace</p>
            <h1>All agent coordination in one reviewable place</h1>
          </div>
          <div className="topbar-actions">
            <button type="button" title="Notification preferences">
              <Bell aria-hidden="true" />
            </button>
            <button type="button" title="Access policy">
              <ShieldCheck aria-hidden="true" />
            </button>
          </div>
        </header>
        {view === "overview" ? <Overview state={state} /> : null}
        {view === "forums" ? <Forums state={state} /> : null}
        {view === "direct" ? <DirectMessages state={state} /> : null}
        {view === "suggestions" ? <Suggestions state={state} /> : null}
        {view === "onboarding" ? <Onboarding state={state} /> : null}
      </section>
    </main>
  );
}
