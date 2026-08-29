import { spawn } from 'child_process';

export interface RunHandle {
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  cancel: () => void;
}

export interface RunOpts {
  onStdoutLine?: (l: string) => void;
  onStderrLine?: (l: string) => void;
  stdinData?: string;
  timeoutMs?: number;
  /** Diretório de trabalho do subprocesso. */
  cwd?: string;
  /** Ambiente do subprocesso. `undefined` → herda o do pai (default). */
  env?: NodeJS.ProcessEnv;
  /** Cancela e mata o subprocesso em voo quando abortado. */
  signal?: AbortSignal;
}

export function run(bin: string, args: string[], opts: RunOpts = {}): RunHandle {
  const useStdin = opts.stdinData != null;
  const child = spawn(bin, args, {
    stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
    cwd: opts.cwd,
    env: opts.env,
  });

  let stdout = '';
  let stderr = '';
  let outRest = '';
  let errRest = '';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = opts.signal;
  let onAbort: (() => void) | undefined;

  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn();
    };

    // Cancelamento externo: mata o subprocesso em voo (o 'close' resolve normalmente).
    if (signal) {
      onAbort = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        finish(() => reject(new Error(`${bin} excedeu o tempo limite de ${opts.timeoutMs} ms`)));
      }, opts.timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (d: string) => {
      stdout += d;
      outRest += d;
      let idx: number;
      while ((idx = outRest.indexOf('\n')) !== -1) {
        const line = outRest.slice(0, idx);
        outRest = outRest.slice(idx + 1);
        opts.onStdoutLine?.(line);
      }
    });

    child.stderr?.on('data', (d: string) => {
      stderr += d;
      errRest += d;
      let idx: number;
      while ((idx = errRest.indexOf('\n')) !== -1) {
        const line = errRest.slice(0, idx);
        errRest = errRest.slice(idx + 1);
        opts.onStderrLine?.(line);
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const msg = err.code === 'ENOENT' ? `${bin} não encontrado na PATH` : err.message;
      finish(() => reject(new Error(msg)));
    });

    child.on('close', (code) => {
      // esvazia restos parciais sem newline final
      if (outRest.length) opts.onStdoutLine?.(outRest);
      if (errRest.length) opts.onStderrLine?.(errRest);
      finish(() => resolve({ code, stdout, stderr }));
    });

    if (useStdin && child.stdin) {
      // Sem handler 'error', um EPIPE (filho encerra antes de ler stdin) derruba o processo.
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(opts.stdinData!);
        child.stdin.end();
      } catch {
        /* filho já fechou o stdin — ignora */
      }
    }
  });

  return {
    done,
    cancel: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },
  };
}
