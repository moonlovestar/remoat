import { logger } from '../utils/logger';
import { buildClickScript } from './approvalDetector';
import { CdpService } from './cdpService';

/** Info about a handled "no matching case" fallback event */
export interface UnmatchedCaseInfo {
    /** Text of the "Other (write your answer)" trigger element that was clicked */
    triggerText: string;
    /** The fallback reply text that was sent into the free-text box */
    replyText: string;
}

export interface UnmatchedCaseDetectorOptions {
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
    /** Callback fired after the fallback action was performed */
    onUnmatchedCaseHandled: (info: UnmatchedCaseInfo) => void;
    /** Reply text to send into the free-text box (default: the fixed sentence below) */
    replyText?: string;
}

/** Default text sent when a "no matching case" dialog is auto-handled. */
export const DEFAULT_UNMATCHED_CASE_REPLY = 'no handler for this, stop the current function';

const OTHER_OPTION_PATTERNS = [
    'other (write your answer)',
    'other(write your answer)',
    'write your answer',
];

/**
 * Detection script — generic, NOT tied to the radio-list (Tier 3) shape.
 * Scans the ENTIRE visible DOM for an "Other (write your answer)" style
 * option, regardless of whether it sits inside a notify-user-container,
 * a modal/dialog, a radio-list, or any other unrecognized layout.
 */
const DETECT_OTHER_OPTION_SCRIPT = `(() => {
    const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const PATTERNS = ${JSON.stringify(OTHER_OPTION_PATTERNS)};

    const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (!isVisible(el)) return false;
        if (el.children.length > 8) return false;
        const t = normalize(el.textContent || '');
        if (t.length === 0 || t.length > 100) return false;
        return PATTERNS.some((p) => t === p || t.includes(p));
    }).sort((a, b) => {
        // Prefer the smallest/leaf-most match (avoid grabbing a whole container).
        if (a.children.length !== b.children.length) return a.children.length - b.children.length;
        return normalize(a.textContent || '').length - normalize(b.textContent || '').length;
    });

    if (candidates.length === 0) return null;
    const el = candidates[0];
    return { text: (el.textContent || '').trim() };
})()`;

/**
 * After clicking "Other (write your answer)", Antigravity swaps in a free-text
 * input (textarea / contenteditable / input[type=text]). Focus the most
 * recently-rendered visible one so subsequent Input.insertText lands there.
 */
const FOCUS_FREE_TEXT_INPUT_SCRIPT = `(() => {
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')).filter(isVisible);
    const el = candidates[candidates.length - 1];
    if (!el) return { ok: false, error: 'No free-text input found after clicking Other option' };
    el.focus();
    return { ok: true };
})()`;

/**
 * Generic fallback detector for "no matching case" dialogs.
 *
 * Unlike ApprovalDetector / PlanningDetector / ErrorPopupDetector, this does
 * NOT try to recognize a specific dialog shape. It only looks for the escape
 * hatch text "Other (write your answer)" anywhere visible on the page, and
 * only fires when none of the specific detectors currently have an active
 * detection — i.e. this is the default/last-resort handler for UI patterns
 * nobody has written a dedicated detector for yet.
 *
 * On match: clicks the "Other" option, types the fixed reply text into the
 * free-text box that appears, submits it (Submit button if present,
 * otherwise Enter), and notifies via the onUnmatchedCaseHandled callback.
 */
export class UnmatchedCaseDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private isOtherDetectorActive: () => boolean;
    private onUnmatchedCaseHandled: (info: UnmatchedCaseInfo) => void;
    private replyText: string;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last handled trigger (prevents re-clicking the same dialog every poll) */
    private lastHandledKey: string | null = null;

    constructor(options: UnmatchedCaseDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.isOtherDetectorActive = options.isOtherDetectorActive;
        this.onUnmatchedCaseHandled = options.onUnmatchedCaseHandled;
        this.replyText = options.replyText ?? DEFAULT_UNMATCHED_CASE_REPLY;
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastHandledKey = null;
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

    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    /**
     * Single poll iteration:
     *   1. Skip entirely if a specific detector already has an active detection
     *      (Approval / Planning / ErrorPopup take priority).
     *   2. Scan the DOM for a visible "Other (write your answer)" option.
     *   3. If found and not already handled, click it, type the fallback
     *      reply, submit, and notify.
     *   4. Reset dedup state once the trigger text disappears (so a future
     *      unrelated "Other" dialog can be handled again).
     */
    private async poll(): Promise<void> {
        try {
            if (this.isOtherDetectorActive()) {
                // A specific detector is already handling something — yield to it.
                return;
            }

            const contextId = this.cdpService.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression: DETECT_OTHER_OPTION_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            const found: { text: string } | null = result?.result?.value ?? null;

            if (!found) {
                this.lastHandledKey = null;
                return;
            }

            const key = found.text;
            if (key === this.lastHandledKey) {
                // Already handled this exact trigger — don't re-click every poll.
                return;
            }
            this.lastHandledKey = key;

            await this.handleUnmatchedCase(found.text);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[UnmatchedCaseDetector] Error during polling:', error);
        }
    }

    /** Click "Other", type the fallback reply, submit, and notify. */
    private async handleUnmatchedCase(triggerText: string): Promise<void> {
        logger.info(`[UnmatchedCaseDetector] No matching case — clicking "${triggerText}" and sending fallback reply`);

        const clicked = await this.runEvaluateScript(buildClickScript(triggerText));
        if (clicked?.ok !== true) {
            logger.warn(`[UnmatchedCaseDetector] Failed to click "${triggerText}": ${JSON.stringify(clicked)}`);
            return;
        }

        // Give the UI a moment to swap in the free-text input.
        await new Promise((resolve) => setTimeout(resolve, 200));

        const focused = await this.runEvaluateScript(FOCUS_FREE_TEXT_INPUT_SCRIPT);
        if (focused?.ok !== true) {
            logger.warn(`[UnmatchedCaseDetector] Failed to focus free-text input: ${JSON.stringify(focused)}`);
            return;
        }

        await this.cdpService.call('Input.insertText', { text: this.replyText });
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Prefer a Submit/Send button if present; otherwise fall back to Enter.
        const submitClicked = await this.runEvaluateScript(buildClickScript('Submit'));
        if (submitClicked?.ok !== true) {
            const sendClicked = await this.runEvaluateScript(buildClickScript('Send'));
            if (sendClicked?.ok !== true) {
                await this.pressEnter();
            }
        }

        this.onUnmatchedCaseHandled({ triggerText, replyText: this.replyText });
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
