import { logger } from '../utils/logger';
import { buildClickScript } from './approvalDetector';
import { CdpService } from './cdpService';

/** Info about a detected open-ended question card (Skip/Submit shape) */
export interface AskQuestionInfo {
    /** Dedup key derived from the DOM state at detection time */
    key: string;
}

export interface AskQuestionDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /**
     * Returns true when ApprovalDetector / PlanningDetector / ErrorPopupDetector
     * currently has an active (non-null) detection for this workspace.
     * Used to yield to those detectors so this generic fallback never fights
     * over a dialog that another, more specific detector already recognizes.
     */
    isOtherDetectorActive: () => boolean;
    /** Callback fired when the Skip/Submit question card first appears */
    onQuestionDetected: (info: AskQuestionInfo) => void;
    /** Callback fired when the question card disappears (answered, skipped, or timed out) */
    onResolved?: () => void;
}

/**
 * Detection script for Antigravity's "Asking 1 question" free-text card.
 *
 * Live DOM inspection (2026-07-26) confirmed this shape: a "Skip" button and
 * a "Submit↵" button rendered as siblings inside a small container (no more
 * than ~8 descendants), with NO allow/deny-style approval text nearby. This
 * distinguishes it from:
 *   - ApprovalDetector's radio-list Tier 3 (which also has a Submit button,
 *     but paired with "Yes, allow..." / deny option rows)
 *   - The generic chat send button (which has no visible "Submit↵" text and
 *     no sibling "Skip" button)
 */
const DETECT_ASK_QUESTION_SCRIPT = `(() => {
    const normalize = (text) => (text || '').toLowerCase().replace(/[^\\\\w\\\\s,]/g, ' ').replace(/\\\\s+/g, ' ').trim();
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const CLICKABLE_SELECTORS = 'button, [role="button"]';

    const btns = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS)).filter(isVisible);
    const submitBtn = btns.find((b) => normalize(b.textContent || '') === 'submit');
    if (!submitBtn) return null;

    // Walk up from Submit looking for a sibling "Skip" button within a small container.
    let anc = submitBtn.parentElement;
    for (let i = 0; i < 6 && anc && anc !== document.body; i++) {
        const skipBtn = Array.from(anc.querySelectorAll(CLICKABLE_SELECTORS))
            .filter(isVisible)
            .find((b) => normalize(b.textContent || '') === 'skip');
        if (skipBtn) {
            // Reject if this container also has allow/approval-style option rows —
            // that's ApprovalDetector's radio-list Tier 3, not an open question.
            const ALLOW_ONCE_PATTERNS = ['yes, allow this time', 'yes, allow once', 'allow this time', 'allow once', 'allow one time'];
            const hasApprovalOption = Array.from(anc.querySelectorAll('*')).some((el) => {
                if (!isVisible(el) || el.children.length > 8) return false;
                const t = normalize(el.textContent || '');
                return t.length > 0 && t.length <= 180 && ALLOW_ONCE_PATTERNS.some((p) => t.includes(p));
            });
            if (hasApprovalOption) return null;
            return { key: 'ask-question-card' };
        }
        anc = anc.parentElement;
    }
    return null;
})()`;

/**
 * After no Skip/Submit card is found, the previous state is considered resolved.
 */
const DETECT_ASK_QUESTION_GONE_SCRIPT = DETECT_ASK_QUESTION_SCRIPT;

/**
 * Focus the most recently-rendered visible free-text input so subsequent
 * Input.insertText lands in the question's answer box.
 */
const FOCUS_FREE_TEXT_INPUT_SCRIPT = `(() => {
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')).filter(isVisible);
    const el = candidates[candidates.length - 1];
    if (!el) return { ok: false, error: 'No free-text input found for ask-question card' };
    el.focus();
    return { ok: true };
})()`;

/**
 * Detects Antigravity's "Asking N question(s)" open-ended free-text card
 * (Skip + Submit↵ button pair) via polling.
 *
 * Unlike ApprovalDetector/PlanningDetector, this card's question text is
 * already relayed to Telegram through the normal ResponseMonitor completion
 * flow (it's just the AI's latest response). This detector's job is narrower:
 * flag that the card is currently open so the NEXT Telegram reply from the
 * user gets typed into the card's free-text box and submitted via the
 * "Submit" button, instead of the normal chat-input + Enter path (which may
 * not reliably submit this specific inline card).
 */
export class AskQuestionDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private isOtherDetectorActive: () => boolean;
    private onQuestionDetected: (info: AskQuestionInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** True while the Skip/Submit card was present on the last poll */
    private cardActive: boolean = false;

    constructor(options: AskQuestionDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.isOtherDetectorActive = options.isOtherDetectorActive;
        this.onQuestionDetected = options.onQuestionDetected;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.cardActive = false;
        this.schedulePoll();
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }

    /** Returns the CDP service instance this detector is bound to */
    getCdpService(): CdpService {
        return this.cdpService;
    }

    /** Returns whether the Skip/Submit question card is currently believed to be open */
    isCardActive(): boolean {
        return this.cardActive;
    }

    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    private async poll(): Promise<void> {
        try {
            if (this.isOtherDetectorActive()) {
                return;
            }

            const found = await this.runEvaluateScript(DETECT_ASK_QUESTION_SCRIPT);

            if (found && !this.cardActive) {
                this.cardActive = true;
                this.onQuestionDetected({ key: found.key });
            } else if (!found && this.cardActive) {
                this.cardActive = false;
                this.onResolved?.();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[AskQuestionDetector] Error during polling:', error);
        }
    }

    /**
     * Type the given answer into the question card's free-text box and click Submit.
     * Falls back to Enter if no Submit button is found (card may have already closed).
     */
    async submitAnswer(text: string): Promise<{ ok: boolean; error?: string }> {
        const focused = await this.runEvaluateScript(FOCUS_FREE_TEXT_INPUT_SCRIPT);
        if (focused?.ok !== true) {
            return { ok: false, error: focused?.error || 'Failed to focus free-text input' };
        }

        await this.cdpService.call('Input.insertText', { text });
        await new Promise((resolve) => setTimeout(resolve, 150));

        const submitClicked = await this.runEvaluateScript(buildClickScript('Submit'));
        if (submitClicked?.ok !== true) {
            await this.pressEnter();
        }

        this.cardActive = false;
        return { ok: true };
    }

    private async pressEnter(): Promise<void> {
        await this.cdpService.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
        });
        await this.cdpService.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
        });
    }

    /** Execute Runtime.evaluate with the primary context and return result.value. */
    private async runEvaluateScript(expression: string): Promise<any> {
        const contextId = this.cdpService.getPrimaryContextId();
        const callParams: Record<string, unknown> = {
            expression,
            returnByValue: true,
            awaitPromise: false,
        };
        if (contextId !== null) {
            callParams.contextId = contextId;
        }
        const result = await this.cdpService.call('Runtime.evaluate', callParams);
        return result?.result?.value;
    }
}

// Re-export for callers that only need the "gone" detection expression name for clarity.
export { DETECT_ASK_QUESTION_GONE_SCRIPT };
