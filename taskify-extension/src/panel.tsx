/**
 * The side panel.
 *
 * Four tabs over one shared state: Boards, Upcoming, Chat and Settings. The panel is the
 * extension's whole user interface; everything else is a library it calls.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AppProvider, useApp, type PanelTab } from "./ui/state";
import { SignIn } from "./ui/SignIn";
import { Boards } from "./ui/Boards";
import { Upcoming } from "./ui/Upcoming";
import { Chat } from "./ui/Chat";
import { Settings } from "./ui/Settings";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "boards", label: "Boards" },
  { id: "upcoming", label: "Upcoming" },
  { id: "chat", label: "Chat" },
  { id: "settings", label: "Settings" },
];

function Shell() {
  const { identity, error, toast, refresh, loading } = useApp();
  const [tab, setTab] = useState<PanelTab>("boards");

  if (!identity) {
    return (
      <div className="app">
        <TopBar loading={loading} onRefresh={refresh} />
        <div className="body">
          <SignIn />
        </div>
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar loading={loading} onRefresh={refresh} />
      <nav className="tabs" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tab${tab === entry.id ? " tab--active" : ""}`}
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? "page" : undefined}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="body">
        {error ? (
          <div className="pad">
            <div className="banner banner--error">{error}</div>
          </div>
        ) : null}
        {tab === "boards" ? <Boards /> : null}
        {tab === "upcoming" ? <Upcoming /> : null}
        {tab === "chat" ? <Chat /> : null}
        {tab === "settings" ? <Settings /> : null}
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function TopBar({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark" aria-hidden="true" />
        <span className="topbar__name">Taskify</span>
      </div>
      <button
        type="button"
        className="iconbtn"
        onClick={() => void onRefresh()}
        disabled={loading}
        aria-label="Refresh"
        title="Refresh"
      >
        {loading ? <span className="spinner" /> : "↻"}
      </button>
    </header>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <AppProvider>
        <Shell />
      </AppProvider>
    </React.StrictMode>,
  );
}
