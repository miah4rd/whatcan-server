import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { RefreshCw, Home as HomeIcon, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import { LangToggle } from "@/lib/i18n";

const AMO_BASE = "https://unicornproperty.amocrm.ru/leads/detail";
const PAGE_SIZE = 50;

type CrmTask = {
  id: string;
  leadId: string;
  taskDate: string;
  taskText: string;
  status: string;
  closedAt: string | null;
  webhookStatus: number | null;
  createdAt: string;
};

type TasksResponse = {
  tasks: CrmTask[];
  total: number;
};

function pad(n: number) { return String(n).padStart(2, "0"); }
function toInputDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatDateShort(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function Tasks() {
  const [, navigate] = useLocation();

  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const now = new Date();
  const [from, setFrom] = useState(() => {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return toInputDate(d);
  });
  const [to, setTo] = useState(() => toInputDate(now));
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all");
  const [leadIdFilter, setLeadIdFilter] = useState("");

  const load = useCallback(async (pageNum: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        from,
        to,
        limit: String(PAGE_SIZE),
        offset: String(pageNum * PAGE_SIZE),
      });
      if (leadIdFilter.trim()) params.set("leadId", leadIdFilter.trim());

      const r = await fetch(`/api/analytics/tasks?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as TasksResponse;
      setTasks(data.tasks ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, from, to, leadIdFilter]);

  useEffect(() => {
    setPage(0);
    void load(0);
  }, [load]);

  function handlePageChange(newPage: number) {
    setPage(newPage);
    void load(newPage);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a0f",
      color: "#e2e8f0",
      fontFamily: "'Inter', system-ui, sans-serif",
      padding: "0 0 60px",
    }}>
      {/* Header */}
      <div style={{
        background: "rgba(15,15,25,0.95)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        padding: "16px 28px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <button
          onClick={() => navigate("/dashboard")}
          style={{
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            color: "#94a3b8",
            cursor: "pointer",
            padding: "6px 12px",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <HomeIcon size={14} /> Dashboard
        </button>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", margin: 0, flex: 1 }}>
          CRM Tasks
        </h1>
        <button
          onClick={() => load(page)}
          disabled={loading}
          style={{
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            color: "#94a3b8",
            cursor: "pointer",
            padding: "6px 12px",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <RefreshCw size={13} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
          Refresh
        </button>
        <LangToggle />
      </div>

      {/* Filters */}
      <div style={{
        padding: "20px 28px 0",
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        alignItems: "flex-end",
      }}>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Status
          </label>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as "all" | "open" | "closed")}
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "#e2e8f0",
              padding: "7px 12px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            From
          </label>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "#e2e8f0",
              padding: "7px 12px",
              fontSize: 13,
            }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            To
          </label>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "#e2e8f0",
              padding: "7px 12px",
              fontSize: 13,
            }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "#64748b", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Lead ID
          </label>
          <input
            type="text"
            value={leadIdFilter}
            onChange={e => setLeadIdFilter(e.target.value)}
            placeholder="e.g. 22477775"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "#e2e8f0",
              padding: "7px 12px",
              fontSize: 13,
              width: 140,
            }}
          />
        </div>
        <div style={{ color: "#64748b", fontSize: 13, paddingBottom: 8 }}>
          {total} tasks
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          margin: "16px 28px 0",
          padding: "12px 16px",
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.25)",
          borderRadius: 8,
          color: "#f87171",
          fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ padding: "16px 28px 0", overflowX: "auto" }}>
        <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
              {["Task Date", "Lead", "Task Text", "Status", "Created"].map(h => (
                <th key={h} style={{
                  padding: "10px 14px",
                  textAlign: "left",
                  color: "#64748b",
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  whiteSpace: "nowrap",
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && tasks.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: "40px 14px", textAlign: "center", color: "#475569" }}>
                  Loading…
                </td>
              </tr>
            )}
            {!loading && tasks.length === 0 && !error && (
              <tr>
                <td colSpan={5} style={{ padding: "40px 14px", textAlign: "center", color: "#475569" }}>
                  No tasks found
                </td>
              </tr>
            )}
            {tasks.map((task) => (
              <tr
                key={task.id}
                style={{
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <td style={{ padding: "12px 14px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                  {formatDateShort(task.taskDate)}
                </td>
                <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                  <a
                    href={`${AMO_BASE}/${task.leadId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: "#60a5fa",
                      textDecoration: "none",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {task.leadId}
                    <ExternalLink size={11} />
                  </a>
                </td>
                <td style={{ padding: "12px 14px", color: "#cbd5e1", maxWidth: 480, lineHeight: 1.5 }}>
                  {task.taskText}
                </td>
                <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                  <span style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 20,
                    fontSize: 11,
                    fontWeight: 600,
                    background: task.status === "open"
                      ? "rgba(52,211,153,0.12)"
                      : "rgba(100,116,139,0.18)",
                    color: task.status === "open" ? "#34d399" : "#64748b",
                    border: task.status === "open"
                      ? "1px solid rgba(52,211,153,0.25)"
                      : "1px solid rgba(100,116,139,0.25)",
                    letterSpacing: "0.03em",
                  }}>
                    {task.status}
                  </span>
                </td>
                <td style={{ padding: "12px 14px", color: "#475569", whiteSpace: "nowrap" }}>
                  {formatDateShort(task.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          padding: "16px 28px 0",
          display: "flex",
          alignItems: "center",
          gap: 12,
          justifyContent: "flex-end",
        }}>
          <button
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 0 || loading}
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: page === 0 ? "#334155" : "#94a3b8",
              cursor: page === 0 ? "default" : "pointer",
              padding: "6px 10px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <ChevronLeft size={14} />
          </button>
          <span style={{ fontSize: 13, color: "#64748b" }}>
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => handlePageChange(page + 1)}
            disabled={page >= totalPages - 1 || loading}
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: page >= totalPages - 1 ? "#334155" : "#94a3b8",
              cursor: page >= totalPages - 1 ? "default" : "pointer",
              padding: "6px 10px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input[type="date"] { color-scheme: dark; }
      `}</style>
    </div>
  );
}
