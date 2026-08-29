import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getAllStyles } from '../lib/userStyles';
import { JobManager } from './jobs';

export interface V1Options {
  jobs: JobManager;
  token?: string;
}

/**
 * `ATELIE_TOKEN` aceita o segredo literal ou `@/caminho/token`. Também aceitamos
 * `ATELIE_TOKEN_FILE`; arquivos com permissão diferente de 0600 falham fechados.
 */
export function loadLocalToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitFile = env.ATELIE_TOKEN_FILE?.trim();
  const raw = env.ATELIE_TOKEN?.trim();
  const file = explicitFile || (raw?.startsWith('@') ? raw.slice(1) : undefined);
  if (!file) return raw || undefined;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('arquivo de token do Ateliê não é um arquivo regular');
  if ((stat.mode & 0o077) !== 0) throw new Error('arquivo de token do Ateliê precisa ter permissão 0600');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error('arquivo de token do Ateliê está vazio');
  return token;
}

function sameToken(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorize(token: string | undefined, request: FastifyRequest, reply: FastifyReply): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  const supplied = typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : '';
  if (sameToken(token, supplied)) return true;
  reply.code(401).header('WWW-Authenticate', 'Bearer').send({ erro: { codigo: 'unauthorized', mensagem: 'token local ausente ou inválido' } });
  return false;
}

export async function registerV1Routes(app: FastifyInstance, options: V1Options): Promise<void> {
  const token = options.token;
  const protectedRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorize(token, request, reply)) return reply;
  };

  app.get('/v1/health', async () => ({ ok: true, versao_api: 'v1', fila: { concorrencia: options.jobs.concurrency } }));

  app.get('/v1/styles', { preHandler: protectedRoute }, async () => ({
    estilos: getAllStyles().map((style) => ({
      id: style.id,
      nome: style.nome,
      grupo: style.grupo,
      descricao: style.desc,
      defaults: style.defaults,
    })),
    modos: ['explicacao', 'cena'],
  }));

  app.post('/v1/jobs', { preHandler: protectedRoute }, async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown> | undefined;
      const envelope = body && typeof body === 'object' && !Array.isArray(body) && body.brief != null;
      const brief = envelope ? body.brief : request.body;
      const force = body?.force === true;
      const retry = body?.retry === true;
      const { job, created } = options.jobs.create(brief, { force, retry });
      reply.header('Location', `/v1/jobs/${job.id}`);
      return reply.code(created ? 202 : 200).send(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'brief inválido';
      return reply.code(400).send({ erro: { codigo: 'invalid_brief', mensagem: message } });
    }
  });

  app.get('/v1/jobs/:id', { preHandler: protectedRoute }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = options.jobs.get(id);
    if (!job) return reply.code(404).send({ erro: { codigo: 'job_not_found', mensagem: 'job não encontrado' } });
    return job;
  });

  app.delete('/v1/jobs/:id', { preHandler: protectedRoute }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = options.jobs.cancel(id);
    if (!job) return reply.code(404).send({ erro: { codigo: 'job_not_found', mensagem: 'job não encontrado' } });
    return job;
  });

  app.get('/v1/jobs/:id/artifact/:n', { preHandler: protectedRoute }, async (request, reply) => {
    const { id, n: rawN } = request.params as { id: string; n: string };
    const n = Number(rawN);
    if (!Number.isInteger(n) || n < 1) return reply.code(400).send({ erro: { codigo: 'invalid_artifact', mensagem: 'n precisa ser inteiro a partir de 1' } });
    const file = options.jobs.artifactPath(id, n);
    if (!file) return reply.code(404).send({ erro: { codigo: 'artifact_not_found', mensagem: 'artefato não encontrado' } });
    reply.type('image/png').header('Cache-Control', 'private, immutable');
    return reply.send(fs.createReadStream(file));
  });
}
