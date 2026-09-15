import { Fragment, StrictMode, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Box,
  Button,
  CssBaseline,
  Divider,
  Drawer,
  FormControl,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  Toolbar,
  Tooltip,
  ThemeProvider,
  Typography,
  createTheme,
} from "@mui/material";
import type {
  BusinessInfo,
  ConversationMessage,
  LeadRecord,
  QAPair,
} from "@janua/core";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";

type BusinessInfoDraft = Omit<BusinessInfo, "custom_fields"> & {
  customFields: Array<{ key: string; value: string }>;
};

type KnowledgeInput = Pick<QAPair, "question" | "answer" | "tags">;

type SiteSettings = {
  embedCode: string;
};

type AdminSettingsPayload = {
  businessInfo: BusinessInfo;
  site: SiteSettings;
  runtime: {
    nodeEnv: string;
    publicBaseUrl: string;
    databaseConfigured: boolean;
    rateLimitEnabled: boolean;
    trustProxy: boolean;
    securityHeadersEnabled: boolean;
    conversationCleanupEnabled: boolean;
  };
  secrets: Record<string, { configured: boolean; masked: string }>;
};

type AdminSessionPayload = {
  authenticated: boolean;
  expiresAt?: string;
};

type PaginationState = {
  page: number;
  limit: number;
  total: number;
};

type AdminPage = "leads" | "knowledge" | "site";

type SortOrder = "asc" | "desc";

type LeadColumnId = "name" | "phone" | "email" | "createdAt" | "status";

type LeadColumn = {
  id: LeadColumnId;
  label: string;
  numeric?: boolean;
};

type FaqColumnId = "question" | "answer";

type FaqColumn = {
  id: FaqColumnId;
  label: string;
};

const pageMeta: Record<AdminPage, { label: string }> = {
  leads: {
    label: "Lead Inbox",
  },
  knowledge: {
    label: "Business Knowledge",
  },
  site: {
    label: "Website Widget",
  },
};

const emptyBusinessInfo: BusinessInfo = {
  business_name: "",
  phone: "",
  email: "",
  address: "",
  store_hours: "",
  services: "",
  custom_fields: {},
};

const emptySiteSettings: SiteSettings = {
  embedCode: "",
};

const defaultPagination: PaginationState = {
  page: 1,
  limit: 20,
  total: 0,
};

const leadColumns: LeadColumn[] = [
  { id: "name", label: "Name" },
  { id: "phone", label: "Phone" },
  { id: "email", label: "Email" },
  { id: "createdAt", label: "Created" },
  { id: "status", label: "Status" },
];

const faqColumns: FaqColumn[] = [
  { id: "question", label: "Question" },
  { id: "answer", label: "Answer" },
];

const drawerWidth = 292;
const collapsedDrawerWidth = 88;

const adminTheme = createTheme({
  palette: {
    mode: "light",
    background: {
      default: "#f5f5f7",
      paper: "rgba(255, 255, 255, 0.86)",
    },
    primary: {
      main: "#007aff",
      dark: "#0066cc",
    },
    text: {
      primary: "#1d1d1f",
      secondary: "#6e6e73",
    },
    divider: "rgba(29, 29, 31, 0.1)",
  },
  typography: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shape: {
    borderRadius: 14,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          textTransform: "none",
          fontWeight: 700,
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          background: "rgba(255, 255, 255, 0.74)",
          backdropFilter: "saturate(180%) blur(24px)",
          borderColor: "rgba(29, 29, 31, 0.1)",
        },
      },
    },
  },
});

