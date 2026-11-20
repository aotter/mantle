// The employees' purchase-request app: a React single-page app under /app, built by `mantle bundle` to
// /assets/client/app.js and loaded by the shell document public/app/index.html (src/routes.ts serves it). Three pages:
//   /app                 my requests, with their live status (read again every 10 s while the tab is visible)
//   /app/new             a new request: each department's remaining budget, validation errors beside their fields
//   /app/requests/{id}   one request; while it is submitted, the requester may change its amount
// It reads the Views my-requests, my-request and department-budgets and writes only through the REST Triggers
// POST /api/requests and POST /api/requests/{id}/amount. It holds no authority: the browser sends the session cookie,
// and the server checks it, the input and `requires` on every call. A 401 (the session ended) goes to /sign-in and back.
// Kit components (@aotter/mantle-ui/kit) render here, in the browser; their classes are in app.css (the kit's kit.css).
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@aotter/mantle-ui/kit";
import { type FormEvent, type MouseEvent, type ReactNode, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

type PurchaseRequest = { id: string; title: string; amount: number; department: string; requestStatus: string; version: number; supplierOrderId?: string | null };
type Budget = { department: string; remaining: number };
type Failure = { status: number; code?: string; message: string; path?: string };

const signIn = () => location.assign(`/sign-in?return=${encodeURIComponent(location.pathname)}`);

/** One REST call. A refusal throws its `{ error }` body; a 401 leaves for sign-in and never settles. */
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 401) { signIn(); return new Promise<T>(() => {}); }
  const data = await response.json().catch(() => null) as { error?: Partial<Failure> } | null;
  if (!response.ok) throw { status: response.status, message: "Not saved. Try again.", ...data?.error } satisfies Failure;
  return data as T;
}
const rows = async <T,>(view: string) => (await api<{ rows: T[] }>(`/api/views/${view}`)).rows;

/** Reads `load` now, again every `every` ms while the tab is visible, and when it becomes visible. */
function useLive<T>(load: () => Promise<T>, every = 10_000) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const reload = useCallback(() => load().then(data => setState({ data }), (failure: Failure) => setState(old => ({ ...old, error: failure.message ?? "Could not load." }))), [load]);
  useEffect(() => {
    void reload();
    const tick = () => document.visibilityState === "visible" && void reload();
    const timer = setInterval(tick, every);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [reload, every]);
  return { ...state, reload };
}

const statusVariant = (status: string) => (status === "rejected" ? "destructive" : status === "submitted" ? "outline" : "secondary") as "destructive" | "outline" | "secondary";
const Status = ({ status }: { status: string }) => <Badge variant={statusVariant(status)}>{status}</Badge>;

function Link({ to, go, children }: { to: string; go: (to: string) => void; children: ReactNode }) {
  const follow = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; // a new tab loads the shell itself
    event.preventDefault();
    go(to);
  };
  return <a href={to} onClick={follow} className="text-primary underline-offset-4 hover:underline">{children}</a>;
}

