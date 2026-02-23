import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

type AdminSnapshot = {
  isPaused: boolean;
  isRunningRound: boolean;
  done: boolean;
  completedInMemory: number;
  persistedRounds: number;
  viewerCount: number;
};

type AdminResponse = { ok: true } & AdminSnapshot;
type Mode = "checking" | "locked" | "ready";

const RESET_TOKEN = "RESET";

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (text) return text;
  return `Falha na requisicao (${res.status})`;
}

async function requestAdminJson(
  path: string,
  init?: RequestInit,
): Promise<AdminResponse> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as AdminResponse;
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-card">
      <div className="status-card__label">{label}</div>
      <div className="status-card__value">{value}</div>
    </div>
  );
}

function App() {
  const [mode, setMode] = useState<Mode>("checking");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");

  useEffect(() => {
    let mounted = true;

    requestAdminJson("/api/admin/status")
      .then((data) => {
        if (!mounted) return;
        setSnapshot(data);
        setMode("ready");
      })
      .catch(() => {
        if (!mounted) return;
        setSnapshot(null);
        setMode("locked");
      });

    return () => {
      mounted = false;
    };
  }, []);

  const busy = useMemo(() => pending !== null, [pending]);

  async function onLogin(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("login");
    try {
      const data = await requestAdminJson("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ passcode }),
      });
      setSnapshot(data);
      setPasscode("");
      setMode("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao entrar");
    } finally {
      setPending(null);
    }
  }

  async function runControl(path: string, task: string) {
    setError(null);
    setPending(task);
    try {
      const data = await requestAdminJson(path, { method: "POST" });
      setSnapshot(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha na acao de admin";
      const lowered = message.toLowerCase();
      if (lowered.includes("unauthorized") || lowered.includes("nao autorizado")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onExport() {
    setError(null);
    setPending("export");
    try {
      const response = await fetch("/api/admin/export", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      const fileName = fileNameMatch?.[1] ?? `papotorto-export-${Date.now()}.json`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha no export";
      const lowered = message.toLowerCase();
      if (lowered.includes("unauthorized") || lowered.includes("nao autorizado")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onReset() {
    setError(null);
    setPending("reset");
    try {
      const data = await requestAdminJson("/api/admin/reset", {
        method: "POST",
        body: JSON.stringify({ confirm: RESET_TOKEN }),
      });
      setSnapshot(data);
      setResetText("");
      setIsResetOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha no reset");
    } finally {
      setPending(null);
    }
  }

  async function onLogout() {
    setError(null);
    setPending("logout");
    try {
      await fetch("/api/admin/logout", {
        method: "POST",
        cache: "no-store",
      });
      setSnapshot(null);
      setPasscode("");
      setMode("locked");
    } finally {
      setPending(null);
    }
  }

  if (mode === "checking") {
    return (
      <div className="admin admin--centered">
        <div className="loading">Verificando sessao admin...</div>
      </div>
    );
  }

  if (mode === "locked") {
    return (
      <div className="admin admin--centered">
        <main className="panel panel--login">
          <a href="/" className="logo-link">
            <img src="/assets/logo.svg" alt="PapoTorto" />
          </a>
          <h1>Acesso Admin</h1>
          <p className="muted">
            Digite sua senha uma vez. Um cookie seguro vai manter este navegador
            conectado.
          </p>

          <form
            onSubmit={onLogin}
            className="login-form"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          >
            <label htmlFor="passcode" className="field-label">
              Senha
            </label>
            <input
              id="passcode"
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              className="text-input"
              autoFocus
              autoComplete="off"
              required
              data-1p-ignore
              data-lpignore="true"
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !passcode.trim()}
              data-1p-ignore
              data-lpignore="true"
            >
              {pending === "login" ? "Verificando..." : "Desbloquear Admin"}
            </button>
          </form>

          {error && <div className="error-banner">{error}</div>}

          <div className="quick-links">
            <a href="/">Jogo Ao Vivo</a>
            <a href="/history">Historico</a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="admin">
      <header className="admin-header">
        <a href="/" className="logo-link">
          PapoTorto
        </a>
        <nav className="quick-links">
          <a href="/">Jogo Ao Vivo</a>
          <a href="/history">Historico</a>
          <button className="link-button" onClick={onLogout} disabled={busy}>
            Sair
          </button>
        </nav>
      </header>

      <main className="panel panel--main">
        <div className="panel-head">
          <h1>Console Admin</h1>
          <p>
            Pausar ou retomar o loop do jogo, exporte todos os dados em JSON ou
            apague todos os dados salvos.
          </p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <section className="status-grid" aria-live="polite">
          <StatusCard
            label="Motor"
            value={snapshot?.isPaused ? "Pausado" : "Rodando"}
          />
          <StatusCard
            label="Rodada Ativa"
            value={snapshot?.isRunningRound ? "Em Andamento" : "Parada"}
          />
          <StatusCard
            label="Rodadas Persistidas"
            value={String(snapshot?.persistedRounds ?? 0)}
          />
          <StatusCard label="Espectadores" value={String(snapshot?.viewerCount ?? 0)} />
        </section>

        <section className="actions" aria-label="Acoes admin">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || Boolean(snapshot?.isPaused)}
            onClick={() => runControl("/api/admin/pause", "pause")}
          >
            {pending === "pause" ? "Pausando..." : "Pausar"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !snapshot?.isPaused}
            onClick={() => runControl("/api/admin/resume", "resume")}
          >
            {pending === "resume" ? "Retomando..." : "Retomar"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onExport}>
            {pending === "export" ? "Exportando..." : "Exportar JSON"}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => setIsResetOpen(true)}
          >
            Resetar Dados
          </button>
        </section>
      </main>

      {isResetOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Resetar todos os dados?</h2>
            <p>
              Isso apaga permanentemente todas as rodadas salvas e zera a
              pontuacao. O fluxo atual do jogo tambem e pausado.
            </p>
            <p>
              Digite <code>{RESET_TOKEN}</code> para continuar.
            </p>
            <input
              type="text"
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
              className="text-input"
              placeholder={RESET_TOKEN}
              autoFocus
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setIsResetOpen(false);
                  setResetText("");
                }}
                disabled={busy}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={onReset}
                disabled={busy || resetText !== RESET_TOKEN}
              >
                {pending === "reset" ? "Resetando..." : "Confirmar Reset"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
