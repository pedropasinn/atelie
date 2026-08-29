import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SESSIONS_ROOT } from '../config';
import { briefHash, normalizeBrief, type StructuredBrief } from '../lib/brief';
import { criarMotor, type AtelieMotor, type GeneratedArtifact, type MotorProgress, type MotorResult } from '../lib/motor';
import { findStyle } from '../lib/userStyles';
import type { Verdict } from '../types';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface StoredJob {
  id: string;
  brief_hash: string;
  brief: StructuredBrief;
  status: JobStatus;
  criado_em: string;
  atualizado_em: string;
  tentativas: number;
  max_tentativas: number;
  progresso: MotorProgress;
  resultado?: {
    artefatos: Array<{
      n: number;
      id: string;
      estilo: string;
      artifact_url: string;
      manifest: GeneratedArtifact['manifest'];
    }>;
    veredito: Verdict;
    duracao_ms: number;
  };
  veredito?: Verdict;
  erro?: { codigo: string; mensagem: string };
}

export interface JobManagerOptions {
  rootDir?: string;
  concurrency?: number;
  motor?: AtelieMotor;
  now?: () => Date;
  /** Novas execuções automáticas depois da primeira falha transitória. */
  transientRetries?: number;
  /** Tempo em que um failed ainda participa da idempotência. */
  failedTtlMs?: number;
  retryDelayMs?: number;
}

export interface CreateJobOptions {
  force?: boolean;
  retry?: boolean;
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REMOVIDO]')
    .replace(/((?:token|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REMOVIDO]')
    .slice(0, 1000);
}

export function isTransientFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:network_error|timeout|timed_out|rate_limit|service_unavailable|server_error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)$/i.test(code)
    || /(?:temporar|transient|indispon[ií]vel|timeout|timed out|rate.?limit|too many requests|\b429\b|\b5\d\d\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)/i.test(message);
}

export class JobManager {
  readonly rootDir: string;
  readonly concurrency: number;
  private readonly motor: AtelieMotor;
  private readonly now: () => Date;
  private readonly transientRetries: number;
  private readonly failedTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly jobs = new Map<string, StoredJob>();
  private readonly byHash = new Map<string, string>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private active = 0;

  constructor(options: JobManagerOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(SESSIONS_ROOT, 'jobs');
    const configured = options.concurrency ?? Number(process.env.ATELIE_JOB_CONCURRENCY || 1);
    this.concurrency = Number.isFinite(configured) ? Math.max(1, Math.round(configured)) : 1;
    this.motor = options.motor ?? criarMotor({ rootDir: this.rootDir });
    this.now = options.now ?? (() => new Date());
    const retries = options.transientRetries ?? Number(process.env.ATELIE_JOB_TRANSIENT_RETRIES ?? 2);
    this.transientRetries = Number.isFinite(retries) ? Math.max(0, Math.min(10, Math.round(retries))) : 2;
    const failedTtl = options.failedTtlMs ?? Number(process.env.ATELIE_FAILED_JOB_TTL_MS ?? 3_600_000);
    this.failedTtlMs = Number.isFinite(failedTtl) ? Math.max(0, failedTtl) : 3_600_000;
    const retryDelay = options.retryDelayMs ?? Number(process.env.ATELIE_JOB_RETRY_DELAY_MS ?? 250);
    this.retryDelayMs = Number.isFinite(retryDelay) ? Math.max(0, retryDelay) : 250;
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.loadExisting();
    queueMicrotask(() => this.drain());
  }

  private jobFile(id: string): string {
    return path.join(this.rootDir, id, 'job.json');
  }

  private persist(job: StoredJob): void {
    const file = this.jobFile(job.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private loadExisting(): void {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.rootDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const job = JSON.parse(fs.readFileSync(this.jobFile(entry.name), 'utf8')) as StoredJob;
        if (!job?.id || !job.brief_hash) continue;
        job.tentativas = Number.isFinite(job.tentativas) ? job.tentativas : 0;
        job.max_tentativas = Number.isFinite(job.max_tentativas) ? job.max_tentativas : 1 + this.transientRetries;
        if (job.status === 'running') {
          job.status = 'queued';
          job.progresso = { etapa: 'preparando', concluidos: 0, total: 1, mensagem: 'job retomado após reinício' };
          this.persist(job);
        }
        this.jobs.set(job.id, job);
        if (job.status !== 'cancelled') {
          const indexed = this.byHash.get(job.brief_hash);
          const indexedJob = indexed ? this.jobs.get(indexed) : undefined;
          if (!indexedJob || Date.parse(job.atualizado_em) >= Date.parse(indexedJob.atualizado_em)) this.byHash.set(job.brief_hash, job.id);
        }
        if (job.status === 'queued') this.queue.push(job.id);
      } catch {
        // Entrada corrompida não derruba a API nem é exposta em logs.
      }
    }
  }

