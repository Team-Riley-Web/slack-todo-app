import type { FetchedFile } from './handlers/import-wizard.js';
import { MAX_FILE_BYTES, ImportLimitError } from '@tr/importer';

export interface FileClient {
  files: { info: (args: { file: string }) => Promise<Record<string, any>> };
}

/**
 * Reads an uploaded file's bytes.
 *
 * `url_private` is not a public URL. It needs an Authorization header carrying
 * a token with `files:read`, which is the one scope the import wizard adds.
 *
 * The size is taken from `files.info` first so an oversized upload is refused
 * before its body is pulled over the network. Slack permits 100 MB uploads and
 * this importer permits 10 MiB, so without that check the common failure mode
 * would be downloading 90 MB in order to reject it.
 */
export function makeFetchFile(
  client: FileClient, token: string,
  fetchImpl: typeof fetch = fetch
): (fileId: string) => Promise<FetchedFile> {
  return async (fileId: string): Promise<FetchedFile> => {
    const info = await client.files.info({ file: fileId });
    const file = info?.file ?? {};

    const size: number | null = typeof file.size === 'number' ? file.size : null;
    const name: string | null = typeof file.name === 'string' ? file.name : null;

    // Refuse before downloading, and throw rather than returning empty text:
    // an empty string would parse as "no rows", which is a different and more
    // confusing message than "too big". ImportLimitError is used so the
    // wizard shows this reason instead of a generic failure.
    if (size !== null && size > MAX_FILE_BYTES) {
      const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
      throw new ImportLimitError(
        `File is ${mib(size)} MiB; the limit is ${mib(MAX_FILE_BYTES)} MiB.`
      );
    }

    const url: unknown = file.url_private_download ?? file.url_private;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`file ${fileId} has no private URL`);
    }

    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`downloading file ${fileId} failed with ${response.status}`);
    }

    return { name, size, text: await response.text() };
  };
}