function MyRequests({ go }: { go: (to: string) => void }) {
  const load = useCallback(() => rows<PurchaseRequest>("my-requests"), []);
  const { data, error } = useLive(load);
  return (
    <Card>
      <CardHeader><CardTitle><h1>My purchase requests</h1></CardTitle></CardHeader>
      <CardContent>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!data ? <p role="status">Loading…</p> : data.length === 0 ? <p>No requests yet.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>What</TableHead><TableHead>Amount</TableHead><TableHead>Department</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.map(r => (
                <TableRow key={r.id}>
                  <TableCell><Link to={`/app/requests/${r.id}`} go={go}>{r.title}</Link></TableCell>
                  <TableCell className="tabular-nums">{r.amount}</TableCell>
                  <TableCell>{r.department}</TableCell>
                  <TableCell><Status status={r.requestStatus} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

type Fields = { title: string; amount: string; department: string };

/** The browser's checks, shown beside each field; the REST Trigger checks the same input again. */
function check({ title, amount, department }: Fields) {
  const errors: Partial<Record<keyof Fields | "form", string>> = {};
  if (!title.trim()) errors.title = "Say what you need.";
  if (!/^[1-9]\d*$/.test(amount)) errors.amount = "A whole amount of at least 1.";
  if (!department) errors.department = "Choose the department that pays.";
  return errors;
}

function NewRequest({ go }: { go: (to: string) => void }) {
  const load = useCallback(() => rows<Budget>("department-budgets"), []);
  const { data: budgets, error: loadError } = useLive(load, 60_000);
  const [fields, setFields] = useState<Fields>({ title: "", amount: "", department: "" });
  const [errors, setErrors] = useState<ReturnType<typeof check>>({});
  const [busy, setBusy] = useState(false);
  const budget = budgets?.find(b => b.department === fields.department);
  const set = (name: keyof Fields) => (event: { target: { value: string } }) => setFields(old => ({ ...old, [name]: event.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = check(fields);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const result = await api<{ results: [[{ id: string }?]] }>("/api/requests", { title: fields.title.trim(), amount: Number(fields.amount), department: fields.department });
      const created = result.results[0][0];
      // submit-request inserts nothing for a department without a budget (another admin may have just removed it).
      if (!created) return setErrors({ department: "This department has no budget." });
      go(`/app/requests/${created.id}`);
    } catch (failure) {
      const { status, message, path } = failure as Failure;
      // A request of 100 or less is approved at once and spends the budget; one that would overspend is a 409.
      if (status === 409) setErrors({ amount: `More than ${fields.department} has left.` });
      // The Trigger's input check names the field in `path` when it can.
      else setErrors({ [(["title", "amount", "department"] as const).find(name => path?.includes(name)) ?? "form"]: message });
    } finally {
      setBusy(false);
    }
  }

  const error = (name: keyof Fields) => errors[name] && <p id={`${name}-error`} className="text-sm text-destructive">{errors[name]}</p>;
  const described = (name: keyof Fields) => (errors[name] ? { "aria-invalid": true, "aria-describedby": `${name}-error` } : {});
  return (
    <Card>
      <CardHeader><CardTitle><h1>New purchase request</h1></CardTitle></CardHeader>
      <CardContent>
        {/* noValidate: the checks above show their errors beside the fields instead of the browser's bubbles. */}
        <form onSubmit={submit} noValidate>
          <div className="field">
            <Label htmlFor="title">What</Label>
            <Input id="title" name="title" value={fields.title} onChange={set("title")} {...described("title")} />
            {error("title")}
          </div>
          <div className="field">
            <Label htmlFor="department">Department</Label>
            <select id="department" name="department" value={fields.department} onChange={set("department")} {...described("department")}>
              <option value="">Choose…</option>
              {budgets?.map(b => <option key={b.department} value={b.department}>{b.department} ({b.remaining} left)</option>)}
            </select>
            {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
            {error("department")}
          </div>
          <div className="field">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" name="amount" inputMode="numeric" value={fields.amount} onChange={set("amount")} {...described("amount")} />
            {budget && Number(fields.amount) > budget.remaining && !errors.amount && (
              <p className="text-sm text-muted-foreground">More than {budget.department} has left ({budget.remaining}): an admin cannot approve it until the budget grows.</p>
            )}
            {error("amount")}
            <p className="text-sm text-muted-foreground">100 or less is approved at once; more waits for an admin.</p>
          </div>
          {errors.form && <p role="alert" className="text-sm text-destructive">{errors.form}</p>}
          <div><Button type="submit" disabled={busy}>Submit</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function RequestDetail({ id, go }: { id: string; go: (to: string) => void }) {
  const load = useCallback(() => rows<PurchaseRequest>(`my-request?id=${encodeURIComponent(id)}`), [id]);
  const { data, error, reload } = useLive(load);
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState("");
  const request = data?.[0];
  if (data && !request) return <NotFound go={go} />;

  async function change(event: FormEvent) {
    event.preventDefault();
    if (!/^[1-9]\d*$/.test(amount)) return setAmountError("A whole amount of at least 1.");
    try {
      // The version this page shows: if an admin decided meanwhile, the guarded UPDATE matches nothing and answers 409.
      await api(`/api/requests/${encodeURIComponent(id)}/amount`, { expectedVersion: request!.version, amount: Number(amount) });
      setAmount(""); setAmountError("");
    } catch (failure) {
      setAmountError((failure as Failure).status === 409 ? "It changed meanwhile; see its status above." : (failure as Failure).message);
    }
    await reload();
  }

  return (
    <Card>
      <CardHeader><CardTitle><h1>{request?.title ?? "Purchase request"}</h1></CardTitle></CardHeader>
      <CardContent>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!request ? <p role="status">Loading…</p> : (
          <>
            <dl>
              <dt>Status</dt><dd><Status status={request.requestStatus} /></dd>
              <dt>Amount</dt><dd className="tabular-nums">{request.amount}</dd>
              <dt>Department</dt><dd>{request.department}</dd>
              {request.supplierOrderId && <><dt>Supplier order</dt><dd>{request.supplierOrderId}</dd></>}
            </dl>
            {request.requestStatus === "submitted" && (
              <form onSubmit={change} noValidate className="mt-4">
                <div className="field">
                  <Label htmlFor="new-amount">Change the amount</Label>
                  <Input id="new-amount" inputMode="numeric" value={amount} onChange={event => setAmount(event.target.value)} aria-invalid={!!amountError || undefined} aria-describedby={amountError ? "new-amount-error" : undefined} />
                  {amountError && <p id="new-amount-error" className="text-sm text-destructive">{amountError}</p>}
                </div>
                <div><Button type="submit" variant="outline">Change</Button></div>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function NotFound({ go }: { go: (to: string) => void }) {
  return <Card><CardContent><h1 className="text-lg font-semibold">Not found</h1><p>There is no such page or request. <Link to="/app" go={go}>Back to my requests</Link></p></CardContent></Card>;
}

function App() {
  const [path, setPath] = useState(location.pathname);
  const go = (to: string) => { history.pushState(null, "", to); setPath(to); };
  useEffect(() => {
    const back = () => setPath(location.pathname);
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  // The same pages src/routes.ts answers 200 for; any other path under /app gets status 404 there and this page here.
  const id = /^\/app\/requests\/([\w-]+)$/.exec(path)?.[1];
  const page = path === "/app" || path === "/app/" ? <MyRequests go={go} /> : path === "/app/new" ? <NewRequest go={go} /> : id ? <RequestDetail key={id} id={id} go={go} /> : <NotFound go={go} />;
  return (
    <main className="app">
      <nav aria-label="Purchase requests">
        <Link to="/app" go={go}>My requests</Link>
        <Button size="sm" onClick={() => go("/app/new")}>New request</Button>
      </nav>
      {page}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
