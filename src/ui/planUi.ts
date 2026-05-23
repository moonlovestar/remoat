import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../utils/telegramFormatter';
import type { PlanningInfo } from '../services/planningDetector';

// Callback data prefixes
export const PLAN_VIEW_BTN = 'plan_view_btn';
export const PLAN_PROCEED_BTN = 'plan_proceed_btn';
export const PLAN_EDIT_BTN = 'plan_edit_btn';
export const PLAN_REFRESH_BTN = 'plan_refresh_btn';
export const PLAN_PAGE_PREFIX = 'plan_page';

const PAGE_SIZE = 3500;

/**
 * Convert plan markdown to Telegram HTML.
 * Handles headings, bold, italic, inline code, code blocks, and list items.
 */
function markdownToTelegramHtml(md: string): string {
    const lines = md.split('\n');
    const out: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
        // Code block toggle
        if (line.trimStart().startsWith('```')) {
            if (inCodeBlock) {
                out.push('</pre>');
                inCodeBlock = false;
            } else {
                out.push('<pre>');
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            out.push(escapeHtml(line));
            continue;
        }

        let converted = escapeHtml(line);

        // Headings: # → bold
        const headingMatch = converted.match(/^(#{1,4})\s+(.*)/);
        if (headingMatch) {
            converted = `<b>${headingMatch[2]}</b>`;
            out.push(converted);
            continue;
        }

        // Bold: **text**
        converted = converted.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        // Italic: *text*
        converted = converted.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
        // Inline code: `text`
        converted = converted.replace(/`([^`]+)`/g, '<code>$1</code>');
        // List items: - item or * item → bullet
        converted = converted.replace(/^(\s*)[-*]\s+/, '$1• ');

        out.push(converted);
    }

    // Close unclosed code block
    if (inCodeBlock) {
        out.push('</pre>');
    }

    return out.join('\n');
}

export interface PlanNotificationUI {
    text: string;
    keyboard: InlineKeyboard;
}

export interface PlanContentPage {
    text: string;
    keyboard: InlineKeyboard;
}

/**
 * Build plan notification message with action buttons.
 */
export function buildPlanNotificationUI(
    info: PlanningInfo,
    projectName: string,
    targetChannelStr: string,
): PlanNotificationUI {
    const description = info.description || info.planSummary || 'A plan has been generated and is awaiting your review.';
    const planName = info.planTitle || 'Implementation Plan';

    let typeLabel = 'Plan';
    if (planName.toLowerCase().includes('task')) typeLabel = 'Task';
    else if (planName.toLowerCase().includes('walkthrough')) typeLabel = 'Walkthrough';

    let text = `\u{1F4CB} <b>${typeLabel} Ready</b>\n\n`;
    text += escapeHtml(description) + `\n\n`;
    text += `<b>${typeLabel}:</b> ${escapeHtml(planName)}\n`;
    text += `<b>Workspace:</b> ${escapeHtml(projectName)}`;

    const suffix = `${projectName}:${targetChannelStr}`;
    const keyboard = new InlineKeyboard();

    const openLabel = info.openText || `Open ${typeLabel}`;
    keyboard.text(`\u{1F4D6} ${openLabel}`, `${PLAN_VIEW_BTN}:${suffix}`);

    if (info.proceedText) {
        const proceedLabel = info.proceedText;
        const proceedIcon = proceedLabel.toLowerCase().includes('accept') || proceedLabel.toLowerCase().includes('approve') ? '✅' : '▶';
        keyboard.text(`${proceedIcon} ${proceedLabel}`, `${PLAN_PROCEED_BTN}:${suffix}`);
    }

    keyboard.row()
        .text(`\u270F\uFE0F Edit ${typeLabel}`, `${PLAN_EDIT_BTN}:${suffix}`)
        .text('\u{1F504} Refresh', `${PLAN_REFRESH_BTN}:${suffix}`);

    return { text, keyboard };
}

/**
 * Split plan content into pages at newline boundaries.
 */
export function paginatePlanContent(content: string, pageSize: number = PAGE_SIZE): string[] {
    if (!content || content.trim().length === 0) return ['(Empty plan)'];
    if (content.length <= pageSize) return [content];

    const pages: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
        if (remaining.length <= pageSize) {
            pages.push(remaining);
            break;
        }

        // Find last newline within page size
        let splitAt = remaining.lastIndexOf('\n', pageSize);
        if (splitAt <= 0) {
            // No newline found; hard split
            splitAt = pageSize;
        }

        pages.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }

    return pages;
}

/**
 * Build a paginated plan content message.
 */
export function buildPlanContentUI(
    pages: string[],
    currentPage: number,
    projectName: string,
    targetChannelStr: string,
    planTitle?: string,
    proceedText?: string,
): PlanContentPage {
    const page = pages[currentPage] || '(Page not found)';
    const totalPages = pages.length;

    let typeLabel = 'Plan';
    if (planTitle) {
        if (planTitle.toLowerCase().includes('task')) typeLabel = 'Task';
        else if (planTitle.toLowerCase().includes('walkthrough')) typeLabel = 'Walkthrough';
    }

    let text = `<b>\u{1F4CB} ${typeLabel} Content</b>`;
    if (totalPages > 1) {
        text += ` (${currentPage + 1}/${totalPages})`;
    }
    text += `\n\n${markdownToTelegramHtml(page)}`;

    const suffix = `${projectName}:${targetChannelStr}`;
    const keyboard = new InlineKeyboard();

    if (totalPages > 1) {
        if (currentPage > 0) {
            keyboard.text('\u25C0 Prev', `${PLAN_PAGE_PREFIX}:${currentPage - 1}:${suffix}`);
        }
        if (currentPage < totalPages - 1) {
            keyboard.text('Next \u25B6', `${PLAN_PAGE_PREFIX}:${currentPage + 1}:${suffix}`);
        }
        keyboard.row();
    }

    if (proceedText) {
        const proceedIcon = proceedText.toLowerCase().includes('accept') || proceedText.toLowerCase().includes('approve') ? '✅' : '▶';
        keyboard.text(`${proceedIcon} ${proceedText}`, `${PLAN_PROCEED_BTN}:${suffix}`);
    }

    keyboard
        .text('\u270F\uFE0F Edit', `${PLAN_EDIT_BTN}:${suffix}`)
        .row()
        .text('\u{1F504} Refresh', `${PLAN_REFRESH_BTN}:${suffix}`)
        .text('\u{1F4D6} View Full', `${PLAN_VIEW_BTN}:${suffix}`);

    return { text, keyboard };
}
