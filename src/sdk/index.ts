import type { StructuredBrief } from '../lib/brief';
import { AtelieMotor, criarMotor, type GenerateOptions, type MotorOptions, type MotorResult } from '../lib/motor';
import type { StoredJob } from '../server/jobs';

export type { StructuredBrief, GenerateOptions, MotorOptions, MotorResult, StoredJob as AtelieJob };
export { AtelieMotor, criarMotor };

export interface AtelieClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class AtelieHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Ateliê HTTP ${status}`);
    this.name = 'AtelieHttpError';
  }
}

export class AtelieClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: AtelieClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let body: unknown;
      try { body = await response.json(); } catch { body = await response.text(); }
      throw new AtelieHttpError(response.status, body);
    }
    return response.json() as Promise<T>;
  }

  health(): Promise<{ ok: boolean; versao_api: string; fila: { concorrencia: number } }> {
    return this.request('/v1/health');
  }

  styles(): Promise<{ estilos: Array<{ id: string; nome: string; grupo: string; descricao: string }>; modos: string[] }> {
    return this.request('/v1/styles');
  }

  createJob(brief: StructuredBrief): Promise<StoredJob> {
    return this.request('/v1/jobs', { method: 'POST', body: JSON.stringify(brief) });
  }

  getJob(id: string): Promise<StoredJob> {
    return this.request(`/v1/jobs/${encodeURIComponent(id)}`);
  }

  cancelJob(id: string): Promise<StoredJob> {
    return this.request(`/v1/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async artifact(id: string, n: number): Promise<Uint8Array> {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await this.fetcher(`${this.baseUrl}/v1/jobs/${encodeURIComponent(id)}/artifact/${n}`, { headers });
    if (!response.ok) {
      let body: unknown;
      try { body = await response.json(); } catch { body = await response.text(); }
      throw new AtelieHttpError(response.status, body);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async waitForJob(id: string, options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<StoredJob> {
    const interval = options.intervalMs ?? 100;
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);
    for (;;) {
      if (options.signal?.aborted) throw new Error('espera cancelada');
      const job = await this.getJob(id);
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
      if (Date.now() >= deadline) throw new Error(`timeout aguardando job ${id}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('espera cancelada')); }, { once: true });
      });
    }
  }
}

export function criarCliente(options: AtelieClientOptions): AtelieClient {
  return new AtelieClient(options);
}
