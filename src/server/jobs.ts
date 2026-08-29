import fs from 'node:fs';
import path from 'node:path';

import { SESSIONS_ROOT } from '../config';
import { briefHash, normalizeBrief, type StructuredBrief } from '../lib/brief';
import { criarMotor, type AtelieMotor, type GeneratedArtifact, type MotorProgress, type MotorResult } from '../lib/motor';
import type { Verdict } from '../types';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface StoredJob {
  id: string;
  brief_hash: string;
  brief: StructuredBrief;
  status: JobStatus;
  criado_em: string;
  atualizado_em: string;
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
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REMOVIDO]')
    .replace(/((?:token|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REMOVIDO]')
    .slice(0, 1000);
}

export class JobManager {
  readonly rootDir: string;
  readonly concurrency: number;
  private readonly motor: AtelieMotor;
  private readonly now: () => Date;
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
        if (job.status === 'running') {
          job.status = 'queued';
          job.progresso = { etapa: 'preparando', concluidos: 0, total: 1, mensagem: 'job retomado após reinício' };
          this.persist(job);
        }
        this.jobs.set(job.id, job);
        this.byHash.set(job.brief_hash, job.id);
        if (job.status === 'queued') this.queue.push(job.id);
      } catch {
        // Entrada corrompida não derruba a API nem é exposta em logs.
      }
    }
  }

  create(value: unknown): { job: StoredJob; created: boolean } {
    const brief = normalizeBrief(value);
    const hash = briefHash(brief);
    const existingId = this.byHash.get(hash);
    if (existingId) return { job: this.jobs.get(existingId)!, created: false };
    const now = this.now().toISOString();
    const id = `job-${hash.slice(0, 24)}`;
    const total = new Set([...(brief.estilo ? [brief.estilo] : []), ...(brief.estilos ?? [])]).size;
    const job: StoredJob = {
      id,
      brief_hash: hash,
      brief,
      status: 'queued',
      criado_em: now,
      atualizado_em: now,
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
      const result: MotorResult = await this.motor.gerar(job.brief, {
        jobId: job.id,
        signal: controller.signal,
        onProgress: (progress) => {
          if (job.status === 'cancelled') return;
          job.progresso = progress;
          job.atualizado_em = this.now().toISOString();
          this.persist(job);
        },
      });
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
