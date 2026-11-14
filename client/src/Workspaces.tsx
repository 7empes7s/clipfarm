import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { WorkspaceSummary } from "../../shared/creator";
import { api, currentWorkspace } from "./api";
import { Sheet } from "./Sheet";

/** The header's switcher: which workspace (me, or a client) the app shows, and a sheet to manage them. */
export function WorkspaceSwitcher({ onSwitch }: { onSwitch: (id: number) => void }) {
  const [list, setList] = useState<WorkspaceSummary[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => void api.workspaces().then(setList).catch(() => undefined), []);
  useEffect(load, [load]);
  const close = useCallback(() => {
    setOpen(false);
    load();
  }, [load]);

  return (
    <>
      <div className="ws-switch">
        <select
          aria-label="Workspace"
          value={currentWorkspace()}
          onChange={(e) => {
            if (e.target.value === "manage") return setOpen(true);
            onSwitch(Number(e.target.value));
          }}
        >
          {list.length === 0 && <option value={currentWorkspace()}>Me</option>}
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          <option value="manage">Manage workspaces…</option>
        </select>
      </div>
      {open && <WorkspacesSheet list={list} onClose={close} onSwitch={onSwitch} />}
    </>
  );
}

function WorkspacesSheet({ list, onClose, onSwitch }: { list: WorkspaceSummary[]; onClose: () => void; onSwitch: (id: number) => void }) {
  const [error, setError] = useState<string | null>(null);
  const current = list.find((w) => w.id === currentWorkspace()) ?? list[0];

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "");
    try {
      const w = await api.addWorkspace(name);
      onSwitch(w.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current) return;
    const f = new FormData(e.currentTarget);
    const text = (n: string) => String(f.get(n) ?? "");
    try {
      await api.saveWorkspace(current.id, text("name"), { handle: text("handle"), color: text("color"), callToAction: text("callToAction") });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Sheet id="ws-title" title="Workspaces" onClose={onClose}>
      <p className="hint">
        Each workspace (you, or a client) has its own shows, clips, posting accounts and numbers. Move an account to a workspace in
        Dashboard, Posting accounts.
      </p>
      <ul className="ws-list">
        {list.map((w) => (
          <li key={w.id} aria-current={w.id === current?.id ? "true" : undefined}>
            <strong>{w.name}</strong>
            <span className="meta">
              {w.stats.sources} show{w.stats.sources === 1 ? "" : "s"}, {w.stats.clipsWaiting} to review, {w.stats.posts} posted,{" "}
              {w.stats.views.toLocaleString()} views, {w.stats.accounts} account{w.stats.accounts === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
      {current && (
        <form className="form" onSubmit={(e) => void save(e)} key={current.id}>
          <h3>Brand for {current.name}</h3>
          <label>
            Name
            <input name="name" defaultValue={current.name} required maxLength={60} />
          </label>
          <div className="row">
            <label>
              Handle
              <input name="handle" defaultValue={current.brand.handle} placeholder="@yourshow" maxLength={40} />
            </label>
            <label>
              Caption colour
              <input name="color" type="color" defaultValue={current.brand.color} />
            </label>
          </div>
          <label>
            Closing line for descriptions
            <input name="callToAction" defaultValue={current.brand.callToAction} placeholder="Full episode on the channel" maxLength={140} />
          </label>
          <button type="submit">Save brand</button>
        </form>
      )}
      <form className="form" onSubmit={(e) => void add(e)}>
        <h3>Add a client</h3>
        <label>
          Workspace name
          <input name="name" required maxLength={60} placeholder="Client's name" />
        </label>
        <button type="submit" className="primary">
          Add workspace
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