function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage("janua:sidebarCollapsed", "false");
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo>(emptyBusinessInfo);
  const [qaPairs, setQaPairs] = useState<QAPair[]>([]);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [leadPagination, setLeadPagination] = useState<PaginationState>(defaultPagination);
  const [knowledgePagination, setKnowledgePagination] = useState<PaginationState>(defaultPagination);
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(emptySiteSettings);
  const [status, setStatus] = useState<{ message: string; isError: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{
    conversationId: string;
    messages: ConversationMessage[];
    loading: boolean;
    error?: string;
    lastUpdatedAt?: string;
  } | null>(null);

  const api = useMemo(() => createAdminApi(), []);
  const isCollapsed = sidebarCollapsed === "true";

  useEffect(() => {
    void checkSession();
  }, [api]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    void reloadAll();
  }, [authState, api]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!transcript?.conversationId) return;
    const conversationId = transcript.conversationId;
    const timer = window.setInterval(() => {
      void loadTranscript(conversationId, { background: true });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [transcript?.conversationId]);

  async function reloadAll(): Promise<void> {
    try {
      const [settingsBody, knowledge, leadBody] = await Promise.all([
        api.get<{ settings: AdminSettingsPayload }>("/api/admin/settings"),
        api.get<{ qaPairs: QAPair[]; pagination: PaginationState }>(adminListPath("/api/admin/knowledge", knowledgePagination)),
        api.get<{ leads: LeadRecord[]; pagination: PaginationState }>(adminListPath("/api/admin/leads", leadPagination)),
      ]);
      setBusinessInfo(settingsBody.settings.businessInfo);
      setQaPairs(knowledge.qaPairs);
      setLeads(leadBody.leads);
      setKnowledgePagination(knowledge.pagination);
      setLeadPagination(leadBody.pagination);
      setSiteSettings(settingsBody.settings.site);
      setStatus(null);
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  const handleAuthError = useCallback((error: unknown): boolean => {
    if (error instanceof AdminApiError && error.status === 401 && error.code === "AUTH_INVALID") {
      setAuthState("unauthenticated");
      setStatus({ message: "Session expired. Please sign in again.", isError: true });
      return true;
    }
    return false;
  }, []);

  async function checkSession(): Promise<void> {
    try {
      await api.get<AdminSessionPayload>("/api/admin/session");
      setAuthState("authenticated");
      setStatus(null);
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) {
        setAuthState("unauthenticated");
        return;
      }
      setAuthState("unauthenticated");
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  async function login(input: { password: string }): Promise<void> {
    try {
      await api.login(input);
      setAuthState("authenticated");
      setStatus(null);
      setToast("Signed in");
    } catch (error) {
      setAuthState("unauthenticated");
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  async function refreshLeads(page = leadPagination.page): Promise<void> {
    try {
      const body = await api.get<{ leads: LeadRecord[]; pagination: PaginationState }>(
        adminListPath("/api/admin/leads", { ...leadPagination, page }),
      );
      setLeads(body.leads);
      setLeadPagination(body.pagination);
      setToast("Leads refreshed");
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  async function refreshKnowledge(page = knowledgePagination.page): Promise<void> {
    try {
      const body = await api.get<{ qaPairs: QAPair[]; pagination: PaginationState }>(
        adminListPath("/api/admin/knowledge", { ...knowledgePagination, page }),
      );
      setQaPairs(body.qaPairs);
      setKnowledgePagination(body.pagination);
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  async function loadTranscript(conversationId: string, options: { background?: boolean } = {}): Promise<void> {
    if (!options.background) {
      setTranscript({ conversationId, messages: [], loading: true });
    }
    try {
      const body = await api.get<{ messages: ConversationMessage[] }>(
        `/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`,
      );
      setTranscript({
        conversationId,
        messages: body.messages,
        loading: false,
        lastUpdatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (handleAuthError(error)) return;
      setTranscript((current) => ({
        conversationId,
        messages: options.background && current?.conversationId === conversationId ? current.messages : [],
        loading: false,
        error: errorMessage(error),
        lastUpdatedAt: current?.conversationId === conversationId ? current.lastUpdatedAt : undefined,
      }));
    }
  }

  async function openTranscript(conversationId: string): Promise<void> {
    await loadTranscript(conversationId);
  }

  const saveBusinessInfo = useCallback(async (next: BusinessInfo): Promise<void> => {
    try {
      await api.put("/api/admin/business-info", next);
      setBusinessInfo(next);
      setToast("Business info saved");
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }, [api, handleAuthError]);

  async function createKnowledge(input: KnowledgeInput): Promise<void> {
    try {
      await api.post("/api/admin/knowledge", input);
      await refreshKnowledge(1);
      setToast("Q&A added");
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  async function updateKnowledge(id: string, input: KnowledgeInput): Promise<void> {
    try {
      await api.put(`/api/admin/knowledge/${encodeURIComponent(id)}`, input);
      await refreshKnowledge();
      setToast("Q&A updated");
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  async function deleteKnowledge(id: string): Promise<void> {
    try {
      await api.delete(`/api/admin/knowledge/${encodeURIComponent(id)}`);
      await refreshKnowledge();
      setToast("Q&A deleted");
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  async function updateLeadStatus(id: string, nextStatus: LeadRecord["status"]): Promise<void> {
    try {
      const body = await api.patch<{ lead: LeadRecord }>(`/api/admin/leads/${encodeURIComponent(id)}/status`, {
        status: nextStatus,
      });
      setLeads((items) => items.map((lead) => (lead.id === id ? body.lead : lead)));
      setToast("Lead status updated");
    } catch (error) {
      if (handleAuthError(error)) return;
      setStatus({ message: errorMessage(error), isError: true });
    }
  }

  if (authState === "checking") {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>Janua Admin</h1>
          <p>Checking your session...</p>
        </section>
      </main>
    );
  }

  if (authState === "unauthenticated") {
    return <AdminLogin status={status} onSubmit={(input) => void login(input)} />;
  }

  return (
    <>
      <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
        <Drawer
          variant="permanent"
          sx={{
            width: isCollapsed ? collapsedDrawerWidth : drawerWidth,
            flexShrink: 0,
            "& .MuiDrawer-paper": {
              boxSizing: "border-box",
              width: isCollapsed ? collapsedDrawerWidth : drawerWidth,
              px: 2.5,
              py: 3.5,
              transition: "width 180ms ease",
              overflowX: "hidden",
              display: "flex",
              flexDirection: "column",
            },
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: isCollapsed ? "center" : "space-between", gap: 1.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
              <Box className="brand__mark" component="span">
                J
              </Box>
              {!isCollapsed ? (
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="h5" component="h1" sx={{ fontWeight: 760, letterSpacing: "-0.03em", lineHeight: 1 }}>
                    Janua
                  </Typography>
                </Box>
              ) : null}
            </Box>
          </Box>
          <Divider sx={{ my: 3 }} />
          <List aria-label="Admin sections" sx={{ display: "grid", gap: 0.75 }}>
            {(["leads", "knowledge", "site"] as AdminPage[]).map((page) => (
              <NavLink className="mui-nav-link" to={adminPagePath(page)} title={pageMeta[page].label} key={page}>
                {({ isActive }) => (
                  <ListItemButton
                    selected={isActive}
                    sx={{
                      minHeight: 52,
                      justifyContent: isCollapsed ? "center" : "flex-start",
                      borderRadius: 2,
                      px: isCollapsed ? 1 : 1.5,
                      "&.Mui-selected": {
                        bgcolor: "rgba(0, 122, 255, 0.1)",
                        color: "text.primary",
                      },
                      "&.Mui-selected:hover": {
                        bgcolor: "rgba(0, 122, 255, 0.14)",
                      },
                    }}
                  >
                    <ListItemIcon
                      sx={{
                        minWidth: isCollapsed ? 0 : 42,
                        color: isActive ? "primary.main" : "text.secondary",
                        justifyContent: "center",
                      }}
                    >
                      <Box className="mui-nav-icon" component="span">
                        <NavGlyph page={page} />
                      </Box>
                    </ListItemIcon>
                    {!isCollapsed ? (
                      <ListItemText
                        primary={pageMeta[page].label}
                        primaryTypographyProps={{ fontWeight: 700, fontSize: 14 }}
                      />
                    ) : null}
                  </ListItemButton>
                )}
              </NavLink>
            ))}
          </List>
          <Box sx={{ mt: "auto", pt: 2 }}>
            <Divider sx={{ mb: 1.5 }} />
            <ListItemButton
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!isCollapsed}
              onClick={() => setSidebarCollapsed(isCollapsed ? "false" : "true")}
              sx={{
                minHeight: 48,
                justifyContent: "center",
                borderRadius: 2,
                px: 1,
                color: "text.secondary",
              }}
            >
              <ListItemIcon
                sx={{
                  minWidth: 0,
                  color: "text.secondary",
                  justifyContent: "center",
                }}
              >
                <Box className="mui-nav-icon" component="span">
                  <ChevronGlyph direction={isCollapsed ? "right" : "left"} />
                </Box>
              </ListItemIcon>
            </ListItemButton>
          </Box>
        </Drawer>
        <Box component="main" sx={{ flexGrow: 1, minWidth: 0 }}>
          <Box className="content">
            {status ? <div className={`status ${status.isError ? "status--error" : ""}`}>{status.message}</div> : null}
            <Routes>
              <Route index element={<Navigate to="leads" replace />} />
              <Route
                path="leads"
                element={
                  <LeadCenter
                    leads={leads}
                    pagination={leadPagination}
                    onRefresh={() => void refreshLeads()}
                    onPageChange={(page) => void refreshLeads(page)}
                    onOpenTranscript={openTranscript}
                    onUpdateStatus={(id, nextStatus) => void updateLeadStatus(id, nextStatus)}
                  />
                }
              />
              <Route
                path="knowledge"
                element={
                  <KnowledgeBase
                    businessInfo={businessInfo}
                    qaPairs={qaPairs}
                    pagination={knowledgePagination}
                    onPageChange={(page) => void refreshKnowledge(page)}
                    onSaveBusinessInfo={saveBusinessInfo}
                    onCreateKnowledge={createKnowledge}
                    onUpdateKnowledge={updateKnowledge}
                    onDeleteKnowledge={deleteKnowledge}
                  />
                }
              />
              <Route path="site" element={<SiteInstallPage settings={siteSettings} />} />
              <Route path="*" element={<Navigate to="/leads" replace />} />
            </Routes>
          </Box>
        </Box>
      </Box>
      {transcript ? (
        <ConversationModal transcript={transcript} onClose={() => setTranscript(null)} />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}

function AdminLogin({
  status,
  onSubmit,
}: {
  status: { message: string; isError: boolean } | null;
  onSubmit: (value: { password: string }) => void;
}) {
  const [password, setPassword] = useState("");

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (password) onSubmit({ password });
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>Janua Admin</h1>
        <p>
          Enter your Admin password. The default is <code>admin-key</code>.
        </p>
        <p>
          For production, set a stronger password in <code>config/agent-config.json</code> under <code>admin.password</code>.
        </p>
        {status ? <div className={`status ${status.isError ? "status--error" : ""}`}>{status.message}</div> : null}
        <label>
          Admin password
          <input
            autoFocus
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}

function NavGlyph({ page }: { page: AdminPage }) {
  if (page === "leads") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
        <path d="M6 7.5a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M3.75 20.25c.7-3.55 3.05-5.4 6.25-5.4 2.18 0 3.96.86 5.08 2.52"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
        <path
          d="M16.25 10.25h3.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-4.2l-2.3 2v-9a1.5 1.5 0 0 1 1.5-1.5h1.5Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      </svg>
    );
  }

  if (page === "knowledge") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
        <path
          d="M5.75 4.75h5.1c1.1 0 1.9.8 1.9 1.9v12.6c0-1.1-.8-1.9-1.9-1.9h-5.1v-12.6Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
        <path
          d="M18.25 4.75h-5.1c-1.1 0-1.9.8-1.9 1.9v12.6c0-1.1.8-1.9 1.9-1.9h5.1v-12.6Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
        <path d="M8.25 8h2M8.25 11h2M14 8h2M14 11h2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
      <rect x="4.25" y="5.25" width="15.5" height="13.5" rx="2.25" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.75 9.25h14.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M8 15.25h4.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function ChevronGlyph({ direction }: { direction: "left" | "right" }) {
  const points = direction === "left" ? "14.5 6.5 9 12 14.5 17.5" : "9.5 6.5 15 12 9.5 17.5";
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
      <path d={`M${points}`} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function LeadCenter({
  leads,
  pagination,
  onRefresh,
  onPageChange,
  onOpenTranscript,
  onUpdateStatus,
}: {
  leads: LeadRecord[];
  pagination: PaginationState;
  onRefresh: () => void;
  onPageChange: (page: number) => void;
  onOpenTranscript: (conversationId: string) => void;
  onUpdateStatus: (id: string, status: LeadRecord["status"]) => void;
}) {
  const [order, setOrder] = useState<SortOrder>("desc");
  const [orderBy, setOrderBy] = useState<LeadColumnId>("createdAt");
  const sortedLeads = useMemo(() => sortLeads(leads, order, orderBy), [leads, order, orderBy]);

  function handleSort(columnId: LeadColumnId): void {
    const isAsc = orderBy === columnId && order === "asc";
    setOrder(isAsc ? "desc" : "asc");
    setOrderBy(columnId);
  }

  return (
    <section className="page" data-page="leads">
      <div className="page-actions">
        <Button variant="contained" type="button" onClick={onRefresh}>
          Refresh Leads
        </Button>
      </div>
      {leads.length > 0 ? (
        <Paper elevation={0} sx={{ overflow: "hidden", border: "1px solid", borderColor: "divider" }}>
          <Toolbar
            sx={{
              minHeight: 64,
              bgcolor: "background.paper",
              display: "flex",
              justifyContent: "space-between",
              gap: 2,
            }}
          >
            <Typography variant="h6" component="div">
              Lead Center
            </Typography>
            <Typography color="text.secondary" variant="body2">
              {pagination.total} total leads
            </Typography>
          </Toolbar>
          <TableContainer>
            <Table sx={{ minWidth: 860 }} aria-label="lead center table">
              <TableHead>
                <TableRow>
                  {leadColumns.map((column) => (
                    <TableCell
                      key={column.id}
                      align={column.numeric ? "right" : "left"}
                      sortDirection={orderBy === column.id ? order : false}
                    >
                      <TableSortLabel
                        active={orderBy === column.id}
                        direction={orderBy === column.id ? order : "asc"}
                        onClick={() => handleSort(column.id)}
                      >
                        {column.label}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                  <TableCell align="right">Conversation</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedLeads.map((lead) => (
                  <TableRow hover key={lead.id}>
                    <TableCell component="th" id={`lead-${lead.id}`} scope="row">
                      {lead.name}
                      {lead.company ? (
                        <Typography variant="body2" color="text.secondary">
                          {lead.company}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell>{lead.phone || "-"}</TableCell>
                    <TableCell>{lead.email || "-"}</TableCell>
                    <TableCell>{formatDate(lead.createdAt)}</TableCell>
                    <TableCell>
                      <FormControl size="small" fullWidth>
                        <Select
                          value={lead.status}
                          onChange={(event) => onUpdateStatus(lead.id, event.target.value as LeadRecord["status"])}
                        >
                          <MenuItem value="new">New</MenuItem>
                          <MenuItem value="contacted">Contacted</MenuItem>
                          <MenuItem value="not_interested">Not interested</MenuItem>
                        </Select>
                      </FormControl>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        variant="outlined"
                        size="small"
                        type="button"
                        onClick={() => onOpenTranscript(lead.conversationId)}
                      >
                        Show conversation
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={pagination.total}
            page={Math.max(0, pagination.page - 1)}
            rowsPerPage={pagination.limit}
            rowsPerPageOptions={[pagination.limit]}
            onPageChange={(_, page) => onPageChange(page + 1)}
          />
        </Paper>
      ) : (
        <EmptyState
          title="Your lead inbox is empty"
          detail="Install the widget on your site, then test with a message like 'Can someone call me?' to make sure capture works."
          actionLabel="Install the widget"
          to="/site"
        />
      )}
    </section>
  );
}

function EmptyState({
  title,
  detail,
  actionLabel,
  to,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  to?: string;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
      {actionLabel && to ? (
        <Link className="button-link" to={to}>
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

function KnowledgeBase({
  businessInfo,
  qaPairs,
  pagination,
  onPageChange,
  onSaveBusinessInfo,
  onCreateKnowledge,
  onUpdateKnowledge,
  onDeleteKnowledge,
}: {
  businessInfo: BusinessInfo;
  qaPairs: QAPair[];
  pagination: PaginationState;
  onPageChange: (page: number) => void;
  onSaveBusinessInfo: (input: BusinessInfo) => Promise<void>;
  onCreateKnowledge: (input: KnowledgeInput) => Promise<void>;
  onUpdateKnowledge: (id: string, input: KnowledgeInput) => Promise<void>;
  onDeleteKnowledge: (id: string) => Promise<void>;
}) {
  return (
    <section className="page" data-page="knowledge">
      <div className="split">
        <BusinessInfoForm businessInfo={businessInfo} onSave={onSaveBusinessInfo} />
        <KnowledgeList
          qaPairs={qaPairs}
          pagination={pagination}
          onPageChange={onPageChange}
          onCreate={onCreateKnowledge}
          onUpdate={onUpdateKnowledge}
          onDelete={onDeleteKnowledge}
        />
      </div>
    </section>
  );
}

function BusinessInfoForm({
  businessInfo,
  onSave,
}: {
  businessInfo: BusinessInfo;
  onSave: (input: BusinessInfo) => Promise<void>;
}) {
  const [draft, setDraft] = useState<BusinessInfoDraft>(() => businessInfoToDraft(businessInfo));

  useEffect(() => {
    setDraft(businessInfoToDraft(businessInfo));
  }, [businessInfo]);

  function update(name: keyof typeof draft, value: string): void {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  useEffect(() => {
    const payload = draftToBusinessInfo(draft);
    if (JSON.stringify(payload) === JSON.stringify(businessInfo)) return;
    return scheduleDebouncedSave(() => onSave(payload));
  }, [draft, businessInfo, onSave]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onSave(draftToBusinessInfo(draft));
  }

  return (
    <section className="card">
      <h4>Business basics</h4>
      <form className="stack" onSubmit={submit}>
        <TextField label="Business name" value={draft.business_name} onChange={(value) => update("business_name", value)} />
        <TextField label="Phone" value={draft.phone} onChange={(value) => update("phone", value)} />
        <TextField label="Email" value={draft.email} onChange={(value) => update("email", value)} />
        <TextField label="Address" value={draft.address} onChange={(value) => update("address", value)} />
        <TextField label="Store hours" value={draft.store_hours} onChange={(value) => update("store_hours", value)} />
        <TextAreaField
          label="Business description"
          value={draft.services}
          onChange={(value) => update("services", value)}
          placeholder="Describe what your business does, who you serve, and what customers can ask about."
          helper="Tell the AI about your website and business so it can answer customers accurately."
        />
        <button type="submit">Save Business Info</button>
        <small className="muted">Auto-saves after edits.</small>
      </form>
    </section>
  );
}

function KnowledgeList({
  qaPairs,
  pagination,
  onPageChange,
  onCreate,
  onUpdate,
  onDelete,
}: {
  qaPairs: QAPair[];
  pagination: PaginationState;
  onPageChange: (page: number) => void;
  onCreate: (input: KnowledgeInput) => Promise<void>;
  onUpdate: (id: string, input: KnowledgeInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [newItem, setNewItem] = useState({ question: "", answer: "" });
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ question: "", answer: "" });
  const [order, setOrder] = useState<SortOrder>("asc");
  const [orderBy, setOrderBy] = useState<FaqColumnId>("question");
  const sortedPairs = useMemo(() => sortFaqPairs(qaPairs, order, orderBy), [qaPairs, order, orderBy]);

  function handleSort(columnId: FaqColumnId): void {
    const isAsc = orderBy === columnId && order === "asc";
    setOrder(isAsc ? "desc" : "asc");
    setOrderBy(columnId);
  }

  function submitNew(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onCreate({
      question: newItem.question,
      answer: newItem.answer,
      tags: [],
    }).then(() => {
      setNewItem({ question: "", answer: "" });
      setCreateOpen(false);
    });
  }

  function startEdit(pair: QAPair): void {
    setEditingId(pair.id);
    setEditDraft({ question: pair.question, answer: pair.answer });
  }

  function submitEdit(id: string, event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onUpdate(id, {
      question: editDraft.question,
      answer: editDraft.answer,
      tags: qaPairs.find((pair) => pair.id === id)?.tags ?? [],
    }).then(() => setEditingId(null));
  }

  return (
    <section className="card">
      <div className="card-heading">
        <h4>FAQ</h4>
        <Button variant="contained" type="button" onClick={() => setCreateOpen(true)}>
          Add FAQ
        </Button>
      </div>
      {qaPairs.length > 0 ? (
        <Paper elevation={0} sx={{ overflow: "hidden", border: "1px solid", borderColor: "divider" }}>
          <TableContainer>
            <Table sx={{ minWidth: 760 }} aria-label="FAQ table">
              <TableHead>
                <TableRow>
                  {faqColumns.map((column) => (
                    <TableCell key={column.id} sortDirection={orderBy === column.id ? order : false}>
                      <TableSortLabel
                        active={orderBy === column.id}
                        direction={orderBy === column.id ? order : "asc"}
                        onClick={() => handleSort(column.id)}
                      >
                        {column.label}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedPairs.map((pair) => (
                  <TableRow hover key={pair.id}>
                    {editingId === pair.id ? (
                      <>
                        <TableCell colSpan={2}>
                          <form className="stack" onSubmit={(event) => submitEdit(pair.id, event)}>
                            <input
                              value={editDraft.question}
                              onChange={(event) => setEditDraft((draft) => ({ ...draft, question: event.currentTarget.value }))}
                              required
                            />
                            <textarea
                              value={editDraft.answer}
                              onChange={(event) => setEditDraft((draft) => ({ ...draft, answer: event.currentTarget.value }))}
                              required
                            />
                            <div className="actions">
                              <Button variant="contained" type="submit">Save</Button>
                              <Button variant="outlined" type="button" onClick={() => setEditingId(null)}>
                                Cancel
                              </Button>
                            </div>
                          </form>
                        </TableCell>
                        <TableCell />
                      </>
                    ) : (
                      <>
                        <TableCell component="th" id={`faq-${pair.id}`} scope="row">
                          {pair.question}
                        </TableCell>
                        <TableCell>
                          <Typography
                            color="text.secondary"
                            sx={{ maxWidth: 520, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                          >
                            {pair.answer}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
                            <Button variant="outlined" size="small" type="button" onClick={() => startEdit(pair)}>
                              Edit
                            </Button>
                            <Button color="error" variant="outlined" size="small" type="button" onClick={() => void onDelete(pair.id)}>
                              Delete
                            </Button>
                          </Box>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={pagination.total}
            page={Math.max(0, pagination.page - 1)}
            rowsPerPage={pagination.limit}
            rowsPerPageOptions={[pagination.limit]}
            onPageChange={(_, page) => onPageChange(page + 1)}
          />
        </Paper>
      ) : (
        <EmptyState
          title="Add your first customer question"
          detail="Good starters: pricing, opening hours, appointment booking, refunds, and emergencies."
        />
      )}
      {isCreateOpen ? (
        <FaqModal
          draft={newItem}
          title="Add FAQ"
          submitLabel="Add FAQ"
          onChange={setNewItem}
          onClose={() => setCreateOpen(false)}
          onSubmit={submitNew}
        />
      ) : null}
    </section>
  );
}

function FaqModal({
  draft,
  title,
  submitLabel,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: { question: string; answer: string };
  title: string;
  submitLabel: string;
  onChange: (draft: { question: string; answer: string }) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="modal">
      <div className="modal__backdrop" onClick={onClose}></div>
      <section className="modal__panel" role="dialog" aria-modal="true" aria-labelledby="faq-modal-title">
        <div className="modal__header">
          <h3 id="faq-modal-title">{title}</h3>
          <button className="button-secondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <form className="stack" onSubmit={onSubmit}>
          <label>
            Question
            <input
              autoFocus
              value={draft.question}
              onChange={(event) => onChange({ ...draft, question: event.currentTarget.value })}
              placeholder="Do you offer same-day appointments?"
              required
            />
          </label>
          <label>
            Answer
            <textarea
              value={draft.answer}
              onChange={(event) => onChange({ ...draft, answer: event.currentTarget.value })}
              placeholder="Yes. We offer same-day appointments when a technician is available."
              required
            />
          </label>
          <div className="actions">
            <button type="submit">{submitLabel}</button>
            <button className="button-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function SiteInstallPage({ settings }: { settings: SiteSettings }) {
  const hasEmbedCode = settings.embedCode.trim().length > 0;

  async function copyEmbedCode(): Promise<void> {
    if (!hasEmbedCode) return;
    await navigator.clipboard.writeText(settings.embedCode);
  }

  return (
    <section className="page" data-page="site">
      <div className="split">
        <section className="card">
          <h4>Install widget</h4>
          <ol className="install-steps">
            <li>Copy the install code.</li>
            <li>Paste it onto your website before the closing body tag.</li>
            <li>Publish your website changes.</li>
            <li>Open your website and test the chat widget.</li>
          </ol>
          <pre>
            {hasEmbedCode ? <HighlightedHtmlCode code={settings.embedCode} /> : <code>Loading widget install code...</code>}
          </pre>
          <button type="button" onClick={() => void copyEmbedCode()} disabled={!hasEmbedCode}>
            Copy install code
          </button>
        </section>
      </div>
      <section className="card">
        <h4>Customize widget</h4>
        <p className="muted">Widget appearance customization is coming soon.</p>
      </section>
    </section>
  );
}

function HighlightedHtmlCode({ code }: { code: string }) {
  const lines = code.split("\n");

  return (
    <code className="html-code">
      {lines.map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {highlightHtmlLine(line)}
          {index < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </code>
  );
}

function highlightHtmlLine(line: string): ReactNode {
  if (line === "<script") {
    return (
      <>
        <span className="html-code__punctuation">&lt;</span>
        <span className="html-code__tag">script</span>
      </>
    );
  }

  if (line === "></script>") {
    return (
      <>
        <span className="html-code__punctuation">&gt;&lt;/</span>
        <span className="html-code__tag">script</span>
        <span className="html-code__punctuation">&gt;</span>
      </>
    );
  }

  const attributeMatch = line.match(/^(\s*)([a-z-]+)(?:="([^"]*)")?$/);
  if (!attributeMatch) return line;

  const [, indent, name, value] = attributeMatch;
  return (
    <>
      {indent}
      <span className="html-code__attr">{name}</span>
      {value !== undefined ? (
        <>
          <span className="html-code__punctuation">=</span>
          <span className="html-code__string">"{value}"</span>
        </>
      ) : null}
    </>
  );
}

function ConversationModal({
  transcript,
  onClose,
}: {
  transcript: {
    conversationId: string;
    messages: ConversationMessage[];
    loading: boolean;
    error?: string;
    lastUpdatedAt?: string;
  };
  onClose: () => void;
}) {
  return (
    <div id="conversation-modal" className="modal">
      <div className="modal__backdrop" onClick={onClose}></div>
      <section className="modal__panel" role="dialog" aria-modal="true" aria-labelledby="conversation-modal-title">
        <div className="modal__header">
          <div>
            <p className="eyebrow">Conversation</p>
            <h3 id="conversation-modal-title">Conversation {transcript.conversationId}</h3>
            <small>
              Live, refreshes every 2s
              {transcript.lastUpdatedAt ? ` · Updated ${formatDate(transcript.lastUpdatedAt)}` : ""}
            </small>
          </div>
          <button className="button-secondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div id="conversation-modal-body" className="transcript">
          {transcript.loading ? <p>Loading transcript...</p> : null}
          {transcript.error ? <p>{transcript.error}</p> : null}
          {!transcript.loading && !transcript.error && transcript.messages.length === 0 ? (
            <p>No conversation messages yet.</p>
          ) : null}
          {transcript.messages.map((message, index) => (
            <div className={`transcript__message transcript__message--${message.role}`} key={`${message.createdAt}-${index}`}>
              <strong>{message.role}</strong>
              <p>{message.content}</p>
              <small>{formatDate(message.createdAt)}</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  helper,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helper?: string;
}) {
  return (
    <label>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {label}
        {helper ? (
          <Tooltip title={helper} arrow>
            <span
              aria-label={`${label} help`}
              style={{
                alignItems: "center",
                border: "1px solid rgba(29, 29, 31, 0.18)",
                borderRadius: 999,
                color: "#6e6e73",
                cursor: "help",
                display: "inline-flex",
                fontSize: 12,
                fontWeight: 800,
                height: 18,
                justifyContent: "center",
                width: 18,
              }}
            >
              ?
            </span>
          </Tooltip>
        ) : null}
      </span>
      <textarea
        value={value}
        placeholder={placeholder}
        rows={5}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label>
      {label}
      <input value={value} disabled />
    </label>
  );
}

function PaginationControls({
  pagination,
  onPageChange,
}: {
  pagination: PaginationState;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));
  const start = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const end = Math.min(pagination.total, pagination.page * pagination.limit);

  return (
    <div className="pagination">
      <span>
        {start}-{end} of {pagination.total}
      </span>
      <div className="actions">
        <button
          className="button-secondary"
          type="button"
          disabled={pagination.page <= 1}
          onClick={() => onPageChange(pagination.page - 1)}
        >
          Previous
        </button>
        <span>
          Page {pagination.page} / {totalPages}
        </span>
        <button
          className="button-secondary"
          type="button"
          disabled={pagination.page >= totalPages}
          onClick={() => onPageChange(pagination.page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function sortLeads(leads: LeadRecord[], order: SortOrder, orderBy: LeadColumnId): LeadRecord[] {
  return [...leads].sort((a, b) => {
    const comparison = compareLeadValues(getLeadSortValue(a, orderBy), getLeadSortValue(b, orderBy));
    return order === "asc" ? comparison : -comparison;
  });
}

function getLeadSortValue(lead: LeadRecord, columnId: LeadColumnId): string | number {
  if (columnId === "createdAt") return Date.parse(lead.createdAt) || 0;
  return String(lead[columnId] ?? "").toLowerCase();
}

function sortFaqPairs(qaPairs: QAPair[], order: SortOrder, orderBy: FaqColumnId): QAPair[] {
  return [...qaPairs].sort((a, b) => {
    const comparison = compareLeadValues(getFaqSortValue(a, orderBy), getFaqSortValue(b, orderBy));
    return order === "asc" ? comparison : -comparison;
  });
}

function getFaqSortValue(pair: QAPair, columnId: FaqColumnId): string | number {
  return pair[columnId].toLowerCase();
}

function compareLeadValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function createAdminApi() {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new AdminApiError(
        response.status,
        body?.error?.code,
        body?.error?.message ?? `Admin request failed: ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  return {
    get: <T,>(path: string) => request<T>(path),
    post: <T,>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
    put: <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
    patch: <T,>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
    delete: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
    login: (body: { password: string }) =>
      request<AdminSessionPayload>("/api/admin/login", { method: "POST", body: JSON.stringify(body) }),
    logout: () => request<{ success: boolean }>("/api/admin/logout", { method: "POST", body: JSON.stringify({}) }),
  };
}

class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function useLocalStorage(key: string, initialValue: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initialValue);

  function update(next: string): void {
    setValue(next);
    if (next) {
      localStorage.setItem(key, next);
    } else {
      localStorage.removeItem(key);
    }
  }

  return [value, update];
}

function adminPagePath(page: AdminPage): string {
  return `/${page}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function adminListPath(path: string, pagination: Pick<PaginationState, "page" | "limit">): string {
  const params = new URLSearchParams({
    page: String(pagination.page),
    limit: String(pagination.limit),
  });
  return `${path}?${params.toString()}`;
}

function scheduleDebouncedSave(save: () => Promise<void>): () => void {
  const timeout = window.setTimeout(() => {
    void save();
  }, 800);
  return () => window.clearTimeout(timeout);
}

function businessInfoToDraft(info: BusinessInfo): BusinessInfoDraft {
  return {
    ...info,
    customFields: Object.entries(info.custom_fields).map(([key, value]) => ({ key, value })),
  };
}

function draftToBusinessInfo(draft: BusinessInfoDraft): BusinessInfo {
  return {
    business_name: draft.business_name,
    phone: draft.phone,
    email: draft.email,
    address: draft.address,
    store_hours: draft.store_hours,
    services: draft.services,
    custom_fields: Object.fromEntries(
      draft.customFields
        .map((field) => [field.key.trim(), field.value.trim()] as const)
        .filter(([key]) => Boolean(key)),
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load admin";
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("Missing #app root");
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={adminTheme}>
      <CssBaseline />
      <BrowserRouter basename="/admin">
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
