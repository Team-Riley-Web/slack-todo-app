import { describe, it, expect } from 'vitest';
import { ImportLimitError, MAX_FILE_BYTES } from '@tr/importer';
import { makeFetchFile, type FileClient } from './slack-file.js';

const client = (file: Record<string, unknown>): FileClient => ({
  files: { info: async () => ({ ok: true, file }) },
});

const okResponse = (text: string) =>
  ({ ok: true, status: 200, text: async () => text }) as unknown as Response;

describe('reading an uploaded file', () => {
  it('sends the bot token, because url_private is not public', async () => {
    const seen: Array<{ url: string; auth: unknown }> = [];
    const fetchFile = makeFetchFile(
      client({ name: 'a.csv', size: 12, url_private: 'https://files.slack.com/a.csv' }),
      'xoxb-test-token',
      (async (url: string, init: RequestInit) => {
        seen.push({ url, auth: (init.headers as Record<string, string>).Authorization });
        return okResponse('title\nx\n');
      }) as unknown as typeof fetch
    );

    const result = await fetchFile('F1');
    expect(seen[0]!.url).toBe('https://files.slack.com/a.csv');
    expect(seen[0]!.auth).toBe('Bearer xoxb-test-token');
    expect(result.text).toBe('title\nx\n');
    expect(result.name).toBe('a.csv');
  });

  it('prefers url_private_download when Slack offers it', async () => {
    const urls: string[] = [];
    const fetchFile = makeFetchFile(
      client({
        name: 'a.csv', size: 5,
        url_private: 'https://files.slack.com/view',
        url_private_download: 'https://files.slack.com/download',
      }),
      't',
      (async (url: string) => { urls.push(url); return okResponse('x'); }) as unknown as typeof fetch
    );
    await fetchFile('F1');
    expect(urls).toEqual(['https://files.slack.com/download']);
  });

  it('refuses an oversized file without downloading it', async () => {
    let downloaded = false;
    const fetchFile = makeFetchFile(
      client({ name: 'huge.csv', size: MAX_FILE_BYTES + 1, url_private: 'https://x' }),
      't',
      (async () => { downloaded = true; return okResponse('x'); }) as unknown as typeof fetch
    );

    await expect(fetchFile('F1')).rejects.toThrow(ImportLimitError);
    expect(downloaded).toBe(false);
  });

  it('reports the size in MiB so the message is readable', async () => {
    const fetchFile = makeFetchFile(
      client({ name: 'huge.csv', size: 11 * 1024 * 1024, url_private: 'https://x' }),
      't',
      (async () => okResponse('x')) as unknown as typeof fetch
    );
    await expect(fetchFile('F1')).rejects.toThrow(/11\.0 MiB; the limit is 10\.0 MiB/);
  });

  it('still downloads when Slack reports no size', async () => {
    const fetchFile = makeFetchFile(
      client({ name: 'a.csv', url_private: 'https://x' }),
      't',
      (async () => okResponse('title\n')) as unknown as typeof fetch
    );
    const result = await fetchFile('F1');
    expect(result.size).toBeNull();
    expect(result.text).toBe('title\n');
  });

  it('fails loudly when the file has no private URL', async () => {
    const fetchFile = makeFetchFile(
      client({ name: 'a.csv', size: 1 }), 't',
      (async () => okResponse('x')) as unknown as typeof fetch
    );
    await expect(fetchFile('F1')).rejects.toThrow(/no private URL/);
  });

  it('fails on a non-ok download rather than treating the body as data', async () => {
    const fetchFile = makeFetchFile(
      client({ name: 'a.csv', size: 1, url_private: 'https://x' }), 't',
      (async () => ({ ok: false, status: 403, text: async () => 'denied' })) as unknown as typeof fetch
    );
    await expect(fetchFile('F1')).rejects.toThrow(/failed with 403/);
  });
});
