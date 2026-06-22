import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { logger } from './logger';

const MAX_INBOUND_FILE_ATTACHMENTS = 4;
const TEMP_FILE_DIR = path.join(os.tmpdir(), 'remoat-files');

export interface InboundFileAttachment {
    localPath: string;
    name: string;
    mimeType: string;
    size?: number;
}

export function buildPromptWithFileRefs(prompt: string, files: InboundFileAttachment[]): string {
    const base = prompt.trim() || 'Please review the attached file(s) and respond accordingly.';
    if (files.length === 0) return base;
    const lines = files.map((f, i) => `${i + 1}. ${f.name}${f.mimeType ? ` (${f.mimeType})` : ''}`);
    return `${base}\n\n[Telegram Attached Files]\n${lines.join('\n')}\n\nPlease refer to the attached file(s) above in your response.`;
}

/**
 * Download a generic Telegram file (document, video, audio, sticker, etc.) to a temp dir.
 */
export async function downloadTelegramFile(
    botApi: { getFile: (fileId: string) => Promise<any> },
    botToken: string,
    files: Array<{ file_id: string; file_size?: number; file_name?: string; mime_type?: string }>,
    messageId: string | number,
): Promise<InboundFileAttachment[]> {
    const batch = files.slice(0, MAX_INBOUND_FILE_ATTACHMENTS);
    if (batch.length === 0) return [];

    await fs.mkdir(TEMP_FILE_DIR, { recursive: true });

    const downloaded: InboundFileAttachment[] = [];
    let index = 0;
    for (const f of batch) {
        try {
            const file = await botApi.getFile(f.file_id);
            const filePath = file.file_path;
            if (!filePath) continue;

            const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
            const response = await fetch(url);
            if (!response.ok) {
                logger.warn(`[FileHandler] Download failed (status=${response.status})`);
                continue;
            }

            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0) continue;

            const remoteExt = path.extname(filePath);
            const rawName = f.file_name || `file-${index + 1}${remoteExt}`;
            const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || `file-${index + 1}`;
            const localPath = path.join(TEMP_FILE_DIR, `${Date.now()}-${messageId}-${index}-${safeName}`);

            await fs.writeFile(localPath, bytes);
            downloaded.push({
                localPath,
                name: safeName,
                mimeType: f.mime_type || response.headers.get('content-type') || 'application/octet-stream',
                size: bytes.length,
            });
            index += 1;
        } catch (error: any) {
            logger.warn('[FileHandler] File processing failed', error?.message || error);
        }
    }

    return downloaded;
}

export async function cleanupInboundFileAttachments(files: InboundFileAttachment[]): Promise<void> {
    for (const f of files) {
        await fs.unlink(f.localPath).catch(() => {});
    }
}