  private failedIsExpired(job: StoredJob): boolean {
    if (job.status !== 'failed') return false;
    const updatedAt = Date.parse(job.atualizado_em);
    return !Number.isFinite(updatedAt) || this.now().getTime() - updatedAt >= this.failedTtlMs;
  }

  create(value: unknown, options: CreateJobOptions = {}): { job: StoredJob; created: boolean } {
    const brief = normalizeBrief(value);
    const unknownStyles = (brief.estilos ?? []).filter((styleId) => !findStyle(styleId));
    if (unknownStyles.length) throw new Error(`brief inválido: estilo(s) inexistente(s): ${unknownStyles.join(', ')}`);
    const hash = briefHash(brief);
    const existingId = this.byHash.get(hash);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    const retryTerminal = options.retry && (existing?.status === 'failed' || existing?.status === 'cancelled');
    if (existing && !options.force && !retryTerminal && !this.failedIsExpired(existing) && existing.status !== 'cancelled') {
      return { job: existing, created: false };
    }
    const now = this.now().toISOString();
    const id = `job-${hash.slice(0, 16)}-${randomUUID().slice(0, 8)}`;
    const total = (brief.estilos ?? []).length;
    const job: StoredJob = {
      id,
      brief_hash: hash,
      brief,
      status: 'queued',
      criado_em: now,
      atualizado_em: now,
      tentativas: 0,
      max_tentativas: 1 + this.transientRetries,
      progresso: { etapa: 'preparando', concluidos: 0, total, mensagem: 'job aguardando na fila' },
    };
    this.jobs.set(id, job);
    this.byHash.set(hash, id);
    this.queue.push(id);
    this.persist(job);
    this.drain();
    return { job, created: true };
  }

  get(id: string): StoredJob | undefined {
    return this.jobs.get(id);
  }

  list(): StoredJob[] {
    return [...this.jobs.values()];
  }

  cancel(id: string): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
    this.controllers.get(id)?.abort();
    job.status = 'cancelled';
    job.atualizado_em = this.now().toISOString();
    job.progresso = { ...job.progresso, mensagem: 'job cancelado' };
    this.persist(job);
    return job;
  }

  artifactPath(id: string, n: number): string | undefined {
    const job = this.jobs.get(id);
    const artifact = job?.resultado?.artefatos.find((a) => a.n === n);
    if (!artifact) return undefined;
    const file = path.join(this.rootDir, id, artifact.id, 'artifact.png');
    return fs.existsSync(file) ? file : undefined;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.active++;
      void this.execute(job).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  private async execute(job: StoredJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running';
    job.atualizado_em = this.now().toISOString();
    job.progresso = { ...job.progresso, mensagem: 'job iniciado' };
    this.persist(job);
    try {
      let result: MotorResult | undefined;
      for (let attempt = 1; attempt <= job.max_tentativas; attempt++) {
        job.tentativas = attempt;
        job.erro = undefined;
        this.persist(job);
        try {
          result = await this.motor.gerar(job.brief, {
            jobId: job.id,
            signal: controller.signal,
            onProgress: (progress) => {
              if (job.status === 'cancelled') return;
              job.progresso = progress;
              job.atualizado_em = this.now().toISOString();
              this.persist(job);
            },
          });
          break;
        } catch (error) {
          if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          if (!isTransientFailure(error) || attempt >= job.max_tentativas) throw error;
          job.progresso = { ...job.progresso, mensagem: `falha transitória; nova tentativa ${attempt + 1}/${job.max_tentativas}` };
          job.atualizado_em = this.now().toISOString();
          this.persist(job);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, this.retryDelayMs * attempt);
            controller.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const abort = new Error('job cancelado');
              abort.name = 'AbortError';
              reject(abort);
            }, { once: true });
          });
        }
      }
      if (!result) throw new Error('job terminou sem resultado');
      if (controller.signal.aborted) return;
      job.status = 'completed';
      job.veredito = result.verdict;
      job.resultado = {
        artefatos: result.artifacts.map((artifact) => ({
          n: artifact.n,
          id: artifact.id,
          estilo: artifact.styleId,
          artifact_url: `/v1/jobs/${job.id}/artifact/${artifact.n}`,
          manifest: artifact.manifest,
        })),
        veredito: result.verdict,
        duracao_ms: result.durationMs,
      };
      job.atualizado_em = this.now().toISOString();
      this.persist(job);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        job.status = 'cancelled';
        job.progresso = { ...job.progresso, mensagem: 'job cancelado' };
      } else {
        job.status = 'failed';
        job.erro = { codigo: 'job_failed', mensagem: safeMessage(error) };
        job.progresso = { ...job.progresso, mensagem: 'job falhou' };
      }
      job.atualizado_em = this.now().toISOString();
      this.persist(job);
    } finally {
      this.controllers.delete(job.id);
    }
  }
}
