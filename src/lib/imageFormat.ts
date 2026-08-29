import fs from 'fs';

export interface ImageFormat {
  format: 'png' | 'jpeg' | 'webp';
  mime: string;
  /** Extensão canônica correspondente ao formato (com ponto). */
  ext: string;
}

/**
 * Detecta o formato REAL de uma imagem pelos magic bytes (PNG 89504E47 /
 * JPEG FFD8 / WEBP "RIFF…WEBP"). O juiz precisa do media_type correto, por
 * isso nunca confiamos apenas na extensão.
 * Default seguro = PNG quando o cabeçalho é irreconhecível.
 */
export function detectImageFormat(filePath: string): ImageFormat {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    // try/finally: se readSync lançar, o fd PRECISA ser fechado (senão vaza descritor).
    try {
      fs.readSync(fd, buf, 0, 12, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return { format: 'png', mime: 'image/png', ext: '.png' };
    if (buf[0] === 0xff && buf[1] === 0xd8) return { format: 'jpeg', mime: 'image/jpeg', ext: '.jpg' };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
      return { format: 'webp', mime: 'image/webp', ext: '.webp' };
  } catch {
    /* ilegível — cai no default */
  }
  return { format: 'png', mime: 'image/png', ext: '.png' };
}
